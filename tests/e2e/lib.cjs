// Shared helpers for the end-to-end scripts: an isolated app instance driven
// through the Chrome DevTools Protocol, checks and the OBS password.
const { spawn } = require('node:child_process')
const { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '../..').split('\\').join('/')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** A CDP call that never answers (app gone) must not hang the script. */
const EVALUATE_TIMEOUT_MS = 60_000
/** The terms version the app asks for: isolated settings accept it, or its dialog covers the page. */
const TERMS_VERSION = Number(/TERMS_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/terms.ts'), 'utf8'))[1])

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  return ok
}
/** Prints the outcome and sets the exit code: 1 if anything failed. */
function report() {
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed.')
  process.exitCode = failures ? 1 : 0
}

/**
 * The OBS WebSocket password, from the environment only: an argument would end
 * up in the shell history and in the process list. Never stored anywhere.
 */
function obsPassword() {
  const password = process.env.TRS_OBS_PASSWORD
  if (!password) {
    console.error('Set TRS_OBS_PASSWORD for this run (OBS → Tools → WebSocket Server Settings).')
    process.exit(2)
  }
  return password
}

/** The trainer's settings, read only (never written by the tests). */
function realSettings() {
  return JSON.parse(readFileSync(join(process.env.APPDATA, 'Training Recording System', 'settings.json'), 'utf8'))
}

/** Settings of an isolated instance: terms accepted, no Companion, no status window, sessions in %TEMP%. */
function isolatedSettings(name, extra = {}) {
  const sessionsDir = join(tmpdir(), `trs-e2e-${name}-sessions`)
  mkdirSync(sessionsDir, { recursive: true })
  return {
    termsAccepted: { version: TERMS_VERSION, acceptedAt: new Date().toISOString() },
    sessionsDir,
    companion: { enabled: false, lan: false, port: 17600 + Math.floor(Math.random() * 40), pttKeys: {} },
    // Isolated tests never reach the trainer's OBS unless they connect on purpose.
    obs: { host: '127.0.0.1', port: 1, passwordEncrypted: null },
    ...extra,
    markers: { statusWindow: false, sound: false, ...extra.markers }
  }
}

/**
 * Starts the app (development build in out/) with its own settings folder and
 * returns a CDP handle on the main window. `settings` are written first.
 * `exited` resolves when the process ends.
 */
async function launch({ name, port, settings, args = [], fresh = true, prepare }) {
  const userData = join(tmpdir(), `trs-e2e-${name}`)
  // fresh: false starts the same instance again (a restart after a crash), settings as it left them.
  if (fresh) {
    rmSync(userData, { recursive: true, force: true })
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
    prepare?.(userData)
  }
  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...args],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  app.stdout.on('data', (chunk) => (output += chunk))
  app.stderr.on('data', (chunk) => (output += chunk))
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.url.endsWith('index.html'))
    } catch {}
  }
  if (!target) {
    app.kill()
    throw new Error('the app did not start')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, reject) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', reject)
  })
  let id = 0
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage)
        reject(new Error(`no answer: ${expression.slice(0, 80)}`))
      }, EVALUATE_TIMEOUT_MS)
      const onMessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== n) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.exception?.description))
        else resolve(d.result?.result?.value)
      }
      ws.addEventListener('message', onMessage)
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  /** Closes the app normally (OBS gets its profile back); killed only if it doesn't exit. */
  const close = async () => {
    await evaluate('window.close()').catch(() => undefined)
    ws.close()
    await new Promise((r) => {
      if (app.exitCode !== null) return r()
      const timer = setTimeout(() => {
        console.log('[e2e] app did NOT exit: killing it')
        app.kill()
        r()
      }, 30_000)
      app.on('exit', () => {
        clearTimeout(timer)
        r()
      })
    })
  }
  const exited = new Promise((r) => app.on('exit', r))
  return { app, exited, evaluate, close, userData, output: () => output }
}

/**
 * Gives an isolated instance the trainer's transcription models, hard-linked
 * (not copied: they are hundreds of MB). Returns the models it got.
 */
function linkModels(userData, models = ['base']) {
  const from = join(process.env.APPDATA, 'Training Recording System', 'models')
  mkdirSync(join(userData, 'models'), { recursive: true })
  const linked = []
  for (const model of models) {
    const name = `ggml-${model}.bin`
    if (!existsSync(join(from, name))) continue
    try {
      linkSync(join(from, name), join(userData, 'models', name))
    } catch {
      copyFileSync(join(from, name), join(userData, 'models', name))
    }
    linked.push(model)
  }
  return linked
}

/** Waits until `predicate(state)` is true; returns the last state. */
async function waitForState(evaluate, predicate, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  let state
  while (Date.now() < until) {
    state = await evaluate('window.api.getState()')
    if (predicate(state)) return state
    await sleep(250)
  }
  return state
}

module.exports = {
  ROOT,
  sleep,
  check,
  report,
  obsPassword,
  realSettings,
  isolatedSettings,
  launch,
  linkModels,
  waitForState,
  failures: () => failures
}
