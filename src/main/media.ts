import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME } from '../shared/media'
import { getSettings } from './settings'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json'
}

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/** Resolves a path inside the sessions folder, or null if it would escape it. */
export function sessionFilePath(parts: string[]): string | null {
  const root = resolve(getSettings().sessionsDir)
  const file = resolve(root, ...parts)
  // relative() also works when the sessions folder is a drive root (E:\), unlike a prefix check.
  const inside = relative(root, file)
  const escapes = inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
  return escapes ? null : file
}

/**
 * Serves a file with HTTP range support, which the video player needs to seek
 * in long recordings without reading the whole file.
 */
export async function serveFile(file: string, rangeHeader: string | null): Promise<Response> {
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response('Not found', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const range = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!range || (range[1] === '' && range[2] === '')) {
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  }
  // "bytes=-500" means the last 500 bytes.
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
  const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start > end || start >= size) {
    return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  })
}

/** Serves files from the sessions folder only; see shared/media.ts for the URL shape. */
export function handleMediaScheme(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'sessions') return new Response('Not found', { status: 404 })
    let parts: string[]
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const file = sessionFilePath(parts)
    if (!file) return new Response('Forbidden', { status: 403 })
    return serveFile(file, request.headers.get('range'))
  })
}
