import { randomUUID } from 'node:crypto'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppState,
  CompanionSettings,
  CompanionState,
  PlayerCommand,
  PlayerState,
  SessionCommandName,
  SessionCommands,
  SessionDetails,
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
  UpdateState,
  WhisperModelId
} from '../shared/types'
import { sameHotkey } from '../shared/hotkey'
import { RECORDING_CONSENT } from '../shared/terms'
import { isAppPage } from './appPages'
import { AudioCapture } from './audioWindow'
import { CompanionServer, newCompanionToken } from './companion'
import { sessionFilePath } from './media'
import { openNotesWindow } from './notesWindow'
import { GlobalHotkeys } from './hotkeys'
import { ObsRecorder } from './recorder/ObsRecorder'
import type { Recorder } from './recorder/Recorder'
import {
  adoptRecording,
  createSession,
  findRecordingFile,
  RECORDING_FILE,
  listSessions,
  loadSession,
  renameSessionFolder,
  screenshotsDir,
  SessionRenameError,
  SessionStore
} from './sessions'
import { decryptSecret, encryptSecret, getSettings, updateSettings } from './settings'
import { hideStatusWindow, showStatusWindow } from './statusWindow'
import { Transcriber } from './transcriber'

interface ActiveSession {
  folder: string
  session: SessionFile
  openRangeId: string | null
  /** Marker numbers are never reused, so a screenshot can't overwrite another's file. */
  nextMarkerNumber: number
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
  /** Settles when the start (capture, marker, muting) is complete; the stop waits for it. */
  started: Promise<void>
  limit: NodeJS.Timeout | null
}

/** Keeps the recording muted a moment longer: the voice trails off after release. */
const UNMUTE_DELAY_MS = 300
/** Longest text accepted for a note (a few pages). */
const MAX_NOTE_TEXT = 20_000
/** A dictation whose release never arrives (phone asleep, key stuck) ends on its own. */
const MAX_DICTATION_MS = 3 * 60_000
/** After OBS drops the connection during a recording, try to get it back for a minute. */
const RECONNECT_DELAY_MS = 5_000
const RECONNECT_ATTEMPTS = 12

/**
 * Owns the application state. Windows (and later the Companion page) are views:
 * they receive state updates and send commands through IPC.
 */
