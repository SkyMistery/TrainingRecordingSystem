// Companion push-to-talk buttons, in an isolated app instance (own settings
// folder, no OBS): holding a button holds its key on the PC, the release lets
// it go, another device can't release it, and a device that disconnects
// mid-press releases its key. Keys: F16 (no application uses it) and End
// (an extended key, sent through SendInput; it reaches the window in front).
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const WS = require(`${ROOT}/node_modules/ws`)
const { uIOhook, UiohookKey } = require(`${ROOT}/node_modules/uiohook-napi`)
const USERDATA = join(require('node:os').tmpdir(), 'trs-e2e-ptt')
const PORT = 17649
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}
const key = (code, label) => ({ device: 'keyboard', code, ctrl: false, alt: false, shift: false, label })

async function main() {
  rmSync(USERDATA, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
  writeFileSync(
    join(USERDATA, 'settings.json'),
    JSON.stringify({
      termsAccepted: { version: 1, acceptedAt: new Date().toISOString() },
      companion: {
        enabled: true,
        lan: false,
        port: PORT,
        pttKeys: { voiceChat: key(UiohookKey.F16, 'F16'), aurora: key(UiohookKey.End, 'End') }
      },
      obs: { host: '127.0.0.1', port: 1, passwordEncrypted: null }
    })
  )
  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', '--remote-debugging-port=9337', `--user-data-dir=${USERDATA}`],
    { cwd: ROOT }
  )
  // Only the two test keys are recorded: nothing else typed meanwhile.
  const TEST_KEYS = new Map([
    [UiohookKey.F16, 'F16'],
    [UiohookKey.End, 'End']
  ])
  const keys = []
  uIOhook.on('keydown', (e) => TEST_KEYS.has(e.keycode) && keys.push(`${TEST_KEYS.get(e.keycode)} down`))
  uIOhook.on('keyup', (e) => TEST_KEYS.has(e.keycode) && keys.push(`${TEST_KEYS.get(e.keycode)} up`))
  uIOhook.start()

  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500)
    try {
      target = (await (await fetch('http://127.0.0.1:9337/json')).json()).find(
        (t) => t.type === 'page' && t.url.endsWith('index.html')
      )
    } catch {}
  }
  const cdp = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => cdp.addEventListener('open', r))
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9)
      const h = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== id) return
        cdp.removeEventListener('message', h)
        resolve(d.result?.result?.value)
      }
      cdp.addEventListener('message', h)
      cdp.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  try {
    let state
    for (let i = 0; i < 20; i++) {
      state = await evaluate('window.api.getState()')
      if (state?.companion.running) break
      await sleep(300)
    }
    const pair = new URL(state.companion.urls[0])
    const base = `http://${pair.host}`
    const cookie = (await fetch(pair.href, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0]

    const connect = () =>
      new Promise((resolve, reject) => {
        const ws = new WS(`ws://${pair.host}/ws`, { headers: { cookie, origin: base } })
        const device = { ws, state: null, results: new Map(), nextId: 1 }
        ws.on('message', (data) => {
          const message = JSON.parse(String(data))
          if (message.type === 'state') device.state = message.state
          else device.results.get(message.id)?.(message)
        })
        device.send = (name, ...args) =>
          new Promise((done) => {
            const id = device.nextId++
            device.results.set(id, done)
            ws.send(JSON.stringify({ id, name, args }))
          })
        ws.on('open', () => resolve(device))
        ws.on('error', reject)
      })

    const phone = await connect()
    await sleep(500)
    check(
      'Companion lists both push-to-talk buttons with their keys',
      JSON.stringify(phone.state?.pttKeys) ===
        JSON.stringify([
          { target: 'voiceChat', label: 'F16' },
          { target: 'aurora', label: 'End' }
        ]),
      JSON.stringify(phone.state?.pttKeys)
    )

    keys.length = 0
    let result = await phone.send('holdPtt', 'voiceChat')
    await sleep(500)
    check('Hold: the key goes down on the PC', !result.error && keys.join(',') === 'F16 down', keys.join(','))
    result = await phone.send('holdPtt', 'voiceChat')
    await sleep(300)
    check('Holding again presses nothing more', !result.error && keys.join(',') === 'F16 down', keys.join(','))
    result = await phone.send('releasePtt', 'voiceChat')
    await sleep(500)
    check('Release: the key goes up', !result.error && keys.join(',') === 'F16 down,F16 up', keys.join(','))

    keys.length = 0
    const tablet = await connect()
    await phone.send('holdPtt', 'voiceChat')
    await tablet.send('releasePtt', 'voiceChat')
    await sleep(500)
    check("Another device can't release it", keys.join(',') === 'F16 down', keys.join(','))
    await phone.send('releasePtt', 'voiceChat')
    await sleep(500)
    check('The holding device can', keys.join(',') === 'F16 down,F16 up', keys.join(','))

    keys.length = 0
    await phone.send('holdPtt', 'aurora')
    await sleep(500)
    check('Extended key (End) held through SendInput', keys.join(',') === 'End down', keys.join(','))
    phone.ws.terminate()
    await sleep(1500)
    check('Disconnecting mid-press releases the key', keys.join(',') === 'End down,End up', keys.join(','))

    result = await tablet.send('holdPtt', 'somethingElse')
    check('Unknown button refused', Boolean(result.error), result.error)

    keys.length = 0
    await evaluate(
      `window.api.saveCompanionSettings({ pttKeys: { voiceChat: null, aurora: ${JSON.stringify(key(UiohookKey.End, 'End'))} } })`
    )
    await sleep(800)
    check(
      'A cleared key removes its button, without disconnecting the devices',
      tablet.ws.readyState === WS.OPEN &&
        JSON.stringify(tablet.state?.pttKeys) === JSON.stringify([{ target: 'aurora', label: 'End' }]),
      `open: ${tablet.ws.readyState === WS.OPEN}, ${JSON.stringify(tablet.state?.pttKeys)}`
    )
    result = await tablet.send('holdPtt', 'voiceChat')
    check('A button without a key is refused', Boolean(result.error), result.error)
    tablet.ws.close()
  } finally {
    uIOhook.stop()
    await evaluate('window.close()').catch(() => undefined)
    cdp.close()
    await new Promise((r) => {
      const timer = setTimeout(() => (app.kill(), r()), 8000)
      app.on('exit', () => (clearTimeout(timer), r()))
    })
    rmSync(USERDATA, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
