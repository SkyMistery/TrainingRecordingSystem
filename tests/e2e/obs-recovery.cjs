// End-to-end test of the app's OBS robustness against the real OBS:
// 1. the trainer switches OBS to their own profile while the app is connected:
//    starting a session must not write into it;
// 2. a pause in OBS keeps marker times right;
// 3. the app dies while OBS records: started again, it continues the session
//    and the recording ends up in the session folder;
// 4. quitting gives OBS back the trainer's profile.
// Uses the real settings (like markers.cjs): close the app first. OBS must be
// idle, on the trainer's own profile. Usage: node obs-recovery.cjs <obs-password>
const { spawn } = require('node:child_process')
const { existsSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const { OBSWebSocket } = require(`${ROOT}/node_modules/obs-websocket-js`)
const SESSIONS = join(process.env.USERPROFILE, 'Documents', 'IVAO TRS', 'Sessions')
const PORT = 9339
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

function startApp() {
  const app = spawn(`${ROOT}/node_modules/electron/dist/electron.exe`, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore'
  })
  const exited = new Promise((r) => app.on('exit', r))
  return { app, exited }
}

async function connect() {
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'))
    } catch {}
  }
  if (!target) throw new Error('app did not start')
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
  const state = () => evaluate('window.api.getState()')
  return { evaluate, state, close: () => ws.close() }
}

async function waitFor(page, condition, ms = 20000) {
  const until = Date.now() + ms
  let s
  while (Date.now() < until) {
    s = await page.state().catch(() => null)
    if (s && condition(s)) return s
    await sleep(300)
  }
  return s
}

async function profileParams(obs) {
  const read = async (parameterCategory, parameterName) =>
    (await obs.call('GetProfileParameter', { parameterCategory, parameterName })).parameterValue
  return {
    mode: await read('Output', 'Mode'),
    format: await read('SimpleOutput', 'RecFormat2'),
    encoder: await read('SimpleOutput', 'RecEncoder'),
    quality: await read('SimpleOutput', 'RecQuality')
  }
}

async function main() {
  const password = process.argv[2]
  if (!password) throw new Error('Usage: node obs-recovery.cjs <obs-websocket-password>')
  const obs = new OBSWebSocket()
  await obs.connect('ws://127.0.0.1:4455', password)
  if ((await obs.call('GetRecordStatus')).outputActive) throw new Error('OBS is recording: stop it first')
  const own = {
    profile: (await obs.call('GetProfileList')).currentProfileName,
    collection: (await obs.call('GetSceneCollectionList')).currentSceneCollectionName
  }
  if (own.profile === 'IVAO TRS') throw new Error('Put OBS on your own profile first')
  const ownParams = await profileParams(obs)
  console.log('trainer profile:', own.profile, '/', own.collection, JSON.stringify(ownParams))

  let run = startApp()
  let page = await connect()
  let folderName = null
  try {
    await waitFor(page, (s) => s.obs.status === 'connected' && !s.busy)

    // 1. The trainer switches OBS back to their own profile while the app is idle.
    await obs.call('SetCurrentSceneCollection', { sceneCollectionName: own.collection })
    await obs.call('SetCurrentProfile', { profileName: own.profile })
    await sleep(1500)
    await page.evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Recovery',trainerVid:'',date:'2026-09-23'})`
    )
    let s = await waitFor(page, (st) => st.recording !== null)
    folderName = s.recording?.folderName
    const during = (await obs.call('GetProfileList')).currentProfileName
    check('recording started after the trainer switched profile', !!folderName, folderName)
    check('the app switched back to its own profile to record', during === 'IVAO TRS', during)

    // 2. Pause in OBS: marker times must not advance while paused.
    await sleep(2000)
    await obs.call('PauseRecord')
    await sleep(3000)
    await obs.call('ResumeRecord')
    await sleep(1000)
    await page.evaluate(`window.api.command('addMarker')`)
    s = await waitFor(page, (st) => st.recording?.markers.length === 1)
    const pressed = s.recording.markers[0].pressedAtMs
    const obsTime = (await obs.call('GetRecordStatus')).outputDuration
    check(
      'marker time excludes the pause',
      Math.abs(pressed - obsTime) < 1500,
      `marker ${pressed} ms, OBS ${obsTime} ms`
    )

    // 3. The app dies while OBS keeps recording.
    run.app.kill()
    await run.exited
    page.close()
    await sleep(1500)
    check('OBS keeps recording after the app died', (await obs.call('GetRecordStatus')).outputActive)
    run = startApp()
    page = await connect()
    s = await waitFor(page, (st) => st.recording !== null)
    check('restarted app continues the same session', s.recording?.folderName === folderName, s.recording?.folderName)
    check('markers from before are kept', s.recording?.markers.length === 1)
    await sleep(1500)
    await page.evaluate(`window.api.command('addMarker')`)
    s = await waitFor(page, (st) => st.recording?.markers.length === 2)
    check(
      'a new marker continues the numbering and the clock',
      s.recording?.markers[1]?.number === 2 && s.recording.markers[1].pressedAtMs > pressed,
      JSON.stringify(s.recording?.markers.map((m) => [m.number, m.pressedAtMs]))
    )
    await page.evaluate('window.api.stopSession()')
    await waitFor(page, (st) => st.recording === null)
    const file = JSON.parse(readFileSync(join(SESSIONS, folderName, 'session.json'), 'utf8'))
    check(
      'recording moved into the session folder',
      file.recording?.file === 'recording.mp4' && existsSync(join(SESSIONS, folderName, 'recording.mp4')),
      JSON.stringify(file.recording)
    )
    check('OBS stopped recording', !(await obs.call('GetRecordStatus')).outputActive)

    // 4. Quit: OBS goes back to the trainer's profile, which was never changed.
    await page.evaluate('window.close()').catch(() => undefined)
    page.close()
    const exited = await Promise.race([run.exited.then(() => true), sleep(15000).then(() => false)])
    check('app quits by itself', exited)
    await sleep(500)
    const after = {
      profile: (await obs.call('GetProfileList')).currentProfileName,
      collection: (await obs.call('GetSceneCollectionList')).currentSceneCollectionName
    }
    check(
      "OBS is back on the trainer's profile",
      after.profile === own.profile && after.collection === own.collection,
      JSON.stringify(after)
    )
    const afterParams = await profileParams(obs)
    check(
      "the trainer's profile settings were not changed",
      JSON.stringify(afterParams) === JSON.stringify(ownParams),
      JSON.stringify(afterParams)
    )
  } finally {
    // Safety net: never leave a test recording running or OBS on the app's profile.
    const status = await obs.call('GetRecordStatus').catch(() => null)
    const dir = (await obs.call('GetRecordDirectory').catch(() => null))?.recordDirectory ?? ''
    if (status?.outputActive && folderName && dir.includes(folderName))
      await obs.call('StopRecord').catch(() => undefined)
    run.app.kill()
    await sleep(1000)
    if ((await obs.call('GetProfileList')).currentProfileName === 'IVAO TRS') {
      await obs.call('SetCurrentSceneCollection', { sceneCollectionName: own.collection }).catch(() => undefined)
      await obs.call('SetCurrentProfile', { profileName: own.profile }).catch(() => undefined)
    }
    await obs.disconnect()
    if (folderName) rmSync(join(SESSIONS, folderName), { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('FAILED', error)
  process.exitCode = 1
})
