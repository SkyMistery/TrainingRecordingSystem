// End-to-end test of markers against the real OBS, in an isolated app instance
// (own settings and sessions folder in %TEMP%; the trainer's settings are only
// read, for the recorded monitor): pre-roll, screenshots, a category hotkey,
// ranges, no extra markers from key auto-repeat, and the trs-media scheme.
// Keys: F13 (marker), F14 (range), F15 (category), sent to the whole PC.
// Needs: the app closed (one app per OBS), OBS idle, TRS_OBS_PASSWORD set.
const { existsSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { check, isolatedSettings, launch, obsPassword, realSettings, report, sleep, waitForState } = require('./lib.cjs')

const PASSWORD = obsPassword()
const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })
const tap = async (code) => {
  uIOhook.keyToggle(code, 'down')
  await sleep(60)
  uIOhook.keyToggle(code, 'up')
  await sleep(400)
}

async function main() {
  const real = realSettings()
  const settings = isolatedSettings('markers', {
    capture: { ...real.capture, hiddenWindows: [] },
    markers: {
      preRollSeconds: 3,
      hotkeys: { marker: key(UiohookKey.F13, 'F13'), range: key(UiohookKey.F14, 'F14'), voiceNote: null },
      categories: [
        { id: 'phraseology', name: 'Phraseology', color: '#1342e4', hotkey: null },
        { id: 'separation', name: 'Separation', color: '#e93434', hotkey: key(UiohookKey.F15, 'F15') }
      ]
    }
  })
  const run = await launch({ name: 'markers', port: 9332, settings })
  const { evaluate } = run
  try {
    await evaluate(
      `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(PASSWORD)} }).catch((e) => e.message)`
    )
    let state = await waitForState(evaluate, (s) => s.obs.status === 'connected' && !s.busy)
    if (state.obs.status !== 'connected') throw new Error(`OBS not connected: ${state.obs.error}`)
    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Automated test',trainerVid:'',date:'2026-09-23'}, true)`
    )
    state = await waitForState(evaluate, (s) => s.recording !== null)
    const folderName = state.recording.folderName
    const folder = join(settings.sessionsDir, folderName)
    uIOhook.start()
    await sleep(4500)
    await tap(UiohookKey.F13) // marker at ~4.5 s
    await sleep(1000)
    await tap(UiohookKey.F15) // category "separation" on it
    await sleep(1000)
    await tap(UiohookKey.F14) // range start
    await sleep(2500)
    await tap(UiohookKey.F14) // range end
    await sleep(500)
    // Auto-repeat must not create extra markers: hold F13 for 1.2 s.
    uIOhook.keyToggle(UiohookKey.F13, 'down')
    await sleep(1200)
    uIOhook.keyToggle(UiohookKey.F13, 'up')
    await sleep(1500)
    uIOhook.stop()
    state = await getMarkers()
    async function getMarkers() {
      return evaluate('window.api.getState()')
    }
    const markers = state.recording.markers
    check(
      'three markers: point, range, point (no extras from auto-repeat)',
      markers.map((m) => m.kind).join(',') === 'point,range,point',
      markers.map((m) => m.kind).join(',')
    )
    const first = markers[0]
    check(
      'pre-roll: placed 3 s before the key press',
      first && first.pressedAtMs - first.timeMs === 3000 && first.pressedAtMs > 3500,
      `${first?.timeMs} / ${first?.pressedAtMs}`
    )
    check(
      'the category hotkey tags the latest marker',
      first?.categoryIds.join(',') === 'separation',
      first?.categoryIds.join(',')
    )
    const range = markers[1]
    check(
      'the range has an end about 2.5 s later',
      range && range.endMs !== null && range.endMs - range.pressedAtMs > 2000 && range.endMs - range.pressedAtMs < 4000,
      `${range?.pressedAtMs} → ${range?.endMs}`
    )
    await evaluate('window.api.stopSession()')
    await waitForState(evaluate, (s) => s.recording === null)

    const file = JSON.parse(readFileSync(join(folder, 'session.json'), 'utf8'))
    check(
      'screenshots saved for every marker',
      file.markers.every((m) => m.screenshot && existsSync(join(folder, m.screenshot))),
      file.markers.map((m) => m.screenshot).join(', ')
    )
    const img = await evaluate(
      `new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = 'trs-media://sessions/' + encodeURIComponent(${JSON.stringify(folderName)}) + '/' + encodeURIComponent(${JSON.stringify(folderName + '_screen')}) + '/m-0001.png' })`
    )
    check('a screenshot loads through trs-media', img > 0, String(img))
    const escape = await evaluate(
      `new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = 'trs-media://sessions/..%2F..%2F..%2FDesktop%2Fx.png' })`
    )
    check('a path out of the sessions folder is blocked', escape === 'blocked', escape)
  } finally {
    uIOhook.stop()
    await evaluate('window.api.getState().then((s) => s.recording && window.api.stopSession())').catch(() => undefined)
    await run.close()
    rmSync(settings.sessionsDir, { recursive: true, force: true })
    rmSync(run.userData, { recursive: true, force: true })
  }
  report()
}
main().catch((e) => {
  console.error('[e2e] FAILED', e)
  process.exit(1)
})
