import { screen, type Display } from 'electron'
import { displayOrigin } from './windowMasks'

/**
 * The Electron display that OBS is recording, matched on the "@ x,y" position
 * in the OBS monitor name (physical pixels).
 */
export function recordedDisplay(obsDisplayName: string | undefined): Display | undefined {
  const origin = obsDisplayName ? displayOrigin(obsDisplayName) : null
  if (!origin) return undefined
  return screen
    .getAllDisplays()
    .find((d) => Math.abs(d.nativeOrigin.x - origin.x) < 2 && Math.abs(d.nativeOrigin.y - origin.y) < 2)
}
