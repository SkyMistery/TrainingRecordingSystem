/**
 * Session files (screenshots, recordings, notes) are served to the desktop UI
 * through this scheme, so they work both from the dev server and the packaged
 * app: trs-media://sessions/<session folder>/<relative path>
 */
export const MEDIA_SCHEME = 'trs-media'

/** The Companion page loads the same files over HTTP from /media/. */
let base = `${MEDIA_SCHEME}://sessions/`

export function setMediaBase(prefix: string): void {
  base = prefix
}

export function mediaUrl(folderName: string, relativePath: string): string {
  const parts = [folderName, ...relativePath.split(/[\\/]/)].map(encodeURIComponent)
  return `${base}${parts.join('/')}`
}
