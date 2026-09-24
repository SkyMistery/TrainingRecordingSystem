import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, type BrowserWindow } from 'electron'

/**
 * The Vite dev server during `npm run dev`. Never in the installed app: an
 * environment variable must not be able to load another page with the
 * app's preload (and so its whole API).
 */
export function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
}

const rendererDir = (): string => join(__dirname, '../renderer')

/** Loads the renderer into a window; `hash` picks the view (e.g. "status"). */
export function loadAppPage(window: BrowserWindow, hash?: string): Promise<void> {
  const dev = devServerUrl()
  if (dev) return window.loadURL(hash ? `${dev}#${hash}` : dev)
  return window.loadFile(join(rendererDir(), 'index.html'), hash ? { hash } : undefined)
}

/** Whether a URL is one of the app's own pages (not the Companion, not the web). */
export function isAppPage(url: string): boolean {
  const dev = devServerUrl()
  if (dev && url.startsWith(`${new URL(dev).origin}/`)) return true
  return url.startsWith(`${pathToFileURL(rendererDir()).href}/`)
}
