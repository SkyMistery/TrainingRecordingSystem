import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionFile, SessionMetadata, SessionSummary } from '../shared/types'

const SESSION_FILE = 'session.json'
export const RECORDING_FILE = 'recording.mp4'

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, filePath)
}

function safeSegment(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export async function createSession(
  root: string,
  metadata: SessionMetadata
): Promise<{ folder: string; session: SessionFile }> {
  const now = new Date()
  const stamp = `${metadata.date}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const name = [stamp, safeSegment(metadata.traineeVid), safeSegment(metadata.position)].filter(Boolean).join('_')

  let folder = join(root, name)
  for (let i = 2; await exists(folder); i++) folder = join(root, `${name}-${i}`)
  await mkdir(folder, { recursive: true })

  const session: SessionFile = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: now.toISOString(),
    metadata,
    recording: null,
    markers: []
  }
  await writeJsonAtomic(join(folder, SESSION_FILE), session)
  return { folder, session }
}

export async function saveSession(folder: string, session: SessionFile): Promise<void> {
  await writeJsonAtomic(join(folder, SESSION_FILE), session)
}

/** Reads a session, filling in fields added by later versions of the app. */
export async function loadSession(folder: string): Promise<SessionFile> {
  const session = JSON.parse(await readFile(join(folder, SESSION_FILE), 'utf8')) as SessionFile
  session.markers = (session.markers ?? []).map((marker) => ({ ...marker, notes: marker.notes ?? [] }))
  return session
}

/**
 * Serialises every change to a session.json, whether it comes from the
 * recording in progress or from a transcription finishing later. The active
 * session is edited in memory (`live`); others are read from disk.
 */
export class SessionStore {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly live: (folder: string) => SessionFile | undefined) {}

  update(folder: string, change: (session: SessionFile) => void): Promise<SessionFile> {
    const run = async (): Promise<SessionFile> => {
      const session = this.live(folder) ?? (await loadSession(folder))
      change(session)
      await saveSession(folder, session)
      return session
    }
    const next = (this.chains.get(folder) ?? Promise.resolve()).then(run, run)
    this.chains.set(
      folder,
      next.catch(() => undefined)
    )
    return next
  }
}

export async function listSessions(root: string): Promise<SessionSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const sessions: SessionSummary[] = []
  for (const entry of entries) {
    const folder = join(root, entry)
    try {
      const session = await loadSession(folder)
      sessions.push({
        id: session.id,
        folder,
        folderName: entry,
        metadata: session.metadata,
        durationMs: session.recording?.durationMs ?? null,
        hasRecording: Boolean(session.recording?.file),
        markerCount: session.markers?.length ?? 0
      })
    } catch {
      // Not a session folder.
    }
  }
  return sessions.sort((a, b) => b.folder.localeCompare(a.folder))
}

/**
 * Moves the file OBS wrote into the session folder under a stable name. OBS may
 * keep the file open for a moment after stopping, so this retries briefly.
 */
export async function adoptRecording(folder: string, outputPath: string): Promise<string> {
  const target = join(folder, RECORDING_FILE)
  if (outputPath === target) return RECORDING_FILE
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(outputPath, target)
      return RECORDING_FILE
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
