import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import QRCode from 'qrcode'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  CompanionDeviceInfo,
  CompanionInfo,
  CompanionSettings,
  CompanionState,
  PlayerState,
  SessionCommandName
} from '../shared/types'
import { devServerUrl } from './appPages'
import { serveFile, sessionFilePath } from './media'

const COOKIE = 'trs_device'

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

/** What a device may download from /media: the screenshots and voice notes it shows. */
const MEDIA_TYPES = new Set(['.png', '.wav'])

/** Every answer: never framed by another page, never cached on a phone that may be lost, types as sent. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer'
}

/** Commands the Companion page may send; settings and recording control stay in the app. */
const ALLOWED_COMMANDS = new Set<SessionCommandName>([
  'addMarker',
  'toggleRange',
  'startNote',
  'stopNote',
  'toggleMarkerCategory',
  'setMarkerTimes',
  'deleteMarker',
  'setNoteText',
  'deleteNote',
  'retranscribeNote',
  'playerCommand',
  'holdPtt',
  'releasePtt'
])

/** Longest message a device may send (a note of 20,000 characters fits). */
const MAX_MESSAGE_BYTES = 256 * 1024
/** More devices than a trainer has: the rest is refused. */
const MAX_CLIENTS = 10
/** Messages per second a device may send on average, and in a burst. */
const MESSAGE_RATE = 20
const MESSAGE_BURST = 60
/** A device reading nothing while the app sends state: dropped past this backlog. */
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024

/** A paired device as stored in settings: never its token, only a digest of it. */
export interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  pairedAt: string
  lastSeenAt: string | null
}

/** The device a request or socket belongs to. */
export interface CompanionDevice {
  id: string
  name: string
}

export interface DeviceStore {
  list(): StoredDevice[]
  save(devices: StoredDevice[]): Promise<void>
}

interface CompanionHooks {
  state: () => CompanionState
  /** A command from a device; errors are sent back to it. */
  execute: (name: SessionCommandName, args: unknown[], device: CompanionDevice) => Promise<void>
  /** The device's last connection closed: what it held (push-to-talk, a note) must be released. */
  deviceGone: (device: CompanionDevice) => void
  /** A new device paired: the trainer is told, in case it isn't theirs. */
  paired: (device: CompanionDevice, address: string) => void
  /** Whether a device may download this file of this session (the one open, a file it shows). */
  mediaAllowed: (folderName: string, relativePath: string) => boolean
  /** Clients connected, devices changed or the server (re)started. */
  changed: () => void
}

/** Virtual adapters (WSL, Hyper-V, VPNs, VMs, hotspots) a tablet on the home network can't reach. */
const VIRTUAL_ADAPTER =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth|TAP|Tailscale|ZeroTier|Radmin|Hamachi|WireGuard|Wintun|NordLynx|ProtonVPN|Mullvad|OpenVPN|Cloudflare|WARP|VPN|Local Area Connection\*/i

/** Real network adapters (name and address), home-network ranges (192.168.x, 10.x) first. */
function lanAdapters(): { name: string; address: string }[] {
  const adapters = Object.entries(networkInterfaces())
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .flatMap(([name, nets]) => (nets ?? []).map((net) => ({ name, net })))
    .filter(({ net }) => net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.'))
    .map(({ name, net }) => ({ name, address: net.address }))
  const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return adapters.sort((x, y) => rank(x.address) - rank(y.address))
}

/** Whether Windows uses the Public profile (inbound connections blocked) on this adapter. */
function isPublicNetwork(adapter: string): Promise<boolean> {
  return new Promise((resolve) => {
    // The name is passed as an argument, never pasted into the command.
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '& { param($name) @(Get-NetConnectionProfile -InterfaceAlias $name | Where-Object { $_.NetworkCategory -eq "Public" }).Count }',
        adapter
      ],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(!error && Number(stdout.trim()) > 0)
    )
  })
}

/** Unanswered pings after which a device is considered gone (phone asleep, Wi-Fi lost). */
const HEARTBEAT_MS = 15_000

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Constant-time comparison; hashing first gives equal lengths whatever the client sent. */
function sameSecret(a: string | undefined | null, b: string): boolean {
  if (!a) return false
  return timingSafeEqual(digest(a), digest(b))
}

