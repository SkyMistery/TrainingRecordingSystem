// End-to-end test of M3 (voice notes + transcription) against the real app, OBS
// and microphone, driven through CDP (window.api) and synthetic F13/F16 keys.
const { spawn } = require('node:child_process')
const { readFileSync, existsSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const TTS_WAV = join(__dirname, 'fixtures', 'note-en.wav')
const OBS_PASSWORD = process.argv[2]
const { uIOhook } = require(`${ROOT}/node_modules/uiohook-napi`)
const { OBSWebSocket } = require(`${ROOT}/node_modules/obs-websocket-js`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[e2e]', ...a)

async function main() {
  const app = spawn(`${ROOT}/node_modules/electron/dist/electron.exe`, ['.', '--remote-debugging-port=9333'], {
    cwd: ROOT
  })
  app.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  app.stderr.on('data', (d) => {
    const t = String(d)
    if (!/cache|DevTools|^s*$/.test(t)) process.stdout.write('[app!] ' + t)
  })
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json')).json()
      target = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'))
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
  const getState = () => evaluate('window.api.getState()')

  let state
  for (let i = 0; i < 30; i++) {
    state = await getState()
    if (state.obs.status === 'connected' && !state.busy) break
    await sleep(500)
  }
  log(
    'OBS',
    state.obs.status,
    '| whisper available:',
    state.transcription.available,
    '| models:',
    state.transcription.installedModels
  )

  // 1. Model download through the app, with progress.
  if (!state.transcription.installedModels.includes('base')) {
    const download = evaluate(`window.api.downloadModel('base')`)
    let maxProgress = 0
    while (true) {
      await sleep(1000)
      const t = (await getState()).transcription
      if (t.download) maxProgress = Math.max(maxProgress, t.download.receivedBytes)
      if (!t.download) break
    }
    await download
    log('downloaded base model, progress seen up to', Math.round(maxProgress / 1e6), 'MB')
  }
  state = await getState()
  log('installed models:', state.transcription.installedModels)

  const originalMarkers = state.markerSettings
  const originalNotes = state.noteSettings
  const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })
  await evaluate(
    `window.api.saveMarkerSettings(${JSON.stringify({ ...originalMarkers, preRollSeconds: 3, hotkeys: { ...originalMarkers.hotkeys, marker: key(91, 'F13'), voiceNote: key(99, 'F16') } })})`
  )
  await evaluate(
    `window.api.saveNoteSettings(${JSON.stringify({ ...originalNotes, model: 'base', language: 'en', attachWindowSeconds: 60 })})`
  )

  const obs = new OBSWebSocket()
  await obs.connect('ws://127.0.0.1:4455', OBS_PASSWORD, { rpcVersion: 1 })
  const micSources = state.capture.audioSources.filter((s) => s.muteDuringNotes && !s.muted)
  const micMuted = async () =>
    Promise.all(
      micSources.map(async (s) => (await obs.call('GetInputMute', { inputName: `TRS Audio ${s.id}` })).inputMuted)
    )

  let folder
  try {
    await evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Automated test',trainerVid:'',date:'2026-09-23'})`
    )
    log('recording started; mic sources muted before note:', await micMuted())
    uIOhook.start()
    await sleep(3000)
    uIOhook.keyToggle(91, 'down')
    await sleep(60)
    uIOhook.keyToggle(91, 'up') // marker #1
    await sleep(1500)

    // 2. Voice note on the recent marker, mic muted in OBS while held.
    uIOhook.keyToggle(99, 'down')
    await sleep(1200)
    const during = await micMuted()
    state = await getState()
    log(
      'while dictating: mic muted in OBS =',
      during,
      '| dictating marker =',
      state.recording.dictatingMarkerId === state.recording.markers[0]?.id ? '#1' : state.recording.dictatingMarkerId
    )
    await sleep(800)
    uIOhook.keyToggle(99, 'up')
    await sleep(1500)
    log('after release: mic muted in OBS =', await micMuted())

    // 3. A note with no recent marker creates one.
    await evaluate(
      `window.api.saveNoteSettings(${JSON.stringify({ ...originalNotes, model: 'base', language: 'en', attachWindowSeconds: 0 })})`
    )
    uIOhook.keyToggle(99, 'down')
    await sleep(1500)
    uIOhook.keyToggle(99, 'up')
    await sleep(1500)
    // 4. A quick tap is ignored.
    uIOhook.keyToggle(99, 'down')
    await sleep(80)
    uIOhook.keyToggle(99, 'up')
    await sleep(1500)
    uIOhook.stop()

    state = await getState()
    folder = join(`${process.env.USERPROFILE}/Documents/IVAO TRS/Sessions`, state.recording.folderName)
    const markers = state.recording.markers
    log('markers:', markers.map((m) => `#${m.number} notes=${m.notes.length}`).join(' | '))

    // 5. Real speech through the transcription pipeline.
    const first = markers[0].notes[0]
    copyFileSync(TTS_WAV, join(folder, first.audio))
    await evaluate(
      `window.api.command('retranscribeNote', ${JSON.stringify(state.recording.folderName)}, ${JSON.stringify(markers[0].id)}, ${JSON.stringify(first.id)})`
    )
    for (let i = 0; i < 60; i++) {
      await sleep(1000)
      const note = (await getState()).recording.markers[0].notes[0]
      if (note.status === 'done' || note.status === 'failed') {
        log(`transcription ${note.status} after ~${i + 1}s:`, JSON.stringify(note.transcript))
        break
      }
    }
    await evaluate('window.api.stopSession()')
    log('recording stopped')
  } finally {
    if ((await getState()).recording) await evaluate('window.api.stopSession()').catch(() => undefined)
    await evaluate(`window.api.saveMarkerSettings(${JSON.stringify(originalMarkers)})`)
    await evaluate(`window.api.saveNoteSettings(${JSON.stringify(originalNotes)})`)
    log('settings restored')
    await obs.disconnect()
  }

  const file = JSON.parse(readFileSync(join(folder, 'session.json'), 'utf8'))
  for (const m of file.markers) {
    for (const n of m.notes) {
      log(
        `marker #${m.number} note ${n.audio} ${n.durationMs}ms file=${existsSync(join(folder, n.audio)) ? 'OK' : 'MISSING'} status=${n.status} transcript=${JSON.stringify(n.transcript)}`
      )
    }
  }
  await evaluate('window.close()').catch(() => undefined)
  ws.close()
  const closing = Date.now()
  await new Promise((r) => {
    const timer = setTimeout(() => {
      log('app did NOT exit: killing it')
      app.kill()
      r()
    }, 8000)
    app.on('exit', () => {
      clearTimeout(timer)
      log('app exited by itself after', Date.now() - closing, 'ms')
      r()
    })
  })
  log('app closed; session folder', folder)
}
main().catch((e) => {
  console.error('[e2e] FAILED', e)
  process.exit(1)
})
