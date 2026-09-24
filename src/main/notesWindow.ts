import { BrowserWindow, screen } from 'electron'
import { recordedDisplay } from './displays'

let window: BrowserWindow | null = null

/**
 * The Companion page in a desktop window, meant for a monitor that isn't shared
 * on Discord. It goes on a monitor other than the main window's and the
 * recorded one, and is excluded from screen capture (OBS, Discord) anyway:
 * the trainer's notes must never end up in a recording or a shared screen.
 */
export function openNotesWindow(pairUrl: string, obsDisplayName: string | undefined): void {
  if (window && !window.isDestroyed()) {
    // A new pairing code or port makes the old address useless.
    if (window.webContents.getURL() !== pairUrl) void window.loadURL(pairUrl)
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
  void window.loadURL(pairUrl)
}
