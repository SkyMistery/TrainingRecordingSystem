import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ThemePreference } from '../shared/theme'
import type { CaptureConfig } from '../shared/types'

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
}

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
  trainerVid: ''
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
        capture: { ...base.capture, ...stored.capture }
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
