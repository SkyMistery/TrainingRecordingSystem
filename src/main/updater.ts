import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/** Besides the check at startup: the app often stays open for hours. */
const CHECK_EVERY_MS = 6 * 60 * 60_000

/**
 * Tells the trainer about new versions on GitHub Releases, and only with
 * their say-so downloads one ("Update to …") and installs it ("Restart to
 * update"): nothing is downloaded or installed by itself, and never while
 * recording (the buttons refuse it).
 */
let current: UpdateState | null = null
let report: (state: UpdateState | null) => void = () => undefined

function set(state: UpdateState | null): void {
  current = state
  report(state)
}

export function startUpdater(onState: (state: UpdateState | null) => void): void {
  if (!app.isPackaged) return
  report = onState
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => {
    if (current) set({ ...current, status: 'downloading', percent: Math.floor(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (error) => {
    console.error('Update failed', error)
    // Offline at startup is not worth showing; a download that stopped is (the button tries again).
    if (current?.status === 'downloading') set({ ...current, status: 'error' })
  })
  const check = (): void => {
    if (current && current.status !== 'error') return
    // Only a check: no Windows notification (it could show on the recorded or shared screen).
    autoUpdater.checkForUpdates().catch((error: unknown) => console.error('Update check failed', error))
  }
  check()
  setInterval(check, CHECK_EVERY_MS)
}

/** "Update to …" confirmed: downloads it in the background (progress in the top bar). */
export async function downloadUpdate(): Promise<void> {
  if (!current || (current.status !== 'available' && current.status !== 'error')) return
  set({ ...current, status: 'downloading', percent: 0 })
  await autoUpdater.downloadUpdate()
}

/** Runs the downloaded installer silently and starts the new version afterwards. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
