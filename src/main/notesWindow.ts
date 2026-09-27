import { BrowserWindow, screen, session } from 'electron'
import { recordedDisplay } from './displays'

let window: BrowserWindow | null = null

/**
 * The Companion page in a desktop window, meant for a monitor that isn't shared
 * on Discord. It goes on a monitor other than the main window's and the
 * recorded one, and is excluded from screen capture (OBS, Discord) anyway:
 * the trainer's notes must never end up in a recording or a shared screen.
 * It is let in with a cookie the app sets itself (no pairing link needed).
 */
export async function openNotesWindow(
  page: { url: string; cookie: { name: string; value: string } },
  obsDisplayName: string | undefined
): Promise<void> {
  await session.defaultSession.cookies.set({
    url: page.url,
    name: page.cookie.name,
    value: page.cookie.value,
    httpOnly: true,
    sameSite: 'lax'
  })
  if (window && !window.isDestroyed()) {
    // Another port (Setup) makes the old address useless; otherwise the page stays as it is.
    if (new URL(window.webContents.getURL() || page.url).origin !== new URL(page.url).origin) {
      void window.loadURL(page.url)
    }
    window.show()
    window.focus()
    return
  }
  const main = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'Training Recording System')
  const mainDisplay = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const recorded = recordedDisplay(obsDisplayName)
  const displays = screen.getAllDisplays()
  const target =
    displays.find((display) => display.id !== mainDisplay.id && display.id !== recorded?.id) ??
    displays.find((display) => display.id !== recorded?.id) ??
    mainDisplay
  const area = target.workArea
  const width = Math.min(560, area.width)
  const height = Math.min(900, area.height)

  window = new BrowserWindow({
    x: area.x + area.width - width - 24,
    y: area.y + 24,
    width,
    height,
    minWidth: 380,
    autoHideMenuBar: true,
    title: 'Trainer notes',
    // A plain web page: no access to the app's internals.
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  window.setContentProtection(true)
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(page.url)
}
