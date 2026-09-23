// End-to-end test of M2 against the real app + OBS, driven through the
// Chrome DevTools Protocol (window.api) and synthetic F13/F14/F15 key presses.
const { spawn } = require('node:child_process')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const { uIOhook } = require(`${ROOT}/node_modules/uiohook-napi`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const app = spawn(`${ROOT}/node_modules/electron/dist/electron.exe`, ['.', '--remote-debugging-port=9333'], {
    cwd: ROOT,
    stdio: 'ignore'
  })
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json')).json()
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('#status'))
    } catch {}
  }
  if (!target) throw new Error('app did not start')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (pending.has(msg.id)) pending.get(msg.id)(msg)
  })
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (msg) => {
        const r = msg.result
        if (r?.exceptionDetails) reject(new Error(r.exceptionDetails.exception?.description ?? 'eval failed'))
        else resolve(r?.result?.value)
      })
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  const log = (...a) => console.log('[e2e]', ...a)
  let state
  for (let i = 0; i < 30; i++) {
    state = await evaluate('window.api.getState()')
    if (state.obs.status === 'connected' && !state.busy) break
    await sleep(500)
  }
  log('OBS', state.obs.status, state.obs.version, '| display', state.capture.display?.name)
  const original = state.markerSettings
  const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })
  const testSettings = {
    ...original,
    preRollSeconds: 3,
    hotkeys: { ...original.hotkeys, marker: key(91, 'F13'), range: key(92, 'F14') },
    categories: original.categories.map((c, i) => (i === 1 ? { ...c, hotkey: key(93, 'F15') } : c))
  }
  await evaluate(`window.api.saveMarkerSettings(${JSON.stringify(testSettings)})`)

  try {
    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Automated test',trainerVid:'',date:'2026-09-23'})`
    )
    log('recording started')
    uIOhook.start()
    const tap = async (code) => {
      uIOhook.keyToggle(code, 'down')
      await sleep(60)
      uIOhook.keyToggle(code, 'up')
      await sleep(400)
    }
    await sleep(4500)
    await tap(91) // marker at ~4.5 s
    await sleep(1000)
    await tap(93) // category "separation" on it
    await sleep(1000)
    await tap(92) // range start
    await sleep(2500)
    await tap(92) // range end
    await sleep(500)
    // Auto-repeat must not create extra markers: hold F13 for 1.2 s.
    uIOhook.keyToggle(91, 'down')
    await sleep(1200)
    uIOhook.keyToggle(91, 'up')
    await sleep(1500)
    uIOhook.stop()
    state = await evaluate('window.api.getState()')
    log(
      'markers during recording:',
      JSON.stringify(
        state.recording.markers.map((m) => ({
          n: m.number,
          kind: m.kind,
          t: m.timeMs,
          pressed: m.pressedAtMs,
          end: m.endMs,
          cat: m.categoryId,
          shot: m.screenshot
        }))
      )
    )
    await evaluate('window.api.stopSession()')
    log('recording stopped')
  } finally {
    await evaluate(`window.api.saveMarkerSettings(${JSON.stringify(original)})`)
    log('settings restored')
  }

  const sessions = await evaluate('window.api.listSessions()')
  const session = sessions.find((s) => s.metadata.traineeName === 'E2E test')
  const file = JSON.parse(readFileSync(join(session.folder, 'session.json'), 'utf8'))
  log('folder', session.folder)
  log('recording', JSON.stringify(file.recording))
  for (const m of file.markers) {
    const shot = m.screenshot && join(session.folder, m.screenshot)
    log(
      `#${m.number} ${m.kind} t=${m.timeMs} pressed=${m.pressedAtMs} end=${m.endMs} cat=${m.categoryId} screenshot=${shot && existsSync(shot) ? 'OK' : 'MISSING'}`
    )
  }
  const folderName = session.folder.split(/[\/]/).pop()
  const img = await evaluate(
    `new Promise((res) => { const i = new Image(); i.onload = () => res('loaded ' + i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('error'); i.src = 'trs-media://sessions/' + encodeURIComponent(${JSON.stringify(folderName)}) + '/screenshots/m-0001.png' })`
  )
  log('screenshot via trs-media:', img)
  const escape = await evaluate(
    `new Promise((res) => { const i = new Image(); i.onload = () => res('LOADED (bad)'); i.onerror = () => res('blocked (good)'); i.src = 'trs-media://sessions/..%2F..%2F..%2FDesktop%2Fx.png' })`
  )
  log('path escape attempt:', escape)
  // Close normally so the app gives OBS back the trainer's profile.
  await evaluate('window.close()').catch(() => undefined)
  ws.close()
  await new Promise((r) => {
    app.on('exit', r)
    setTimeout(() => {
      app.kill()
      r()
    }, 8000)
  })
  log('app closed')
}
main().catch((e) => {
  console.error('[e2e] FAILED', e)
  process.exit(1)
})
