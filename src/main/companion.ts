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
import type { CompanionInfo, CompanionSettings, CompanionState, SessionCommandName } from '../shared/types'
import { devServerUrl } from './appPages'
import { serveFile, sessionFilePath } from './media'

const COOKIE = 'trs_companion'

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
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
  'playerCommand'
])

export function newCompanionToken(): string {
  return randomBytes(24).toString('hex')
}

interface CompanionHooks {
  state: () => CompanionState
  execute: (name: SessionCommandName, args: unknown[]) => Promise<void>
  /** Clients connected or the server (re)started. */
  changed: () => void
}

/** Virtual adapters (WSL, Hyper-V, VPNs, VMs) a tablet can't reach. */
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth|TAP|Tailscale|ZeroTier/i

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
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `@(Get-NetConnectionProfile -InterfaceAlias '${adapter.replace(/'/g, "''")}' | Where-Object { $_.NetworkCategory -eq "Public" }).Count`
      ],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(!error && Number(stdout.trim()) > 0)
    )
  })
}

/** Unanswered pings after which a device is considered gone (phone asleep, Wi-Fi lost). */
const HEARTBEAT_MS = 15_000

/** Constant-time comparison; hashing first gives equal lengths whatever the client sent. */
function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
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

function cookieToken(req: IncomingMessage): string | undefined {
  const cookies = req.headers.cookie?.split(';').map((part) => part.trim().split('=')) ?? []
  return cookies.find(([name]) => name === COOKIE)?.[1]
}

const PAIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="0; url=/"><title>Paired</title>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem">Paired. <a href="/">Continue</a></body>`

const UNPAIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Training Recording System</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#21212e">
<h1 style="font-size:1.4rem">Not paired</h1>
<p>Open <b>Setup → Companion</b> in Training Recording System and scan the QR code (or open its link) to pair this device.</p>`

/**
 * Local web server for the Companion page: the trainer's private notes and a
 * remote control, on a second monitor or a tablet. Devices pair with a secret
 * link (QR code) that sets a cookie; every page, file and WebSocket needs it.
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
  /** The device holding the push-to-talk button: its note ends if it goes away. */
  private noteOwner: WebSocket | null = null

  constructor(
    private readonly hooks: CompanionHooks,
    private readonly settings: () => CompanionSettings,
    private readonly token: () => string
  ) {}

  info(): CompanionInfo {
    return {
      running: this.server !== null,
      error: this.error,
      urls: this.urls,
      qr: this.qr,
      clients: this.sockets?.clients.size ?? 0,
      publicNetwork: this.publicNetwork
    }
  }

  /** Link that pairs a device (the first one is this PC). */
  pairUrl(host = '127.0.0.1'): string {
    return `http://${host}:${this.settings().port}/pair?token=${this.token()}`
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

  /** Requests must arrive through this PC or a real network adapter, not a VPN or VM adapter. */
  private reachedThrough(req: IncomingMessage): boolean {
    const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '')
    return local === '127.0.0.1' || lanAdapters().some((adapter) => adapter.address === local)
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
        if (!res.headersSent) res.writeHead(400)
        res.end()
      })
    })
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => undefined)
      const origin = req.headers.origin
      let allowed = false
      try {
        allowed =
          req.url === '/ws' &&
          this.reachedThrough(req) &&
          sameToken(cookieToken(req), this.token()) &&
          origin === `http://${req.headers.host}`
      } catch {
        allowed = false
      }
      if (!allowed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      sockets.handleUpgrade(req, socket, head, (ws) => this.onClient(ws))
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
    const message = JSON.stringify({ type: 'state', state: this.hooks.state() })
    for (const client of this.sockets.clients) client.send(message)
  }

  private onClient(ws: WebSocket): void {
    ws.on('error', (error) => console.warn('[companion] socket error', error.message))
    this.alive.add(ws)
    ws.on('pong', () => this.alive.add(ws))
    ws.send(JSON.stringify({ type: 'state', state: this.hooks.state() }))
    this.hooks.changed()
    ws.on('close', () => {
      // Its push-to-talk release will never arrive: end the note now.
      if (this.noteOwner === ws) {
        this.noteOwner = null
        this.hooks.execute('stopNote', []).catch(() => undefined)
      }
      this.hooks.changed()
    })
    ws.on('message', (data) => {
      let message: { id?: number; name?: SessionCommandName; args?: unknown[] }
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      const { id, name, args } = message
      if (!name || !ALLOWED_COMMANDS.has(name) || !Array.isArray(args)) {
        ws.send(JSON.stringify({ type: 'result', id, error: 'Unknown command' }))
        return
      }
      if (name === 'startNote') this.noteOwner = ws
      if (name === 'stopNote') {
        // Another device releasing its button must not end this device's note.
        if (this.noteOwner && this.noteOwner !== ws && this.noteOwner.readyState === this.noteOwner.OPEN) {
          ws.send(JSON.stringify({ type: 'result', id }))
          return
        }
        this.noteOwner = null
      }
      this.hooks
        .execute(name, args)
        .then(() => ws.send(JSON.stringify({ type: 'result', id })))
        .catch((error: unknown) =>
          ws.send(JSON.stringify({ type: 'result', id, error: error instanceof Error ? error.message : String(error) }))
        )
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.reachedThrough(req)) {
      res.writeHead(403).end()
      return
    }
    // A request line like "GET //x" is not a valid path for URL.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end()
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const device = `${req.socket.remoteAddress} ${req.headers['user-agent'] ?? ''}`
    if (url.pathname === '/' || url.pathname === '/pair')
      console.info(`[companion] ${req.method} ${url.pathname} from ${device}`)

    if (url.pathname === '/pair') {
      if (!sameToken(url.searchParams.get('token') ?? undefined, this.token())) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(UNPAIRED_PAGE)
        return
      }
      // The cookie outlives the link. A page (not a redirect) continues to "/",
      // so the next request is a same-site navigation: links opened from a
      // camera app count as cross-site, and some browsers drop the cookie on a
      // redirect then. Lax still keeps it off cross-site sub-requests, and the
      // WebSocket checks the Origin anyway.
      res
        .writeHead(200, {
          'Set-Cookie': `${COOKIE}=${this.token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer'
        })
        .end(PAIRED_PAGE)
      return
    }

    if (!sameToken(cookieToken(req), this.token())) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(UNPAIRED_PAGE)
      return
    }

    if (url.pathname === '/client-error' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      for await (const chunk of req) {
        body += chunk
        if (body.length > 2000) break
      }
      console.warn(`[companion] page error on ${device}: ${body.slice(0, 2000)}`)
      res.writeHead(204).end()
      return
    }

    if (url.pathname.startsWith('/media/')) {
      const parts = decodeParts(url.pathname.slice('/media/'.length))
      const file = parts && sessionFilePath(parts)
      if (!file) {
        res.writeHead(403).end()
        return
      }
      const response = await serveFile(file, req.headers.range ?? null)
      res.writeHead(response.status, Object.fromEntries(response.headers))
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
      res.writeHead(403).end()
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, {
        'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size
      })
      await pipeline(createReadStream(file), res).catch(() => undefined)
    } catch {
      res.writeHead(404).end()
    }
  }
}
