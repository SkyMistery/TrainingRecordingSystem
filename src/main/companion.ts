import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import QRCode from 'qrcode'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CompanionInfo, CompanionSettings, CompanionState, SessionCommandName } from '../shared/types'
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
  'setMarkerCategory',
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

/** Addresses of real network adapters, home-network ranges (192.168.x, 10.x) first. */
function lanAddresses(): string[] {
  const addresses = Object.entries(networkInterfaces())
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .flatMap(([, nets]) => nets ?? [])
    .filter((net) => net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.'))
    .map((net) => net.address)
  const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return addresses.sort((x, y) => rank(x) - rank(y))
}

/** Whether a connected Windows network uses the Public profile (inbound connections blocked). */
function isPublicNetwork(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '@(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" }).Count'
      ],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(!error && Number(stdout.trim()) > 0)
    )
  })
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
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

  async restart(): Promise<void> {
    await this.stop()
    const settings = this.settings()
    if (!settings.enabled) {
      this.hooks.changed()
      return
    }
    const server = createServer((req, res) => void this.handle(req, res))
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin
      const allowed =
        req.url === '/ws' && sameToken(cookieToken(req), this.token()) && origin === `http://${req.headers.host}`
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
      const hosts = ['127.0.0.1', ...(settings.lan ? lanAddresses() : [])]
      this.urls = hosts.map((host) => this.pairUrl(host))
      this.publicNetwork = settings.lan ? await isPublicNetwork() : false
      // The QR code is for the tablet: the best network address, or this PC.
      this.qr = await QRCode.toDataURL(this.urls[1] ?? this.urls[0], { margin: 1, width: 240 })
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
    for (const client of this.sockets?.clients ?? []) client.close()
    this.sockets?.close()
    const server = this.server
    this.server = null
    this.sockets = null
    this.urls = []
    this.qr = null
    if (server) await new Promise<void>((done) => server.close(() => done()))
  }

  /** Sends the current state to every connected device. */
  broadcast(): void {
    if (!this.sockets || this.sockets.clients.size === 0) return
    const message = JSON.stringify({ type: 'state', state: this.hooks.state() })
    for (const client of this.sockets.clients) client.send(message)
  }

  private onClient(ws: WebSocket): void {
    ws.send(JSON.stringify({ type: 'state', state: this.hooks.state() }))
    this.hooks.changed()
    ws.on('close', () => this.hooks.changed())
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
      this.hooks
        .execute(name, args)
        .then(() => ws.send(JSON.stringify({ type: 'result', id })))
        .catch((error: unknown) =>
          ws.send(JSON.stringify({ type: 'result', id, error: error instanceof Error ? error.message : String(error) }))
        )
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

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

    if (url.pathname.startsWith('/media/')) {
      const file = sessionFilePath(
        url.pathname.slice('/media/'.length).split('/').filter(Boolean).map(decodeURIComponent)
      )
      if (!file) {
        res.writeHead(403).end()
        return
      }
      const response = await serveFile(file, req.headers.range ?? null)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res)
      else res.end()
      return
    }

    await this.serveApp(url.pathname === '/' ? '/companion.html' : url.pathname, req, res)
  }

  /** The Companion page is a second entry of the renderer build. */
  private async serveApp(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const devServer = process.env['ELECTRON_RENDERER_URL']
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
    const file = resolve(root, '.' + decodeURIComponent(path))
    if (!file.startsWith(root + sep)) {
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
      createReadStream(file).pipe(res)
    } catch {
      res.writeHead(404).end()
    }
  }
}
