import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { availableParallelism, constants as osConstants, setPriority } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net } from 'electron'
import { WHISPER_MODELS } from '../shared/whisper'
import type { ModelDownload, Note, SessionFile, WhisperModelId } from '../shared/types'
import type { SessionStore } from './sessions'
import { getSettings } from './settings'
import { buildPrompt, cleanTranscript, isSilent } from './transcriptHints'

/** A fixed revision of the model repository, so the files match the digests below. */
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'
const MODEL_URL = (model: WhisperModelId): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-${model}.bin`

/** Size and sha256 of each model file: a damaged or altered download is refused. */
const MODEL_FILES: Record<WhisperModelId, { bytes: number; sha256: string }> = {
  base: { bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  small: { bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  'large-v3-turbo-q5_0': {
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  }
}

/**
 * The longest whisper may take for a note: a few minutes, plus ten times the
 * note's length (Large v3 Turbo on an old CPU, while OBS encodes).
 */
const timeoutFor = (durationMs: number): number => 3 * 60_000 + 10 * durationMs
/** A download that receives nothing for this long has stalled. */
const STALL_MS = 60_000
/** Name of the temporary note copies whisper reads (see runWhisper). */
const TEMP_PREFIX = 'note-'
/** Windows' exit code for a program missing a DLL (here: the Visual C++ runtime). */
const DLL_NOT_FOUND = 0xc0000135

interface Job {
  folder: string
  noteId: string
}

export interface TranscriberEvents {
  /** A note changed in a session (status or transcript). */
  noteChanged: (folder: string) => void
  /** Queue length, installed models or download progress changed. */
  stateChanged: () => void
}

/** A transcription problem the trainer can fix (shown in Setup → Voice notes). */
class TranscriberError extends Error {}

function findNote(session: SessionFile, noteId: string): Note | undefined {
  for (const marker of session.markers) {
    const note = marker.notes.find((item) => item.id === noteId)
    if (note) return note
  }
  return undefined
}

/**
 * Offline transcription with whisper.cpp, one note at a time so a long
 * session never loads the CPU with parallel jobs while recording.
 */
export class Transcriber {
  private readonly queue: Job[] = []
  private running = false
  /** Session folder of the note being transcribed right now. */
  private currentFolder: string | null = null
  private download: ModelDownload | null = null
  private downloadAbort: AbortController | null = null
  downloadError: string | null = null
  /** Why the last transcription failed, when it is something the trainer can fix. */
  lastError: string | null = null

  constructor(
    private readonly store: SessionStore,
    private readonly events: TranscriberEvents
  ) {
    void this.removeTemporaryCopies()
  }

  static binaryPath(): string {
    const base = app.isPackaged
      ? join(process.resourcesPath, 'whisper')
      : join(app.getAppPath(), 'resources', 'whisper')
    return join(base, 'whisper-cli.exe')
  }

  static modelsDir(): string {
    return join(app.getPath('userData'), 'models')
  }

  static modelPath(model: WhisperModelId): string {
    return join(Transcriber.modelsDir(), `ggml-${model}.bin`)
  }

  available(): boolean {
    return existsSync(Transcriber.binaryPath())
  }

  installedModels(): WhisperModelId[] {
    return WHISPER_MODELS.map((model) => model.id).filter((id) => existsSync(Transcriber.modelPath(id)))
  }

  currentDownload(): ModelDownload | null {
    return this.download
  }

  queued(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  enqueue(folder: string, noteId: string): void {
    // A copied session has the same note ids: the folder tells them apart.
    if (this.queue.some((job) => job.noteId === noteId && job.folder === folder)) return
    this.queue.push({ folder, noteId })
    this.events.stateChanged()
    void this.process()
  }

  /** True while a note of this session is being transcribed. */
  isTranscribing(folder: string): boolean {
    return this.currentFolder === folder
  }

  /** Drops the queued notes of a session (it is being deleted or renamed). */
  forget(folder: string): void {
    const before = this.queue.length
    this.queue.splice(0, this.queue.length, ...this.queue.filter((job) => job.folder !== folder))
    if (this.queue.length !== before) this.events.stateChanged()
  }

  /** Re-queues notes left pending (e.g. the app closed mid-queue) or waiting for a model. */
  async resume(folder: string, session: SessionFile): Promise<void> {
    for (const marker of session.markers) {
      for (const note of marker.notes) {
        if (note.status === 'pending' || note.status === 'transcribing' || note.status === 'no-model') {
          this.enqueue(folder, note.id)
        }
      }
    }
  }

  async downloadModel(model: WhisperModelId): Promise<void> {
    if (this.download) throw new Error('A model is already being downloaded')
    const target = Transcriber.modelPath(model)
    const partial = `${target}.part`
    const abort = new AbortController()
    this.downloadAbort = abort
    this.download = { model, receivedBytes: 0, totalBytes: 0 }
    this.downloadError = null
    this.events.stateChanged()
    const stalled = (): void => abort.abort(new Error('The download stalled: check the connection and try again'))
    let stall = setTimeout(stalled, STALL_MS)
    try {
      await mkdir(Transcriber.modelsDir(), { recursive: true })
      // Electron's fetch: it goes through the system proxy, as a browser would.
      const response = await net.fetch(MODEL_URL(model), { signal: abort.signal })
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)
      this.download.totalBytes = Number(response.headers.get('content-length') ?? 0)
      let lastUpdate = 0
      const hash = createHash('sha256')
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        clearTimeout(stall)
        stall = setTimeout(stalled, STALL_MS)
        hash.update(chunk)
        if (!this.download) return
        this.download.receivedBytes += chunk.length
        if (Date.now() - lastUpdate > 250) {
          lastUpdate = Date.now()
          this.events.stateChanged()
        }
      })
      await pipeline(body, createWriteStream(partial))
      const expected = MODEL_FILES[model]
      if (this.download.receivedBytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
        throw new Error('The downloaded model is damaged: download it again')
      }
      await rename(partial, target)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      const reason: unknown = abort.signal.reason
      this.downloadError =
        reason instanceof Error && reason.message.startsWith('The download stalled')
          ? reason.message
          : abort.signal.aborted
            ? null // cancelled by the trainer
            : error instanceof Error
              ? error.message
              : String(error)
      throw error
    } finally {
      clearTimeout(stall)
      this.download = null
      this.downloadAbort = null
      this.events.stateChanged()
    }
    void this.process()
  }

  cancelDownload(): void {
    this.downloadAbort?.abort()
  }

  private async setStatus(folder: string, noteId: string, patch: Partial<Note>): Promise<void> {
    await this.store.update(folder, (session) => {
      const note = findNote(session, noteId)
      if (note) Object.assign(note, patch)
    })
    this.events.noteChanged(folder)
  }

  private async process(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const deferred: Job[] = []
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        this.events.stateChanged()
        const { model, language, transcribe, vocabulary } = getSettings().notes
        // A session deleted or moved outside the app meanwhile: nothing left to transcribe.
        if (!existsSync(join(job.folder, 'session.json'))) continue
        if (!transcribe || !this.available()) {
          await this.setStatus(job.folder, job.noteId, { status: 'pending' }).catch(() => undefined)
          continue
        }
        if (!existsSync(Transcriber.modelPath(model))) {
          const waiting = await this.store
            .read(job.folder)
            .then((session) => findNote(session, job.noteId)?.status === 'no-model')
            .catch(() => false)
          // Written once: every new note would otherwise rewrite every session waiting for the model.
          if (!waiting) await this.setStatus(job.folder, job.noteId, { status: 'no-model' }).catch(() => undefined)
          deferred.push(job)
          continue
        }
        this.currentFolder = job.folder
        try {
          const before = findNote(await this.store.read(job.folder), job.noteId)
          if (!before) continue
          await this.setStatus(job.folder, job.noteId, { status: 'transcribing' })
          const transcript = await this.runWhisper(
            join(job.folder, before.audio),
            before.durationMs,
            model,
            language,
            vocabulary
          )
          // Transcribing again never trades a transcript for an empty one (a worse model, the wrong language).
          const kept = transcript === '' && before.transcript ? before.transcript : transcript
          await this.setStatus(job.folder, job.noteId, { status: 'done', transcript: kept })
          if (this.lastError) {
            this.lastError = null
            this.events.stateChanged()
          }
        } catch (error) {
          console.error('Transcription failed', error)
          if (error instanceof TranscriberError) {
            this.lastError = error.message
            this.events.stateChanged()
          }
          await this.setStatus(job.folder, job.noteId, { status: 'failed' }).catch(() => undefined)
        } finally {
          this.currentFolder = null
        }
      }
      // Waiting for a model: they run as soon as it is downloaded.
      this.queue.push(
        ...deferred.filter(
          (job) => !this.queue.some((queued) => queued.noteId === job.noteId && queued.folder === job.folder)
        )
      )
    } finally {
      this.running = false
      this.events.stateChanged()
    }
    // Deferred jobs only rerun once a model shows up.
    if (this.queue.length > 0 && existsSync(Transcriber.modelPath(getSettings().notes.model))) void this.process()
  }

  /**
   * whisper-cli reads its arguments in the Windows ANSI code page, so a path
   * with other characters (a Greek or Cyrillic user name, say) isn't found.
   * It runs in the models folder instead, with plain relative names: the model
   * file and a temporary copy of the note.
   */
  private async runWhisper(
    wavPath: string,
    durationMs: number,
    model: WhisperModelId,
    language: string,
    vocabulary: string
  ): Promise<string> {
    // Whisper makes words up on silence ("Grazie a tutti", "Thank you").
    if (await isSilent(wavPath).catch(() => false)) return ''
    const dir = Transcriber.modelsDir()
    await this.removeForeignLibraries(dir)
    const copy = `${TEMP_PREFIX}${randomBytes(4).toString('hex')}.wav`
    await copyFile(wavPath, join(dir, copy))
    try {
      return await this.spawnWhisper(
        dir,
        `ggml-${model}.bin`,
        copy,
        language,
        buildPrompt(language, vocabulary),
        timeoutFor(durationMs)
      )
    } finally {
      await rm(join(dir, copy), { force: true }).catch(() => undefined)
    }
  }

  /** Temporary copies and unfinished downloads left behind by a crash. */
  private async removeTemporaryCopies(): Promise<void> {
    const names = await readdir(Transcriber.modelsDir()).catch(() => [] as string[])
    for (const name of names.filter((item) => item.startsWith(TEMP_PREFIX) || item.endsWith('.part'))) {
      await rm(join(Transcriber.modelsDir(), name), { force: true }).catch(() => undefined)
    }
  }

  /**
   * whisper runs in the models folder (see runWhisper), and its library loads
   * every "ggml-*.dll" it finds there too: nothing but models may be in it.
   */
  private async removeForeignLibraries(dir: string): Promise<void> {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/\.dll$/i.test(name)) continue
      console.warn(`Removed ${name} from the models folder: whisper would load it`)
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }

  private spawnWhisper(
    cwd: string,
    modelFile: string,
    wavFile: string,
    language: string,
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    const threads = String(Math.max(1, Math.min(4, availableParallelism() - 1)))
    const args = ['-m', modelFile, '-f', wavFile, '-l', language, '-nt', '-np', '-t', threads, '--prompt', prompt]
    // No inherited GGML_* (GGML_BACKEND_PATH would make it load libraries from there).
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GGML_/i.test(name)))
    return new Promise((resolve, reject) => {
      const child = spawn(Transcriber.binaryPath(), args, { windowsHide: true, cwd, env })
      // Below OBS and Aurora: a note transcribed during a recording must not cost frames.
      if (child.pid) {
        try {
          setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
        } catch {
          // Normal priority then.
        }
      }
      const output: Buffer[] = []
      const errors: Buffer[] = []
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(cleanTranscript(Buffer.concat(output).toString('utf8'), prompt))
        else if (code !== null && code >>> 0 === DLL_NOT_FOUND) {
          reject(
            new TranscriberError(
              'Transcription can’t start: the Microsoft Visual C++ Redistributable (x64) is missing on this PC. Install it from Microsoft’s website, then use “Transcribe again”.'
            )
          )
        } else reject(new Error(`whisper exited with ${code}: ${Buffer.concat(errors).toString('utf8').slice(-500)}`))
      })
    })
  }
}
