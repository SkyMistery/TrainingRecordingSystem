import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { SessionFile, SessionMetadata, SessionSummary } from '../shared/types'
import { exists, renameWithRetry, writeJsonAtomic } from './files'

const SESSION_FILE = 'session.json'
/** Copy of the last good session.json, read if the file itself is damaged. */
const BACKUP_FILE = 'session.json.bak'
export const RECORDING_FILE = 'recording.mp4'
/** Keeps paths short: the screenshots folder repeats the name inside the session folder. */
const MAX_FOLDER_NAME = 80

function safeSegment(value: string): string {
  return String(value ?? '')
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
    .slice(0, MAX_FOLDER_NAME)
    .replace(/[-_]+$/, '')
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
  // Written the same way (never half-written), and after the file itself.
  await writeJsonAtomic(join(folder, BACKUP_FILE), session).catch(() => undefined)
}

async function readSessionFile(file: string): Promise<SessionFile> {
  const session = JSON.parse(await readFile(file, 'utf8')) as SessionFile
  // Anything else in the sessions folder (or a hand-edited file) is not a session.
  const valid =
    session &&
    typeof session === 'object' &&
    typeof session.createdAt === 'string' &&
    session.metadata &&
    typeof session.metadata === 'object' &&
    typeof session.metadata.date === 'string' &&
    (session.markers === undefined || Array.isArray(session.markers))
  if (!valid) throw new Error('Not a session file')
  return session
}

/** Reads a session, filling in fields added by later versions of the app. */
export async function loadSession(folder: string): Promise<SessionFile> {
  let session: SessionFile
  try {
    session = await readSessionFile(join(folder, SESSION_FILE))
  } catch (error) {
    // A power cut can leave session.json damaged: the backup is at most one change older.
    if (!(await exists(join(folder, BACKUP_FILE)))) throw error
    session = await readSessionFile(join(folder, BACKUP_FILE))
    console.warn(`Session ${basename(folder)}: session.json unreadable, using the backup`)
  }
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

/** A rename that stopped part-way; `folder` is where the session is now. */
export class SessionRenameError extends Error {
  constructor(
    readonly folder: string,
    readonly cause: unknown
  ) {
    super('Could not rename the session folder')
  }
}

/**
 * Gives a session folder (and its screenshots folder) the name its details
 * call for, after they were corrected. Returns the new folder, or the same one
 * when the name doesn't change. The session is saved after each step, so
 * session.json always matches the folders on disk even if a later step fails.
 */
export async function renameSessionFolder(root: string, folder: string, session: SessionFile): Promise<string> {
  const current = basename(folder)
  const wanted = sessionFolderName(session.metadata)
  // A "-2" style suffix is kept: the same details keep the same folder.
  const tail = current.slice(wanted.length)
  const suffix = /^-\d+$/.test(tail) ? tail : ''
  const sameName = current.toLowerCase() === (wanted + suffix).toLowerCase()
  // Windows names ignore case: a change of capitals only is a rename in place.
  const target =
    current === wanted + suffix
      ? folder
      : sameName
        ? join(root, wanted + suffix)
        : await freeFolder(root, session.metadata)
  let location = folder
  try {
    if (target !== folder) {
      await renameWithRetry(folder, target)
      location = target
    }

    // Screenshots: v1.0 used "screenshots/", later versions "<session>_screen/".
    const shotsDir = screenshotsDir(target)
    const oldDirs = new Set(
      session.markers.map((marker) => marker.screenshot?.split('/')[0]).filter((dir): dir is string => !!dir)
    )
    for (const dir of oldDirs) {
      if (dir === shotsDir || !(await exists(join(target, dir)))) continue
      // Never merge into an existing folder (a case-only change is the same folder).
      if (dir.toLowerCase() !== shotsDir.toLowerCase() && (await exists(join(target, shotsDir)))) continue
      await renameWithRetry(join(target, dir), join(target, shotsDir))
      for (const marker of session.markers) {
        if (marker.screenshot?.startsWith(`${dir}/`))
          marker.screenshot = `${shotsDir}/${marker.screenshot.slice(dir.length + 1)}`
      }
      await saveSession(target, session)
    }
    return target
  } catch (error) {
    throw new SessionRenameError(location, error)
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
 * The recording of a session whose file wasn't moved into place: OBS crashed
 * or the connection was lost before it reported the file, or the file was
 * still busy. Older versions stored OBS's own path. Null if there is none.
 */
export async function findRecordingFile(folder: string, stored: string | null): Promise<string | null> {
  if (await exists(join(folder, RECORDING_FILE))) return join(folder, RECORDING_FILE)
  if (stored && isAbsolute(stored) && (await exists(stored))) return stored
  // OBS names its files after the date and time; keep the newest one.
  const candidates: { path: string; modified: number }[] = []
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!/\.mp4$/i.test(name)) continue
    const path = join(folder, name)
    const info = await stat(path).catch(() => null)
    if (info?.isFile()) candidates.push({ path, modified: info.mtimeMs })
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.path ?? null
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
