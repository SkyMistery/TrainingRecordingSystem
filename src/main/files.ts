import { randomBytes } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'

/** Windows refuses a rename for a moment while antivirus, the indexer or Explorer holds the file. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Renames, retrying while Windows reports the file or folder as in use. */
export async function renameWithRetry(from: string, to: string, attempts = 9): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= attempts || !BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/**
 * Replaces a JSON file so that it is never left half written: the data goes
 * to a temporary file, is flushed to disk, then takes the file's place.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
