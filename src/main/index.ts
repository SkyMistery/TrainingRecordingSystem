import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import { Controller } from './controller'
import { handleMediaScheme, registerMediaScheme } from './media'
import { getSettings, updateSettings } from './settings'

registerMediaScheme()

// Atmosphere page background (--body) for each theme, used before the UI paints.
const BODY_COLOR: Record<Theme, string> = { day: '#ffffff', night: '#12131b' }

let mainWindow: BrowserWindow | null = null
let controller: Controller | null = null
/** Quitting waits for the recording to stop and OBS to get its profile back. */
let quitState: 'running' | 'shuttingDown' | 'done' = 'running'

function effectiveTheme(): Theme {
  return nativeTheme.shouldUseDarkColors ? 'night' : 'day'
}

function applyThemePreference(preference: ThemePreference): void {
  nativeTheme.themeSource = preference === 'day' ? 'light' : preference === 'night' ? 'dark' : 'system'
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: BODY_COLOR[effectiveTheme()],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Closing the window while recording goes through the quit confirmation.
  mainWindow.on('close', (event) => {
    if (quitState === 'running' && controller?.isRecording()) {
      event.preventDefault()
      app.quit()
    }
  })
  // The hidden microphone window would otherwise keep the app running.
  mainWindow.on('closed', () => {
    mainWindow = null
    app.quit()
  })

  // Links open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('theme:get', (): ThemeState => ({ theme: effectiveTheme(), preference: getSettings().theme }))
  ipcMain.handle('theme:set', async (_event, preference: ThemePreference) => {
    applyThemePreference(preference)
    await updateSettings({ theme: preference })
    return effectiveTheme()
  })
  nativeTheme.on('updated', () => {
    const theme = effectiveTheme()
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(BODY_COLOR[theme])
      window.webContents.send('theme:changed', theme)
    }
  })
}

app.whenReady().then(async () => {
  applyThemePreference(getSettings().theme)
  handleMediaScheme()
  registerIpc()
  controller = new Controller()
  await controller.init()
  createMainWindow()

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      console.error('Update check failed', error)
    })
  }
})

app.on('window-all-closed', () => app.quit())

// Stop the recording cleanly and give OBS back the trainer's own profile.
app.on('before-quit', (event) => {
  if (quitState === 'done') return
  event.preventDefault()
  // Closing windows during shutdown asks to quit again: let the first request finish.
  if (quitState === 'shuttingDown') return
  void (async () => {
    if (controller?.isRecording() && mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Stop recording and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'A training session is being recorded.',
        detail: 'Quitting stops the recording. The session and everything recorded so far are kept.'
      })
      if (response !== 0) return
    }
    quitState = 'shuttingDown'
    await controller?.shutdown().catch((error: unknown) => console.error('Shutdown failed', error))
    quitState = 'done'
    app.quit()
  })()
})
