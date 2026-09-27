// End-to-end test of the review: player, Companion server security, WebSocket
// commands and the notes window, in an isolated app instance (own settings and
// sessions folder in %TEMP%). Uses a copy of a real session (never the session
// itself): TRS_REVIEW_SESSION=<folder name>, or the newest session with a
// recording, a range and voice notes.
const { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const WS = require('ws')
const { check, isolatedSettings, launch, realSettings, report, sleep, waitForState } = require('./lib.cjs')

const PORT = 17646
const CDP_PORT = 9334
const COPY = '2026-09-24_0100_000000_E2E_REVIEW'
/** Screenshots for a human look (they show transcriptions): kept only if asked for. */
const KEEP_SCREENSHOTS = process.env.TRS_KEEP_SCREENSHOTS === '1'

function realSessionsDir() {
  try {
    const dir = realSettings().sessionsDir
    if (dir) return dir
  } catch {}
  return join(process.env.USERPROFILE, 'Documents', 'IVAO TRS', 'Sessions')
}

/** A real session to copy: the one named, or the newest one with a recording, a range and notes. */
function pickSource(dir) {
  if (process.env.TRS_REVIEW_SESSION) return process.env.TRS_REVIEW_SESSION
  const candidates = readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'session.json')) && existsSync(join(dir, name, 'recording.mp4')))
    .map((name) => ({ name, session: JSON.parse(readFileSync(join(dir, name, 'session.json'), 'utf8')) }))
    .filter(
      ({ session }) =>
        session.markers?.some((m) => m.kind === 'range' && m.notes?.length) &&
        session.markers.some((m) => m.kind === 'point')
    )
    .sort((a, b) => b.name.localeCompare(a.name))
  if (!candidates[0])
    throw new Error('No session with a recording, a range with notes and a point marker: set TRS_REVIEW_SESSION')
  return candidates[0].name
}

async function cdpTarget(match) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const target = list.find((t) => t.type === 'page' && match(t.url))
      if (target) return target
    } catch {}
    await sleep(500)
  }
  throw new Error('target not found')
}

