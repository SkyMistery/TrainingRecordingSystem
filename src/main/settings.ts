import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ThemePreference } from '../shared/theme'
import type { CaptureConfig, Hotkey, MarkerSettings, NoteSettings } from '../shared/types'

export interface Settings {
  theme: ThemePreference
  obs: {
    host: string
    port: number
    /** Password encrypted with Electron safeStorage, base64. */
    passwordEncrypted: string | null
  }
  capture: CaptureConfig
  sessionsDir: string
  trainerVid: string
  markers: MarkerSettings
  notes: NoteSettings
  /** Trainer's own OBS profile and scene collection, to restore on exit. */
  obsPreviousWorkspace: { profile: string; collection: string } | null
  /** Last position of the status window, in screen coordinates. */
  statusWindowPosition: { x: number; y: number } | null
}

const key = (code: number, label: string): Hotkey => ({
  device: 'keyboard',
  code,
  ctrl: false,
  alt: false,
  shift: false,
  label
})

/** Category colours come from the IVAO brand palette (atmos, semantic, product). */
export const defaultMarkerSettings = (): MarkerSettings => ({
  preRollSeconds: 10,
  // 67 and 68 are the uiohook keycodes of F9 and F10.
  hotkeys: { marker: key(67, 'F9'), range: key(68, 'F10'), voiceNote: null },
  categories: [
    { id: 'phraseology', name: 'Phraseology', color: '#1342e4', hotkey: null },
    { id: 'separation', name: 'Separation', color: '#e93434', hotkey: null },
    { id: 'coordination', name: 'Coordination', color: '#f9cc2c', hotkey: null },
    { id: 'traffic', name: 'Traffic management', color: '#8b5cf6', hotkey: null },
    { id: 'positive', name: 'Positive', color: '#2ec662', hotkey: null }
  ],
  sound: true,
  statusWindow: true
})

const defaults = (): Settings => ({
  theme: 'system',
  obs: { host: '127.0.0.1', port: 4455, passwordEncrypted: null },
  capture: {
    display: null,
    outputScale: 'native',
    fps: 30,
    encoder: 'x264',
    audioSources: []
  },
  sessionsDir: join(app.getPath('documents'), 'IVAO TRS', 'Sessions'),
  trainerVid: '',
  markers: defaultMarkerSettings(),
  notes: {
    micDeviceId: 'default',
    micLabel: 'Default microphone',
    model: 'small',
    language: 'auto',
    transcribe: true,
    attachWindowSeconds: 60
  },
  obsPreviousWorkspace: null,
  statusWindowPosition: null
})

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

let current: Settings | null = null

export function getSettings(): Settings {
  if (!current) {
    const base = defaults()
    try {
      const stored = JSON.parse(readFileSync(filePath(), 'utf8')) as Partial<Settings>
      current = {
        ...base,
        ...stored,
        obs: { ...base.obs, ...stored.obs },
        capture: { ...base.capture, ...stored.capture },
        notes: { ...base.notes, ...stored.notes },
        markers: {
          ...base.markers,
          ...stored.markers,
          hotkeys: { ...base.markers.hotkeys, ...stored.markers?.hotkeys }
        }
      }
    } catch {
      current = base
    }
  }
  return current
}

/** Merges and persists settings; the file is replaced atomically. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  current = { ...getSettings(), ...patch }
  const tmp = `${filePath()}.tmp`
  await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8')
  await rename(tmp, filePath())
  return current
}

export function encryptSecret(secret: string): string | null {
  if (!secret) return null
  return safeStorage.encryptString(secret).toString('base64')
}

export function decryptSecret(encrypted: string | null): string | undefined {
  if (!encrypted) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return undefined
  }
}
