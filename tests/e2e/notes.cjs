// End-to-end test of voice notes against the real OBS and microphone, in an
// isolated app instance (own settings and sessions folder in %TEMP%; the
// trainer's settings are only read, for the monitor, audio sources and
// microphone; the "base" model is hard-linked): push-to-talk from the hotkey,
// OBS microphones muted while dictating, a note joins a recent marker or makes
// one, a tap is ignored, a hotkey still works with another modifier held, and
// a real recording of speech is transcribed.
// Keys: F13 (marker), F16 (voice note) and Left Shift, sent to the whole PC.
// Needs: the app closed (one app per OBS), OBS idle, TRS_OBS_PASSWORD set.
const { copyFileSync, existsSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { OBSWebSocket } = require('obs-websocket-js')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const {
  check,
  isolatedSettings,
  launch,
  linkModels,
  obsPassword,
  realSettings,
  report,
  sleep,
  waitForState
} = require('./lib.cjs')

const PASSWORD = obsPassword()
const SPEECH_WAV = join(__dirname, 'fixtures', 'note-en.wav')
const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })
const tap = async (code, ms = 60) => {
  uIOhook.keyToggle(code, 'down')
  await sleep(ms)
  uIOhook.keyToggle(code, 'up')
}

async function main() {
  const real = realSettings()
  const settings = isolatedSettings('notes', {
    capture: { ...real.capture, hiddenWindows: [] },
    markers: {
      preRollSeconds: 3,
      hotkeys: { marker: key(UiohookKey.F13, 'F13'), range: null, voiceNote: key(UiohookKey.F16, 'F16') }
    },
    notes: {
      ...real.notes,
      model: 'base',
      language: 'en',
      transcribe: true,
      attachWindowSeconds: 60,
      holdHotkeyFromButtons: false
    }
  })
  let models = []
  const run = await launch({ name: 'notes', port: 9333, settings, prepare: (dir) => (models = linkModels(dir)) })
  const { evaluate } = run
  const getState = () => evaluate('window.api.getState()')
  const obs = new OBSWebSocket()
  let folder = null
  try {
    await evaluate(
      `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(PASSWORD)} }).catch((e) => e.message)`
    )
    let state = await waitForState(evaluate, (s) => s.obs.status === 'connected' && !s.busy)
    if (state.obs.status !== 'connected') throw new Error(`OBS not connected: ${state.obs.error}`)
    if (!models.includes('base')) {
      // First run on this PC: through the app, with its progress.
      await evaluate(`window.api.downloadModel('base')`)
    }
    await obs.connect('ws://127.0.0.1:4455', PASSWORD, { rpcVersion: 1 })
    const micSources = state.capture.audioSources.filter((s) => s.muteDuringNotes && !s.muted)
    const micMuted = async () =>
      Promise.all(
        micSources.map(async (s) => (await obs.call('GetInputMute', { inputName: `TRS Audio ${s.id}` })).inputMuted)
      )

    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Automated test',trainerVid:'',date:'2026-09-23'}, true)`
    )
    state = await waitForState(evaluate, (s) => s.recording !== null)
    folder = join(settings.sessionsDir, state.recording.folderName)
    uIOhook.start()
    await sleep(3000)
    await tap(UiohookKey.F13) // marker #1
    await sleep(1500)
    state = await getState()
    check('a marker from the hotkey', state.recording.markers.length === 1)

    // A voice note on the recent marker, microphones muted in OBS while it is held.
    const before = await micMuted()
    uIOhook.keyToggle(UiohookKey.F16, 'down')
    await sleep(1200)
    const during = await micMuted()
    state = await getState()
    check('dictating on the recent marker', state.recording.dictatingMarkerId === state.recording.markers[0].id)
    check(
      'OBS microphones muted while dictating',
      micSources.length === 0 || during.every(Boolean),
      `${micSources.length} sources: ${during}`
    )
    await sleep(800)
    uIOhook.keyToggle(UiohookKey.F16, 'up')
    await sleep(1500)
    const after = await micMuted()
    check('and unmuted after', JSON.stringify(after) === JSON.stringify(before), `${after}`)

    // No recent marker: the note makes one.
    await evaluate(`window.api.saveNoteSettings({ attachWindowSeconds: 0 })`)
    await tap(UiohookKey.F16, 1500)
    await sleep(1500)
    // A quick tap is ignored, and leaves no marker behind.
    await tap(UiohookKey.F16, 80)
    await sleep(1500)
    state = await getState()
    check(
      'a note with no recent marker makes one; a tap leaves nothing',
      state.recording.markers.length === 2 && state.recording.markers.map((m) => m.notes.length).join(',') === '1,1',
      state.recording.markers.map((m) => `#${m.number}:${m.notes.length}`).join(' ')
    )

    // A hotkey still works while another modifier is held (the trainer talking on a push-to-talk key).
    uIOhook.keyToggle(UiohookKey.Shift, 'down')
    await tap(UiohookKey.F13)
    uIOhook.keyToggle(UiohookKey.Shift, 'up')
    await sleep(1500)
    state = await getState()
    check(
      'the marker hotkey works with a modifier held',
      state.recording.markers.length === 3,
      `${state.recording.markers.length} markers`
    )
    uIOhook.stop()

    // Real speech through the transcription pipeline.
    const first = state.recording.markers[0]
    const note = first.notes[0]
    copyFileSync(SPEECH_WAV, join(folder, note.audio))
    await evaluate(
      `window.api.command('retranscribeNote', ${JSON.stringify(state.recording.folderName)}, ${JSON.stringify(first.id)}, ${JSON.stringify(note.id)})`
    )
    state = await waitForState(
      evaluate,
      (s) => ['done', 'failed'].includes(s.recording?.markers[0].notes[0].status),
      90_000
    )
    const transcribed = state.recording.markers[0].notes[0]
    check(
      'speech transcribed',
      transcribed.status === 'done' && /QNH/i.test(transcribed.transcript ?? ''),
      JSON.stringify(transcribed.transcript)
    )

    await evaluate('window.api.stopSession()')
    state = await waitForState(evaluate, (s) => s.recording === null)
    const file = JSON.parse(readFileSync(join(folder, 'session.json'), 'utf8'))
    const notes = file.markers.flatMap((m) => m.notes)
    check('every note has its audio file', notes.length === 2 && notes.every((n) => existsSync(join(folder, n.audio))))
    check(
      'the session is saved as ended, with its video',
      Boolean(file.recording?.endedAt) && existsSync(join(folder, 'recording.mp4'))
    )
  } finally {
    uIOhook.stop()
    await evaluate('window.api.getState().then((s) => s.recording && window.api.stopSession())').catch(() => undefined)
    await obs.disconnect().catch(() => undefined)
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
