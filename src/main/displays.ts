import { screen, type Display } from 'electron'

/**
 * The Electron display that OBS is recording, matched on the "@ x,y" position
 * in the OBS monitor name (physical pixels).
 */
export function recordedDisplay(obsDisplayName: string | undefined): Display | undefined {
  const match = obsDisplayName && /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(obsDisplayName)
  if (!match) return undefined
  const [x, y] = [Number(match[1]), Number(match[2])]
  return screen.getAllDisplays().find((d) => Math.abs(d.nativeOrigin.x - x) < 2 && Math.abs(d.nativeOrigin.y - y) < 2)
}
