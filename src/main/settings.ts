import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { writeJsonAtomic } from './files'
import type { ThemePreference } from '../shared/theme'
import type { CaptureConfig, CompanionSettings, Hotkey, MarkerSettings, NoteSettings } from '../shared/types'

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
  companion: CompanionSettings
  /** Secret that pairs Companion devices; a new one unpairs them all. */
  companionToken: string
  /** Trainer's own OBS profile and scene collection, to restore on exit. */
  obsPreviousWorkspace: { profile: string | null; collection: string | null } | null
  /** Last position of the status window, in screen coordinates. */
  statusWindowPosition: { x: number; y: number } | null
  /** Terms of use accepted by the user: which version, and when. */
  termsAccepted: { version: number; acceptedAt: string } | null
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
  companion: { enabled: true, lan: false, port: 17645 },
  companionToken: randomBytes(24).toString('hex'),
  obsPreviousWorkspace: null,
  statusWindowPosition: null,
  termsAccepted: null
})

const filePath = (): string => join(app.getPath('userData'), 'settings.json')
/** Copy of the last settings written successfully, used if settings.json is damaged. */
const backupPath = (): string => `${filePath()}.bak`

let current: Settings | null = null

function readStored(path: string): Partial<Settings> | null {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return stored && typeof stored === 'object' ? (stored as Partial<Settings>) : null
  } catch {
    return null
  }
}

export function getSettings(): Settings {
  if (!current) {
    const base = defaults()
    let stored = readStored(filePath())
    if (!stored && existsSync(filePath())) {
      // Damaged (not merely missing): keep it for diagnosis and fall back to the backup.
      console.error('settings.json is damaged; using the backup copy')
      try {
        copyFileSync(filePath(), join(app.getPath('userData'), 'settings.damaged.json'))
      } catch {
        // Diagnosis only.
      }
      stored = readStored(backupPath())
    }
    current = stored
      ? {
          ...base,
          ...stored,
          obs: { ...base.obs, ...stored.obs },
          capture: { ...base.capture, ...stored.capture },
          notes: { ...base.notes, ...stored.notes },
          companion: { ...base.companion, ...stored.companion },
          markers: {
            ...base.markers,
            ...stored.markers,
            hotkeys: { ...base.markers.hotkeys, ...stored.markers?.hotkeys }
          }
        }
      : base
  }
  return current
}

/** Writes run one at a time: overlapping writes to the same temporary file could corrupt it. */
let writes: Promise<void> = Promise.resolve()

/** Merges and persists settings; the file is replaced atomically. */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  current = { ...getSettings(), ...patch }
  const write = async (): Promise<void> => {
    // The latest settings, so a queued write never puts back older values.
    const settings = getSettings()
    await writeJsonAtomic(filePath(), settings)
    await writeJsonAtomic(backupPath(), settings).catch(() => undefined)
  }
  const next = writes.then(write, write)
  writes = next.catch(() => undefined)
  return next.then(() => getSettings())
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
