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

/** e.g. 2026-09-24_123456_Mario-Rossi_LIRF_APP_Training */
function sessionFolderName(metadata: SessionMetadata): string {
  return [metadata.date, metadata.traineeVid, metadata.traineeName, metadata.position, metadata.trainingType]
    .map(safeSegment)
    .filter(Boolean)
    .join('_')
}

/** A folder path for the session that doesn't exist yet; a second session the same day gets "-2". */
async function freeFolder(root: string, metadata: SessionMetadata): Promise<string> {
  const name = sessionFolderName(metadata)
  let folder = join(root, name)
  for (let i = 2; await exists(folder); i++) folder = join(root, `${name}-${i}`)
  return folder
}

export async function createSession(
  root: string,
  metadata: SessionMetadata
): Promise<{ folder: string; session: SessionFile }> {
  const now = new Date()
  const folder = await freeFolder(root, metadata)
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

/**
 * Gives a session folder (and its screenshots folder) the name its details
 * call for, after they were corrected. Returns the new folder, or the same one
 * when the name doesn't change. Screenshot paths in `session` are updated;
 * the caller saves it.
 */
export async function renameSessionFolder(root: string, folder: string, session: SessionFile): Promise<string> {
  const current = basename(folder)
  // Keep "-2" style suffixes out of the comparison: the same details keep the same folder.
  const wanted = sessionFolderName(session.metadata)
  const target =
    current === wanted || current.startsWith(`${wanted}-`) ? folder : await freeFolder(root, session.metadata)
  if (target !== folder) await renameWithRetry(folder, target)

  // Screenshots: v1.0 used "screenshots/", later versions "<session>_screen/".
  const shotsDir = screenshotsDir(target)
  const oldDirs = new Set(
    session.markers.map((marker) => marker.screenshot?.split('/')[0]).filter((dir): dir is string => !!dir)
  )
  for (const dir of oldDirs) {
    if (dir === shotsDir || !(await exists(join(target, dir)))) continue
    if (await exists(join(target, shotsDir))) continue // never merge into an existing folder
    await renameWithRetry(join(target, dir), join(target, shotsDir))
    for (const marker of session.markers) {
      if (marker.screenshot?.startsWith(`${dir}/`))
        marker.screenshot = `${shotsDir}/${marker.screenshot.slice(dir.length + 1)}`
    }
  }
  return target
}

/** Windows refuses to rename a folder for a moment while a file in it is being closed. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 8) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
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
