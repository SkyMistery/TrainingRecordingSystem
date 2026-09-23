import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import { getSettings, updateSettings } from './settings'

// Atmosphere page background (--body) for each theme, used before the UI paints.
const BODY_COLOR: Record<Theme, string> = { day: '#ffffff', night: '#12131b' }

let mainWindow: BrowserWindow | null = null

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

app.whenReady().then(() => {
  applyThemePreference(getSettings().theme)
  registerIpc()
  createMainWindow()

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      console.error('Update check failed', error)
    })
  }
})

app.on('window-all-closed', () => app.quit())
