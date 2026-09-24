import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // "Nicolò" → "Nicolo"
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
  // e.g. 2026-09-24_123456_Mario-Rossi_LIRF_APP_Training; a second session the same day gets "-2".
  const name = [metadata.date, metadata.traineeVid, metadata.traineeName, metadata.position, metadata.trainingType]
    .map(safeSegment)
    .filter(Boolean)
    .join('_')

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
  session.markers = (session.markers ?? []).map((stored) => {
    // Before v1.1 a marker had a single category.
    const { categoryId, ...marker } = stored as typeof stored & { categoryId?: string | null }
    return {
      ...marker,
      categoryIds: marker.categoryIds ?? (categoryId ? [categoryId] : []),
      notes: marker.notes ?? []
    }
  })
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

/** Screenshots folder of a session, named after the session so it can be shared on its own. */
export function screenshotsDir(folder: string): string {
  return `${basename(folder)}_screen`
}

export async function listSessions(root: string): Promise<SessionSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const sessions: (SessionSummary & { createdAt: string })[] = []
  for (const entry of entries) {
    const folder = join(root, entry)
    try {
      const session = await loadSession(folder)
      sessions.push({
        id: session.id,
        createdAt: session.createdAt,
        folder,
        folderName: entry,
        metadata: session.metadata,
        durationMs: session.recording?.durationMs ?? null,
        hasRecording: Boolean(session.recording?.file),
        markerCount: session.markers?.length ?? 0,
        noteCount: session.markers.reduce((sum, marker) => sum + marker.notes.length, 0)
      })
    } catch {
      // Not a session folder.
    }
  }
  // Newest first; folder names no longer carry the time of day.
  return sessions
    .sort((a, b) => b.metadata.date.localeCompare(a.metadata.date) || b.createdAt.localeCompare(a.createdAt))
    .map(({ createdAt: _createdAt, ...summary }) => summary)
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
