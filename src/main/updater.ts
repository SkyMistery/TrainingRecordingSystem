import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/** Besides the check at startup: the app often stays open for hours. */
const CHECK_EVERY_MS = 6 * 60 * 60_000

/**
 * Keeps the installed app up to date from GitHub Releases. The update is
 * downloaded in the background and shown in the top bar; it is installed when
 * the app closes, or right away with "Restart to update".
 */
export function startUpdater(onState: (state: UpdateState | null) => void): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  let current: UpdateState | null = null
  const set = (state: UpdateState | null): void => {
    current = state
    onState(state)
  }
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => {
    if (current) set({ ...current, status: 'downloading', percent: Math.floor(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (error) => {
    console.error('Update failed', error)
    // Offline at startup is not worth showing; a download that stopped is (the next check retries).
    if (current?.status === 'downloading') set({ ...current, status: 'error' })
  })
  const check = (): void => {
    if (current?.status === 'ready') return
    autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => console.error('Update check failed', error))
  }
  check()
  setInterval(check, CHECK_EVERY_MS)
}

/** Runs the downloaded installer silently and starts the new version afterwards. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
