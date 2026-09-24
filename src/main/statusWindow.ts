import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { loadAppPage } from './appPages'
import { recordedDisplay } from './displays'
import { getSettings, updateSettings } from './settings'

const WIDTH = 360
const HEIGHT = 112
const MARGIN = 24

let window: BrowserWindow | null = null

/** Top-right corner of a monitor other than the recorded one, so the window isn't recorded. */
function defaultPosition(obsDisplayName: string | undefined): { x: number; y: number } {
  const recorded = recordedDisplay(obsDisplayName)
  const displays = screen.getAllDisplays()
  const target =
    displays.find((d) => d.id !== recorded?.id && d.id === screen.getPrimaryDisplay().id) ??
    displays.find((d) => d.id !== recorded?.id) ??
    screen.getPrimaryDisplay()
  const area = target.workArea
  return { x: area.x + area.width - WIDTH - MARGIN, y: area.y + MARGIN }
}

function isVisibleOnSomeDisplay(position: { x: number; y: number }): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    return (
      position.x >= a.x - WIDTH / 2 &&
      position.x < a.x + a.width - WIDTH / 2 &&
      position.y >= a.y &&
      position.y < a.y + a.height - 20
    )
  })
}

export function showStatusWindow(obsDisplayName: string | undefined): void {
  if (window && !window.isDestroyed()) {
    window.showInactive()
    return
  }
  const saved = getSettings().statusWindowPosition
  const position = saved && isVisibleOnSomeDisplay(saved) ? saved : defaultPosition(obsDisplayName)

  window = new BrowserWindow({
    ...position,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never take focus away from Aurora.
    focusable: false,
    show: false,
    title: 'TRS status',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  // Kept out of the recording even if it is dragged onto the recorded monitor.
  window.setContentProtection(true)
  window.once('ready-to-show', () => window?.showInactive())
  window.on('moved', () => {
    if (!window) return
    const [x, y] = window.getPosition()
    updateSettings({ statusWindowPosition: { x, y } }).catch((error: unknown) => console.error(error))
  })
  window.on('closed', () => {
    window = null
  })

  void loadAppPage(window, 'status')
}

export function hideStatusWindow(): void {
  if (window && !window.isDestroyed()) window.close()
  window = null
}
