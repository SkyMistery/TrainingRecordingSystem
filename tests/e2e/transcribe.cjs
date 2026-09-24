// End-to-end test of offline transcription when the paths contain characters
// outside the Windows ANSI code page (e.g. a Greek user name): whisper-cli must
// still find the model and the note. Isolated app instance, no OBS needed; it
// uses the "base" model already downloaded by the app (hard-linked, not copied).
const { spawn } = require('node:child_process')
const {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const USERDATA = join(tmpdir(), 'trs-e2e-transcribe Νίκος')
const SESSIONS = join(tmpdir(), 'trs-e2e-transcribe Ελληνικά')
const MODEL = join(process.env.APPDATA, 'Training Recording System', 'models', 'ggml-base.bin')
const FOLDER = join(SESSIONS, '2026-09-24_000000_E2E_TRANSCRIBE')
const PORT = 9336
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

function setup() {
  rmSync(USERDATA, { recursive: true, force: true })
  rmSync(SESSIONS, { recursive: true, force: true })
  mkdirSync(join(USERDATA, 'models'), { recursive: true })
  try {
    linkSync(MODEL, join(USERDATA, 'models', 'ggml-base.bin'))
  } catch {
    copyFileSync(MODEL, join(USERDATA, 'models', 'ggml-base.bin'))
  }
  writeFileSync(
    join(USERDATA, 'settings.json'),
    JSON.stringify({
      sessionsDir: SESSIONS,
      notes: { model: 'base', language: 'en', transcribe: true },
      // Isolated test profile: the terms dialog would cover the page.
      termsAccepted: { version: 1, acceptedAt: new Date().toISOString() },
      companion: { enabled: false, lan: false, port: 17648 },
      obs: { host: '127.0.0.1', port: 1, passwordEncrypted: null }
    })
  )
  mkdirSync(join(FOLDER, 'notes'), { recursive: true })
  copyFileSync(join(__dirname, 'fixtures', 'note-en.wav'), join(FOLDER, 'notes', 'n-0001.wav'))
  const note = {
    id: 'note1',
    audio: 'notes/n-0001.wav',
    durationMs: 9000,
    recordedAtMs: 5000,
    transcript: null,
    status: 'pending',
    text: null
  }
  const session = {
    schemaVersion: 1,
    id: 'e2e-transcribe',
    createdAt: new Date().toISOString(),
    metadata: {
      traineeVid: '000000',
      traineeName: 'E2E test',
      position: 'LIRF_APP',
      trainingType: 'Training',
      trainerVid: '',
      date: '2026-09-24'
    },
    recording: null,
    markers: [
      {
        id: 'm1',
        number: 1,
        kind: 'point',
        timeMs: 1000,
        pressedAtMs: 1000,
        endMs: null,
        categoryIds: [],
        screenshot: null,
        createdAt: new Date().toISOString(),
        notes: [note]
      }
    ]
  }
  writeFileSync(join(FOLDER, 'session.json'), JSON.stringify(session, null, 2))
}

async function main() {
  if (!existsSync(MODEL)) {
    console.log('SKIP  the "base" model is not installed: download it once from Setup → Voice notes')
    return
  }
  setup()
  // Pending notes are transcribed again at startup.
  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`],
    { cwd: ROOT }
  )
  try {
    let note = null
    for (let i = 0; i < 120; i++) {
      await sleep(1000)
      try {
        note = JSON.parse(readFileSync(join(FOLDER, 'session.json'), 'utf8')).markers[0].notes[0]
      } catch {
        continue
      }
      if (note.status === 'done' || note.status === 'failed') break
    }
    check('note transcribed with non-ASCII paths', note?.status === 'done', note?.status)
    check('transcript has the words spoken', /QNH/i.test(note?.transcript ?? ''), note?.transcript?.slice(0, 60))
    const leftovers = readdirSync(join(USERDATA, 'models')).filter((name) => name.startsWith('note-'))
    check('no temporary copies left in the models folder', leftovers.length === 0, leftovers.join(', '))
  } finally {
    app.kill()
    await sleep(1000)
    rmSync(SESSIONS, { recursive: true, force: true })
    rmSync(USERDATA, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
