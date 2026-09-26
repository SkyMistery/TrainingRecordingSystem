import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import { isAppPage, loadAppPage } from './appPages'
import { Controller } from './controller'
import { handleMediaScheme, registerMediaScheme } from './media'
import { flushSettings, getSettings, updateSettings } from './settings'
import { installUpdate, startUpdater } from './updater'

registerMediaScheme()

// A second copy would fight over the keyboard hook, OBS, the Companion port and
// the same files: bring the running one to the front instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

/**
 * Every window stays on its own page: a link, a dropped file or a script must
 * not replace it with another page (which would get the preload's API), and
 * new windows are refused (web links go to the default browser).
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL()
    // The notes window moves within the Companion page (pairing → page).
    const sameCompanion = url.startsWith('http://') && current && new URL(url).origin === new URL(current).origin
    if (!isAppPage(url) && !sameCompanion) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

// Atmosphere page background (--body) for each theme, used before the UI paints.
const BODY_COLOR: Record<Theme, string> = { day: '#ffffff', night: '#12131b' }

/** Stopping the recording and restoring the OBS profile normally takes a few seconds. */
const SHUTDOWN_TIMEOUT_MS = 20_000

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

  void loadAppPage(mainWindow)
}

/** Stops the recording and gives OBS its profile back, without ever hanging (OBS may not answer). */
async function shutdown(): Promise<void> {
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.error('Shutdown took too long; quitting anyway')
      resolve()
    }, SHUTDOWN_TIMEOUT_MS)
  )
  await Promise.race([
    (async () => {
      await controller?.shutdown().catch((error: unknown) => console.error('Shutdown failed', error))
      // Restoring OBS forgets the remembered workspace: let that reach settings.json before exiting.
      await flushSettings()
    })(),
    timeout
  ])
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  // "Restart to update": the app's own shutdown first, since the installer
  // starts at once and would cut the OBS profile restore short.
  ipcMain.handle('update:install', async (event) => {
    if (!isAppPage(event.senderFrame?.url ?? '')) throw new Error('Not allowed')
    if (controller?.isRecording()) throw new Error('Stop the recording before updating')
    if (quitState !== 'running') return
    quitState = 'shuttingDown'
    await shutdown()
    quitState = 'done'
    installUpdate()
  })
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
  // Only the app's own pages get permissions (the microphone); the Companion
  // page in the notes window and anything else get none.
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback) =>
    callback(isAppPage(contents.getURL()))
  )
  session.defaultSession.setPermissionCheckHandler((contents, _permission, _origin, details) =>
    isAppPage(details.requestingUrl ?? contents?.getURL() ?? '')
  )
  applyThemePreference(getSettings().theme)
  handleMediaScheme()
  registerIpc()
  // Transcripts shown while recording must not end up in the recording itself
  // (single monitor, or the window left on the recorded one): hide the window
  // from screen capture only then, since the review is meant to be shared.
  controller = new Controller((recording) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setContentProtection(recording)
  })
  try {
    await controller.init()
  } catch (error) {
    // Never keep running invisibly (with the keyboard hook active).
    console.error('Startup failed', error)
    dialog.showErrorBox(
      'Training Recording System could not start',
      error instanceof Error ? error.message : String(error)
    )
    quitState = 'done'
    app.quit()
    return
  }
  createMainWindow()

  startUpdater((update) => controller?.setUpdate(update))
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
    await shutdown()
    quitState = 'done'
    app.quit()
  })()
})
