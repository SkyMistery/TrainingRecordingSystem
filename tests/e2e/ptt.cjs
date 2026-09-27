// Companion devices and push-to-talk buttons, in an isolated app instance (own
// settings and sessions folder, no OBS): one-time pairing links, a secret per
// device, removing a device; push-to-talk only during a review, held while the
// device keeps asking, released when it stops, when it disconnects or when the
// review closes, never by another device; malformed or flooding messages; the
// files and sessions a device may reach.
// Keys: F16 (no application uses it) and End (an extended key, sent through
// SendInput; it reaches the window in front: the caret may move to the end of a line).
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const WS = require('ws')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { check, isolatedSettings, launch, report, sleep, waitForState } = require('./lib.cjs')

const PORT = 17649
const key = (code, label, mods = {}) => ({
  device: 'keyboard',
  code,
  ctrl: false,
  alt: false,
  shift: false,
  label,
  ...mods
})

/** A finished session in the isolated sessions folder, with one screenshot and one note. */
function makeSession(sessionsDir, name) {
  const folder = join(sessionsDir, name)
  mkdirSync(join(folder, 'notes'), { recursive: true })
  mkdirSync(join(folder, `${name}_screen`), { recursive: true })
  writeFileSync(join(folder, 'notes', 'n-0001.wav'), Buffer.alloc(64))
  writeFileSync(join(folder, `${name}_screen`, 'm-0001.png'), Buffer.alloc(64))
  const session = {
    schemaVersion: 1,
    id: `e2e-${name}`,
    createdAt: new Date().toISOString(),
    metadata: {
      traineeVid: '000000',
      traineeName: 'E2E test',
      position: 'TEST_APP',
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
        screenshot: `${name}_screen/m-0001.png`,
        createdAt: new Date().toISOString(),
        notes: [
          {
            id: 'note1',
            audio: 'notes/n-0001.wav',
            durationMs: 2000,
            recordedAtMs: 1000,
            transcript: 'x',
            status: 'done',
            text: null
          }
        ]
      }
    ]
  }
  writeFileSync(join(folder, 'session.json'), JSON.stringify(session))
  return folder
}

