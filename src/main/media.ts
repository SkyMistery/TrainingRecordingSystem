import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { MEDIA_SCHEME } from '../shared/media'
import { getSettings } from './settings'

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/** Serves files from the sessions folder only; see shared/media.ts for the URL shape. */
export function handleMediaScheme(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'sessions') return new Response('Not found', { status: 404 })
    const root = resolve(getSettings().sessionsDir)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const file = resolve(root, ...parts)
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
  })
}