/** decodeURIComponent throws on malformed input such as "%E0". */
function decodePart(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

function decodeParts(path: string): string[] | null {
  const parts = path.split('/').filter(Boolean).map(decodePart)
  return parts.every((part): part is string => part !== null) ? parts : null
}

function cookieValue(req: IncomingMessage): string | undefined {
  const cookies = req.headers.cookie?.split(';').map((part) => part.trim().split('=')) ?? []
  return cookies.find(([name]) => name === COOKIE)?.[1]
}

/** "Android · Chrome", "iPhone · Safari", "Windows · Edge": enough to recognise one's own devices. */
function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const system = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'browser'
  return `${system} · ${browser}`
}

/** Error text for a device: no Windows paths (they carry the user name). */
function forDevice(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z]:\\[^'"\n]*/g, '…').replace(/\\\\[^'"\n]*/g, '…')
}

const PAIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="0; url=/"><title>Paired</title>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem">Paired. <a href="/">Continue</a></body>`

const UNPAIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Training Recording System</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#21212e">
<h1 style="font-size:1.4rem">Not paired</h1>
<p>Open <b>Setup → Companion</b> in Training Recording System and scan the QR code (or open its link) to pair this device. A pairing link works once.</p>`

/** The notes window on this PC: paired by the app itself, for this run only. */
const THIS_PC: CompanionDevice = { id: 'this-pc', name: 'Notes window (this PC)' }

/**
 * Local web server for the Companion page: the trainer's private notes and a
 * remote control, on a second monitor or a tablet. A device pairs once with a
 * one-time link (QR code) and gets its own secret in a cookie; every page,
 * file and WebSocket needs it, and each device can be removed on its own.
 */
export class CompanionServer {
  private server: Server | null = null
  private sockets: WebSocketServer | null = null
  private error: string | null = null
  private qr: string | null = null
  private urls: string[] = []
  private publicNetwork = false
  /** Restarts run one at a time, or two could fight over the port. */
  private restarting: Promise<void> = Promise.resolve()
  private heartbeat: NodeJS.Timeout | null = null
  private readonly alive = new WeakSet<WebSocket>()
  private readonly deviceOf = new Map<WebSocket, CompanionDevice>()
  /** Message allowance of each socket (token bucket). */
  private readonly allowance = new WeakMap<WebSocket, { tokens: number; at: number }>()
  /** The link in the QR code: good for one pairing, then replaced. Never stored. */
  private pairingCode = randomBytes(16).toString('hex')
  /** The notes window's secret: this run only. */
  private readonly localToken = randomBytes(32).toString('base64url')

  constructor(
    private readonly hooks: CompanionHooks,
    private readonly settings: () => CompanionSettings,
    private readonly devices: DeviceStore
  ) {}

  info(): CompanionInfo {
    const connected = new Set([...this.deviceOf.values()].map((device) => device.id))
    const devices: CompanionDeviceInfo[] = this.devices.list().map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      connected: connected.has(device.id)
    }))
    return {
      running: this.server !== null,
      error: this.error,
      urls: this.urls,
      qr: this.qr,
      clients: this.sockets?.clients.size ?? 0,
      publicNetwork: this.publicNetwork,
      devices
    }
  }

  /** One-time link that pairs a device (the first address is this PC). */
  pairUrl(host = '127.0.0.1'): string {
    return `http://${host}:${this.settings().port}/pair?code=${this.pairingCode}`
  }

  /** The Companion page for the notes window on this PC, and the cookie that lets it in. */
  localPage(): { url: string; cookie: { name: string; value: string } } {
    return {
      url: `http://127.0.0.1:${this.settings().port}/`,
      cookie: { name: COOKIE, value: `${THIS_PC.id}.${this.localToken}` }
    }
  }

  restart(): Promise<void> {
    const next = this.restarting.then(
      () => this.doRestart(),
      () => this.doRestart()
    )
    this.restarting = next.catch(() => undefined)
    return next
  }

  /** Addresses, network profile and QR code again (the network may have changed since the start). */
  async refreshNetwork(): Promise<void> {
    if (!this.server) return
    const settings = this.settings()
    const adapters = settings.lan ? lanAdapters() : []
    this.urls = ['127.0.0.1', ...adapters.map((adapter) => adapter.address)].map((host) => this.pairUrl(host))
    this.publicNetwork = adapters[0] ? await isPublicNetwork(adapters[0].name) : false
    // The QR code is for the tablet: without a network address there is nothing it could open.
    const target = settings.lan ? this.urls[1] : this.urls[0]
    this.qr = target ? await QRCode.toDataURL(target, { margin: 1, width: 240 }) : null
    this.hooks.changed()
  }

  /** Forgets devices: their cookies stop working at once and their connections close. */
  async removeDevices(ids: string[] | 'all'): Promise<void> {
    const remove = (id: string): boolean => ids === 'all' || ids.includes(id)
    await this.devices.save(this.devices.list().filter((device) => !remove(device.id)))
    for (const [socket, device] of this.deviceOf) if (device.id !== THIS_PC.id && remove(device.id)) socket.terminate()
    // A link seen by someone else before the removal must not pair them again.
    this.pairingCode = randomBytes(16).toString('hex')
    await this.refreshNetwork()
    this.hooks.changed()
  }

  /** Requests must arrive through this PC or a real network adapter, not a VPN or VM adapter. */
  private reachedThrough(req: IncomingMessage): boolean {
    const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '')
    return local === '127.0.0.1' || lanAdapters().some((adapter) => adapter.address === local)
  }

  /**
   * The Host a browser sends is the address it was given: this PC or one of its
   * network addresses. Anything else (a name of someone else's site pointed at
   * this PC: DNS rebinding) is refused.
   */
  private validHost(req: IncomingMessage): boolean {
    const port = this.settings().port
    const hosts = ['127.0.0.1', 'localhost', ...lanAdapters().map((adapter) => adapter.address)]
    return hosts.some((host) => req.headers.host === `${host}:${port}`)
  }

  /** The paired device a request comes from, from its cookie; null if none. */
  private authenticate(req: IncomingMessage): CompanionDevice | null {
    const value = cookieValue(req)
    const dot = value?.indexOf('.') ?? -1
    if (!value || dot <= 0) return null
    const id = value.slice(0, dot)
    const token = value.slice(dot + 1)
    if (id === THIS_PC.id) return sameSecret(token, this.localToken) ? THIS_PC : null
    const device = this.devices.list().find((item) => item.id === id)
    if (!device) return null
    return timingSafeEqual(digest(token), Buffer.from(device.tokenHash, 'hex')) ? { id, name: device.name } : null
  }

  private async doRestart(): Promise<void> {
    await this.stop()
    const settings = this.settings()
    if (!settings.enabled) {
      this.hooks.changed()
      return
    }
    // Anything a client sends must never throw out of here: the server runs in the app's main process.
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        console.warn('[companion] request failed', error)
        if (!res.headersSent) res.writeHead(400, SECURITY_HEADERS)
        res.end()
      })
    })
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => undefined)
      let device: CompanionDevice | null = null
      try {
        const origin = req.headers.origin
        if (
          req.url === '/ws' &&
          this.reachedThrough(req) &&
          this.validHost(req) &&
          origin === `http://${req.headers.host}` &&
          sockets.clients.size < MAX_CLIENTS
        ) {
          device = this.authenticate(req)
        }
      } catch {
        device = null
      }
      if (!device) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const paired = device
      sockets.handleUpgrade(req, socket, head, (ws) => this.onClient(ws, paired))
    })
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(settings.port, settings.lan ? '0.0.0.0' : '127.0.0.1', () => resolvePromise())
      })
      this.server = server
      this.sockets = sockets
      this.error = null
      // Pings find devices that went away without closing (a sleeping phone).
      this.heartbeat = setInterval(() => {
        for (const client of sockets.clients) {
          if (!this.alive.has(client)) {
            client.terminate()
            continue
          }
          this.alive.delete(client)
          client.ping()
        }
      }, HEARTBEAT_MS)
      await this.refreshNetwork()
    } catch (error) {
      this.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${settings.port} is already in use: choose another one.`
          : error instanceof Error
            ? error.message
            : String(error)
      server.close()
    }
    this.hooks.changed()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    // Terminate, not close: a sleeping phone would hold the close handshake for 30 s.
    for (const client of this.sockets?.clients ?? []) client.terminate()
    this.sockets?.close()
    const server = this.server
    this.server = null
    this.sockets = null
    this.urls = []
    this.qr = null
    if (server) {
      const closed = new Promise<void>((done) => server.close(() => done()))
      server.closeAllConnections()
      await closed
    }
  }

  /** Sends the current state to every connected device. */
  broadcast(): void {
    if (!this.sockets || this.sockets.clients.size === 0) return
    this.sendAll(JSON.stringify({ type: 'state', state: this.hooks.state(), serverNow: Date.now() }))
  }

  /** The review player's position, several times a second: only that, not the whole state. */
  sendPlayer(player: PlayerState): void {
    if (!this.sockets || this.sockets.clients.size === 0) return
    this.sendAll(JSON.stringify({ type: 'player', player, serverNow: Date.now() }))
  }

  private sendAll(message: string): void {
    for (const client of this.sockets?.clients ?? []) {
      // A device that reads nothing (or only answers pings) must not make the app buffer forever.
      if (client.bufferedAmount > MAX_BACKLOG_BYTES) client.terminate()
      else client.send(message)
    }
  }

  /** Token bucket: false once a device sends faster than any person could. */
  private withinRate(ws: WebSocket): boolean {
    const now = Date.now()
    const bucket = this.allowance.get(ws) ?? { tokens: MESSAGE_BURST, at: now }
    bucket.tokens = Math.min(MESSAGE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * MESSAGE_RATE)
    bucket.at = now
    bucket.tokens -= 1
    this.allowance.set(ws, bucket)
    return bucket.tokens >= 0
  }

  private onClient(ws: WebSocket, device: CompanionDevice): void {
    ws.on('error', (error) => console.warn('[companion] socket error', error.message))
    this.alive.add(ws)
    this.deviceOf.set(ws, device)
    ws.on('pong', () => this.alive.add(ws))
    ws.send(JSON.stringify({ type: 'hello', deviceId: device.id }))
    ws.send(JSON.stringify({ type: 'state', state: this.hooks.state(), serverNow: Date.now() }))
    void this.touch(device)
    this.hooks.changed()
    ws.on('close', () => {
      this.deviceOf.delete(ws)
      // Its push-to-talk and note releases will never arrive: release them now (unless it is still connected).
      if (![...this.deviceOf.values()].some((other) => other.id === device.id)) this.hooks.deviceGone(device)
      this.hooks.changed()
    })
    ws.on('message', (data) => {
      // Whatever arrives, nothing may throw out of here (the main process would show an error dialog).
      try {
        if (!this.withinRate(ws)) {
          ws.close(1008, 'Too many messages')
          return
        }
        this.onMessage(ws, device, String(data))
      } catch (error) {
        console.warn('[companion] bad message from', device.name, error instanceof Error ? error.message : error)
      }
    })
  }

  private onMessage(ws: WebSocket, device: CompanionDevice, data: string): void {
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    const { id, name, args } = message as { id?: unknown; name?: unknown; args?: unknown }
    // Only a plain number goes back: anything else (a huge nested value) is not echoed.
    const replyId = Number.isSafeInteger(id) ? (id as number) : null
    const reply = (error?: string): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', id: replyId, error }))
    }
    if (
      typeof name !== 'string' ||
      !ALLOWED_COMMANDS.has(name as SessionCommandName) ||
      !Array.isArray(args) ||
      args.length > 4
    ) {
      reply('Unknown command')
      return
    }
    this.hooks.execute(name as SessionCommandName, args, device).then(
      () => reply(),
      (error: unknown) => reply(forDevice(error))
    )
  }

  /** Remembers when a device was last connected (shown in Setup). */
  private async touch(device: CompanionDevice): Promise<void> {
    if (device.id === THIS_PC.id) return
    const now = new Date().toISOString()
    await this.devices
      .save(this.devices.list().map((item) => (item.id === device.id ? { ...item, lastSeenAt: now } : item)))
      .catch(() => undefined)
  }

  private async pair(req: IncomingMessage, res: ServerResponse, code: string | null): Promise<void> {
    if (!sameSecret(code, this.pairingCode)) {
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }).end(UNPAIRED_PAGE)
      return
    }
    // Used: the link (seen in a browser history, a screenshot…) pairs nobody else.
    this.pairingCode = randomBytes(16).toString('hex')
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomBytes(6).toString('hex'),
      name: deviceName(req.headers['user-agent']),
      tokenHash: digest(token).toString('hex'),
      pairedAt: new Date().toISOString(),
      lastSeenAt: null
    }
    await this.devices.save([...this.devices.list(), device])
    this.hooks.paired({ id: device.id, name: device.name }, req.socket.remoteAddress ?? '')
    void this.refreshNetwork()
    // The cookie outlives the link. A page (not a redirect) continues to "/",
    // so the next request is a same-site navigation: links opened from a
    // camera app count as cross-site, and some browsers drop the cookie on a
    // redirect then. Lax still keeps it off cross-site sub-requests, and the
    // WebSocket checks the Origin anyway.
    res
      .writeHead(200, {
        ...SECURITY_HEADERS,
        'Set-Cookie': `${COOKIE}=${device.id}.${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
        'Content-Type': 'text/html; charset=utf-8'
      })
      .end(PAIRED_PAGE)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.reachedThrough(req) || !this.validHost(req)) {
      res.writeHead(403, SECURITY_HEADERS).end()
      return
    }
    // A request line like "GET //x" is not a valid path for URL.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400, SECURITY_HEADERS).end()
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const from = `${req.socket.remoteAddress} ${req.headers['user-agent'] ?? ''}`
    if (url.pathname === '/' || url.pathname === '/pair')
      console.info(`[companion] ${req.method} ${url.pathname} from ${from}`)

    if (url.pathname === '/pair') {
      await this.pair(req, res, url.searchParams.get('code'))
      return
    }

    const device = this.authenticate(req)
    if (!device) {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }).end(UNPAIRED_PAGE)
      return
    }

    if (url.pathname === '/client-error' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      for await (const chunk of req) {
        body += chunk
        if (body.length > 2000) break
      }
      console.warn(`[companion] page error on ${device.name}: ${body.slice(0, 2000).replace(/\s+/g, ' ')}`)
      res.writeHead(204, SECURITY_HEADERS).end()
      return
    }

    if (url.pathname.startsWith('/media/')) {
      const parts = decodeParts(url.pathname.slice('/media/'.length))
      const file = parts && parts.length >= 2 && sessionFilePath(parts)
      const allowed =
        file &&
        MEDIA_TYPES.has(extname(file).toLowerCase()) &&
        this.hooks.mediaAllowed(parts[0], parts.slice(1).join('/'))
      if (!allowed) {
        res.writeHead(403, SECURITY_HEADERS).end()
        return
      }
      const response = await serveFile(file, req.headers.range ?? null)
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...SECURITY_HEADERS })
      // pipeline, not pipe: an aborted download (seek, closed page) must close the file,
      // or Windows refuses to rename or delete the session folder afterwards.
      if (response.body) {
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res).catch(
          () => undefined
        )
      } else res.end()
      return
    }

    await this.serveApp(url.pathname === '/' ? '/companion.html' : url.pathname, req, res)
  }

  /** The Companion page is a second entry of the renderer build. */
  private async serveApp(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const devServer = devServerUrl()
    if (devServer) {
      const target = new URL(path + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), devServer)
      const upstream = httpRequest(
        target,
        { method: req.method, headers: { ...req.headers, host: target.host } },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        }
      )
      upstream.on('error', () => res.writeHead(502).end())
      req.pipe(upstream)
      return
    }
    const root = resolve(join(__dirname, '../renderer'))
    const decoded = decodePart(path)
    const file = decoded === null ? null : resolve(root, '.' + decoded)
    if (!file || !file.startsWith(root + sep)) {
      res.writeHead(403, SECURITY_HEADERS).end()
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size
      })
      await pipeline(createReadStream(file), res).catch(() => undefined)
    } catch {
      res.writeHead(404, SECURITY_HEADERS).end()
    }
  }
}
