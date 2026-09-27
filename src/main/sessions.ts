import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Marker, Note, SessionFile, SessionMetadata, SessionSummary } from '../shared/types'
import { exists, renameWithRetry, writeJsonAtomic } from './files'

const SESSION_FILE = 'session.json'
/** Copy of the last good session.json, read if the file itself is damaged. */
const BACKUP_FILE = 'session.json.bak'
/** An unreadable session.json, kept when the backup takes its place. */
const DAMAGED_FILE = 'session.damaged.json'
/** The session.json format this app writes; a newer one is read but never overwritten. */
const SCHEMA_VERSION = 1
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
  // Notepad or PowerShell may save a byte order mark, which JSON.parse refuses.
  const session = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as SessionFile
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

/**
 * A file path stored in session.json, if it stays inside the session folder
 * ("notes/n-0001.wav"); null for anything else ("..\x", "C:\x", "\\server\x",
 * "x.wav:stream"). Sessions may come from someone else, or be edited by hand:
 * their paths are never trusted to delete, move, read or serve files.
 */
export function sessionPath(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored === '') return null
  const parts = stored.split(/[\\/]/)
  const bad = parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':'))
  return bad ? null : parts.join('/')
}

/**
 * The recording's file name inside the session folder. Before v1.2 the app
 * stored OBS's own (absolute) path: kept only if it is in this folder.
 */
function recordingFileName(folder: string, stored: unknown): string | null {
  if (typeof stored !== 'string' || !/\.mp4$/i.test(stored)) return null
  if (!isAbsolute(stored)) return /[\\/:]/.test(stored) ? null : stored
  return dirname(resolve(stored)).toLowerCase() === resolve(folder).toLowerCase() ? basename(stored) : null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** A marker as the current app expects it, whatever an older version (or a hand edit) stored. */
function normaliseMarker(stored: Record<string, unknown>): Marker {
  // Before v1.1 a marker had a single category.
  const { categoryId, ...marker } = stored as unknown as Marker & { categoryId?: string | null }
  const categoryIds = Array.isArray(marker.categoryIds) ? marker.categoryIds : categoryId ? [categoryId] : []
  const notes = (Array.isArray(marker.notes) ? marker.notes : [])
    .filter(isObject)
    .map((note) => ({ ...note, audio: sessionPath(note.audio) }))
    // A note whose audio is outside the session can't be played, transcribed or deleted safely.
    .filter((note): note is Note => note.audio !== null)
    .map((note) => ({ ...note, durationMs: finite(note.durationMs, 0), recordedAtMs: finite(note.recordedAtMs, 0) }))
  const timeMs = finite(marker.timeMs, 0)
  return {
    ...marker,
    number: finite(marker.number, 0),
    kind: marker.kind === 'range' ? 'range' : 'point',
    timeMs,
    pressedAtMs: finite(marker.pressedAtMs, timeMs),
    endMs: marker.endMs === null || marker.endMs === undefined ? null : finite(marker.endMs, timeMs),
    categoryIds: categoryIds.filter((id): id is string => typeof id === 'string'),
    screenshot: sessionPath(marker.screenshot),
    notes
  }
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
    // The next save replaces it: keep the unreadable one (a hand edit, perhaps) once.
    await copyFile(join(folder, SESSION_FILE), join(folder, DAMAGED_FILE), constants.COPYFILE_EXCL).catch(
      () => undefined
    )
  }
  session.markers = ((session.markers ?? []) as unknown[]).filter(isObject).map(normaliseMarker)
  if (isObject(session.recording)) session.recording.file = recordingFileName(folder, session.recording.file)
  else session.recording = null
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

  /** The session as it is now, after the changes already queued; nothing is written. */
  read(folder: string): Promise<SessionFile> {
    return this.queue(folder, async () => this.live(folder) ?? (await loadSession(folder)))
  }

  update(folder: string, change: (session: SessionFile) => void): Promise<SessionFile> {
    return this.queue(folder, async () => {
      const session = this.live(folder) ?? (await loadSession(folder))
      if (Number(session.schemaVersion) > SCHEMA_VERSION) {
        throw new Error('This session was saved by a newer version of the app: update the app to change it.')
      }
      change(session)
      await saveSession(folder, session)
      return session
    })
  }

  private queue<T>(folder: string, run: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(folder) ?? Promise.resolve()).then(run, run)
    const settled = next.catch(() => undefined)
    this.chains.set(folder, settled)
    // Forget idle sessions (the map would otherwise keep every folder ever touched).
    void settled.then(() => {
      if (this.chains.get(folder) === settled) this.chains.delete(folder)
    })
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
    const movePaths = (from: string): void => {
      for (const marker of session.markers) {
        if (marker.screenshot?.startsWith(`${from}/`))
          marker.screenshot = `${shotsDir}/${marker.screenshot.slice(from.length + 1)}`
      }
    }
    for (const dir of oldDirs) {
      if (dir === shotsDir) continue
      if (!(await exists(join(target, dir)))) {
        // Moved by an earlier attempt that couldn't save session.json afterwards: point there now.
        const moved = session.markers.find((marker) => marker.screenshot?.startsWith(`${dir}/`))
        if (moved && (await exists(join(target, shotsDir, moved.screenshot!.slice(dir.length + 1))))) {
          movePaths(dir)
          await saveSession(target, session)
        }
        continue
      }
      // Never merge into an existing folder (a case-only change is the same folder).
      if (dir.toLowerCase() !== shotsDir.toLowerCase() && (await exists(join(target, shotsDir)))) continue
      await renameWithRetry(join(target, dir), join(target, shotsDir))
      const before = session.markers.map((marker) => marker.screenshot)
      movePaths(dir)
      try {
        await saveSession(target, session)
      } catch (error) {
        // session.json must keep pointing at the screenshots: put the folder back.
        session.markers.forEach((marker, i) => (marker.screenshot = before[i]))
        await renameWithRetry(join(target, shotsDir), join(target, dir)).catch(() => undefined)
        throw error
      }
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
        markerCount: session.markers.length,
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
 * still busy. Null if there is none.
 */
export async function findRecordingFile(folder: string): Promise<string | null> {
  if (await exists(join(folder, RECORDING_FILE))) return join(folder, RECORDING_FILE)
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
 * Moves the file OBS wrote into the session folder under a stable name, and
 * returns that name. OBS may keep the file open for a moment after stopping,
 * so this retries briefly. A recording already in place is never replaced:
 * another one gets "recording-2.mp4".
 */
export async function adoptRecording(folder: string, outputPath: string): Promise<string> {
  if (resolve(outputPath).toLowerCase() === resolve(folder, RECORDING_FILE).toLowerCase()) return RECORDING_FILE
  let name = RECORDING_FILE
  for (let i = 2; await exists(join(folder, name)); i++) name = `recording-${i}.mp4`
  await renameWithRetry(outputPath, join(folder, name), 21)
  return name
}
