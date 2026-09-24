// End-to-end test of the sessions list actions: note counts, transcribing a
// session's notes again, deleting a session (to the Recycle Bin). Runs an
// isolated app instance with its own sessions folder in %TEMP%: no OBS needed.
const { spawn } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const USERDATA = join(tmpdir(), 'trs-e2e-sessions')
const SESSIONS = join(tmpdir(), 'trs-e2e-sessions-folder')
const PORT = 9335
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

function makeSession(name, notes) {
  const folder = join(SESSIONS, name)
  mkdirSync(join(folder, 'notes'), { recursive: true })
  const markerNotes = []
  for (let i = 1; i <= notes; i++) {
    const audio = `notes/n-000${i}.wav`
    copyFileSync(join(__dirname, 'fixtures', 'note-en.wav'), join(folder, audio))
    markerNotes.push({
      id: `note${i}`,
      audio,
      durationMs: 2000,
      recordedAtMs: 5000,
      transcript: 'old transcript',
      status: 'done',
      text: i === 1 ? 'edited by the trainer' : null
    })
  }
  const session = {
    schemaVersion: 1,
    id: `e2e-${name}`,
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
        categoryId: null,
        screenshot: null,
        createdAt: new Date().toISOString(),
        notes: markerNotes
      }
    ]
  }
  writeFileSync(join(folder, 'session.json'), JSON.stringify(session, null, 2))
  return folder
}

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const target = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'))
      if (target) return target
    } catch {}
    await sleep(500)
  }
  throw new Error('main window not found')
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const n = ++id
      const handler = (message) => {
        const data = JSON.parse(message.data)
        if (data.id !== n) return
        ws.removeEventListener('message', handler)
        const result = data.result
        resolve(result.exceptionDetails ? { error: result.exceptionDetails.exception?.description } : result.result.value)
      }
      ws.addEventListener('message', handler)
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  return { evaluate, close: () => ws.close() }
}

async function main() {
  rmSync(SESSIONS, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
  writeFileSync(
    join(USERDATA, 'settings.json'),
    JSON.stringify({
      sessionsDir: SESSIONS,
      companion: { enabled: false, lan: false, port: 17647 },
      obs: { host: '127.0.0.1', port: 1, passwordEncrypted: null }
    })
  )
  const keep = makeSession('2026-09-24_1000_000000_E2E_KEEP', 2)
  const remove = makeSession('2026-09-24_1100_000000_E2E_DELETE', 1)

  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`],
    { cwd: ROOT }
  )
  let page
  try {
    page = await connect(await cdpTarget())
    await sleep(1500)

    const state = await page.evaluate('window.api.getState()')
    check('state reports the sessions folder', state.sessionsDir === SESSIONS, state.sessionsDir)

    const list = await page.evaluate('window.api.listSessions()')
    const counts = Object.fromEntries(list.map((s) => [s.folderName, s.noteCount]))
    check(
      'sessions list counts voice notes',
      counts['2026-09-24_1000_000000_E2E_KEEP'] === 2 && counts['2026-09-24_1100_000000_E2E_DELETE'] === 1,
      JSON.stringify(counts)
    )

    const retranscribe = await page.evaluate(`window.api.retranscribeSession('2026-09-24_1000_000000_E2E_KEEP')`)
    check('retranscribe accepted', retranscribe?.error === undefined, retranscribe?.error)
    await sleep(1500)
    const kept = JSON.parse(readFileSync(join(keep, 'session.json'), 'utf8'))
    const notes = kept.markers[0].notes
    check(
      'every note left "done" and was queued again',
      notes.every((note) => note.status !== 'done' || note.transcript !== 'old transcript'),
      notes.map((note) => note.status).join(', ')
    )
    check('the trainer’s edited text is kept', notes[0].text === 'edited by the trainer')

    const escape = await page.evaluate(`window.api.deleteSession('..').then(() => 'deleted', (e) => e.message)`)
    check('deleting outside the sessions folder is refused', escape !== 'deleted', escape)
    const unknown = await page.evaluate(`window.api.deleteSession('a\\\\b').then(() => 'deleted', (e) => e.message)`)
    check('deleting a path is refused', unknown !== 'deleted', unknown)

    const deleted = await page.evaluate(
      `window.api.deleteSession('2026-09-24_1100_000000_E2E_DELETE').then(() => 'ok', (e) => e.message)`
    )
    check('delete succeeds', deleted === 'ok', deleted)
    check('the folder is gone (Recycle Bin)', !existsSync(remove))
    check('the other session is untouched', existsSync(join(keep, 'session.json')))
    const after = await page.evaluate('window.api.listSessions()')
    check(
      'the list no longer shows it',
      after.length === 1 && after[0].folderName === '2026-09-24_1000_000000_E2E_KEEP',
      after.map((s) => s.folderName).join(', ')
    )
  } finally {
    page?.close()
    app.kill()
    await sleep(1000)
    rmSync(SESSIONS, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
