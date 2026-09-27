import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import { isAppPage, loadAppPage } from './appPages'
import { Controller } from './controller'
import { handleMediaScheme, registerMediaScheme } from './media'
import { flushSettings, getSettings, updateSettings } from './settings'
import { downloadUpdate, installUpdate, startUpdater } from './updater'

registerMediaScheme()

// A bug must never leave a key pressed (Aurora would keep transmitting) nor
// stop the app with a dialog on the shared screen: it is logged instead.
process.on('uncaughtException', (error) => {
  console.error('Unexpected error', error)
  controller?.releaseEverything()
})
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection', reason))

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

/** The only places links of the app lead to: its own documents on GitHub and IVAO's sites. */
function isKnownLink(url: string): boolean {
  try {
    const { protocol, hostname, pathname } = new URL(url)
    if (protocol !== 'https:') return false
    if (hostname === 'github.com') return pathname.startsWith('/SkyMistery/TrainingRecordingSystem')
    return hostname === 'ivao.aero' || hostname.endsWith('.ivao.aero') || hostname === 'obsproject.com'
  } catch {
    return false
  }
}

/**
 * Every window stays on its own page: a link, a dropped file or a script must
 * not replace it with another page (which would get the preload's API), and
 * new windows are refused (the app's own links go to the default browser).
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
    if (isKnownLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

// Atmosphere page background (--body) for each theme, used before the UI paints.
const BODY_COLOR: Record<Theme, string> = { day: '#ffffff', night: '#12131b' }

/**
 * Stopping the recording (OBS may take up to 30 s to finish a long file),
 * waiting for it to be idle and restoring the OBS profile: never longer.
 */
const SHUTDOWN_TIMEOUT_MS = 60_000
/** "Restart to update" that didn't restart by then: the installer didn't start. */
const INSTALL_TIMEOUT_MS = 15_000

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
      contextIsolation: true,
      devTools: !app.isPackaged
    }
  })

  // Hidden from screen capture (OBS, Discord) unless a review is open: see Controller.
  mainWindow.setContentProtection(!(controller?.isShareable() ?? false))
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
  // Windows shutting down, restarting or signing out: before-quit never comes.
  // While recording Windows waits a moment (it shows the app as busy) for a clean stop.
  mainWindow.on('query-session-end', (event) => {
    if (controller?.isRecording()) event.preventDefault()
    void quitNow()
  })
  mainWindow.on('session-end', () => void quitNow())

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

/** Quits now (the recording stopped and saved first), without asking. */
async function quitNow(): Promise<void> {
  if (quitState !== 'running') return
  quitState = 'shuttingDown'
  await shutdown()
  quitState = 'done'
  app.quit()
}

function registerIpc(): void {
  // Only the app's own pages may ask (the Companion page in the notes window has no preload anyway).
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isAppPage(event.senderFrame?.url ?? '')) throw new Error('Not allowed')
      return fn(...args)
    })
  }
  handle('app:version', () => app.getVersion())
  handle('update:download', () => {
    if (controller?.isRecording()) throw new Error('Stop the recording before updating')
    return downloadUpdate()
  })
  // "Restart to update": the app's own shutdown first, since the installer
  // starts at once and would cut the OBS profile restore short.
  handle('update:install', async () => {
    if (controller?.isRecording()) throw new Error('Stop the recording before updating')
    if (quitState !== 'running') return
    quitState = 'shuttingDown'
    await shutdown()
    quitState = 'done'
    installUpdate()
    // The installer didn't start (moved away, blocked by an antivirus): don't stay half closed.
    setTimeout(() => {
      dialog.showErrorBox(
        'The update was not installed',
        'The installer did not start (an antivirus may have blocked it). The app closes now: start it again and try the update later, or download it from GitHub.'
      )
      app.exit(0)
    }, INSTALL_TIMEOUT_MS).unref()
  })
  handle('theme:get', (): ThemeState => ({ theme: effectiveTheme(), preference: getSettings().theme }))
  handle('theme:set', async (preference: ThemePreference) => {
    if (!['day', 'night', 'system'].includes(preference)) throw new Error('Invalid theme')
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
  // No menu in the installed app: its shortcuts would reload the page (losing
  // what is being typed), close the app during a review without asking, or
  // open the developer tools, and Alt would show it in a shared window.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  // Only the app's own pages get a permission, and only the microphone; the
  // Companion page in the notes window and anything else get none.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      (details.mediaTypes ?? []).length > 0 &&
      (details.mediaTypes ?? []).every((type) => type === 'audio')
    callback(audioOnly && isAppPage(contents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'media' && isAppPage(details.requestingUrl ?? contents?.getURL() ?? '')
  )
  applyThemePreference(getSettings().theme)
  handleMediaScheme()
  registerIpc()
  // Only the review is meant to be shared (Discord): the recording page shows
  // transcripts (they would end up in the recording itself on the recorded
  // monitor), the sessions list other trainees, Setup the pairing QR code.
  controller = new Controller((shareable) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setContentProtection(!shareable)
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
let askingToQuit = false
app.on('before-quit', (event) => {
  if (quitState === 'done') return
  event.preventDefault()
  // Closing windows during shutdown asks to quit again: let the first request finish.
  if (quitState === 'shuttingDown' || askingToQuit) return
  void (async () => {
    if (controller?.isRecording() && mainWindow && !mainWindow.isDestroyed()) {
      askingToQuit = true
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Stop recording and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'A training session is being recorded.',
        detail: 'Quitting stops the recording. The session and everything recorded so far are kept.'
      })
      askingToQuit = false
      if (response !== 0) return
    }
    await quitNow()
  })()
})
