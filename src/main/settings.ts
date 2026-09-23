import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { ThemePreference } from '../shared/theme'

export interface Settings {
  theme: ThemePreference
}

const defaults: Settings = {
  theme: 'system'
}

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

let current: Settings | null = null

export function getSettings(): Settings {
  if (!current) {
    try {
      current = { ...defaults, ...JSON.parse(readFileSync(filePath(), 'utf8')) }
    } catch {
      current = { ...defaults }
    }
  }
  return current!
}

/** Merges and persists settings; the file is replaced atomically. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  current = { ...getSettings(), ...patch }
  const tmp = `${filePath()}.tmp`
  await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8')
  await rename(tmp, filePath())
  return current
}
