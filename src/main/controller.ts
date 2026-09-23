import { randomUUID } from 'node:crypto'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type {
  AppState,
  AudioLevels,
  AudioSourceKind,
  CaptureConfig,
  EncoderId,
  Hotkey,
  Marker,
  MarkerFeedback,
  MarkerSettings,
  Note,
  NoteSettings,
  ObsConnectionConfig,
  SessionFile,
  SessionMetadata,
  TranscriptionState,
  WhisperModelId
} from '../shared/types'
import { sameHotkey } from '../shared/hotkey'
import { AudioCapture } from './audioWindow'
import { GlobalHotkeys } from './hotkeys'
import { ObsRecorder } from './recorder/ObsRecorder'
import type { Recorder } from './recorder/Recorder'
import { adoptRecording, createSession, listSessions, loadSession, SessionStore } from './sessions'
import { decryptSecret, encryptSecret, getSettings, updateSettings } from './settings'
import { hideStatusWindow, showStatusWindow } from './statusWindow'
import { Transcriber } from './transcriber'

interface ActiveSession {
  folder: string
  session: SessionFile
  openRangeId: string | null
}

/** A voice note being dictated (push-to-talk held). */
interface Dictation {
  token: string
  markerId: string
  recordedAtMs: number
  /** The marker was created for this note (and goes away if the note is empty). */
  createdMarker: boolean
  /** OBS microphone sources muted for the dictation, unmuted afterwards. */
  mutedSourceIds: string[]
}

/** Keeps the recording muted a moment longer: the voice trails off after release. */
const UNMUTE_DELAY_MS = 300

/**
 * Owns the application state. Windows (and later the Companion page) are views:
 * they receive state updates and send commands through IPC.
 */
export class Controller {
  private readonly recorder: Recorder
  private readonly hotkeys = new GlobalHotkeys()
  private active: ActiveSession | null = null
  private dictation: Dictation | null = null
  private state: AppState
  private readonly store = new SessionStore((folder) =>
    this.active?.folder === folder ? this.active.session : undefined
  )
  private readonly transcriber: Transcriber
  private readonly audio = new AudioCapture((message) => {
    console.error('Microphone error:', message)
    this.feedback('error')
  })

  constructor() {
    const settings = getSettings()
    this.transcriber = new Transcriber(this.store, {
      noteChanged: (folder) => {
        if (this.active?.folder === folder) this.publishRecording()
        else this.broadcast('sessions:changed', null)
      },
      stateChanged: () => this.patch({ transcription: this.transcriptionState() })
    })
    this.state = {
      obs: { status: 'disconnected', error: null, version: null },
      recording: null,
      capture: settings.capture,
      markerSettings: settings.markers,
      noteSettings: settings.notes,
      transcription: this.transcriptionState(),
      busy: false
    }
    this.recorder = new ObsRecorder(
      () => {
        const { host, port, passwordEncrypted } = getSettings().obs
        return { url: `ws://${host}:${port}`, password: decryptSecret(passwordEncrypted) }
      },
      {
        onDisconnected: (reason) => {
          this.patch({ obs: { status: 'error', error: reason, version: null } })
          if (this.active) void this.finaliseSession(null)
        },
        onLevels: (levels) => this.broadcast('audio:levels', levels),
        onRecordingStopped: (outputPath) => void this.finaliseSession(outputPath)
      },
      {
        get: () => getSettings().obsPreviousWorkspace,
        set: (obsPreviousWorkspace) => void updateSettings({ obsPreviousWorkspace })
      }
    )
  }

  async init(): Promise<void> {
    await this.detectDefaultEncoder()
    this.registerIpc()
    this.hotkeys.on('down', (hotkey) => this.onHotkey(hotkey))
    this.hotkeys.on('up', (hotkey) => {
      if (this.dictation && sameHotkey(hotkey, getSettings().markers.hotkeys.voiceNote)) this.run(() => this.stopNote())
    })
    try {
      this.hotkeys.start()
    } catch (error) {
      console.error('Global hotkeys unavailable', error)
    }
    // Connect silently at startup; the Setup page shows the outcome.
    void this.connectObs().catch(() => undefined)
    void this.resumeTranscriptions()
  }