export class Controller {
  private readonly recorder: Recorder
  private readonly hotkeys = new GlobalHotkeys()
  private active: ActiveSession | null = null
  private dictation: Dictation | null = null
  /** Set while a session is being ended (see endSession). */
  private ending: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
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
        if (marker.categoryIds.includes(categoryId)) {
          marker.categoryIds = marker.categoryIds.filter((id) => id !== categoryId)
          return
        }
        // Commands also come from the Companion page: only known categories are added.
        if (!getSettings().markers.categories.some((category) => category.id === categoryId)) {
          throw new Error('Unknown category')
        }
        marker.categoryIds = [...marker.categoryIds, categoryId]
      })
      this.feedback('category')
    },
    setMarkerTimes: (folderName, markerId, times) =>
      this.editSession(folderName, (session) => {
        const marker = this.findMarker(session, markerId)
        const valid = (value: unknown): boolean => value === undefined || Number.isFinite(value)
        if (!times || !valid(times.timeMs) || !(times.endMs === null || valid(times.endMs))) {
          throw new Error('Invalid marker time')
        }
        const limit = session.recording?.durationMs || Number.MAX_SAFE_INTEGER
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
        if (text !== null && (typeof text !== 'string' || text.length > MAX_NOTE_TEXT))
          throw new Error('Invalid note text')
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

  /** `onRecordingChanged` lets the main window hide itself from screen capture while recording. */
  constructor(private readonly onRecordingChanged: (recording: boolean) => void = () => undefined) {
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
      update: null,
      termsAcceptedVersion: settings.termsAccepted?.version ?? null,
      busy: false
    }
    this.recorder = new ObsRecorder(
      () => {
        const { host, port, passwordEncrypted } = getSettings().obs
        return { url: `ws://${host}:${port}`, password: decryptSecret(passwordEncrypted) }
      },
      {
        onDisconnected: (reason, durationMs) => {
          this.patch({ obs: { status: 'error', error: reason, version: null } })
          if (!this.active) return
          this.endSession(async () => ({ outputPath: null, durationMs })).catch((error: unknown) =>
            console.error(error)
          )
          // OBS may still be recording (only the connection dropped): reconnect and pick the session up again.
          this.scheduleReconnect(1)
        },
        onLevels: (levels) => this.broadcast('audio:levels', levels),
        onRecordingStopped: (outputPath, durationMs) =>
          this.endSession(async () => ({ outputPath, durationMs })).catch((error: unknown) => console.error(error))
      },
      {
        get: () => getSettings().obsPreviousWorkspace,
        set: (obsPreviousWorkspace) =>
          updateSettings({ obsPreviousWorkspace }).catch((error: unknown) => console.error(error))
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

  setUpdate(update: UpdateState | null): void {
    this.patch({ update })
  }

  /** Each step runs even if an earlier one fails, so OBS still gets the trainer's profile back. */
  async shutdown(): Promise<void> {
    this.cancelReconnect()
    this.hotkeys.stop()
    await this.stopSession().catch((error: unknown) => console.error('Could not stop the recording', error))
    this.audio.destroy()
    this.transcriber.cancelDownload()
    await this.companion.stop().catch((error: unknown) => console.error('Could not stop the Companion', error))
    await this.recorder.disconnect().catch((error: unknown) => console.error('Could not restore OBS', error))
  }

  // ---------------------------------------------------------------------------

  private registerIpc(): void {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => {
        // Only the app's own pages may use its API.
        if (!isAppPage(event.senderFrame?.url ?? '')) throw new Error('Not allowed')
        return fn(...args)
      })
    }

    handle('state:get', () => this.state)

    handle('obs:getConnection', (): ObsConnectionConfig => {
      const { host, port, passwordEncrypted } = getSettings().obs
      return { host, port, hasPassword: Boolean(passwordEncrypted) }
    })
    handle('obs:connect', async (config: ObsConnectionConfig) => {
      this.refuseWhileRecording()
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

    // From the top bar: connect again with the saved host, port and password.
    handle('obs:reconnect', () => {
      this.refuseWhileRecording()
      return this.connectObs()
    })

    handle('capture:listDisplays', () => this.requireObs().listDisplays())
    handle('capture:listAudioTargets', (kind: AudioSourceKind) => this.requireObs().listAudioTargets(kind))
    handle('capture:preview', () => (this.recorder.isConnected() ? this.recorder.preview(640) : null))
    handle('capture:save', async (patch: Partial<CaptureConfig>) => {
      const capture: CaptureConfig = { ...this.state.capture, ...patch }
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
    // A session folder by name (never a path from the renderer), or the sessions folder.
    handle('sessions:openFolder', async (folderName?: string) => {
      const target = folderName === undefined ? getSettings().sessionsDir : this.sessionFolder(folderName)
      if (folderName === undefined) await mkdir(target, { recursive: true })
      const problem = await shell.openPath(target)
      if (problem) throw new Error(problem)
    })
    handle('sessions:defaults', () => ({ trainerVid: getSettings().trainerVid }))
    handle('sessions:chooseFolder', () => this.chooseSessionsFolder())
    handle('session:delete', (folderName: string) => this.deleteSession(folderName))
    handle('session:retranscribe', (folderName: string) => this.retranscribeSession(folderName))
    handle('session:updateDetails', (folderName: string, details: SessionDetails) =>
      this.updateSessionDetails(folderName, details)
    )
    handle('session:start', (metadata: SessionMetadata, consent: boolean) => this.startSession(metadata, consent))
    handle('terms:accept', async (version: number) => {
      if (!Number.isInteger(version)) throw new Error('Invalid terms version')
      await updateSettings({ termsAccepted: { version, acceptedAt: new Date().toISOString() } })
      this.patch({ termsAcceptedVersion: version })
    })
    handle('session:stop', () => this.stopSession())

    handle('command', (name: SessionCommandName, args: unknown[]) => this.execute(name, args))
    handle('markers:saveSettings', async (patch: Partial<MarkerSettings>) => {
      const markers: MarkerSettings = { ...getSettings().markers, ...patch }
      await updateSettings({ markers })
      this.patch({ markerSettings: markers })
    })
    handle('notes:saveSettings', async (patch: Partial<NoteSettings>) => {
      const notes: NoteSettings = { ...getSettings().notes, ...patch }
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
    handle('companion:save', async (patch: Partial<CompanionSettings>) => {
      const companion: CompanionSettings = { ...getSettings().companion, ...patch }
      await updateSettings({ companion })
      this.patch({ companionSettings: companion })
      await this.companion.restart()
    })
    handle('companion:newToken', async () => {
      // Unpairs every device: they need the new link or QR code.
      await updateSettings({ companionToken: newCompanionToken() })
      await this.companion.restart()
    })
    handle('companion:refresh', () => this.companion.refreshNetwork())
    handle('companion:openWindow', () =>
      openNotesWindow(this.requireCompanion().pairUrl(), this.state.capture.display?.name)
    )
    handle('companion:openBrowser', () => shell.openExternal(this.requireCompanion().pairUrl()))
    handle('hotkeys:capture', () => this.hotkeys.captureNext())
    handle('hotkeys:cancelCapture', () => this.hotkeys.cancelCapture())
  }

  /** The pairing link must not go to another program that took the Companion's port. */
  private requireCompanion(): CompanionServer {
    if (!this.companion.info().running) throw new Error('The Companion is not running: check Setup → Companion')
    return this.companion
  }

  private requireObs(): Recorder {
    if (!this.recorder.isConnected()) throw new Error('OBS is not connected')
    return this.recorder
  }

  /** Reconnecting drops the connection that the recording depends on. */
  private refuseWhileRecording(): void {
    if (this.active) throw new Error('Stop the recording before connecting to OBS again')
  }

  private scheduleReconnect(attempt: number): void {
    this.cancelReconnect()
    if (attempt > RECONNECT_ATTEMPTS) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.recorder.isConnected() || this.state.obs.status === 'connecting') return
      this.connectObs().catch(() => this.scheduleReconnect(attempt + 1))
    }, RECONNECT_DELAY_MS)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async connectObs(): Promise<void> {
    this.cancelReconnect()
    await this.recorder.disconnect().catch(() => undefined)
    this.patch({ obs: { status: 'connecting', error: null, version: null } })
    try {
      const { version } = await this.recorder.connect()
      this.patch({ obs: { status: 'connected', error: null, version } })
    } catch (error) {
      this.patch({ obs: { status: 'error', error: describeObsError(error), version: null } })
      throw new Error(describeObsError(error))
    }
    await this.reattachRecording().catch((error: unknown) => console.error('Could not resume the recording', error))
    // Applied again before every recording, so a failure here isn't fatal.
    if (this.state.capture.display && !this.active) {
      await this.withBusy(() => this.recorder.configure(this.state.capture)).catch((error: unknown) =>
        console.warn('Capture settings not applied yet:', error instanceof Error ? error.message : error)
      )
    }
  }

  // --- Sessions ------------------------------------------------------------------

  private async startSession(metadata: SessionMetadata, consent: boolean): Promise<void> {
    if (this.active || this.ending) throw new Error('A session is already being recorded')
    // IVAO Rule 2.1.12: no recording of a voice conversation without its participants' consent.
    if (consent !== true) throw new Error('Confirm that everyone in the voice call agreed to be recorded')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metadata?.date ?? ''))) throw new Error('Enter the date of the session')
    const recorder = this.requireObs()
    let capture = this.state.capture
    if (!capture.display) throw new Error('Choose the display to record in Setup first')

    await this.withBusy(async () => {
      // The monitor may have been unplugged or changed resolution since Setup.
      const display = (await recorder.listDisplays()).find((item) => item.id === capture.display!.id)
      if (!display) throw new Error('The monitor chosen in Setup is not connected: choose it again in Setup')
      if (display.width !== capture.display!.width || display.height !== capture.display!.height) {
        capture = { ...capture, display }
        this.patch({ capture })
        await updateSettings({ capture })
      }
      await recorder.configure(capture)
      const { folder, session } = await createSession(getSettings().sessionsDir, metadata)
      session.consent = { statement: RECORDING_CONSENT, confirmedAt: new Date().toISOString() }
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
      await this.activate(folder, session)
      // Only a convenience for the next session: a failure must not break this one.
      await updateSettings({ trainerVid: metadata.trainerVid }).catch((error: unknown) => console.error(error))
    })
  }

  /** Makes a session the one being recorded (a new one, or one picked up again after a lost connection). */
  private async activate(folder: string, session: SessionFile): Promise<void> {
    const lastNumber = Math.max(0, ...session.markers.map((marker) => marker.number))
    this.active = { folder, session, openRangeId: null, nextMarkerNumber: lastNumber + 1 }
    this.onRecordingChanged(true)
    await this.persist()
    // Kept open for the whole session so push-to-talk starts instantly.
    const { micDeviceId, micLabel } = getSettings().notes
    this.audio.open(micDeviceId, micLabel).catch((error: unknown) => {
      console.error('Could not open the microphone', error)
    })
    this.publishRecording()
    if (getSettings().markers.statusWindow) showStatusWindow(this.state.capture.display?.name)
  }

  /**
   * After a lost connection (or a restart of the app), OBS may still be
   * recording one of the sessions: continue it instead of leaving it orphaned.
   */
  private async reattachRecording(): Promise<void> {
    if (this.active || this.ending) return
    const running = await this.recorder.recordingInProgress()
    if (!running) return
    const folder = sessionFilePath([basename(running.outputDir)])
    if (!folder || folder.toLowerCase() !== resolve(running.outputDir).toLowerCase()) return
    const session = await loadSession(folder).catch(() => null)
    if (!session?.recording) return
    console.info(`Continuing the recording of ${basename(folder)}`)
    this.recorder.continueRecording(running.durationMs)
    await this.activate(folder, session)
  }

  /**
   * A recording that wasn't moved into its session folder when it stopped
   * (OBS crashed, the connection was lost, the file was busy) is picked up
   * when the session is opened or the app starts.
   */
  private async recoverRecording(folder: string): Promise<void> {
    if (this.active?.folder === folder) return
    const session = await loadSession(folder)
    const recording = session.recording
    if (!recording || recording.file === RECORDING_FILE) return
    const found = await findRecordingFile(folder, recording.file)
    if (!found) return
    const file = await adoptRecording(folder, found)
    await this.store.update(folder, (current) => {
      if (current.recording) current.recording.file = file
    })
    console.info(`Recording of ${basename(folder)} recovered`)
  }

  /** Stop pressed in the app (or quitting): stops OBS, then finalises. */
  private stopSession(): Promise<void> {
    return this.endSession(async () => {
      const durationMs = this.recorder.currentTimeMs()
      try {
        return { outputPath: await this.recorder.stop(), durationMs }
      } catch (error) {
        // Still finalise: the session must not stay open with OBS in an unknown state.
        console.error('OBS did not stop the recording cleanly', error)
        return { outputPath: null, durationMs }
      }
    })
  }

  /**
   * Ends the session exactly once, whoever asks first: the Stop button, OBS
   * stopping by itself, a lost connection, or quitting. Later requests wait for
   * the first. Markers, notes and hotkeys are refused from the start, so none
   * land in a session that is being closed.
   */
  private endSession(stop: () => Promise<{ outputPath: string | null; durationMs?: number }>): Promise<void> {
    if (this.ending) return this.ending
    const active = this.active
    if (!active) return Promise.resolve()
    this.ending = this.withBusy(async () => {
      try {
        const { outputPath, durationMs } = await stop()
        await this.finaliseSession(active, outputPath, durationMs)
      } finally {
        this.active = null
        this.ending = null
        this.onRecordingChanged(false)
        this.patch({ recording: null })
        this.broadcast('sessions:changed', null)
      }
    })
    return this.ending
  }

  /** Stores the recording in the session folder and saves the session a last time. */
  private async finaliseSession(active: ActiveSession, outputPath: string | null, durationMs?: number): Promise<void> {
    if (this.dictation) await this.stopNote().catch(() => undefined)
    this.audio.close()
    hideStatusWindow()
    const recording = active.session.recording
    if (recording) {
      recording.durationMs = Math.round(durationMs ?? Date.now() - Date.parse(recording.startedAt))
      // Without a path from OBS (crash, lost connection) the file is looked for in the folder.
      const file = outputPath ?? (await findRecordingFile(active.folder, null))
      if (file) {
        try {
          recording.file = await adoptRecording(active.folder, file)
        } catch (error) {
          // Still busy (e.g. OBS still writing it): recovered when the session is opened.
          console.error('Could not move the recording into the session folder', error)
        }
      }
      // A range still open when recording stops ends with the recording.
      const open = active.session.markers.find((marker) => marker.id === active.openRangeId)
      if (open) open.endMs = Math.max(open.timeMs, recording.durationMs)
    }
    try {
      await this.store.update(active.folder, () => undefined)
    } catch (error) {
      console.error('Could not save the session', error)
      throw new Error(
        'The recording stopped, but the session file could not be saved. Close any program using the session folder and restart the app.'
      )
    }
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
    if (this.transcriber.isTranscribing(folder)) {
      throw new Error('A voice note of this session is being transcribed: try again in a few seconds')
    }
    this.transcriber.forget(folder)
    try {
      await shell.trashItem(folder)
    } catch (error) {
      console.error('Could not delete the session', error)
      throw new Error(
        'Could not move the session to the Recycle Bin. Close any program using its files and try again. On a network drive there is no Recycle Bin: delete the folder from File Explorer instead.'
      )
    }
    this.broadcast('sessions:changed', null)
  }

  /**
   * Corrects the trainee, position or session type of a recorded session and
   * renames its folders to match. Returns the new folder name.
   */
  private async updateSessionDetails(folderName: string, details: SessionDetails): Promise<string> {
    const folder = this.sessionFolder(folderName)
    if (this.active?.folder === folder) throw new Error('This session is being recorded')
    if (this.state.review?.folderName === folderName) throw new Error('Close the review of this session first')
    if (this.transcriber.isTranscribing(folder)) {
      throw new Error('A voice note of this session is being transcribed: try again in a few seconds')
    }
    const clean: SessionDetails = {
      traineeVid: String(details.traineeVid ?? '').trim(),
      traineeName: String(details.traineeName ?? '').trim(),
      position: String(details.position ?? '')
        .trim()
        .toUpperCase(),
      trainingType: String(details.trainingType ?? '').trim()
    }
    if (!/^\d+$/.test(clean.traineeVid)) throw new Error('The trainee VID must be a number')
    if (!clean.position) throw new Error('The position is required')
    if (!clean.trainingType) throw new Error('The session type is required')

    // Transcriptions would write into the folder being renamed: pause them.
    this.transcriber.forget(folder)
    let target = folder
    let session: SessionFile | null = null
    try {
      session = await this.store.update(folder, (current) => {
        current.metadata = { ...current.metadata, ...clean }
      })
      target = await renameSessionFolder(getSettings().sessionsDir, folder, session)
    } catch (error) {
      console.error('Could not save the session details', error)
      if (error instanceof SessionRenameError) target = error.folder
      throw new Error(
        session
          ? 'The details are saved, but the folder could not be renamed. Close any program using its files (e.g. File Explorer or a video player) and save again.'
          : 'Could not save the details. Close any program using the session files and try again.'
      )
    } finally {
      const current = session ?? (await loadSession(target).catch(() => null))
      if (current) await this.transcriber.resume(target, current).catch(() => undefined)
      this.broadcast('sessions:changed', null)
    }
    return basename(target)
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
    if (!this.active || this.ending) return
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
      number: active.nextMarkerNumber++,
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
      // Through the store: the session may have ended (or the marker been deleted) meanwhile.
      const session = await this.store.update(active.folder, (current) => {
        const stored = current.markers.find((item) => item.id === marker.id)
        if (stored) stored.screenshot = relative
      })
      if (!session.markers.some((item) => item.id === marker.id)) {
        await unlink(join(active.folder, relative)).catch(() => undefined)
      }
      if (this.active === active) this.publishRecording()
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

  private async deleteMarker(folderName: string, markerId: string, force = false): Promise<void> {
    const folder = this.sessionFolder(folderName)
    if (!force && this.active?.folder === folder && this.dictation?.markerId === markerId) {
      throw new Error('A voice note is being recorded on this marker')
    }
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
    // An accidental push-to-talk tap (force) leaves nothing worth keeping in the Recycle Bin.
    for (const file of files) {
      if (force) await unlink(join(folder, file)).catch(() => undefined)
      else await this.discard(join(folder, file))
    }
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

    const dictation: Dictation = {
      token: randomUUID(),
      markerId: marker?.id ?? '',
      recordedAtMs: now,
      createdMarker: !marker,
      mutedSourceIds: [],
      started: Promise.resolve(),
      limit: setTimeout(() => {
        if (this.dictation === dictation) this.run(() => this.stopNote())
      }, MAX_DICTATION_MS)
    }
    // The release can arrive before this finishes: stopNote waits for `started`.
    dictation.started = (async () => {
      // Start capturing before anything slower (screenshot, OBS calls).
      await this.audio.start(dictation.token)
      if (!marker) {
        marker = this.newMarker(active, 'point')
        dictation.markerId = marker.id
        void this.commitMarker(active, marker, 'noteStart')
      } else {
        this.publishRecording()
        this.feedback('noteStart')
      }
      // Keep the trainer's dictation out of the recording.
      const toMute = this.state.capture.audioSources.filter((source) => source.muteDuringNotes && !source.muted)
      for (const source of toMute) {
        if (this.dictation !== dictation) break // already released
        await this.recorder.setMuted(source.id, true).catch(() => undefined)
        dictation.mutedSourceIds.push(source.id)
      }
    })()
    this.dictation = dictation
    try {
      await dictation.started
    } catch (error) {
      if (this.dictation === dictation) this.dictation = null
      this.publishRecording()
      throw error
    }
  }

  private async stopNote(): Promise<void> {
    const dictation = this.dictation
    const active = this.active
    if (!dictation || !active) return
    this.dictation = null
    if (dictation.limit) clearTimeout(dictation.limit)
    this.publishRecording()
    this.feedback('noteEnd')
    const started = await dictation.started.then(
      () => true,
      () => false
    )

    setTimeout(() => {
      for (const id of dictation.mutedSourceIds) {
        // Only if the trainer didn't mute it on purpose meanwhile.
        const source = this.state.capture.audioSources.find((item) => item.id === id)
        if (source && !source.muted) void this.recorder.setMuted(id, false).catch(() => undefined)
      }
    }, UNMUTE_DELAY_MS)
    if (!started) return

    const audio = await this.audio.stop(dictation.token)
    if (!audio) {
      // An accidental tap: don't leave behind a marker made only for this note.
      if (dictation.createdMarker && this.active === active) {
        await this.deleteMarker(basename(active.folder), dictation.markerId, true).catch(() => undefined)
      }
      return
    }
    const relative = await this.writeNoteAudio(active, Buffer.from(audio.wav))
    const note: Note = {
      id: randomUUID().slice(0, 8),
      audio: relative,
      durationMs: audio.durationMs,
      recordedAtMs: dictation.recordedAtMs,
      transcript: null,
      status: 'pending',
      text: null
    }
    const session = await this.store.update(active.folder, (current) => {
      current.markers.find((marker) => marker.id === dictation.markerId)?.notes.push(note)
    })
    if (!session.markers.some((marker) => marker.notes.includes(note))) {
      // Its marker was deleted meanwhile (e.g. from the Companion).
      await unlink(join(active.folder, relative)).catch(() => undefined)
      return
    }
    if (this.active === active) this.publishRecording()
    this.transcriber.enqueue(active.folder, note.id)
  }

  /**
   * Saves a note's audio under the next free number. Numbers are never reused
   * and an existing file is never replaced, even after notes were deleted or
   * when two notes end at the same moment.
   */
  private async writeNoteAudio(active: ActiveSession, wav: Buffer): Promise<string> {
    await mkdir(join(active.folder, 'notes'), { recursive: true })
    const used = active.session.markers.flatMap((marker) =>
      marker.notes.map((note) => Number(/n-(\d+)\.wav$/.exec(note.audio)?.[1] ?? 0))
    )
    for (let number = Math.max(0, ...used) + 1; ; number++) {
      const relative = `notes/n-${String(number).padStart(4, '0')}.wav`
      try {
        await writeFile(join(active.folder, relative), wav, { flag: 'wx' })
        return relative
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  private async deleteNote(folderName: string, markerId: string, noteId: string): Promise<void> {
    const note = await this.editSession(folderName, (session) => {
      const marker = this.findMarker(session, markerId)
      const found = this.findNote(session, markerId, noteId)
      marker.notes = marker.notes.filter((item) => item.id !== noteId)
      return found
    })
    await this.discard(join(this.sessionFolder(folderName), note.audio))
  }

  /** Files of deleted markers and notes go to the Recycle Bin, so a mistake can be undone from Windows. */
  private async discard(file: string): Promise<void> {
    await shell.trashItem(file).catch(() => undefined) // no Recycle Bin (e.g. network drive): the file stays
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
    await this.recoverRecording(folder).catch((error: unknown) => console.error('Recording not recovered', error))
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

  /** Transcribes notes left over from a previous run (app closed mid-queue) and recovers orphaned recordings. */
  private async resumeTranscriptions(): Promise<void> {
    for (const summary of await listSessions(getSettings().sessionsDir)) {
      await this.recoverRecording(summary.folder).catch(() => undefined)
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
    if (!this.active || this.ending) throw new Error('No session is being recorded')
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
