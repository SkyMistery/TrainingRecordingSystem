// End-to-end test of M4: review player, Companion server security, WebSocket
// commands and the notes window. Uses a copy of a real session.
const { spawn } = require('node:child_process')
const { cpSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = require('node:path').resolve(__dirname, '../..').split('\\').join('/')
const WS = require(`${ROOT}/node_modules/ws`)
const SESSIONS = join(process.env.USERPROFILE, 'Documents', 'IVAO TRS', 'Sessions')
// A real session to copy (folder name in the sessions folder), with a range and voice notes.
const SOURCE = process.env.TRS_REVIEW_SESSION
if (!SOURCE) throw new Error('Set TRS_REVIEW_SESSION to a session folder name with a recording, a range and notes')
const USERDATA = join(require('node:os').tmpdir(), 'trs-e2e-review')
const OUT = require('node:os').tmpdir()
const COPY = '2026-09-24_0100_000000_E2E_REVIEW'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

async function cdpTarget(match) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json')).json()
      const target = list.find((t) => t.type === 'page' && match(t.url))
      if (target) return target
    } catch {}
    await sleep(500)
  }
  throw new Error('target not found')
}

async function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const h = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== n) return
        ws.removeEventListener('message', h)
        if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.exception?.description))
        else resolve(d.result)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  return {
    eval: async (expression) =>
      (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value,
    screenshot: async (file) => writeFileSync(file, Buffer.from((await call('Page.captureScreenshot')).data, 'base64')),
    close: () => ws.close()
  }
}