  isRecording(): boolean {
    return this.active !== null
  }

  async shutdown(): Promise<void> {
    this.hotkeys.stop()
    if (this.active) await this.stopSession()
    this.audio.destroy()
    this.transcriber.cancelDownload()
    await this.recorder.disconnect().catch(() => undefined)
  }

  // ---------------------------------------------------------------------------

  private registerIpc(): void {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (_event, ...args) => fn(...args))
    }

    handle('state:get', () => this.state)

    handle('obs:getConnection', (): ObsConnectionConfig => {
      const { host, port, passwordEncrypted } = getSettings().obs
      return { host, port, hasPassword: Boolean(passwordEncrypted) }
    })
    handle('obs:connect', async (config: ObsConnectionConfig) => {
      const current = getSettings().obs
      await updateSettings({
        obs: {
          host: config.host.trim() || '127.0.0.1',
          port: config.port || 4455,
          passwordEncrypted:
            config.password !== undefined ? encryptSecret(config.password.trim()) : current.passwordEncrypted
        }
      })
      await this.connectObs()
    })

    handle('capture:listDisplays', () => this.requireObs().listDisplays())
    handle('capture:listAudioTargets', (kind: AudioSourceKind) => this.requireObs().listAudioTargets(kind))
    handle('capture:preview', () => (this.recorder.isConnected() ? this.recorder.preview(640) : null))
    handle('capture:save', async (capture: CaptureConfig) => {
      await updateSettings({ capture })
      this.patch({ capture })
      if (this.recorder.isConnected() && !this.recorder.isRecording()) {
        await this.withBusy(() => this.recorder.configure(capture))
      }
    })
    handle('capture:setMuted', async (sourceId: string, muted: boolean) => {
      await this.updateSource(sourceId, { muted })
      if (this.recorder.isConnected()) await this.recorder.setMuted(sourceId, muted)
    })
    handle('capture:setVolume', async (sourceId: string, volumeDb: number) => {
      await this.updateSource(sourceId, { volumeDb })
      if (this.recorder.isConnected()) await this.recorder.setVolume(sourceId, volumeDb)
    })

    handle('sessions:list', () => listSessions(getSettings().sessionsDir))
    handle('sessions:openFolder', async (folder?: string) => {
      const target = folder ?? getSettings().sessionsDir
      await mkdir(target, { recursive: true })
      await shell.openPath(target)
    })
    handle('sessions:defaults', () => ({ trainerVid: getSettings().trainerVid }))
    handle('session:start', (metadata: SessionMetadata) => this.startSession(metadata))
    handle('session:stop', () => this.stopSession())

    handle('markers:add', () => this.addPointMarker())
    handle('markers:toggleRange', () => this.toggleRange())
    handle('markers:setCategory', (markerId: string | null, categoryId: string | null) =>
      this.setCategory(markerId, categoryId)
    )
    handle('markers:delete', (markerId: string) => this.deleteMarker(markerId))
    handle('markers:saveSettings', async (markers: MarkerSettings) => {
      await updateSettings({ markers })
      this.patch({ markerSettings: markers })
    })
    handle('notes:start', () => this.startNote())
    handle('notes:stop', () => this.stopNote())
    handle('notes:setText', (markerId: string, noteId: string, text: string | null) =>
      this.updateNote(markerId, noteId, (note) => {
        note.text = text !== null && text.trim() !== (note.transcript ?? '') ? text.trim() : null
      })
    )
    handle('notes:delete', (markerId: string, noteId: string) => this.deleteNote(markerId, noteId))
    handle('notes:retranscribe', async (markerId: string, noteId: string) => {
      await this.updateNote(markerId, noteId, (note) => {
        note.status = 'pending'
      })
      this.transcriber.enqueue(this.requireActive().folder, noteId)
    })
    handle('notes:saveSettings', async (notes: NoteSettings) => {
      await updateSettings({ notes })
      this.patch({ noteSettings: notes })
      // A different model or language may unblock notes waiting for one.
      if (this.active) await this.transcriber.resume(this.active.folder, this.active.session)
    })
    handle('models:download', (model: WhisperModelId) => this.transcriber.downloadModel(model))
    handle('models:cancelDownload', () => this.transcriber.cancelDownload())
    handle('hotkeys:capture', () => this.hotkeys.captureNext())
    handle('hotkeys:cancelCapture', () => this.hotkeys.cancelCapture())
  }

  private requireObs(): Recorder {
    if (!this.recorder.isConnected()) throw new Error('OBS is not connected')
    return this.recorder
  }

  private async connectObs(): Promise<void> {
    await this.recorder.disconnect().catch(() => undefined)
    this.patch({ obs: { status: 'connecting', error: null, version: null } })
    try {
      const { version } = await this.recorder.connect()
      this.patch({ obs: { status: 'connected', error: null, version } })
    } catch (error) {
      this.patch({ obs: { status: 'error', error: describeObsError(error), version: null } })
      throw new Error(describeObsError(error))
    }
    // Applied again before every recording, so a failure here isn't fatal.
    if (this.state.capture.display) {
      await this.withBusy(() => this.recorder.configure(this.state.capture)).catch((error: unknown) =>
        console.warn('Capture settings not applied yet:', error instanceof Error ? error.message : error)
      )
    }
  }

  // --- Sessions ------------------------------------------------------------------

  private async startSession(metadata: SessionMetadata): Promise<void> {
    if (this.active) throw new Error('A session is already being recorded')
    const recorder = this.requireObs()
    const capture = this.state.capture
    if (!capture.display) throw new Error('Choose the display to record in Setup first')

    await this.withBusy(async () => {
      await recorder.configure(capture)
      const { folder, session } = await createSession(getSettings().sessionsDir, metadata)
      try {
        await recorder.start(folder)
      } catch (error) {
        // Don't leave an empty session behind when OBS refuses to record.
        await rm(folder, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      session.recording = {
        file: null,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        display: { name: capture.display!.name, width: capture.display!.width, height: capture.display!.height }
      }
      this.active = { folder, session, openRangeId: null }
      await this.persist()
      await updateSettings({ trainerVid: metadata.trainerVid })
    })
    // Kept open for the whole session so push-to-talk starts instantly.
    this.audio.open(getSettings().notes.micDeviceId).catch((error: unknown) => {
      console.error('Could not open the microphone', error)
    })
    this.publishRecording()
    if (getSettings().markers.statusWindow) showStatusWindow(capture.display.name)
  }

  private async stopSession(): Promise<void> {
    if (!this.active) return
    const durationMs = this.recorder.currentTimeMs()
    const outputPath = await this.withBusy(() => this.recorder.stop())
    await this.finaliseSession(outputPath, durationMs)
  }

  /** Stores the recording in the session folder; also used when OBS stops or disconnects. */
  private async finaliseSession(outputPath: string | null, durationMs?: number): Promise<void> {
    const active = this.active
    if (!active) return
    if (this.dictation) await this.stopNote().catch(() => undefined)
    this.audio.close()
    hideStatusWindow()
    const recording = active.session.recording
    if (recording) {
      recording.durationMs = Math.round(durationMs ?? Date.now() - Date.parse(recording.startedAt))
      if (outputPath) {
        try {
          recording.file = await adoptRecording(active.folder, outputPath)
        } catch (error) {
          console.error('Could not move the recording into the session folder', error)
          recording.file = outputPath
        }
      }
      // A range still open when recording stops ends with the recording.
      const open = active.session.markers.find((marker) => marker.id === active.openRangeId)
      if (open) open.endMs = Math.max(open.timeMs, recording.durationMs)
    }
    await this.persist()
    this.active = null
    this.patch({ recording: null })
    this.broadcast('sessions:changed', null)
  }

  private publishRecording(): void {
    const active = this.active
    if (!active) return
    this.patch({
      recording: {
        sessionId: active.session.id,
        metadata: active.session.metadata,
        elapsedMs: this.recorder.currentTimeMs(),
        sampledAt: Date.now(),
        folderName: basename(active.folder),
        markers: active.session.markers.map((marker) => ({ ...marker })),
        openRangeId: active.openRangeId,
        dictatingMarkerId: this.dictation?.markerId ?? null
      }
    })
  }

  private async persist(): Promise<void> {
    const active = this.active
    if (!active) return
    await this.store
      .update(active.folder, () => undefined)
      .catch((error: unknown) => console.error('Could not save the session', error))
  }

  // --- Markers -------------------------------------------------------------------

  private run(action: () => Promise<void>): void {
    action().catch((error: unknown) => {
      console.error('Hotkey action failed', error)
      this.feedback('error')
    })
  }

  private onHotkey(hotkey: Hotkey): void {
    if (!this.active) return
    const { hotkeys, categories } = getSettings().markers
    if (sameHotkey(hotkey, hotkeys.marker)) {
      this.run(() => this.addPointMarker())
    } else if (sameHotkey(hotkey, hotkeys.range)) {
      this.run(() => this.toggleRange())
    } else if (sameHotkey(hotkey, hotkeys.voiceNote)) {
      this.run(() => this.startNote())
    } else {
      const category = categories.find((item) => sameHotkey(hotkey, item.hotkey))
      if (category) this.run(() => this.setCategory(null, category.id))
    }
  }

  private newMarker(active: ActiveSession, kind: Marker['kind']): Marker {
    const pressedAtMs = Math.round(this.recorder.currentTimeMs())
    const preRollMs = getSettings().markers.preRollSeconds * 1000
    return {
      id: randomUUID().slice(0, 8),
      number: (active.session.markers.at(-1)?.number ?? 0) + 1,
      kind,
      timeMs: Math.max(0, pressedAtMs - preRollMs),
      pressedAtMs,
      endMs: null,
      categoryId: null,
      screenshot: null,
      createdAt: new Date().toISOString(),
      notes: []
    }
  }

  /** Saves the marker right away, then attaches the screenshot when OBS has written it. */
  private async commitMarker(active: ActiveSession, marker: Marker, feedback: MarkerFeedback): Promise<void> {
    active.session.markers.push(marker)
    await this.persist()
    this.publishRecording()
    this.feedback(feedback)

    const relative = `screenshots/m-${String(marker.number).padStart(4, '0')}.png`
    try {
      await mkdir(join(active.folder, 'screenshots'), { recursive: true })
      await this.recorder.screenshot(join(active.folder, relative))
      marker.screenshot = relative
      if (this.active === active) {
        await this.persist()
        this.publishRecording()
      }
    } catch (error) {
      console.error('Screenshot failed', error)
    }
  }

  private async addPointMarker(): Promise<void> {
    const active = this.requireActive()
    await this.commitMarker(active, this.newMarker(active, 'point'), 'marker')
  }

  /** First press opens a range, the second closes it. */
  private async toggleRange(): Promise<void> {
    const active = this.requireActive()
    const open = active.session.markers.find((marker) => marker.id === active.openRangeId)
    if (open) {
      open.endMs = Math.max(open.timeMs, Math.round(this.recorder.currentTimeMs()))
      active.openRangeId = null
      await this.persist()
      this.publishRecording()
      this.feedback('rangeEnd')
      return
    }
    const marker = this.newMarker(active, 'range')
    active.openRangeId = marker.id
    await this.commitMarker(active, marker, 'rangeStart')
  }

  /** `markerId` null means the most recent marker (used by category hotkeys). */
  private async setCategory(markerId: string | null, categoryId: string | null): Promise<void> {
    const active = this.requireActive()
    const marker = markerId
      ? active.session.markers.find((item) => item.id === markerId)
      : active.session.markers.at(-1)
    if (!marker) {
      this.feedback('error')
      return
    }
    marker.categoryId = categoryId
    await this.persist()
    this.publishRecording()
    this.feedback('category')
  }

  private async deleteMarker(markerId: string): Promise<void> {
    const active = this.requireActive()
    const marker = active.session.markers.find((item) => item.id === markerId)
    if (!marker) return
    active.session.markers = active.session.markers.filter((item) => item.id !== markerId)
    if (active.openRangeId === markerId) active.openRangeId = null
    await this.persist()
    this.publishRecording()
    const files = [marker.screenshot, ...marker.notes.map((note) => note.audio)].filter(
      (file): file is string => !!file
    )
    for (const file of files) await unlink(join(active.folder, file)).catch(() => undefined)
  }

  // --- Voice notes -----------------------------------------------------------------

  /**
   * Push-to-talk pressed: the note goes to the open range, or to the latest
   * marker if it is recent enough; otherwise a new marker is created for it.
   */
  private async startNote(): Promise<void> {
    const active = this.requireActive()
    if (this.dictation) return
    const now = Math.round(this.recorder.currentTimeMs())
    const windowMs = getSettings().notes.attachWindowSeconds * 1000
    const latest = active.session.markers.at(-1)
    let marker = active.session.markers.find((item) => item.id === active.openRangeId)
    if (!marker && latest && now - latest.pressedAtMs <= windowMs) marker = latest

    const token = randomUUID()
    this.dictation = {
      token,
      markerId: marker?.id ?? '',
      recordedAtMs: now,
      createdMarker: !marker,
      mutedSourceIds: []
    }
    // Start capturing before anything slower (screenshot, OBS calls).
    await this.audio.start(token)

    if (!marker) {
      marker = this.newMarker(active, 'point')
      this.dictation.markerId = marker.id
      void this.commitMarker(active, marker, 'noteStart')
    } else {
      this.publishRecording()
      this.feedback('noteStart')
    }

    // Keep the trainer's dictation out of the recording.
    const toMute = this.state.capture.audioSources.filter((source) => source.muteDuringNotes && !source.muted)
    for (const source of toMute) {
      await this.recorder.setMuted(source.id, true).catch(() => undefined)
      this.dictation?.mutedSourceIds.push(source.id)
    }
  }

  private async stopNote(): Promise<void> {
    const dictation = this.dictation
    const active = this.active
    if (!dictation || !active) return
    this.dictation = null
    this.publishRecording()
    this.feedback('noteEnd')

    setTimeout(() => {
      for (const id of dictation.mutedSourceIds) {
        // Only if the trainer didn't mute it on purpose meanwhile.
        const source = this.state.capture.audioSources.find((item) => item.id === id)
        if (source && !source.muted) void this.recorder.setMuted(id, false).catch(() => undefined)
      }
    }, UNMUTE_DELAY_MS)

    const audio = await this.audio.stop(dictation.token)
    if (!audio) {
      // An accidental tap: don't leave behind a marker made only for this note.
      if (dictation.createdMarker && this.active === active) await this.deleteMarker(dictation.markerId)
      return
    }
    const noteNumber = active.session.markers.reduce((sum, marker) => sum + marker.notes.length, 0) + 1
    const relative = `notes/n-${String(noteNumber).padStart(4, '0')}.wav`
    await mkdir(join(active.folder, 'notes'), { recursive: true })
    await writeFile(join(active.folder, relative), Buffer.from(audio.wav))

    const note: Note = {
      id: randomUUID().slice(0, 8),
      audio: relative,
      durationMs: audio.durationMs,
      recordedAtMs: dictation.recordedAtMs,
      transcript: null,
      status: 'pending',
      text: null
    }
    await this.store.update(active.folder, (session) => {
      session.markers.find((marker) => marker.id === dictation.markerId)?.notes.push(note)
    })
    if (this.active === active) this.publishRecording()
    this.transcriber.enqueue(active.folder, note.id)
  }

  private async updateNote(markerId: string, noteId: string, change: (note: Note) => void): Promise<void> {
    const active = this.requireActive()
    await this.store.update(active.folder, (session) => {
      const note = session.markers.find((marker) => marker.id === markerId)?.notes.find((item) => item.id === noteId)
      if (note) change(note)
    })
    this.publishRecording()
  }

  private async deleteNote(markerId: string, noteId: string): Promise<void> {
    const active = this.requireActive()
    const marker = active.session.markers.find((item) => item.id === markerId)
    const note = marker?.notes.find((item) => item.id === noteId)
    if (!marker || !note) return
    marker.notes = marker.notes.filter((item) => item.id !== noteId)
    await this.persist()
    this.publishRecording()
    await unlink(join(active.folder, note.audio)).catch(() => undefined)
  }

  /** Transcribes notes left over from a previous run (app closed mid-queue). */
  private async resumeTranscriptions(): Promise<void> {
    for (const summary of await listSessions(getSettings().sessionsDir)) {
      const session = await loadSession(summary.folder).catch(() => null)
      if (session) await this.transcriber.resume(summary.folder, session)
    }
  }

  private transcriptionState(): TranscriptionState {
    return {
      installedModels: this.transcriber.installedModels(),
      download: this.transcriber.currentDownload(),
      downloadError: this.transcriber.downloadError,
      queued: this.transcriber.queued(),
      available: this.transcriber.available()
    }
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new Error('No session is being recorded')
    return this.active
  }

  private feedback(kind: MarkerFeedback): void {
    this.broadcast('marker:feedback', kind)
  }

  // --- Settings ------------------------------------------------------------------

  private async updateSource(sourceId: string, patch: { muted?: boolean; volumeDb?: number }): Promise<void> {
    const capture: CaptureConfig = {
      ...this.state.capture,
      audioSources: this.state.capture.audioSources.map((source) =>
        source.id === sourceId ? { ...source, ...patch } : source
      )
    }
    this.patch({ capture })
    await updateSettings({ capture })
  }

  /** On first run, prefer the GPU's hardware encoder so recording doesn't load the CPU. */
  private async detectDefaultEncoder(): Promise<void> {
    const settings = getSettings()
    if (settings.capture.display) return
    try {
      const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId: number; active?: boolean }[] }
      const gpu = info.gpuDevice?.find((device) => device.active) ?? info.gpuDevice?.[0]
      const byVendor: Record<number, EncoderId> = { 0x10de: 'nvenc', 0x1002: 'amd', 0x8086: 'qsv' }
      const encoder = gpu ? byVendor[gpu.vendorId] : undefined
      if (encoder && encoder !== settings.capture.encoder) {
        const capture = { ...settings.capture, encoder }
        await updateSettings({ capture })
        this.state.capture = capture
      }
    } catch {
      // Keep the software encoder.
    }
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.patch({ busy: true })
    try {
      return await fn()
    } finally {
      this.patch({ busy: false })
    }
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    this.broadcast('state:changed', this.state)
  }

  private broadcast(channel: string, payload: AppState | AudioLevels | MarkerFeedback | null): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
}

/** obs-websocket close code for authentication problems. */
const OBS_AUTH_FAILED = 4009

function describeObsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: number }).code
  if (code === OBS_AUTH_FAILED || /authentication/i.test(message)) {
    return /missing/i.test(message)
      ? 'OBS requires a password: paste the one shown in OBS (Tools → WebSocket Server Settings → Show Connect Info).'
      : 'OBS rejected the password. Paste it again from OBS (Tools → WebSocket Server Settings → Show Connect Info).'
  }
  if (/ECONNREFUSED|connect|socket|closed/i.test(message) && !/too old/.test(message)) {
    return 'Cannot reach OBS. Make sure OBS is running and the WebSocket server is enabled (Tools → WebSocket Server Settings).'
  }
  return message
}
