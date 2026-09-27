// End-to-end test of hidden windows (privacy masks) against the real OBS, in an
// isolated app instance (own settings in %TEMP%: the trainer's are only read,
// for the recorded monitor). A magenta test window is opened on the recorded
// monitor; the OBS scene preview must show it without a rule, and a grey mask
// over it with one, also after it moves, after the monitor's position changed,
// and after the display source was moved in OBS.
// Needs: the app closed (one app per OBS), OBS idle, TRS_OBS_PASSWORD set.
const { spawn } = require('node:child_process')
const { rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { OBSWebSocket } = require('obs-websocket-js')
const { check, isolatedSettings, launch, obsPassword, realSettings, report, sleep, waitForState } = require('./lib.cjs')

const TITLE = 'TRS mask test'
const SIZE = { width: 400, height: 300 }
const PASSWORD = obsPassword()

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
  const real = realSettings()
  if (!real.capture?.display) throw new Error('choose the recorded monitor in the app first')
  const { evaluate, close, output, userData } = await launch({
    name: 'masks',
    port: 9336,
    settings: isolatedSettings('masks', { capture: { ...real.capture, hiddenWindows: [] } })
  })
  const log = (...a) => console.log('[e2e]', ...a)
  const signal = join(tmpdir(), 'trs-mask-test.move')
  let form = null
  const obs = new OBSWebSocket()
  try {
    const startupErrors = new Set()
    await evaluate(
      `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(PASSWORD)} }).catch((e) => e.message)`
    )
    let state = await waitForState(evaluate, (s) => {
      if (s.hiddenWindowsError) startupErrors.add(s.hiddenWindowsError)
      return s.obs.status === 'connected' && !s.busy
    })
    const display = state.capture.display
    log('OBS', state.obs.status, state.obs.version, '| display', display?.name)
    if (state.obs.status !== 'connected') throw new Error(`OBS not connected: ${state.obs.error}`)
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
        return [0, 1, 2].map((c) => { let t = 0; for (let i = c; i < d.length; i += 4) t += d[i]; return Math.round(t / 25) })
      })()`)
    const isMagenta = (c) => c && c[0] > 180 && c[1] < 80 && c[2] > 180
    const isMask = (c) => c && c.every((v) => v >= 20 && v <= 60) && Math.max(...c) - Math.min(...c) < 12

    rmSync(signal, { force: true })
    const a = { x: 200, y: 200 }
    const b = { x: 700, y: 400 }
    const center = (p) => [p.x + SIZE.width / 2, p.y + SIZE.height / 2]
    form = openTestWindow({ x: ox + a.x, y: oy + a.y }, { x: ox + b.x, y: oy + b.y }, signal)
    let windows = []
    for (let i = 0; i < 20 && !windows.some((w) => w.title === TITLE); i++) {
      windows = await evaluate('window.api.listWindows()')
      await sleep(500)
    }
    const test = windows.find((w) => w.title === TITLE)
    check(`test window listed (${test?.exe})`, Boolean(test))
    if (!test) throw new Error('test window not found')
    check("the app's own windows are not listed", !windows.some((w) => /Training Recording System/.test(w.title)))

    await sleep(800)
    let color = await sample(...center(a))
    check('no rule: the window is recorded', isMagenta(color), String(color))

    const rule = { id: 'e2e', exe: test.exe, title: TITLE, enabled: true }
    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify(rule)}] })`)
    await sleep(500)
    color = await sample(...center(a))
    check('rule on: the window is covered', isMask(color), String(color))
    color = await sample(a.x + 3, a.y + 3)
    check('rule on: its corner is covered too', isMask(color), String(color))
    state = await evaluate('window.api.getState()')
    check('Setup shows the rule as on screen', state.hiddenWindowsFound.includes('e2e'))

    writeFileSync(signal, '')
    await sleep(800)
    color = await sample(...center(b))
    check('moved: covered at its new position', isMask(color), String(color))
    state = await evaluate('window.api.getState()')
    check('no error reported', state.hiddenWindowsError === null, String(state.hiddenWindowsError))

    // The display source moved (a stray drag in OBS's preview): put back within a few seconds.
    await obs.connect('ws://127.0.0.1:4455', PASSWORD)
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: 'TRS Recording', sourceName: 'TRS Display' })
    const locked = await obs.call('GetSceneItemLocked', { sceneName: 'TRS Recording', sceneItemId })
    check('the display is locked in OBS', locked.sceneItemLocked === true)
    await obs.call('SetSceneItemTransform', {
      sceneName: 'TRS Recording',
      sceneItemId,
      sceneItemTransform: { positionX: 300, cropLeft: 200 }
    })
    await sleep(3500)
    const { sceneItemTransform } = await obs.call('GetSceneItemTransform', { sceneName: 'TRS Recording', sceneItemId })
    check(
      'a display moved in OBS is put back',
      sceneItemTransform.positionX === 0 && sceneItemTransform.cropLeft === 0,
      `x ${sceneItemTransform.positionX}, crop ${sceneItemTransform.cropLeft}`
    )
    color = await sample(...center(b))
    check('still covered after that', isMask(color), String(color))

    // The monitor's position changed since Setup (monitors rearranged): the next connection reads it again.
    const stale = { ...display, name: display.name.replace(/@\s*-?\d+\s*,\s*-?\d+/, '@ 20000,20000') }
    await evaluate(`window.api.saveCapture({ display: ${JSON.stringify(stale)} })`)
    await sleep(800)
    color = await sample(...center(b))
    check('with a stale monitor position the mask is misplaced (test premise)', isMagenta(color), String(color))
    await evaluate('window.api.reconnectObs()')
    state = await waitForState(evaluate, (s) => s.obs.status === 'connected' && !s.busy)
    check('the monitor is read again from OBS', state.capture.display.name === display.name, state.capture.display.name)
    await sleep(800)
    color = await sample(...center(b))
    check('covered again after the monitor was read again', isMask(color), String(color))

    // A monitor name without its position: the masks can't be placed, and that is reported.
    await evaluate(
      `window.api.saveCapture({ display: ${JSON.stringify({ ...display, name: 'Display without position' })} })`
    )
    state = await waitForState(evaluate, (s) => s.hiddenWindowsError !== null, 3000)
    check(
      'an unknown monitor position is reported',
      Boolean(state.hiddenWindowsError),
      String(state.hiddenWindowsError)
    )
    await evaluate(`window.api.saveCapture({ display: ${JSON.stringify(display)} })`)
    state = await waitForState(evaluate, (s) => s.hiddenWindowsError === null, 3000)
    check('the report goes away once fixed', state.hiddenWindowsError === null)

    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify({ ...rule, enabled: false })}] })`)
    await sleep(500)
    color = await sample(...center(b))
    check('rule off: recorded again', isMagenta(color), String(color))

    await evaluate(`window.api.saveCapture({ hiddenWindows: [${JSON.stringify({ ...rule, title: null })}] })`)
    await sleep(500)
    color = await sample(...center(b))
    check('every window of the program: covered', isMask(color), String(color))
    check(
      'no hidden-windows error while connecting',
      startupErrors.size === 0,
      [...startupErrors].join(' | ') || 'none'
    )
  } finally {
    form?.kill()
    rmSync(signal, { force: true })
    await obs.disconnect().catch(() => undefined)
    // Closed normally, so OBS gets the trainer's profile back.
    await close()
    log('app closed')
    rmSync(userData, { recursive: true, force: true })
  }
  const logged = output()
    .split(/\r?\n/)
    .filter(
      (line) => line.includes('Could not cover hidden windows') && !line.includes('position of the recorded monitor')
    )
  check('nothing else logged about hidden windows', logged.length === 0, logged.join(' | ') || 'none')
  report()
}
main().catch((e) => {
  console.error('[e2e] FAILED', e)
  process.exit(1)
})
