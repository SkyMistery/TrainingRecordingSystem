import { join } from 'node:path'
import { BrowserWindow, screen, type Display } from 'electron'
import { getSettings, updateSettings } from './settings'

const WIDTH = 360
const HEIGHT = 112
const MARGIN = 24

let window: BrowserWindow | null = null

/**
 * The Electron display that OBS is recording, matched on the "@ x,y" position
 * in the OBS monitor name (physical pixels).
 */
function recordedDisplay(obsDisplayName: string | undefined): Display | undefined {
  const match = obsDisplayName && /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(obsDisplayName)
  if (!match) return undefined
  const [x, y] = [Number(match[1]), Number(match[2])]
  return screen
    .getAllDisplays()
    .find((d) => Math.abs(d.nativeOrigin.x - x) < 2 && Math.abs(d.nativeOrigin.y - y) < 2)
}

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
    return position.x >= a.x - WIDTH / 2 && position.x < a.x + a.width - WIDTH / 2 && position.y >= a.y && position.y < a.y + a.height - 20
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
  window.once('ready-to-show', () => window?.showInactive())
  window.on('moved', () => {
    if (!window) return
    const [x, y] = window.getPosition()
    void updateSettings({ statusWindowPosition: { x, y } })
  })
  window.on('closed', () => {
    window = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#status`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'status' })
  }
}

export function hideStatusWindow(): void {
  if (window && !window.isDestroyed()) window.close()
  window = null
}
