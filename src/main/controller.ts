import { randomUUID } from 'node:crypto'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppState,
  CompanionSettings,
  CompanionState,
  PlayerCommand,
  PlayerState,
  SessionCommandName,
  SessionCommands,
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
import { CompanionServer, newCompanionToken } from './companion'
import { sessionFilePath } from './media'
import { openNotesWindow } from './notesWindow'
import { GlobalHotkeys } from './hotkeys'
import { ObsRecorder } from './recorder/ObsRecorder'
import type { Recorder } from './recorder/Recorder'
import { adoptRecording, createSession, listSessions, loadSession, screenshotsDir, SessionStore } from './sessions'
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
  private readonly audio = new AudioCapture((problem) => {
    if (problem) {
      console.error('Microphone:', problem)
      this.feedback('error')
    }
    if (problem !== this.state.microphoneError) this.patch({ microphoneError: problem })
  })
  private readonly companion = new CompanionServer(
    {
      state: () => this.companionState(),
      execute: (name, args) => this.execute(name, args),
      changed: () => this.patch({ companion: this.companion.info() })
    },
    () => getSettings().companion,
    () => getSettings().companionToken
  )

  /** Session edits and live actions shared by the desktop windows and the Companion page. */
  private readonly commands: { [K in SessionCommandName]: (...args: SessionCommands[K]) => Promise<void> } = {
    addMarker: () => this.addPointMarker(),
    toggleRange: () => this.toggleRange(),
    startNote: () => this.startNote(),
    stopNote: () => this.stopNote(),
    toggleMarkerCategory: async (folderName, markerId, categoryId) => {
      await this.editSession(folderName, (session) => {
        const marker = this.findMarker(session, markerId)
        marker.categoryIds = marker.categoryIds.includes(categoryId)
          ? marker.categoryIds.filter((id) => id !== categoryId)
          : [...marker.categoryIds, categoryId]
      })
      this.feedback('category')
    },
    setMarkerTimes: (folderName, markerId, times) =>
      this.editSession(folderName, (session) => {
        const marker = this.findMarker(session, markerId)
        const limit = session.recording?.durationMs ?? Number.MAX_SAFE_INTEGER
        const timeMs = Math.round(Math.min(limit, Math.max(0, times.timeMs ?? marker.timeMs)))
        let endMs = times.endMs === undefined ? marker.endMs : times.endMs
        if (marker.kind === 'range' && endMs !== null) endMs = Math.round(Math.min(limit, Math.max(timeMs, endMs)))
        marker.timeMs = timeMs
        marker.endMs = marker.kind === 'range' ? endMs : null
      }),
    deleteMarker: (folderName, markerId) => this.deleteMarker(folderName, markerId),
    setNoteText: (folderName, markerId, noteId, text) =>
      this.editSession(folderName, (session) => {
        const note = this.findNote(session, markerId, noteId)
        note.text = text !== null && text.trim() !== (note.transcript ?? '') ? text.trim() : null
      }),
    deleteNote: (folderName, markerId, noteId) => this.deleteNote(folderName, markerId, noteId),
    retranscribeNote: async (folderName, markerId, noteId) => {
      await this.editSession(folderName, (session) => {
        this.findNote(session, markerId, noteId).status = 'pending'
      })
      this.transcriber.enqueue(this.sessionFolder(folderName), noteId)
    },
    playerCommand: async (command) => this.sendPlayerCommand(command)
  }

  constructor() {
    const settings = getSettings()
    this.transcriber = new Transcriber(this.store, {
      noteChanged: (folder) => void this.sessionChanged(folder),
      stateChanged: () => this.patch({ transcription: this.transcriptionState() })
    })
    this.state = {
      obs: { status: 'disconnected', error: null, version: null },
      recording: null,
      capture: settings.capture,
      markerSettings: settings.markers,
      companionSettings: settings.companion,
      sessionsDir: settings.sessionsDir,
      microphoneError: null,
      noteSettings: settings.notes,
      transcription: this.transcriptionState(),
      review: null,
      companion: { running: false, error: null, urls: [], qr: null, clients: 0, publicNetwork: false },
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
    // Persist the pairing secret generated on first run.
    await updateSettings({ companionToken: getSettings().companionToken })
    await this.companion.restart()
  }

  isRecording(): boolean {
    return this.active !== null
  }

  async shutdown(): Promise<void> {
    this.hotkeys.stop()
    if (this.active) await this.stopSession()
    this.audio.destroy()
    this.transcriber.cancelDownload()
    await this.companion.stop()
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
    handle('sessions:chooseFolder', () => this.chooseSessionsFolder())
    handle('session:delete', (folderName: string) => this.deleteSession(folderName))
    handle('session:retranscribe', (folderName: string) => this.retranscribeSession(folderName))
    handle('session:start', (metadata: SessionMetadata) => this.startSession(metadata))
    handle('session:stop', () => this.stopSession())

    handle('command', (name: SessionCommandName, args: unknown[]) => this.execute(name, args))
    handle('markers:saveSettings', async (markers: MarkerSettings) => {
      await updateSettings({ markers })
      this.patch({ markerSettings: markers })
    })
    handle('notes:saveSettings', async (notes: NoteSettings) => {
      await updateSettings({ notes })
      this.patch({ noteSettings: notes })
      // A different model or language may unblock notes waiting for one.
      if (this.active) await this.transcriber.resume(this.active.folder, this.active.session)
    })
    handle('models:download', (model: WhisperModelId) => this.transcriber.downloadModel(model))
    handle('models:cancelDownload', () => this.transcriber.cancelDownload())
    handle('review:open', (folderName: string) => this.openReview(folderName))
    handle('review:close', () => this.patch({ review: null }))
    handle('player:report', (player: PlayerState) => {
      if (this.state.review) this.patch({ review: { ...this.state.review, player } })
    })
    handle('companion:save', async (companion: CompanionSettings) => {
      await updateSettings({ companion })
      this.patch({ companionSettings: companion })
      await this.companion.restart()
    })
    handle('companion:newToken', async () => {
      // Unpairs every device: they need the new link or QR code.
      await updateSettings({ companionToken: newCompanionToken() })
      await this.companion.restart()
    })
    handle('companion:openWindow', () => openNotesWindow(this.companion.pairUrl()))
    handle('companion:openBrowser', () => shell.openExternal(this.companion.pairUrl()))
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
    const { micDeviceId, micLabel } = getSettings().notes
    this.audio.open(micDeviceId, micLabel).catch((error: unknown) => {
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

  /** New sessions go to the chosen folder; existing ones stay where they are (move them by hand). */
  private async chooseSessionsFolder(): Promise<void> {
    if (this.active) throw new Error('Stop the recording before changing the sessions folder')
    if (this.state.review) throw new Error('Close the review before changing the sessions folder')
    const window = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the sessions folder',
      defaultPath: getSettings().sessionsDir,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const chosen = result.filePaths[0]
    if (result.canceled || !chosen) return
    await updateSettings({ sessionsDir: chosen })
    this.patch({ sessionsDir: chosen })
    this.broadcast('sessions:changed', null)
    void this.resumeTranscriptions()
  }

  /** Moves the session folder to the Recycle Bin, so a mistake can be undone from Windows. */
  private async deleteSession(folderName: string): Promise<void> {
    const folder = this.sessionFolder(folderName)
    if (this.active?.folder === folder) throw new Error('This session is being recorded')
    if (this.state.review?.folderName === folderName) throw new Error('Close the review of this session first')
    if (this.transcriber.forget(folder)) {
      throw new Error('A voice note of this session is being transcribed: try again in a few seconds')
    }
    try {
      await shell.trashItem(folder)
    } catch (error) {
      console.error('Could not delete the session', error)
      throw new Error('Could not move the session to the Recycle Bin. Close any program using its files and try again.')
    }
    this.broadcast('sessions:changed', null)
  }

  /** Transcribes every voice note of a session again, e.g. after downloading a better model. */
  private async retranscribeSession(folderName: string): Promise<void> {
    const folder = this.sessionFolder(folderName)
    const noteIds: string[] = []
    await this.editSession(folderName, (session) => {
      for (const marker of session.markers) {
        for (const note of marker.notes) {
          note.status = 'pending'
          noteIds.push(note.id)
        }
      }
    })
    for (const noteId of noteIds) this.transcriber.enqueue(folder, noteId)
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
      if (category) this.run(() => this.tagLatestMarker(category.id))
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
      categoryIds: [],
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

    const dir = screenshotsDir(active.folder)
    const relative = `${dir}/m-${String(marker.number).padStart(4, '0')}.png`
    try {
      await mkdir(join(active.folder, dir), { recursive: true })
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

  /** Category hotkeys add (or remove) a category on the most recent marker of the session being recorded. */
  private async tagLatestMarker(categoryId: string): Promise<void> {
    const active = this.requireActive()
    const latest = active.session.markers.at(-1)
    if (!latest) {
      this.feedback('error')
      return
    }
    await this.commands.toggleMarkerCategory(basename(active.folder), latest.id, categoryId)
  }

  private async deleteMarker(folderName: string, markerId: string): Promise<void> {
    const folder = this.sessionFolder(folderName)
    const marker = await this.editSession(folderName, (session) => {
      const found = this.findMarker(session, markerId)
      session.markers = session.markers.filter((item) => item.id !== markerId)
      return found
    })
    if (this.active?.folder === folder && this.active.openRangeId === markerId) {
      this.active.openRangeId = null
      this.publishRecording()
    }
    const files = [marker.screenshot, ...marker.notes.map((note) => note.audio)].filter(
      (file): file is string => !!file
    )
    for (const file of files) await unlink(join(folder, file)).catch(() => undefined)
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
      if (dictation.createdMarker && this.active === active) {
        await this.deleteMarker(basename(active.folder), dictation.markerId)
      }
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

  private async deleteNote(folderName: string, markerId: string, noteId: string): Promise<void> {
    const note = await this.editSession(folderName, (session) => {
      const marker = this.findMarker(session, markerId)
      const found = this.findNote(session, markerId, noteId)
      marker.notes = marker.notes.filter((item) => item.id !== noteId)
      return found
    })
    await unlink(join(this.sessionFolder(folderName), note.audio)).catch(() => undefined)
  }

  // --- Session edits, review and Companion -------------------------------------------

  private async execute(name: SessionCommandName, args: unknown[]): Promise<void> {
    const command = this.commands[name] as ((...args: unknown[]) => Promise<void>) | undefined
    if (!command) throw new Error(`Unknown command: ${name}`)
    await command(...args)
  }

  /** Full path of a session folder given its name, refusing anything outside the sessions folder. */
  private sessionFolder(folderName: string): string {
    const folder = typeof folderName === 'string' ? sessionFilePath([folderName]) : null
    if (!folder || folderName.includes('/') || folderName.includes('\\')) throw new Error('Unknown session')
    return folder
  }

  private findMarker(session: SessionFile, markerId: string): Marker {
    const marker = session.markers.find((item) => item.id === markerId)
    if (!marker) throw new Error('Marker not found')
    return marker
  }

  private findNote(session: SessionFile, markerId: string, noteId: string): Note {
    const note = this.findMarker(session, markerId).notes.find((item) => item.id === noteId)
    if (!note) throw new Error('Note not found')
    return note
  }

  /**
   * Applies a change to a session — the one being recorded or any finished
   * one — saves it, and refreshes every view that shows it.
   */
  private async editSession<T>(folderName: string, change: (session: SessionFile) => T): Promise<T> {
    const folder = this.sessionFolder(folderName)
    let result!: T
    const session = await this.store.update(folder, (current) => {
      result = change(current)
    })
    await this.sessionChanged(folder, session)
    return result
  }

  private async sessionChanged(folder: string, session?: SessionFile): Promise<void> {
    if (this.active?.folder === folder) this.publishRecording()
    const review = this.state.review
    if (review && sessionFilePath([review.folderName]) === folder) {
      const current = session ?? (await this.store.update(folder, () => undefined))
      this.patch({ review: { ...review, markers: structuredClone(current.markers) } })
    }
    this.broadcast('sessions:changed', null)
  }

  private async openReview(folderName: string): Promise<void> {
    const folder = this.sessionFolder(folderName)
    if (this.active?.folder === folder) throw new Error('This session is still being recorded')
    const session = await this.store.update(folder, () => undefined)
    this.patch({
      review: {
        folderName,
        metadata: session.metadata,
        durationMs: session.recording?.durationMs ?? 0,
        hasRecording: Boolean(session.recording?.file),
        markers: structuredClone(session.markers),
        player: { positionMs: 0, playing: false, rate: 1, sampledAt: Date.now() }
      }
    })
    await this.transcriber.resume(folder, session)
  }

  /** The review player lives in the main window; other views steer it through here. */
  private sendPlayerCommand(command: PlayerCommand): void {
    if (!this.state.review) throw new Error('No session is open for review')
    this.broadcast('player:command', command)
  }

  private companionState(): CompanionState {
    return {
      recording: this.state.recording,
      review: this.state.review,
      categories: this.state.markerSettings.categories,
      voiceNoteHotkey: this.state.markerSettings.hotkeys.voiceNote?.label ?? null
    }
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
    this.companion.broadcast()
  }

  private broadcast(channel: string, payload: AppState | AudioLevels | MarkerFeedback | PlayerCommand | null): void {
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