async function main() {
  const settings = isolatedSettings('ptt', {
    companion: {
      enabled: true,
      lan: false,
      port: PORT,
      pttKeys: { voiceChat: key(UiohookKey.F16, 'F16'), aurora: key(UiohookKey.End, 'End') }
    }
  })
  makeSession(settings.sessionsDir, 'E2E_A')
  makeSession(settings.sessionsDir, 'E2E_B')
  const { evaluate, close, userData } = await launch({ name: 'ptt', port: 9337, settings })

  // Only the two test keys are recorded: nothing else typed meanwhile.
  const TEST_KEYS = new Map([
    [UiohookKey.F16, 'F16'],
    [UiohookKey.End, 'End']
  ])
  const keys = []
  uIOhook.on('keydown', (e) => TEST_KEYS.has(e.keycode) && keys.push(`${TEST_KEYS.get(e.keycode)} down`))
  uIOhook.on('keyup', (e) => TEST_KEYS.has(e.keycode) && keys.push(`${TEST_KEYS.get(e.keycode)} up`))
  uIOhook.start()

  const devices = []
  try {
    let state = await waitForState(evaluate, (s) => s.companion.running)
    const base = `http://127.0.0.1:${PORT}`

    /** Pairs a new device with the current one-time link; returns its cookie. */
    const pair = async () => {
      const current = await evaluate('window.api.getState()')
      const response = await fetch(current.companion.urls[0], { redirect: 'manual' })
      return {
        status: response.status,
        cookie: response.headers.get('set-cookie')?.split(';')[0],
        link: current.companion.urls[0]
      }
    }
    const connect = (cookie) =>
      new Promise((resolve, reject) => {
        const ws = new WS(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, origin: base } })
        const device = { ws, state: null, id: null, results: new Map(), nextId: 1, closedWith: null }
        ws.on('message', (data) => {
          const message = JSON.parse(String(data))
          if (message.type === 'state') device.state = message.state
          else if (message.type === 'hello') device.id = message.deviceId
          else if (message.type === 'result') device.results.get(message.id)?.(message)
        })
        ws.on('close', (code) => (device.closedWith = code))
        device.send = (name, ...args) =>
          new Promise((done) => {
            const id = device.nextId++
            device.results.set(id, done)
            ws.send(JSON.stringify({ id, name, args }))
            setTimeout(() => done({ error: 'no answer' }), 5000)
          })
        ws.on('open', () => {
          devices.push(device)
          resolve(device)
        })
        ws.on('error', reject)
      })

    // --- Pairing ---------------------------------------------------------------
    const first = await pair()
    check('a pairing link pairs a device', first.status === 200 && Boolean(first.cookie))
    state = await waitForState(evaluate, (s) => s.notice?.title === 'A new device paired with the Companion', 3000)
    check(
      'the PC says a device paired',
      state.notice?.title === 'A new device paired with the Companion',
      state.notice?.title
    )
    const reused = await fetch(first.link, { redirect: 'manual' })
    check('the same link pairs nobody else (one-time)', reused.status === 403, String(reused.status))
    const second = await pair()
    check('the new link pairs a second device', second.status === 200 && second.cookie !== first.cookie)
    state = await evaluate('window.api.getState()')
    check(
      'both devices are listed in Setup',
      state.companion.devices.length === 2,
      JSON.stringify(state.companion.devices.map((d) => d.name))
    )

    const phone = await connect(first.cookie)
    const tablet = await connect(second.cookie)
    await sleep(500)
    check(
      'the Companion lists both push-to-talk buttons with their keys',
      JSON.stringify(phone.state?.pttKeys) ===
        JSON.stringify([
          { target: 'voiceChat', label: 'F16' },
          { target: 'aurora', label: 'End' }
        ]),
      JSON.stringify(phone.state?.pttKeys)
    )

    // --- Push-to-talk only during a recording or a review -----------------------
    let result = await phone.send('holdPtt', 'voiceChat')
    check('push-to-talk refused with no recording or review open', Boolean(result.error), result.error)
    await evaluate(`window.api.openReview('E2E_A')`)
    await sleep(500)

    keys.length = 0
    result = await phone.send('holdPtt', 'voiceChat')
    await sleep(400)
    check(
      'hold: the key goes down on the PC',
      !result.error && keys.join(',') === 'F16 down',
      `${result.error ?? ''} ${keys}`
    )
    state = await evaluate('window.api.getState()')
    check(
      'the PC shows who holds it',
      state.pttHolds[0]?.target === 'voiceChat' && state.pttHolds[0]?.deviceId === phone.id
    )
    check('the device sees it held by itself', phone.state?.pttHolds[0]?.deviceId === phone.id)
    // Keep-alive: asking again every second keeps it down and presses nothing more.
    for (let i = 0; i < 3; i++) {
      await sleep(1000)
      await phone.send('holdPtt', 'voiceChat')
    }
    check('kept down while the device keeps asking', keys.join(',') === 'F16 down', keys.join(','))
    result = await tablet.send('holdPtt', 'voiceChat')
    check('another device can’t take it', Boolean(result.error), result.error)
    await tablet.send('releasePtt', 'voiceChat')
    await sleep(300)
    check("another device can't release it", keys.join(',') === 'F16 down', keys.join(','))
    result = await phone.send('releasePtt', 'voiceChat')
    await sleep(400)
    check('the holding device can', keys.join(',') === 'F16 down,F16 up', keys.join(','))

    keys.length = 0
    await phone.send('holdPtt', 'voiceChat')
    await sleep(3500)
    check(
      'released by itself when the device stops asking (phone locked)',
      keys.join(',') === 'F16 down,F16 up',
      keys.join(',')
    )

    keys.length = 0
    await phone.send('holdPtt', 'voiceChat')
    await sleep(300)
    await evaluate(`window.api.releasePtt('voiceChat')`)
    await sleep(300)
    check('the PC’s Release button lets go of it', keys.join(',') === 'F16 down,F16 up', keys.join(','))

    keys.length = 0
    await phone.send('holdPtt', 'aurora')
    await sleep(400)
    check('extended key (End) held through SendInput', keys.join(',') === 'End down', keys.join(','))
    phone.ws.terminate()
    await sleep(1500)
    check('a device disconnecting mid-press releases the key', keys.join(',') === 'End down,End up', keys.join(','))

    keys.length = 0
    await tablet.send('holdPtt', 'voiceChat')
    await sleep(300)
    await evaluate('window.api.closeReview()')
    await sleep(500)
    check('closing the review releases the key', keys.join(',') === 'F16 down,F16 up', keys.join(','))
    await evaluate(`window.api.openReview('E2E_A')`)
    await sleep(500)

    result = await tablet.send('holdPtt', 'somethingElse')
    check('unknown button refused', Boolean(result.error), result.error)

    // --- What a device may reach ------------------------------------------------------
    const get = (path, cookie) => fetch(`${base}${path}`, { headers: { cookie } })
    let response = await get('/media/E2E_A/E2E_A_screen/m-0001.png', second.cookie)
    check('a screenshot of the open session can be loaded', response.status === 200, String(response.status))
    check('media are not cached (a lost phone)', response.headers.get('cache-control') === 'no-store')
    response = await get('/media/E2E_A/notes/n-0001.wav', second.cookie)
    check('a voice note of the open session can be loaded', response.status === 200, String(response.status))
    response = await get('/media/E2E_A/session.json', second.cookie)
    check('session.json can’t be downloaded', response.status === 403, String(response.status))
    response = await get('/media/E2E_B/notes/n-0001.wav', second.cookie)
    check('another session’s files can’t be downloaded', response.status === 403, String(response.status))
    result = await tablet.send('deleteMarker', 'E2E_B', 'm1')
    check('another session can’t be edited', Boolean(result.error), result.error)
    // fetch can't set Host: a plain request, as a page of a rebound name would send it.
    const foreignHost = await new Promise((resolve) => {
      const request = require('node:http').get(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/',
          headers: { cookie: second.cookie, host: 'attacker.example:17649' }
        },
        (reply) => resolve(reply.statusCode)
      )
      request.on('error', () => resolve(null))
    })
    check('a foreign Host (DNS rebinding) is refused', foreignHost === 403, String(foreignHost))

    // --- Malformed and flooding messages ------------------------------------------------
    const probe = await connect(second.cookie)
    probe.ws.send('null')
    probe.ws.send('[1,2,3]')
    probe.ws.send('not json')
    let nested = '0'
    for (let i = 0; i < 100_000; i++) nested = `[${nested}]`
    probe.ws.send(`{"id":${nested},"name":"x","args":[]}`)
    await sleep(500)
    result = await probe.send('playerCommand', { type: 'pause' })
    check(
      'malformed messages are ignored and the device still works',
      !result.error || result.error !== 'no answer',
      result.error
    )
    result = await probe.send('playerCommand', { type: 'rate', rate: 1e9 })
    check('an invalid player command is refused', Boolean(result.error), result.error)
    const big = await connect(second.cookie)
    big.ws.send(JSON.stringify({ id: 1, name: 'setNoteText', args: ['E2E_A', 'm1', 'note1', 'x'.repeat(400_000)] }))
    await sleep(800)
    check('a message too large closes that connection only', big.closedWith !== null, String(big.closedWith))
    const flood = await connect(second.cookie)
    for (let i = 0; i < 300; i++)
      flood.ws.send(JSON.stringify({ id: i, name: 'playerCommand', args: [{ type: 'pause' }] }))
    await sleep(800)
    check('a flood of messages closes that connection', flood.closedWith === 1008, String(flood.closedWith))
    state = await evaluate('window.api.getState()')
    check('the app is still fine', state?.companion.running === true)

    // --- Push-to-talk keys that would act on the window in front ------------------------
    const refused = async (pttKeys) =>
      evaluate(
        `window.api.saveCompanionSettings({ pttKeys: ${JSON.stringify(pttKeys)} }).then(() => null, (e) => e.message)`
      )
    let error = await refused({ voiceChat: key(UiohookKey.Enter, 'Enter'), aurora: null })
    check('Enter is refused as a push-to-talk key', Boolean(error), error)
    error = await refused({ voiceChat: key(UiohookKey.F4, 'Alt + F4', { alt: true }), aurora: null })
    check('Alt combinations are refused', Boolean(error), error)
    error = await refused({ voiceChat: key(UiohookKey.W, 'Ctrl + W', { ctrl: true }), aurora: null })
    check('Ctrl + letter is refused', Boolean(error), error)
    await evaluate(
      `window.api.saveMarkerSettings({ hotkeys: { marker: null, range: null, voiceNote: ${JSON.stringify(key(UiohookKey.F15, 'F15'))} } })`
    )
    error = await refused({ voiceChat: null, aurora: key(UiohookKey.F15, 'F15') })
    check('the voice-note key can’t be the Aurora push-to-talk key', Boolean(error), error)

    keys.length = 0
    await evaluate(
      `window.api.saveCompanionSettings({ pttKeys: { voiceChat: null, aurora: ${JSON.stringify(key(UiohookKey.End, 'End'))} } })`
    )
    await sleep(800)
    check(
      'a cleared key removes its button, without disconnecting the devices',
      tablet.ws.readyState === WS.OPEN &&
        JSON.stringify(tablet.state?.pttKeys) === JSON.stringify([{ target: 'aurora', label: 'End' }]),
      `open: ${tablet.ws.readyState === WS.OPEN}, ${JSON.stringify(tablet.state?.pttKeys)}`
    )
    result = await tablet.send('holdPtt', 'voiceChat')
    check('a button without a key is refused', Boolean(result.error), result.error)

    // --- Removing a device ------------------------------------------------------------
    state = await evaluate('window.api.getState()')
    const tabletId = tablet.id
    await evaluate(`window.api.removeCompanionDevice(${JSON.stringify(tabletId)})`)
    await sleep(800)
    check('a removed device is disconnected', tablet.ws.readyState !== WS.OPEN)
    response = await get('/', second.cookie)
    check('and its secret no longer works', response.status === 401, String(response.status))
  } finally {
    uIOhook.stop()
    for (const device of devices) device.ws.terminate()
    await close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(settings.sessionsDir, { recursive: true, force: true })
  }
  report()
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
