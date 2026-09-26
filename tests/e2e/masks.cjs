// End-to-end test of hidden windows (privacy masks) against the real app + OBS.
// A magenta test window is opened on the recorded monitor; the OBS scene preview
// must show it without a rule, and a grey mask over it with one, also after it moves.
// Uses the real settings (restored at the end): close the app first. OBS must be idle.
const { spawn } = require('node:child_process')
const { rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TITLE = 'TRS mask test'
const SIZE = { width: 400, height: 300 }
let failures = 0
const check = (ok, what) => {
  if (!ok) failures++
  console.log(ok ? 'PASS' : 'FAIL', what)
}

/** A topmost magenta window at `at` (screen pixels) that moves to `moveTo` once `signal` exists. */
function openTestWindow(at, moveTo, signal) {
  const script = join(tmpdir(), 'trs-mask-test.ps1')
  writeFileSync(
    script,
    `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Name Dpi -Namespace Trs -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Trs.Dpi]::SetProcessDPIAware() | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = '${TITLE}'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(${at.x}, ${at.y})
$form.Size = New-Object System.Drawing.Size(${SIZE.width}, ${SIZE.height})
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TopMost = $true
$form.ShowInTaskbar = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({ if (Test-Path '${signal}') { $form.Location = New-Object System.Drawing.Point(${moveTo.x}, ${moveTo.y}); $timer.Stop() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`
  )
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: 'ignore',
    windowsHide: true
  })
}

async function main() {
  const app = spawn(`${ROOT}/node_modules/electron/dist/electron.exe`, ['.', '--remote-debugging-port=9336'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // The main process's log: connecting to OBS (switching it to the app's scene) must not report the masks failing.
  let output = ''
  app.stdout.on('data', (chunk) => (output += chunk))
  app.stderr.on('data', (chunk) => (output += chunk))
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch('http://127.0.0.1:9336/json')).json()
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
  const startupErrors = new Set()
  for (let i = 0; i < 30; i++) {
    state = await evaluate('window.api.getState()')
    if (state.hiddenWindowsError) startupErrors.add(state.hiddenWindowsError)
    if (state.obs.status === 'connected' && !state.busy) break
    await sleep(500)
  }
  const display = state.capture.display
  log('OBS', state.obs.status, state.obs.version, '| display', display?.name)
  if (state.obs.status !== 'connected' || !display) throw new Error('OBS not connected or no display chosen')
  const origin = /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(display.name)
  const [ox, oy] = origin ? [Number(origin[1]), Number(origin[2])] : [0, 0]

  /** Average colour of the preview (scene) around a display point. */
  const sample = (x, y) =>
    evaluate(`(async () => {
      const src = await window.api.getPreview()
      if (!src) return null
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const s = img.naturalWidth / ${display.width}
      const d = ctx.getImageData(Math.round(${x} * s) - 2, Math.round(${y} * s) - 2, 5, 5).data
      const avg = [0, 1, 2].map((c) => { let t = 0; for (let i = c; i < d.length; i += 4) t += d[i]; return Math.round(t / 25) })
      return avg
    })()`)
  const isMagenta = (c) => c && c[0] > 180 && c[1] < 80 && c[2] > 180
  const isMask = (c) => c && c.every((v) => v >= 20 && v <= 60) && Math.max(...c) - Math.min(...c) < 12

  const originalRules = state.capture.hiddenWindows
  log('rules', JSON.stringify(originalRules))
  const signal = join(tmpdir(), 'trs-mask-test.move')
  rmSync(signal, { force: true })
  const a = { x: 200, y: 200 }
  const b = { x: 700, y: 400 }
  const center = (p) => [p.x + SIZE.width / 2, p.y + SIZE.height / 2]
  const form = openTestWindow({ x: ox + a.x, y: oy + a.y }, { x: ox + b.x, y: oy + b.y }, signal)
  try {
    await evaluate(`window.api.saveCapture({ hiddenWindows: [] })`)
    const windows = await (async () => {
      for (let i = 0; i < 20; i++) {
        const list = await evaluate('window.api.listWindows()')
        if (list.some((w) => w.title === TITLE)) return list
        await sleep(500)
      }
      return []
    })()
    const test = windows.find((w) => w.title === TITLE)
    check(Boolean(test), `test window listed (${test?.exe})`)
    if (!test) throw new Error('test window not found')
    check(!windows.some((w) => /Training Recording System/.test(w.title)), "the app's own windows are not listed")

    await sleep(800)
    let color = await sample(...center(a))
    check(isMagenta(color), `no rule: the window is recorded (${color})`)

    const rule = { id: 'e2e', exe: test.exe, title: TITLE, enabled: true }
    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify(rule)}] })`)
    await sleep(500)
    color = await sample(...center(a))
    check(isMask(color), `rule on: the window is covered (${color})`)
    color = await sample(a.x + 3, a.y + 3)
    check(isMask(color), `rule on: its corner is covered too (${color})`)

    writeFileSync(signal, '')
    await sleep(800)
    color = await sample(...center(b))
    check(isMask(color), `moved: covered at its new position (${color})`)
    state = await evaluate('window.api.getState()')
    check(state.hiddenWindowsError === null, `no error reported (${state.hiddenWindowsError})`)

    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify({ ...rule, enabled: false })}] })`)
    await sleep(500)
    color = await sample(...center(b))
    check(isMagenta(color), `rule off: recorded again (${color})`)

    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify({ ...rule, title: null })}] })`)
    await sleep(500)
    color = await sample(...center(b))
    check(isMask(color), `every window of the program: covered (${color})`)
  } finally {
    form.kill()
    rmSync(signal, { force: true })
    await evaluate(`window.api.saveCapture({ hiddenWindows: ${JSON.stringify(originalRules)} })`)
    log('rules restored')
  }

  // Close normally so the app gives OBS back the trainer's profile.
  await evaluate('window.close()').catch(() => undefined)
  ws.close()
  await new Promise((r) => {
    const timer = setTimeout(() => {
      log('app did NOT exit: killing it')
      app.kill()
      r()
    }, 8000)
    app.on('exit', () => {
      clearTimeout(timer)
      r()
    })
  })
  log('app closed')
  check(
    startupErrors.size === 0,
    `no hidden-windows error while connecting (${[...startupErrors].join(' | ') || 'none'})`
  )
  const logged = output.split(/\r?\n/).filter((line) => line.includes('Could not cover hidden windows'))
  check(logged.length === 0, `nothing logged about hidden windows (${logged.join(' | ') || 'none'})`)
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  if (failures) process.exitCode = 1
}
main().catch((e) => {
  console.error('[e2e] FAILED', e)
  process.exit(1)
})
