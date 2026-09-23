/**
 * Session files (screenshots, recordings) are served to the UI through this
 * scheme so they work both from the dev server and the packaged app:
 * trs-media://sessions/<session folder>/<relative path>
 */
export const MEDIA_SCHEME = 'trs-media'

export function mediaUrl(folderName: string, relativePath: string): string {
  const parts = [folderName, ...relativePath.split(/[\\/]/)].map(encodeURIComponent)
  return `${MEDIA_SCHEME}://sessions/${parts.join('/')}`
}
