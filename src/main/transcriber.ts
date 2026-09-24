import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { WHISPER_MODELS } from '../shared/whisper'
import type { ModelDownload, Note, SessionFile, WhisperModelId } from '../shared/types'
import type { SessionStore } from './sessions'
import { getSettings } from './settings'

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

/** Vocabulary hint: keeps ATC terms spelled the usual way. */
const PROMPT =
  'ATC training debrief. QNH, squawk, runway, taxi, holding point, handoff, readback, separation, callsign, FL, ILS, SID, STAR.'

const TIMEOUT_MS = 5 * 60_000

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

function findNote(session: SessionFile, noteId: string): Note | undefined {
  for (const marker of session.markers) {
    const note = marker.notes.find((item) => item.id === noteId)
    if (note) return note
  }
  return undefined
}

/** Whisper marks silence and noises with tokens like [BLANK_AUDIO] or (wind blowing). */
function cleanTranscript(output: string): string {
  return output
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

  constructor(
    private readonly store: SessionStore,
    private readonly events: TranscriberEvents
  ) {}

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
    if (this.queue.some((job) => job.noteId === noteId)) return
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
    this.downloadAbort = new AbortController()
    this.download = { model, receivedBytes: 0, totalBytes: 0 }
    this.downloadError = null
    this.events.stateChanged()
    try {
      await mkdir(Transcriber.modelsDir(), { recursive: true })
      const response = await fetch(MODEL_URL(model), { signal: this.downloadAbort.signal })
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)
      this.download.totalBytes = Number(response.headers.get('content-length') ?? 0)
      let lastUpdate = 0
      const hash = createHash('sha256')
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
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
      this.downloadError = this.downloadAbort?.signal.aborted
        ? null
        : error instanceof Error
          ? error.message
          : String(error)
      throw error
    } finally {
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
        const { model, language, transcribe } = getSettings().notes
        if (!transcribe || !this.available()) {
          await this.setStatus(job.folder, job.noteId, { status: 'pending' }).catch(() => undefined)
          continue
        }
        if (!existsSync(Transcriber.modelPath(model))) {
          await this.setStatus(job.folder, job.noteId, { status: 'no-model' }).catch(() => undefined)
          deferred.push(job)
          continue
        }
        this.currentFolder = job.folder
        try {
          await this.setStatus(job.folder, job.noteId, { status: 'transcribing' })
          const session = await this.store.update(job.folder, () => undefined)
          const note = findNote(session, job.noteId)
          if (!note) continue
          const transcript = await this.runWhisper(join(job.folder, note.audio), model, language)
          await this.setStatus(job.folder, job.noteId, { status: 'done', transcript })
        } catch (error) {
          console.error('Transcription failed', error)
          await this.setStatus(job.folder, job.noteId, { status: 'failed' }).catch(() => undefined)
        } finally {
          this.currentFolder = null
        }
      }
      // Waiting for a model: they run as soon as it is downloaded.
      this.queue.push(...deferred.filter((job) => !this.queue.some((queued) => queued.noteId === job.noteId)))
    } finally {
      this.running = false
      this.events.stateChanged()
    }
    // Deferred jobs only rerun once a model shows up.
    if (this.queue.length > 0 && existsSync(Transcriber.modelPath(getSettings().notes.model))) void this.process()
  }

  private runWhisper(wavPath: string, model: WhisperModelId, language: string): Promise<string> {
    const threads = String(Math.max(1, Math.min(4, availableParallelism() - 1)))
    const args = [
      '-m',
      Transcriber.modelPath(model),
      '-f',
      wavPath,
      '-l',
      language,
      '-nt',
      '-np',
      '-t',
      threads,
      '--prompt',
      PROMPT
    ]
    return new Promise((resolve, reject) => {
      const child = spawn(Transcriber.binaryPath(), args, { windowsHide: true })
      const output: Buffer[] = []
      const errors: Buffer[] = []
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(cleanTranscript(Buffer.concat(output).toString('utf8')))
        else reject(new Error(`whisper exited with ${code}: ${Buffer.concat(errors).toString('utf8').slice(-500)}`))
      })
    })
  }
}
