import { BrowserWindow, screen } from 'electron'

let window: BrowserWindow | null = null

/**
 * The Companion page in a desktop window, meant for a monitor that isn't shared
 * on Discord. It is placed on a different monitor from the main window.
 */
export function openNotesWindow(pairUrl: string): void {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  const main = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'Training Recording System')
  const mainDisplay = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const target = screen.getAllDisplays().find((display) => display.id !== mainDisplay.id) ?? mainDisplay
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
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(pairUrl)
}