async function main() {
  // Isolated settings: Companion on its own port, no OBS needed.
  require('node:fs').mkdirSync(USERDATA, { recursive: true })
  writeFileSync(
    join(USERDATA, 'settings.json'),
    JSON.stringify({
      companion: { enabled: true, lan: false, port: 17646 },
      obs: { host: '127.0.0.1', port: 1, passwordEncrypted: null }
    })
  )
  rmSync(join(SESSIONS, COPY), { recursive: true, force: true })
  cpSync(join(SESSIONS, SOURCE), join(SESSIONS, COPY), { recursive: true })
  const sessionFile = join(SESSIONS, COPY, 'session.json')
  const copy = JSON.parse(readFileSync(sessionFile, 'utf8'))
  copy.metadata.traineeName = 'E2E test'
  writeFileSync(sessionFile, JSON.stringify(copy, null, 2))

  const app = spawn(
    `${ROOT}/node_modules/electron/dist/electron.exe`,
    ['.', '--remote-debugging-port=9334', `--user-data-dir=${USERDATA}`],
    { cwd: ROOT }
  )
  app.stderr.on('data', (d) => {
    const t = String(d)
    if (/Error|error/.test(t) && !/cache|DevTools|gpu/i.test(t)) process.stdout.write('[app!] ' + t)
  })
  const main = await cdp(await cdpTarget((url) => url.endsWith('index.html')))
  let state
  for (let i = 0; i < 20; i++) {
    state = await main.eval('window.api.getState()')
    if (state.companion.running) break
    await sleep(300)
  }
  check(
    'Companion server running on 127.0.0.1 only by default',
    state.companion.running && state.companion.urls.length === 1,
    state.companion.urls[0]?.replace(/token=.*/, 'token=…')
  )
  const pair = new URL(state.companion.urls[0])
  const base = `http://${pair.host}`
  const token = pair.searchParams.get('token')

  // --- HTTP security ---------------------------------------------------------------
  check('Unpaired request refused', (await fetch(base + '/')).status === 401)
  check(
    'Wrong pairing token refused',
    (await fetch(base + '/pair?token=' + 'x'.repeat(token.length), { redirect: 'manual' })).status === 403
  )
  const paired = await fetch(pair.href, { redirect: 'manual' })
  const cookie = paired.headers.get('set-cookie')?.split(';')[0]
  check(
    'Pairing sets an HttpOnly, SameSite=Lax cookie and continues to the page',
    paired.status === 200 &&
      /HttpOnly/.test(paired.headers.get('set-cookie')) &&
      /SameSite=Lax/.test(paired.headers.get('set-cookie')) &&
      (await paired.text()).includes('url=/')
  )
  const page = await fetch(base + '/', { headers: { cookie } })
  check('Companion page served once paired', page.status === 200 && (await page.text()).includes('Trainer notes'))
  const media = await fetch(`${base}/media/${encodeURIComponent(COPY)}/recording.mp4`, {
    headers: { cookie, range: 'bytes=0-99' }
  })
  check(
    'Recording served with HTTP range (206, 100 bytes)',
    media.status === 206 && (await media.arrayBuffer()).byteLength === 100,
    media.headers.get('content-range')
  )
  const escape = await fetch(`${base}/media/..%2F..%2Fsettings.json`, { headers: { cookie } })
  check(
    'Path escape from the sessions folder refused',
    escape.status === 403 || escape.status === 404,
    String(escape.status)
  )
  const noCookieMedia = await fetch(`${base}/media/${encodeURIComponent(COPY)}/recording.mp4`)
  check('Media refused without pairing', noCookieMedia.status === 401)

  // Malformed requests from anyone on the network must not break the server.
  const raw = (request) =>
    new Promise((resolve) => {
      const socket = require('node:net').connect(Number(pair.port), pair.hostname, () => socket.write(request))
      let reply = ''
      socket.on('data', (chunk) => (reply += chunk))
      socket.on('close', () => resolve(reply.split('\r\n')[0]))
      socket.on('error', () => resolve('error'))
      setTimeout(() => socket.destroy(), 3000)
    })
  const multibyte = 'é' + 'a'.repeat(token.length - 1)
  const badRequests = [
    ['Request line "//" answered', 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    [
      'Multibyte pairing token answered',
      `GET /pair?token=${encodeURIComponent(multibyte)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    ],
    [
      'Multibyte cookie answered',
      `GET / HTTP/1.1\r\nHost: x\r\nCookie: trs_companion=${multibyte}\r\nConnection: close\r\n\r\n`
    ],
    [
      'Malformed media path answered',
      `GET /media/%E0%A4%A HTTP/1.1\r\nHost: x\r\n${'Cookie: ' + cookie}\r\nConnection: close\r\n\r\n`
    ],
    [
      'Malformed static path answered',
      `GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\n${'Cookie: ' + cookie}\r\nConnection: close\r\n\r\n`
    ]
  ]
  for (const [label, request] of badRequests) {
    const status = await raw(request)
    check(label, /^HTTP\/1\.1 4\d\d/.test(status), status)
  }
  check(
    'Server still works after malformed requests',
    (await fetch(base + '/', { headers: { cookie } })).status === 200
  )

  // --- WebSocket security -------------------------------------------------------------
  const wsOpen = (headers) =>
    new Promise((resolve) => {
      const ws = new WS(`ws://${pair.host}/ws`, { headers })
      ws.on('open', () => resolve({ ok: true, ws }))
      ws.on('error', () => resolve({ ok: false }))
      ws.on('unexpected-response', () => resolve({ ok: false }))
    })
  check('WebSocket refused without cookie', !(await wsOpen({ origin: base })).ok)
  check('WebSocket refused from another origin', !(await wsOpen({ cookie, origin: 'http://evil.example' })).ok)
  const { ok, ws } = await wsOpen({ cookie, origin: base })
  check('WebSocket accepted when paired, same origin', ok)
  let companion = null
  const results = new Map()
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (message.type === 'state') companion = message.state
    else results.get(message.id)?.(message)
  })
  let nextId = 1
  const send = (name, ...args) =>
    new Promise((resolve) => {
      const id = nextId++
      results.set(id, resolve)
      ws.send(JSON.stringify({ id, name, args }))
    })
  await sleep(300)
  check('Companion receives state', companion !== null && companion.review === null)
  check(
    'Settings commands not allowed from Companion',
    (await send('saveMarkerSettings', {})).error === 'Unknown command'
  )

  // --- Review ---------------------------------------------------------------------------
  // Through the real button, like the trainer.
  const clicked = await main.eval(
    `(() => { const row = [...document.querySelectorAll('tr')].find((tr) => tr.innerText.includes('E2E test')); const button = row && [...row.querySelectorAll('button')].find((b) => b.innerText.includes('Review')); button?.click(); return !!button })()`
  )
  check('Review button found in the sessions list', clicked)
  await sleep(1500)
  check(
    'Review state reaches the Companion',
    companion?.review?.folderName === COPY,
    `${companion?.review?.markers.length} markers`
  )
  const video = await main.eval(
    `(() => { const v = document.querySelector('video'); return v && { ready: v.readyState, duration: v.duration } })()`
  )
  check('Review video loads', video && video.ready >= 1 && video.duration > 60, JSON.stringify(video))
  const noNotesInMain = await main.eval(
    `!document.body.innerText.includes('trafigo') && !document.body.innerText.includes('Prova')`
  )
  check('No note text in the shareable review window', noNotesInMain)

  const zoomed = await main.eval(`(async () => {
    const v = document.querySelector('video'); const frame = v.parentElement; const r = frame.getBoundingClientRect()
    for (let i = 0; i < 3; i++) frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + r.width * 0.7, clientY: r.top + r.height * 0.3, bubbles: true, cancelable: true }))
    await new Promise((res) => setTimeout(res, 300))
    return { transform: v.style.transform, frameWidth: Math.round(r.width), scrolled: document.querySelector('main').scrollTop }
  })()`)
  check(
    'Wheel zooms the video at the cursor without scrolling the page',
    zoomed.transform.includes('scale(1.72') && zoomed.scrolled === 0,
    JSON.stringify(zoomed)
  )
  await main.screenshot(join(OUT, 'trs-review-zoom.png'))
  const unzoomed = await main.eval(
    `(async () => { const v = document.querySelector('video'); v.parentElement.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await new Promise((r) => setTimeout(r, 300)); return v.style.transform })()`
  )
  check('Double-click resets the zoom', unzoomed.includes('scale(1)'), unzoomed)
  await main.eval('document.querySelector("video").pause()')
  const theatre = await main.eval(`(async () => {
    const before = document.querySelector('video'); before.currentTime = 20; before.dataset.probe = 'same'
    await new Promise((r) => setTimeout(r, 400))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const v = document.querySelector('video'); const frame = v.parentElement; const r = frame.getBoundingClientRect()
    for (let i = 0; i < 2; i++) frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }))
    await new Promise((res) => setTimeout(res, 300))
    const result = { sameElement: v.dataset.probe === 'same', time: v.currentTime, fixed: getComputedStyle(frame.closest('.fixed') ?? document.body).position, transform: v.style.transform, width: Math.round(r.width) }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    frame.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return result
  })()`)
  check(
    'Full window keeps the same video and position',
    theatre.sameElement && Math.abs(theatre.time - 20) < 0.5 && theatre.fixed === 'fixed',
    JSON.stringify(theatre)
  )
  check('Wheel zoom works in full window', theatre.transform.includes('scale(1.44'), theatre.transform)
  await send('playerCommand', { type: 'seek', positionMs: 30000 })
  await sleep(800)
  const t30 = await main.eval(`document.querySelector('video').currentTime`)
  check('Companion seek moves the player', Math.abs(t30 - 30) < 0.5, `${t30.toFixed(2)} s`)
  check(
    'Player position reported back to the Companion',
    Math.abs(companion.review.player.positionMs - 30000) < 800,
    String(companion.review.player.positionMs)
  )
  await send('playerCommand', { type: 'marker', direction: -1 })
  await sleep(600)
  const range = companion.review.markers.find((m) => m.kind === 'range')
  const tPrev = await main.eval(`document.querySelector('video').currentTime`)
  check(
    'Previous marker jumps to the range start',
    Math.abs(tPrev * 1000 - range.timeMs) < 300,
    `${tPrev.toFixed(2)} s vs ${range.timeMs} ms`
  )
  await send('playerCommand', { type: 'toggle' })
  await sleep(1200)
  const playing = await main.eval(`!document.querySelector('video').paused`)
  check('Play from Companion', playing && companion.review.player.playing)
  await send('playerCommand', { type: 'pause' })
  await sleep(400)

  // --- Edits from the Companion ------------------------------------------------------------
  const point = companion.review.markers.find((m) => m.kind === 'point')
  // A marker can have several categories: make sure it ends up with exactly these two.
  for (const id of point.categoryIds) await send('toggleMarkerCategory', COPY, point.id, id)
  await send('toggleMarkerCategory', COPY, point.id, 'positive')
  await send('toggleMarkerCategory', COPY, point.id, 'separation')
  const note = range.notes[0]
  await send('setNoteText', COPY, range.id, note.id, 'Traffico: chi va prima tra la 126 e la 582?')
  await send('setMarkerTimes', COPY, range.id, { endMs: range.timeMs + 20000 })
  await sleep(400)
  const saved = JSON.parse(readFileSync(sessionFile, 'utf8'))
  const savedRange = saved.markers.find((m) => m.id === range.id)
  const savedPoint = saved.markers.find((m) => m.id === point.id)
  check(
    'Two categories saved to session.json',
    JSON.stringify(savedPoint.categoryIds) === '["positive","separation"]' && !('categoryId' in savedPoint),
    JSON.stringify(savedPoint.categoryIds)
  )
  check(
    'Edited note text saved (transcript kept)',
    savedRange.notes[0].text === 'Traffico: chi va prima tra la 126 e la 582?' &&
      savedRange.notes[0].transcript === note.transcript
  )
  check('Range end moved', savedRange.endMs === range.timeMs + 20000)
  const mainSees = await main.eval(
    `window.api.getState().then(s => s.review.markers.find(m => m.kind === 'point').categoryIds.join(','))`
  )
  check('Edits reflected in the desktop app', mainSees === 'positive,separation', mainSees)
  check(
    'Bad marker id reports an error',
    (await send('toggleMarkerCategory', COPY, 'nope', 'positive')).error === 'Marker not found'
  )
  check(
    'Other folders refused',
    (await send('toggleMarkerCategory', '..', point.id, 'positive')).error === 'Unknown session'
  )

  // --- Notes window ------------------------------------------------------------------------
  await main.eval('window.api.openNotesWindow()')
  const notes = await cdp(await cdpTarget((url) => url.startsWith(base)))
  await sleep(2500)
  const text = await notes.eval('document.body.innerText')
  check(
    'Notes window shows the transcriptions',
    text.includes('Traffico: chi va prima') && text.includes('Trainer notes'),
    text.slice(0, 80).replace(/\n/g, ' | ')
  )
  const clickIn = (label) =>
    notes.eval(`(() => { const b = document.querySelector('[aria-label="${label}"]'); b?.click(); return !!b })()`)
  const videoTime = () => main.eval('document.querySelector("video").currentTime')
  await send('playerCommand', { type: 'seek', positionMs: 0 })
  await sleep(500)
  await clickIn('Next marker')
  await sleep(800)
  const afterNext = await videoTime()
  const errorShown = await notes.eval('document.body.innerText.includes("Not connected")')
  check('Notes window button moves the video (Next marker)', afterNext > 1 && !errorShown, afterNext.toFixed(2) + ' s')
  // Restart the Companion server: the page must reconnect and keep working.
  await main.eval('window.api.getState().then((s) => window.api.saveCompanionSettings(s.companionSettings))')
  await sleep(3500)
  await clickIn('Back 5 seconds')
  await sleep(800)
  const afterBack = await videoTime()
  const errorAfter = await notes.eval('document.body.innerText.includes("Not connected")')
  check(
    'Notes window still works after reconnecting',
    afterBack < afterNext && !errorAfter,
    afterBack.toFixed(2) + ' s'
  )
  await clickIn('1.5× speed')
  await sleep(800)
  const mainRate = await main.eval('document.querySelector("video").playbackRate')
  const shownRate = await notes.eval(
    'document.querySelector("[aria-label=\\"1.5× speed\\"]").getAttribute("aria-checked")'
  )
  check(
    'Notes window speed buttons change the video speed',
    mainRate === 1.5 && shownRate === 'true',
    `rate ${mainRate}, selected ${shownRate}`
  )
  await clickIn('1× speed')
  await notes.screenshot(join(OUT, 'trs-companion-review.png'))
  await main.screenshot(join(OUT, 'trs-review-main.png'))
  notes.close()

  ws.close()
  await main.eval('window.close()').catch(() => undefined)
  main.close()
  await new Promise((r) => {
    const timer = setTimeout(() => {
      app.kill()
      r()
    }, 8000)
    app.on('exit', () => {
      clearTimeout(timer)
      r()
    })
  })
  rmSync(join(SESSIONS, COPY), { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
}
main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
