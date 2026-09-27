// Voice notes with a stale microphone id, in an isolated app instance (own
// settings and sessions folder in %TEMP%; the trainer's settings are only
// read), against the real OBS and microphone. Also checks that a note started
// from a button holds the voice-note key (Discord push-to-mute) only when
// "holdHotkeyFromButtons" is on, without starting a second note.
// Keys: F16 (voice note), sent to the whole PC.
// Needs: the app closed (one app per OBS), OBS idle, TRS_OBS_PASSWORD set.
const { existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { check, isolatedSettings, launch, obsPassword, realSettings, report, sleep, waitForState } = require('./lib.cjs')

const PASSWORD = obsPassword()
const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })
const real = realSettings()

async function runCase(name, notes) {
  const holdKey = notes.holdHotkeyFromButtons
  const settings = isolatedSettings('mic', {
    capture: { ...real.capture, hiddenWindows: [] },
    markers: {
      preRollSeconds: 3,
      hotkeys: {
        marker: key(UiohookKey.F13, 'F13'),
        range: key(UiohookKey.F14, 'F14'),
        voiceNote: key(UiohookKey.F16, 'F16')
      }
    },
    notes: { ...real.notes, ...notes, transcribe: false }
  })
  const run = await launch({ name: 'mic', port: 9335, settings })
  const { evaluate } = run
  try {
    await evaluate(
      `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(PASSWORD)} }).catch((e) => e.message)`
    )
    let state = await waitForState(evaluate, (s) => s.obs.status === 'connected' && !s.busy)
    if (state.obs.status !== 'connected') throw new Error(`OBS not connected: ${state.obs.error}`)
    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Microphone test',trainerVid:'',date:'2026-09-24'}, true)`
    )
    state = await waitForState(evaluate, (s) => s.recording !== null)
    const folder = join(settings.sessionsDir, state.recording.folderName)
    await sleep(2500)
    uIOhook.start()
    uIOhook.keyToggle(UiohookKey.F16, 'down')
    await sleep(1500)
    uIOhook.keyToggle(UiohookKey.F16, 'up')
    await sleep(2000)
    // Also through the UI command, like the "Hold to dictate" button.
    const keyEvents = []
    const onDown = (e) => e.keycode === UiohookKey.F16 && keyEvents.push('down')
    const onUp = (e) => e.keycode === UiohookKey.F16 && keyEvents.push('up')
    uIOhook.on('keydown', onDown)
    uIOhook.on('keyup', onUp)
    await evaluate(`window.api.command('startNote')`)
    await sleep(1500)
    const heldDuringNote = keyEvents.join(',')
    await evaluate(`window.api.command('stopNote')`)
    await sleep(2000)
    uIOhook.off('keydown', onDown)
    uIOhook.off('keyup', onUp)
    uIOhook.stop()
    const expected = holdKey ? ['down', 'down,up'] : ['', '']
    check(
      `${name}: button note ${holdKey ? 'holds' : 'does not press'} the voice-note key`,
      heldDuringNote === expected[0] && keyEvents.join(',') === expected[1],
      `during: [${heldDuringNote}], after: [${keyEvents.join(',')}]`
    )
    state = await evaluate('window.api.getState()')
    const saved = state.recording.markers.flatMap((m) => m.notes)
    check(
      `${name}: both voice notes saved (hotkey and button)`,
      saved.length === 2 && saved.every((n) => existsSync(join(folder, n.audio))),
      `${saved.length} notes`
    )
    return { microphoneError: state.microphoneError }
  } finally {
    uIOhook.stop()
    // Only this instance's own session: it records into its own sessions folder.
    await evaluate('window.api.getState().then((s) => s.recording && window.api.stopSession())').catch(() => undefined)
    await run.close()
    rmSync(settings.sessionsDir, { recursive: true, force: true })
    rmSync(run.userData, { recursive: true, force: true })
  }
}

;(async () => {
  const first = await runCase('stale id, same name', {
    micDeviceId: 'stale-device-id-from-another-origin',
    micLabel: real.notes.micLabel,
    holdHotkeyFromButtons: true
  })
  check('stale id, same name: no microphone warning', first.microphoneError === null, String(first.microphoneError))
  const second = await runCase('unknown microphone', {
    micDeviceId: 'stale-device-id',
    micLabel: 'A microphone that does not exist',
    holdHotkeyFromButtons: false
  })
  check(
    'unknown microphone: falls back and says so',
    /not found/.test(second.microphoneError ?? ''),
    String(second.microphoneError)
  )
  report()
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
