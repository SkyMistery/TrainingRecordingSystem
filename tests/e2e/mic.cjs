// Voice notes with a stale microphone id, in an isolated app instance (own
// settings folder), against the real OBS and microphone.
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const OBS_PASSWORD = process.argv[2]
const USERDATA = join(require('node:os').tmpdir(), 'trs-e2e-mic')
const { uIOhook } = require(`${ROOT}/node_modules/uiohook-napi`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const real = JSON.parse(readFileSync(join(process.env.APPDATA, 'Training Recording System', 'settings.json'), 'utf8'))
const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })

async function runCase(name, notes) {
  rmSync(USERDATA, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
  writeFileSync(
    join(USERDATA, 'settings.json'),
    JSON.stringify({
      capture: real.capture,
      companion: { enabled: false, lan: false, port: 17647 },
      markers: {
        ...real.markers,
        preRollSeconds: 3,
        statusWindow: false,
        sound: false,
        hotkeys: { marker: key(91, 'F13'), range: key(92, 'F14'), voiceNote: key(99, 'F16') }
      },
      notes: { ...real.notes, ...notes, transcribe: false }
    })
  )
  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', '--remote-debugging-port=9335', `--user-data-dir=${USERDATA}`],
    { cwd: ROOT }
  )
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      target = (await (await fetch('http://127.0.0.1:9335/json')).json()).find(
        (t) => t.type === 'page' && t.url.endsWith('index.html')
      )
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const h = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== n) return
        ws.removeEventListener('message', h)
        if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.exception?.description))
        else resolve(d.result?.result?.value)
      }
      ws.addEventListener('message', h)
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  await evaluate(
    `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(OBS_PASSWORD)} }).catch((e) => e.message)`
  )
  let state
  for (let i = 0; i < 20; i++) {
    state = await evaluate('window.api.getState()')
    if (state.obs.status === 'connected' && !state.busy) break
    await sleep(500)
  }
  let folder
  try {
    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Microphone test',trainerVid:'',date:'2026-09-24'})`
    )
    await sleep(2500)
    uIOhook.start()
    uIOhook.keyToggle(99, 'down')
    await sleep(1500)
    uIOhook.keyToggle(99, 'up')
    await sleep(2000)
    // Also through the UI command, like the "Hold to dictate" button.
    await evaluate(`window.api.command('startNote')`)
    await sleep(1500)
    await evaluate(`window.api.command('stopNote')`)
    await sleep(2000)
    uIOhook.stop()
    state = await evaluate('window.api.getState()')
    folder = join(process.env.USERPROFILE, 'Documents', 'IVAO TRS', 'Sessions', state.recording.folderName)
    const notes = state.recording.markers.flatMap((m) => m.notes)
    check(
      `${name}: both voice notes saved (hotkey and button)`,
      notes.length === 2,
      `${notes.length} notes, files: ${notes.map((n) => (existsSync(join(folder, n.audio)) ? 'OK' : 'MISSING')).join(',')}`
    )
    return { microphoneError: state.microphoneError }
  } finally {
    await evaluate('window.api.getState().then((s) => s.recording && window.api.stopSession())').catch(() => undefined)
    await evaluate('window.close()').catch(() => undefined)
    ws.close()
    await new Promise((r) => {
      const timer = setTimeout(() => (app.kill(), r()), 8000)
      app.on('exit', () => (clearTimeout(timer), r()))
    })
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
}

;(async () => {
  const first = await runCase('stale id, same name', {
    micDeviceId: 'stale-device-id-from-another-origin',
    micLabel: real.notes.micLabel
  })
  check('stale id, same name: no microphone warning', first.microphoneError === null, String(first.microphoneError))
  const second = await runCase('unknown microphone', {
    micDeviceId: 'stale-device-id',
    micLabel: 'A microphone that does not exist'
  })
  check(
    'unknown microphone: falls back and says so',
    /not found/.test(second.microphoneError ?? ''),
    String(second.microphoneError)
  )
  rmSync(USERDATA, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