/** A second CDP handle (the notes window), with screenshots. */
async function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => reject(new Error(`no answer: ${method}`)), 60_000)
      const h = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== n) return
        clearTimeout(timer)
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
  const realDir = realSessionsDir()
  const source = pickSource(realDir)
  console.log('[e2e] copy of', source)
  const settings = isolatedSettings('review', { companion: { enabled: true, lan: false, port: PORT } })
  const sessionsDir = settings.sessionsDir
  rmSync(join(sessionsDir, COPY), { recursive: true, force: true })
  cpSync(join(realDir, source), join(sessionsDir, COPY), { recursive: true })
  const sessionFile = join(sessionsDir, COPY, 'session.json')
  const copy = JSON.parse(readFileSync(sessionFile, 'utf8'))
  copy.metadata.traineeName = 'E2E test'
  writeFileSync(sessionFile, JSON.stringify(copy, null, 2))
  // Every text the trainer's notes hold: none may ever show in the shareable review window.
  const noteTexts = copy.markers
    .flatMap((m) => m.notes ?? [])
    .flatMap((n) => [n.text, n.transcript])
    .filter((text) => typeof text === 'string' && text.trim().length >= 8)
    .map((text) => text.trim().slice(0, 40))

  const run = await launch({ name: 'review', port: CDP_PORT, settings })
  const main = await cdp(await cdpTarget((url) => url.endsWith('index.html')))
  const screenshots = []
  let ws = null
  try {
    let state = await waitForState(run.evaluate, (s) => s.companion.running)
    check(
      'Companion server running on 127.0.0.1 only by default',
      state.companion.running && state.companion.urls.length === 1
    )
    const pair = new URL(state.companion.urls[0])
    const base = `http://${pair.host}`
    const code = pair.searchParams.get('code')

    // --- HTTP security ---------------------------------------------------------------
    check('Unpaired request refused', (await fetch(base + '/')).status === 401)
    check(
      'Wrong pairing code refused',
      (await fetch(base + '/pair?code=' + 'x'.repeat(code.length), { redirect: 'manual' })).status === 403
    )
    const paired = await fetch(pair.href, { redirect: 'manual' })
    const setCookie = paired.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]
    check(
      'Pairing sets an HttpOnly, SameSite=Lax cookie and continues to the page',
      paired.status === 200 &&
        /HttpOnly/.test(setCookie) &&
        /SameSite=Lax/.test(setCookie) &&
        (await paired.text()).includes('url=/')
    )
    check('Answers can’t be framed by another page', paired.headers.get('x-frame-options') === 'DENY')
    const page = await fetch(base + '/', { headers: { cookie } })
    check('Companion page served once paired', page.status === 200 && (await page.text()).includes('Trainer notes'))
    const beforeReview = await fetch(`${base}/media/${encodeURIComponent(COPY)}/${copy.markers[0].screenshot}`, {
      headers: { cookie }
    })
    check('No media while no session is open', beforeReview.status === 403, String(beforeReview.status))
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
    const host = `Host: 127.0.0.1:${PORT}`
    const multibyte = 'é' + 'a'.repeat(code.length - 1)
    const badRequests = [
      ['Request line "//" answered', `GET // HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`],
      [
        'Multibyte pairing code answered',
        `GET /pair?code=${encodeURIComponent(multibyte)} HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`
      ],
      [
        'Multibyte cookie answered',
        `GET / HTTP/1.1\r\n${host}\r\nCookie: trs_device=ab.${multibyte}\r\nConnection: close\r\n\r\n`
      ],
      [
        'Malformed media path answered',
        `GET /media/%E0%A4%A HTTP/1.1\r\n${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`
      ],
      [
        'Malformed static path answered',
        `GET /%E0%A4%A HTTP/1.1\r\n${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`
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
        const socket = new WS(`ws://${pair.host}/ws`, { headers })
        socket.on('open', () => resolve({ ok: true, ws: socket }))
        socket.on('error', () => resolve({ ok: false }))
        socket.on('unexpected-response', () => resolve({ ok: false }))
      })
    check('WebSocket refused without cookie', !(await wsOpen({ origin: base })).ok)
    check('WebSocket refused from another origin', !(await wsOpen({ cookie, origin: 'http://evil.example' })).ok)
    const opened = await wsOpen({ cookie, origin: base })
    check('WebSocket accepted when paired, same origin', opened.ok)
    ws = opened.ws
    let companion = null
    const results = new Map()
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.type === 'state') companion = message.state
      else if (message.type === 'player' && companion?.review) companion.review.player = message.player
      else if (message.type === 'result') results.get(message.id)?.(message)
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
    const withShot = companion.review.markers.find((m) => m.screenshot)
    if (withShot) {
      const shot = await fetch(`${base}/media/${encodeURIComponent(COPY)}/${withShot.screenshot}`, {
        headers: { cookie, range: 'bytes=0-99' }
      })
      check(
        'A screenshot of the open session served with HTTP range (206, 100 bytes)',
        shot.status === 206 && (await shot.arrayBuffer()).byteLength === 100
      )
    }
    const mp4 = await fetch(`${base}/media/${encodeURIComponent(COPY)}/recording.mp4`, { headers: { cookie } })
    check('The recording itself is not served to devices', mp4.status === 403, String(mp4.status))
    const video = await main.eval(
      `(() => { const v = document.querySelector('video'); return v && { ready: v.readyState, duration: v.duration } })()`
    )
    check('Review video loads', video && video.ready >= 1 && video.duration > 60, JSON.stringify(video))
    const leaked = async () => {
      const shown = await main.eval('document.body.innerText')
      return noteTexts.filter((text) => shown.includes(text))
    }
    let leaks = await leaked()
    check(
      `No note text in the shareable review window (${noteTexts.length} texts checked)`,
      noteTexts.length > 0 && leaks.length === 0,
      leaks.join(' | ')
    )

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
    if (KEEP_SCREENSHOTS) await main.screenshot(join(tmpdir(), 'trs-review-zoom.png'))
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
    const range = companion.review.markers.find((m) => m.kind === 'range' && m.notes.length)
    const tPrev = await main.eval(`document.querySelector('video').currentTime`)
    // The marker before 30 s, or no move at all if there is none.
    const previousExpected = [...companion.review.markers]
      .filter((m) => m.timeMs < 30000 - 1500)
      .sort((a, b) => a.timeMs - b.timeMs)
      .at(-1)
    check(
      'Previous marker jumps to the marker before',
      Math.abs(tPrev * 1000 - (previousExpected?.timeMs ?? 30000)) < 300,
      `${tPrev.toFixed(2)} s`
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
    const NEW_TEXT = 'Traffico: chi va prima tra la 126 e la 582?'
    await send('setNoteText', COPY, range.id, note.id, NEW_TEXT)
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
      savedRange.notes[0].text === NEW_TEXT && savedRange.notes[0].transcript === note.transcript
    )
    check('Range end moved', savedRange.endMs === range.timeMs + 20000)
    const mainSees = await main.eval(
      `window.api.getState().then(s => s.review.markers.find(m => m.id === ${JSON.stringify(point.id)}).categoryIds.join(','))`
    )
    check('Edits reflected in the desktop app', mainSees === 'positive,separation', mainSees)
    noteTexts.push(NEW_TEXT)
    leaks = await leaked()
    check('Still no note text in the review window after editing one', leaks.length === 0, leaks.join(' | '))
    check(
      'Bad marker id reports an error',
      (await send('toggleMarkerCategory', COPY, 'nope', 'positive')).error === 'Marker not found'
    )
    check('Other folders refused', Boolean((await send('toggleMarkerCategory', '..', point.id, 'positive')).error))

    // --- Notes window ------------------------------------------------------------------------
    await main.eval('window.api.openNotesWindow()')
    const notes = await cdp(await cdpTarget((url) => url.startsWith(base)))
    await sleep(2500)
    const text = await notes.eval('document.body.innerText')
    check(
      'Notes window opens without pairing and shows the transcriptions',
      text.includes('Traffico: chi va prima') && text.includes('Trainer notes'),
      text.slice(0, 80).replace(/\n/g, ' | ')
    )
    state = await run.evaluate('window.api.getState()')
    check(
      'The notes window is not listed as a paired device',
      state.companion.devices.length === 1,
      JSON.stringify(state.companion.devices.map((d) => d.name))
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
    check(
      'Notes window button moves the video (Next marker)',
      afterNext > 1 && !errorShown,
      afterNext.toFixed(2) + ' s'
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
    const onVideo = (expression) => main.eval(`document.querySelector("video").${expression}`)
    await onVideo('currentTime = 20')
    await sleep(500)
    await clickIn('Back 10 seconds')
    await sleep(800)
    const afterBack10 = await videoTime()
    check('Notes window: back 10 seconds', Math.abs(afterBack10 - 10) < 0.5, afterBack10.toFixed(2) + ' s')
    await clickIn('Forward 10 seconds')
    await sleep(800)
    const afterForward10 = await videoTime()
    check('Notes window: forward 10 seconds', Math.abs(afterForward10 - 20) < 0.5, afterForward10.toFixed(2) + ' s')
    await clickIn('10× speed')
    await onVideo('currentTime = 30')
    await onVideo('play()')
    // Measured once playing: after 1× Chromium may stall at 10× until the page's stall check seeks (~1.5 s).
    await sleep(2500)
    const fastFrom = await videoTime()
    await sleep(1000)
    const fastTime = (await videoTime()) - fastFrom
    const fastState = await onVideo('paused ? "paused" : "playing"')
    await onVideo('pause()')
    const fastRate = await onVideo('playbackRate')
    check(
      '10× speed plays ten times faster',
      fastRate === 10 && fastTime > 6,
      `rate ${fastRate}, ${fastTime.toFixed(2)} s of video in 1 s from ${fastFrom.toFixed(2)} s (${fastState})`
    )
    await clickIn('1× speed')
    if (KEEP_SCREENSHOTS) {
      await notes.screenshot(join(tmpdir(), 'trs-companion-review.png'))
      await main.screenshot(join(tmpdir(), 'trs-review-main.png'))
      screenshots.push('trs-companion-review.png', 'trs-review-main.png', 'trs-review-zoom.png')
    }
    notes.close()
  } finally {
    ws?.close()
    main.close()
    await run.close()
    rmSync(join(sessionsDir, COPY), { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(run.userData, { recursive: true, force: true })
    if (screenshots.length)
      console.log('[e2e] screenshots in', tmpdir(), '(they show transcriptions: delete them after looking)')
  }
  report()
}
main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
