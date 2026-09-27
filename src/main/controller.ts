import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, screen, shell } from 'electron'
import type {
  AppState,
  CompanionSettings,
  CompanionState,
  PlayerCommand,
  PlayerState,
  PttTarget,
  SessionCommandName,
  SessionCommands,
  SessionDetails,
  AudioLevels,
  AudioSourceKind,
  CaptureConfig,
  DisplayOption,
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
import { bestMatch, pressMatches, sameKey } from '../shared/hotkey'
import { PLAYBACK_RATES } from '../shared/markers'
import { RECORDING_CONSENT, TERMS_VERSION } from '../shared/terms'
import { isAppPage } from './appPages'
import { AudioCapture } from './audioWindow'
import { CompanionServer, type CompanionDevice } from './companion'
import { sessionFilePath } from './media'
import { openNotesWindow } from './notesWindow'
import { canSimulate, GlobalHotkeys } from './hotkeys'
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
import {
  checkKeyConflicts,
  validLanguage,
  validMarkerSettings,
  validModel,
  validPlayerCommand,
  validPttKey
} from './validate'
import { WindowMasks } from './windowMasks'

interface ActiveSession {
  folder: string
  session: SessionFile
  openRangeId: string | null
  /** Marker numbers are never reused, so a screenshot can't overwrite another's file. */
  nextMarkerNumber: number
  /** Problems met during this recording, shown until it ends. */
  warnings: string[]
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
  /** Releases the voice-note hotkey held for a note started from a button. */
  releaseHotkey: (() => void) | null
  /** Who started it: the hotkey, the app's button, or a Companion device (only it, or the app, ends it). */
  owner: string
  /** Started from the hotkey: its key is watched, in case the release never reaches the app. */
  keyCheck: NodeJS.Timeout | null
}

/** A push-to-talk key held for a Companion device's button. */
interface PttHoldState {
  release: () => void
  deviceId: string
  deviceName: string
  /** The longest it stays pressed (PTT_MAX_MS). */
  limit: NodeJS.Timeout
  /** Renewed by the device every second while its button is held (PTT_KEEPALIVE_MS). */
  keepalive: NodeJS.Timeout
}

/** Commands from the app's own windows; Companion devices have their own id. */
const FROM_APP = 'app'
const FROM_HOTKEY = 'hotkey'

const PTT_NAMES: Record<PttTarget, string> = { voiceChat: 'Voice chat push-to-talk', aurora: 'Aurora push-to-talk' }

const PTT_TARGETS: PttTarget[] = ['voiceChat', 'aurora']
/**
 * A Companion push-to-talk key is released by itself after this long: one
 * transmission on the IVAO frequency is short; a voice chat talk may be longer.
 */
const PTT_MAX_MS: Record<PttTarget, number> = { aurora: 60_000, voiceChat: 5 * 60_000 }
/** After that, the button must be released and pressed again, not before this pause. */
const PTT_PAUSE_MS = 5_000
/**
 * The Companion repeats "still holding" every second while a push-to-talk
 * button is held; without it for this long (phone locked, Wi-Fi gone, page
 * frozen) the key is released.
 */
const PTT_KEEPALIVE_MS = 2_500
/** A dictation from the hotkey: the key is checked this often, in case its release never reached the app. */
const KEY_CHECK_MS = 250
/** Companion markers: faster than this is a script or a stuck button, not a trainer. */
const MIN_COMPANION_MARKER_MS = 300
/** Session commands that name a session: from the Companion, only the one recorded or reviewed. */
const SESSION_SCOPED = new Set<SessionCommandName>([
  'toggleMarkerCategory',
  'setMarkerTimes',
  'deleteMarker',
  'setNoteText',
  'deleteNote',
  'retranscribeNote'
])

/** Keeps the recording muted a moment longer: the voice trails off after release. */
const UNMUTE_DELAY_MS = 300
/** Longest text accepted for a note (a few pages). */
const MAX_NOTE_TEXT = 20_000
/** A dictation whose release never arrives (phone asleep, key stuck) ends on its own. */
const MAX_DICTATION_MS = 3 * 60_000
/** After OBS drops the connection during a recording, try to get it back for a minute. */
const RECONNECT_DELAY_MS = 5_000
const RECONNECT_ATTEMPTS = 12
/** Monitors changed (rearranged, plugged, resolution): read the recorded one again once they settle. */
const DISPLAY_CHANGE_DELAY_MS = 1_500
/** The latest warnings of a recording are kept; older ones are dropped. */
const MAX_WARNINGS = 5

/**
 * Owns the application state. Windows (and later the Companion page) are views:
 * they receive state updates and send commands through IPC.
 */
export class Controller {
  private readonly recorder: Recorder
  private readonly windowMasks: WindowMasks
  private readonly hotkeys = new GlobalHotkeys()
  /** Push-to-talk keys held for the Companion's buttons. */
  private readonly pttHolds = new Map<PttTarget, PttHoldState>()
  /** A button that reached its time limit: its device must release it, and wait a moment, before pressing again. */
  private readonly pttPaused = new Map<PttTarget, { deviceId: string; until: number; mustRelease: boolean }>()
  /** When each Companion device last added a marker (MIN_COMPANION_MARKER_MS). */
  private readonly lastCompanionMarker = new Map<string, number>()
  private active: ActiveSession | null = null
  private dictation: Dictation | null = null
  /** Set while a session is being ended (see endSession). */
  private ending: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private displayTimer: NodeJS.Timeout | null = null
  /** The hook, OBS and the Companion run (after the terms of use are accepted). */
  private servicesStarted = false
  /** A session being started (see startSession). */
  private starting: Promise<void> | null = null
  /** Quitting: no new session, no new connection. */
  private shuttingDown = false
  /** Whether the main window may be captured (shared on Discord): only while a review is open. */
  private shareable = false
  private state: AppState
  /** A finished session whose last save failed: kept until "Save again" works. */
  private unsaved: { folder: string; session: SessionFile } | null = null
  /** Voice notes released and still being saved (the session end waits for them). */
  private readonly savingNotes = new Set<Promise<void>>()
  private readonly store = new SessionStore((folder) =>
    this.active?.folder === folder
      ? this.active.session
      : this.unsaved?.folder === folder
        ? this.unsaved.session
        : undefined
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
      execute: (name, args, device) => this.execute(name, args, device),
      deviceGone: (device) => this.deviceGone(device),
      paired: (device, address) =>
        this.patch({
          notice: {
            kind: 'warning',
            title: 'A new device paired with the Companion',
            message: `${device.name}${address ? ` (${address.replace(/^::ffff:/, '')})` : ''} can now see your notes and use the Companion’s buttons. If it isn’t yours, remove it in Setup → Companion.`
          }
        }),
      mediaAllowed: (folderName, path) => this.companionMayRead(folderName, path),
      changed: () => this.patch({ companion: this.companion.info() })
    },
    () => getSettings().companion,
    {
      list: () => getSettings().companionDevices ?? [],
      save: async (companionDevices) => {
        await updateSettings({ companionDevices })
      }
    }
  )

  /** Session edits and live actions shared by the desktop windows and the Companion page. */
  private readonly commands: { [K in SessionCommandName]: (...args: SessionCommands[K]) => Promise<void> } = {
    addMarker: () => this.addPointMarker(),
    toggleRange: () => this.toggleRange(),
    // Notes and push-to-talk depend on who asks: see execute().
    startNote: () => this.startNote(FROM_APP),
    stopNote: () => this.stopNote(FROM_APP),
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
        // Only the range being recorded is open: a closed one would never get an end again.
        if (times.endMs === null && marker.kind === 'range' && this.active?.openRangeId !== markerId) {
          throw new Error('A range needs an end')
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
    playerCommand: async (command) => this.sendPlayerCommand(command),
    holdPtt: async () => {
      throw new Error('Push-to-talk buttons are on the Companion')
    },
    releasePtt: async (target) => this.releasePtt(target, FROM_APP)
  }

  /**
   * `onShareableChanged`: the main window hides itself from screen capture
   * (OBS, Discord) except while a review is open, the one page meant to be
   * shared: the sessions list shows other trainees, a recording the notes.
   */
  constructor(private readonly onShareableChanged: (shareable: boolean) => void) {
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
      sessionsDirWarning: sessionsDirWarning(settings.sessionsDir),
      hiddenWindowsError: null,
      hiddenWindowsFound: [],
      microphoneError: null,
      noteSettings: settings.notes,
      transcription: this.transcriptionState(),
      review: null,
      companion: { running: false, error: null, urls: [], qr: null, clients: 0, publicNetwork: false, devices: [] },
      update: null,
      notice: null,
      pttHolds: [],
      stuckKey: null,
      hotkeysError: null,
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
          this.patch({
            notice: {
              kind: 'warning',
              title: 'Connection to OBS lost during the recording',
              message:
                'Reconnecting… If OBS is still recording, the session continues (markers made meanwhile are missing).'
            }
          })
          // Not stopped: OBS may still be recording, and the session goes on once it is back.
          this.endSession(async () => ({ outputPath: null, durationMs, stopped: false })).catch((error: unknown) =>
            console.error(error)
          )
          this.scheduleReconnect(1)
        },
        onLevels: (levels) => this.broadcast('audio:levels', levels),
        onRecordingStopped: (outputPath, durationMs) =>
          this.endSession(async () => ({ outputPath, durationMs, stopped: true })).then(
            () =>
              this.patch({
                notice: {
                  kind: 'warning',
                  title: 'OBS stopped the recording',
                  message:
                    'The session was saved. If you didn’t stop it in OBS, check OBS: the disk may be full or the encoder may have failed.'
                }
              }),
            (error: unknown) => console.error(error)
          ),
        onWarning: (message) => this.warn(message),
        onPauseChanged: () => this.publishRecording()
      },
      {
        get: () => getSettings().obsPreviousWorkspace,
        set: (obsPreviousWorkspace) =>
          updateSettings({ obsPreviousWorkspace }).catch((error: unknown) => console.error(error))
      }
    )
    this.windowMasks = new WindowMasks(
      this.recorder,
      () => this.state.capture,
      (hiddenWindowsError) => {
        // During a recording the trainer must know at once: private windows may be in the video.
        if (hiddenWindowsError && this.active) this.feedback('error')
        this.patch({ hiddenWindowsError })
      },
      (hiddenWindowsFound) => this.patch({ hiddenWindowsFound })
    )
  }

  async init(): Promise<void> {
    await this.detectDefaultEncoder()
    this.registerIpc()
    await this.windowMasks.start()
    this.hotkeys.on('down', (hotkey) => this.onHotkey(hotkey))
    this.hotkeys.on('up', (hotkey) => {
      const dictation = this.dictation
      if (dictation?.owner === FROM_HOTKEY && pressMatches(hotkey, getSettings().markers.hotkeys.voiceNote)) {
        this.run(() => this.stopNote(FROM_HOTKEY))
      }
    })
    this.hotkeys.on('stuck', (stuckKey) => {
      if (stuckKey) {
        this.feedback('error')
        this.warn(stuckKey)
      }
      this.patch({ stuckKey })
    })
    // A monitor rearranged, plugged in or resized moves the recorded one: the masks follow its position.
    screen.on('display-added', () => this.scheduleDisplayRefresh())
    screen.on('display-removed', () => this.scheduleDisplayRefresh())
    screen.on('display-metrics-changed', () => this.scheduleDisplayRefresh())
    // Locking the PC or putting it to sleep: nothing stays pressed (Aurora would keep transmitting),
    // and a dictation whose release happens over the lock screen ends.
    powerMonitor.on('lock-screen', () => this.releaseEverything())
    powerMonitor.on('suspend', () => this.releaseEverything())
    // The hook, OBS (it switches OBS to the app's profile) and the Companion only once the terms are accepted.
    if (getSettings().termsAccepted?.version === TERMS_VERSION) await this.startServices()
  }

  /** Everything that acts outside the app's own window. */
  private async startServices(): Promise<void> {
    if (this.servicesStarted) return
    this.servicesStarted = true
    const { companion, markers, notes } = getSettings()
    // Left down by a run that ended while holding them (a crash): released before anything else.
    this.hotkeys.releaseIfDown([
      companion.pttKeys.voiceChat,
      companion.pttKeys.aurora,
      notes.holdHotkeyFromButtons ? markers.hotkeys.voiceNote : null
    ])
    try {
      this.hotkeys.start()
    } catch (error) {
      console.error('Global hotkeys unavailable', error)
      this.patch({
        hotkeysError: `Hotkeys don’t work: Windows refused the keyboard hook (${error instanceof Error ? error.message : String(error)}). Restart the app; if it persists, restart Windows.`
      })
    }
    // Connect silently at startup; the Setup page shows the outcome.
    // Then leftovers of the last run: after connecting, so a recording OBS is still
    // writing is continued (reattachRecording) rather than picked up as finished.
    void this.connectObs()
      .catch(() => undefined)
      .finally(() => void this.resumeTranscriptions())
    await this.companion.restart()
  }

  /** Lock screen, sleep, an unexpected error: every key the app holds is released, dictations end. */
  releaseEverything(): void {
    for (const target of [...this.pttHolds.keys()]) this.releasePtt(target, FROM_APP)
    if (this.dictation) this.run(() => this.stopNote(FROM_APP))
    this.hotkeys.releaseAll()
  }

  isRecording(): boolean {
    return this.active !== null || this.starting !== null
  }

  /** See the constructor: the main window is capturable only while a review is open. */
  isShareable(): boolean {
    return this.shareable
  }

  setUpdate(update: UpdateState | null): void {
    this.patch({ update })
  }

  /** Each step runs even if an earlier one fails, so OBS still gets the trainer's profile back. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.cancelReconnect()
    // A recording starting right now is stopped once it has started, not left running in OBS.
    await this.starting?.catch(() => undefined)
    if (this.displayTimer) clearTimeout(this.displayTimer)
    this.hotkeys.stop()
    await this.stopSession().catch((error: unknown) => console.error('Could not stop the recording', error))
    this.audio.destroy()
    this.transcriber.cancelDownload()
    await this.companion.stop().catch((error: unknown) => console.error('Could not stop the Companion', error))
    this.windowMasks.stop()
    await this.recorder.disconnect().catch((error: unknown) => console.error('Could not restore OBS', error))
    // A session whose last save failed gets one more try.
    await this.saveUnsaved().catch((error: unknown) => console.error('Session still not saved', error))
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
      if (this.connecting) throw new Error('Already connecting to OBS: wait a moment')
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
    handle('capture:listWindows', () => this.windowMasks.listWindows())
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
      if (version !== TERMS_VERSION) throw new Error('Invalid terms version')
      await updateSettings({ termsAccepted: { version, acceptedAt: new Date().toISOString() } })
      this.patch({ termsAcceptedVersion: version })
      await this.startServices()
    })
    handle('session:stop', () => this.stopSession())
    handle('notice:dismiss', () => this.patch({ notice: null }))
    handle('notice:retry', () => this.saveUnsaved())

    handle('command', (name: SessionCommandName, args: unknown[]) => this.execute(name, args, null))
    handle('markers:saveSettings', async (patch: unknown) => {
      const markers: MarkerSettings = { ...getSettings().markers, ...validMarkerSettings(patch) }
      checkKeyConflicts(getSettings().companion.pttKeys, markers.hotkeys.voiceNote)
      const { holdHotkeyFromButtons } = getSettings().notes
      if (holdHotkeyFromButtons && markers.hotkeys.voiceNote && !canSimulate(markers.hotkeys.voiceNote)) {
        throw new Error(
          `${markers.hotkeys.voiceNote.label} can’t be pressed by the app: choose another voice-note key, or turn off holding it for buttons`
        )
      }
      await updateSettings({ markers })
      this.patch({ markerSettings: markers })
    })
    handle('notes:saveSettings', async (patch: Partial<NoteSettings>) => {
      if (patch.model !== undefined) validModel(patch.model)
      if (patch.language !== undefined) validLanguage(patch.language)
      if (patch.vocabulary !== undefined && (typeof patch.vocabulary !== 'string' || patch.vocabulary.length > 2000)) {
        throw new Error('Invalid vocabulary')
      }
      const notes: NoteSettings = { ...getSettings().notes, ...patch }
      const voiceNote = getSettings().markers.hotkeys.voiceNote
      if (notes.holdHotkeyFromButtons && voiceNote && !canSimulate(voiceNote)) {
        throw new Error(`${voiceNote.label} can’t be pressed by the app: choose another voice-note key first`)
      }
      await updateSettings({ notes })
      this.patch({ noteSettings: notes })
      // A different model or language may unblock notes waiting for one.
      if (this.active) await this.transcriber.resume(this.active.folder, this.active.session)
    })
    handle('models:download', (model: WhisperModelId) => this.transcriber.downloadModel(validModel(model)))
    handle('models:cancelDownload', () => this.transcriber.cancelDownload())
    handle('review:open', (folderName: string) => this.openReview(folderName))
    handle('review:close', () => {
      // Push-to-talk buttons work during a recording or a review only.
      if (!this.active) for (const target of [...this.pttHolds.keys()]) this.releasePtt(target, FROM_APP)
      this.patch({ review: null })
    })
    // A recording picked up after a crash has no duration: the player tells it from the video itself.
    handle('review:duration', async (folderName: string, durationMs: number) => {
      const review = this.state.review
      if (!review || review.folderName !== folderName || review.durationMs > 0) return
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 48 * 3_600_000) return
      const length = Math.round(durationMs)
      const session = await this.store.update(this.sessionFolder(folderName), (current) => {
        if (current.recording && !current.recording.durationMs) current.recording.durationMs = length
        // Ranges left open by the crash end with the recording.
        for (const marker of current.markers) {
          if (marker.kind === 'range' && marker.endMs === null) marker.endMs = Math.max(marker.timeMs, length)
        }
      })
      if (this.state.review?.folderName === folderName) {
        this.patch({ review: { ...this.state.review, durationMs: length, markers: structuredClone(session.markers) } })
      }
      this.broadcast('sessions:changed', null)
    })
    handle('player:report', (player: PlayerState) => {
      const review = this.state.review
      if (!review) return
      // Several times a second: the position alone goes to the devices, not the whole state to every window.
      this.state = { ...this.state, review: { ...review, player } }
      this.companion.sendPlayer(player)
    })
    handle('companion:save', async (patch: Partial<CompanionSettings>) => {
      const previous = getSettings().companion
      const companion: CompanionSettings = { ...previous, ...patch }
      if (patch.pttKeys) {
        companion.pttKeys = {
          voiceChat: validPttKey('voiceChat', patch.pttKeys.voiceChat),
          aurora: validPttKey('aurora', patch.pttKeys.aurora)
        }
        checkKeyConflicts(companion.pttKeys, getSettings().markers.hotkeys.voiceNote)
      }
      if (!Number.isInteger(companion.port) || companion.port < 1024 || companion.port > 65535) {
        throw new Error('The port must be a number from 1024 to 65535')
      }
      companion.enabled = Boolean(companion.enabled)
      companion.lan = Boolean(companion.lan)
      await updateSettings({ companion })
      this.patch({ companionSettings: companion })
      if (patch.pttKeys) for (const target of [...this.pttHolds.keys()]) this.releasePtt(target, FROM_APP)
      // Only these need the server restarted, which disconnects the devices.
      if (
        companion.enabled !== previous.enabled ||
        companion.lan !== previous.lan ||
        companion.port !== previous.port
      ) {
        await this.companion.restart()
      }
    })
    // Every device must pair again (a lost phone, a link seen by someone else).
    handle('companion:unpairAll', () => this.companion.removeDevices('all'))
    handle('companion:removeDevice', (id: string) => this.companion.removeDevices([String(id)]))
    // The PC's "Release" next to a push-to-talk key held for a device.
    handle('companion:releasePtt', (target: PttTarget) => this.releasePtt(target, FROM_APP))
    handle('companion:refresh', () => this.companion.refreshNetwork())
    handle('companion:openWindow', () =>
      openNotesWindow(this.requireCompanion().localPage(), this.state.capture.display?.name)
    )
    handle('companion:openBrowser', () => shell.openExternal(this.requireCompanion().pairUrl()))
    handle('hotkeys:capture', (id: string, modifiersAlone?: boolean) =>
      this.hotkeys.captureNext(String(id), modifiersAlone === true)
    )
    handle('hotkeys:cancelCapture', (id: string) => this.hotkeys.cancelCapture(String(id)))
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
    if (attempt > RECONNECT_ATTEMPTS) {
      this.patch({
        notice: {
          kind: 'error',
          title: 'Could not reconnect to OBS',
          message:
            'The session is saved up to the lost connection. If OBS went on recording, stop it in OBS: its file is added to the session when you open it.'
        }
      })
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.recorder.isConnected() || this.state.obs.status === 'connecting') return
      this.connectObs().then(
        () =>
          this.patch({
            notice: this.active
              ? { kind: 'info', title: 'Connection to OBS is back', message: 'The recording continues.' }
              : {
                  kind: 'warning',
                  title: 'Reconnected to OBS',
                  message: 'OBS was no longer recording: the session is saved up to the lost connection.'
                }
          }),
        () => this.scheduleReconnect(attempt + 1)
      )
    }, RECONNECT_DELAY_MS)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /** One connection attempt at a time (two would close each other's socket); a second request joins it. */
  private connecting: Promise<void> | null = null

  private connectObs(): Promise<void> {
    this.connecting ??= this.doConnectObs().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnectObs(): Promise<void> {
    if (this.shuttingDown) throw new Error('The app is closing')
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
    // The monitors may have been rearranged since the app last talked to OBS.
    await this.refreshDisplay().catch((error: unknown) =>
      console.warn('Recorded monitor not checked:', error instanceof Error ? error.message : error)
    )
    // Applied again before every recording, so a failure here isn't fatal.
    if (this.state.capture.display && !this.active) {
      await this.withBusy(() => this.recorder.configure(this.state.capture)).catch((error: unknown) =>
        console.warn('Capture settings not applied yet:', error instanceof Error ? error.message : error)
      )
    }
    // A recording started in OBS itself must not land in an old session's folder.
    if (!this.active) await this.recorder.resetOutputDir(getSettings().sessionsDir).catch(() => undefined)
  }

  private scheduleDisplayRefresh(): void {
    if (this.displayTimer) clearTimeout(this.displayTimer)
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null
      this.refreshDisplay().catch((error: unknown) =>
        console.warn('Recorded monitor not checked:', error instanceof Error ? error.message : error)
      )
    }, DISPLAY_CHANGE_DELAY_MS)
  }

  /**
   * Reads the recorded monitor from OBS again: its name carries its position
   * ("@ x,y"), which the masks need, and changes when monitors are rearranged
   * even if the monitor and its resolution stay the same.
   */
  private async refreshDisplay(): Promise<void> {
    const current = this.state.capture.display
    if (!current || !this.recorder.isConnected()) return
    const display = (await this.recorder.listDisplays()).find((item) => item.id === current.id)
    if (!display) return // unplugged: Start says so
    // While recording OBS keeps the size it started with; the position is what the masks follow.
    const next = this.active ? { ...current, name: display.name } : display
    if (sameDisplay(next, current)) return
    console.info(`Recorded monitor is now “${next.name}” (was “${current.name}”)`)
    const capture = { ...this.state.capture, display: next }
    this.patch({ capture })
    await updateSettings({ capture })
  }

  // --- Sessions ------------------------------------------------------------------

  private startSession(metadata: SessionMetadata, consent: boolean): Promise<void> {
    if (this.starting) return Promise.reject(new Error('The recording is starting'))
    // Counted as recording from now: quitting asks first, and waits for the start to stop it.
    this.starting = this.doStartSession(metadata, consent).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStartSession(metadata: SessionMetadata, consent: boolean): Promise<void> {
    if (this.shuttingDown) throw new Error('The app is closing')
    if (this.active || this.ending) throw new Error('A session is already being recorded')
    if (getSettings().termsAccepted?.version !== TERMS_VERSION) throw new Error('Accept the terms of use first')
    // IVAO Rule 2.1.12: no recording of a voice conversation without its participants' consent.
    if (consent !== true) throw new Error('Confirm that everyone in the voice call agreed to be recorded')
    metadata = validMetadata(metadata)
    const recorder = this.requireObs()
    let capture = this.state.capture
    if (!capture.display) throw new Error('Choose the display to record in Setup first')

    await this.withBusy(async () => {
      // The monitor may have been unplugged, resized or moved (its position, for the masks) since Setup.
      const display = (await recorder.listDisplays()).find((item) => item.id === capture.display!.id)
      if (!display) throw new Error('The monitor chosen in Setup is not connected: choose it again in Setup')
      if (!sameDisplay(display, capture.display!)) {
        capture = { ...capture, display }
        this.patch({ capture })
        await updateSettings({ capture })
      }
      await recorder.configure(capture)
      // Private windows covered before the first frame. A problem is shown (and heard) but doesn't stop the session.
      await this.windowMasks.refreshNow().catch(() => undefined)
      const { folder, session } = await createSession(getSettings().sessionsDir, metadata)
      session.consent = {
        statement: RECORDING_CONSENT,
        confirmedAt: new Date().toISOString(),
        termsVersion: TERMS_VERSION
      }
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
    // A range left open when the connection dropped is still open.
    const openRange = session.markers.findLast((marker) => marker.kind === 'range' && marker.endMs === null)
    this.active = {
      folder,
      session,
      openRangeId: openRange?.id ?? null,
      nextMarkerNumber: lastNumber + 1,
      warnings: []
    }
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
    // The session is still being closed after the connection dropped: continue it once that is done.
    if (this.ending) await this.ending.catch(() => undefined)
    if (this.active) return
    const running = await this.recorder.recordingInProgress()
    if (!running) return
    const folder = sessionFilePath([basename(running.outputDir)])
    if (!folder || folder.toLowerCase() !== resolve(running.outputDir).toLowerCase()) return
    const session = await this.store.read(folder).catch(() => null)
    const recording = session?.recording
    // Only a recording that never stopped. OBS recording into a finished session's
    // folder (started from OBS) is something else, and must not replace its video.
    if (!session || !recording || recording.endedAt || recording.file !== null) return
    console.info(`Continuing the recording of ${basename(folder)}`)
    this.recorder.continueRecording(running.durationMs)
    await this.activate(folder, session)
    // A dictation cut off by the lost connection may have left a microphone muted in OBS.
    for (const source of this.state.capture.audioSources) {
      await this.recorder.setMuted(source.id, source.muted).catch(() => undefined)
    }
  }

  /**
   * A recording that wasn't moved into its session folder when it stopped
   * (OBS crashed, the connection was lost, the file was busy) is picked up
   * when the session is opened or the app starts.
   */
  private async recoverRecording(folder: string, opening = false): Promise<void> {
    if (this.active?.folder === folder) return
    const session = await this.store.read(folder)
    const recording = session.recording
    if (!recording || recording.file !== null) return
    // Never stopped (lost connection, crash): OBS may still be writing it, and the
    // session continues once OBS is back. Only the trainer opening it takes the file now.
    if (!recording.endedAt && !opening) {
      if (!this.recorder.isConnected()) return
      const running = await this.recorder.recordingInProgress().catch(() => null)
      if (running && resolve(running.outputDir).toLowerCase() === folder.toLowerCase()) return
    }
    const found = await findRecordingFile(folder)
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
        return { outputPath: await this.recorder.stop(), durationMs, stopped: true }
      } catch (error) {
        // Still finalise: the session must not stay open with OBS in an unknown state.
        console.error('OBS did not stop the recording cleanly', error)
        return { outputPath: null, durationMs, stopped: false }
      }
    })
  }

  /**
   * Ends the session exactly once, whoever asks first: the Stop button, OBS
   * stopping by itself, a lost connection, or quitting. Later requests wait for
   * the first. Markers, notes and hotkeys are refused from the start, so none
   * land in a session that is being closed.
   */
  /**
   * `stopped`: OBS confirmed the recording stopped. After a lost connection it
   * may still be recording: the session then stays open to be continued.
   */
  private endSession(
    stop: () => Promise<{ outputPath: string | null; durationMs?: number; stopped: boolean }>
  ): Promise<void> {
    if (this.ending) return this.ending
    const active = this.active
    if (!active) return Promise.resolve()
    this.ending = this.withBusy(async () => {
      try {
        const { outputPath, durationMs, stopped } = await stop()
        await this.finaliseSession(active, outputPath, durationMs, stopped)
      } finally {
        this.active = null
        this.ending = null
        this.patch({ recording: null })
        // Push-to-talk buttons work during a recording or a review only.
        if (!this.state.review) this.releaseAllPtt()
        this.broadcast('sessions:changed', null)
        // Stopped from OBS itself: OBS's own folder still points into this session.
        void this.recorder.resetOutputDir(getSettings().sessionsDir).catch(() => undefined)
      }
    })
    return this.ending
  }

  /** Stores the recording in the session folder and saves the session a last time. */
  private async finaliseSession(
    active: ActiveSession,
    outputPath: string | null,
    durationMs: number | undefined,
    stopped: boolean
  ): Promise<void> {
    if (this.dictation) await this.stopNote(FROM_APP).catch(() => undefined)
    // A note released just before the end is still being saved: its audio must not be cut off.
    await Promise.all([...this.savingNotes]).catch(() => undefined)
    this.audio.close()
    hideStatusWindow()
    const recording = active.session.recording
    if (recording) {
      recording.durationMs = Math.round(durationMs ?? Date.now() - Date.parse(recording.startedAt))
      if (stopped) {
        recording.endedAt = new Date().toISOString()
        // Without a path from OBS (it failed) the file is looked for in the folder.
        const file = outputPath ?? (await findRecordingFile(active.folder))
        if (file) {
          try {
            recording.file = await adoptRecording(active.folder, file)
          } catch (error) {
            // Still busy: recovered when the session is opened.
            console.error('Could not move the recording into the session folder', error)
          }
        }
      }
      // Not stopped (connection lost): OBS may still be writing the file. The
      // session is continued if it is, or its file is picked up later.
      // A range still open when recording stops ends with the recording (kept open if it may continue).
      const open = active.session.markers.find((marker) => marker.id === active.openRangeId)
      if (open && stopped) open.endMs = Math.max(open.timeMs, recording.durationMs)
    }
    // Kept in memory until it is saved: "Save again" (in the notice) retries.
    this.unsaved = { folder: active.folder, session: active.session }
    try {
      await this.store.update(active.folder, () => undefined)
      this.unsaved = null
    } catch (error) {
      console.error('Could not save the session', error)
      this.patch({
        notice: {
          kind: 'error',
          title: 'The session file could not be saved',
          message: `The recording stopped, but the markers and notes of ${basename(active.folder)} are not saved yet: ${describeFileError(error)}. Close any program using the session folder, then save again. Don’t close the app before.`,
          retry: 'saveSession'
        }
      })
      throw new Error('The recording stopped, but the session file could not be saved.')
    }
  }

  /** "Save again" in the notice after the final save failed. */
  private async saveUnsaved(): Promise<void> {
    const unsaved = this.unsaved
    if (!unsaved) return
    try {
      await this.store.update(unsaved.folder, () => undefined)
    } catch (error) {
      throw new Error(`Still not saved: ${describeFileError(error)}.`)
    }
    this.unsaved = null
    this.patch({ notice: null })
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
    this.patch({ sessionsDir: chosen, sessionsDirWarning: sessionsDirWarning(chosen) })
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
        'Windows could not move the session to the Recycle Bin. A program may be using its files (close it and try again), the drive may have no Recycle Bin (network or some USB drives), or the recording may be too big for it. You can delete the folder from File Explorer instead (Open the session folder).'
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
      if (session && target !== folder) {
        // The session folder has its new name already: the dialog must not keep the old one.
        this.patch({
          notice: {
            kind: 'warning',
            title: 'Details saved, screenshots folder not renamed',
            message:
              'Close any program using the session’s screenshots (File Explorer, an image viewer), then save the details again to rename it.'
          }
        })
        return basename(target)
      }
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
        metadata: active.session.metadata,
        elapsedMs: this.recorder.currentTimeMs(),
        sampledAt: Date.now(),
        folderName: basename(active.folder),
        markers: active.session.markers.map((marker) => ({ ...marker })),
        openRangeId: active.openRangeId,
        dictatingMarkerId: this.dictation?.markerId ?? null,
        warnings: [...active.warnings],
        paused: this.recorder.isPaused()
      }
    })
  }

  /** Shows a problem of the recording in progress (app, status window, Companion) with the error tone. */
  private warn(message: string): void {
    console.warn('Recording:', message)
    const active = this.active
    if (!active) return
    active.warnings = [...active.warnings.filter((item) => item !== message), message].slice(-MAX_WARNINGS)
    this.feedback('error')
    this.publishRecording()
  }

  /** Saves the session being recorded; everything stays in memory if it fails, and the next save retries. */
  private async persist(): Promise<void> {
    const active = this.active
    if (!active) return
    await this.store
      .update(active.folder, () => undefined)
      .catch((error: unknown) => {
        console.error('Could not save the session', error)
        this.warn(`The session file could not be saved (${describeFileError(error)}): the next change tries again.`)
      })
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
    // Extra modifiers don't stop a hotkey: the trainer may be talking (Right Ctrl, AltGr) while pressing it.
    const action = bestMatch<() => Promise<void>>(hotkey, [
      { binding: hotkeys.marker, value: () => this.addPointMarker() },
      { binding: hotkeys.range, value: () => this.toggleRange() },
      { binding: hotkeys.voiceNote, value: () => this.startNote(FROM_HOTKEY) },
      ...categories.map((category) => ({ binding: category.hotkey, value: () => this.tagLatestMarker(category.id) }))
    ])
    if (action) this.run(action)
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
    if (force) {
      for (const file of files) await unlink(join(folder, file)).catch(() => undefined)
    } else await this.discard(files.map((file) => join(folder, file)))
  }

  // --- Voice notes -----------------------------------------------------------------

  /**
   * Push-to-talk pressed: the note goes to the open range, or to the latest
   * marker if it is recent enough; otherwise a new marker is created for it.
   * `owner`: FROM_HOTKEY (the trainer holds the hotkey), FROM_APP (the app's
   * button) or a Companion device; only it, or the app, ends the note. From a
   * button, the hotkey may be held for the trainer (Discord's push-to-mute).
   */
  private async startNote(owner: string): Promise<void> {
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
      limit: null,
      // Fails if the key can't be pressed: the note would then be heard in the voice chat.
      releaseHotkey: owner === FROM_HOTKEY ? null : this.holdVoiceNoteHotkey(),
      owner,
      keyCheck: null
    }
    dictation.limit = setTimeout(() => {
      if (this.dictation === dictation) this.run(() => this.stopNote(FROM_APP))
    }, MAX_DICTATION_MS)
    if (owner === FROM_HOTKEY) dictation.keyCheck = this.watchNoteKey(dictation)
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
        try {
          await this.recorder.setMuted(source.id, true)
          dictation.mutedSourceIds.push(source.id)
        } catch {
          this.warn(`OBS did not mute “${source.label}”: this voice note is in the recording.`)
        }
      }
    })()
    this.dictation = dictation
    try {
      await dictation.started
    } catch (error) {
      if (this.dictation === dictation) this.dictation = null
      this.endDictationTimers(dictation)
      dictation.releaseHotkey?.()
      this.publishRecording()
      throw error
    }
  }

  /**
   * The hotkey's release may never reach the app (it happened over the lock
   * screen, or in a program running as administrator): the key itself is
   * checked, and the note ends once it is up.
   */
  private watchNoteKey(dictation: Dictation): NodeJS.Timeout | null {
    const hotkey = getSettings().markers.hotkeys.voiceNote
    if (!hotkey) return null
    let upChecks = 0
    return setInterval(() => {
      if (this.dictation !== dictation) return
      upChecks = this.hotkeys.isDown(hotkey) ? 0 : upChecks + 1
      // Twice in a row: a normal release reaches the hook first.
      if (upChecks >= 2) {
        this.hotkeys.forgetHeld(hotkey)
        this.run(() => this.stopNote(FROM_HOTKEY))
      }
    }, KEY_CHECK_MS)
  }

  private endDictationTimers(dictation: Dictation): void {
    if (dictation.limit) clearTimeout(dictation.limit)
    if (dictation.keyCheck) clearInterval(dictation.keyCheck)
  }

  /**
   * Holds the voice-note hotkey if the trainer asked for it; returns its
   * release. Throws if it can't be pressed: the note isn't started then, or
   * Discord wouldn't mute the trainer and the trainee would hear it.
   */
  private holdVoiceNoteHotkey(): (() => void) | null {
    const hotkey = getSettings().markers.hotkeys.voiceNote
    if (!hotkey || !getSettings().notes.holdHotkeyFromButtons) return null
    try {
      return this.hotkeys.hold(hotkey)
    } catch (error) {
      console.error('Could not hold the voice note hotkey', error)
      this.feedback('error')
      throw new Error(
        `The note was not started, so that it isn’t heard in the voice chat: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Push-to-talk released. `from`: who asks (see startNote); another Companion device can't end this note. */
  private async stopNote(from: string): Promise<void> {
    const dictation = this.dictation
    const active = this.active
    if (!dictation || !active) return
    const fromDevice = from !== FROM_APP && from !== FROM_HOTKEY
    if (fromDevice && from !== dictation.owner) return
    if (from === FROM_HOTKEY && dictation.owner !== FROM_HOTKEY) return
    this.dictation = null
    this.endDictationTimers(dictation)
    dictation.releaseHotkey?.()
    this.publishRecording()
    this.feedback('noteEnd')
    // Tracked: the end of the session waits for the audio before closing the microphone.
    const saving = this.saveNote(active, dictation)
    this.savingNotes.add(saving)
    try {
      await saving
    } finally {
      this.savingNotes.delete(saving)
    }
  }

  private async saveNote(active: ActiveSession, dictation: Dictation): Promise<void> {
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
    if (audio === 'failed') {
      // Not a tap: the microphone window didn't answer. The marker stays; the problem is shown.
      this.warn('A voice note was lost: the microphone didn’t answer. Check the microphone in Setup → Voice notes.')
      return
    }
    if (audio === 'tap') {
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
    await this.discard([join(this.sessionFolder(folderName), note.audio)])
  }

  /**
   * Files of deleted markers and notes go to the Recycle Bin, so a mistake can
   * be undone from Windows. Where there is none (a network drive), the files
   * stay: the trainer is told, since they may hold a voice or a private window.
   */
  private async discard(files: string[]): Promise<void> {
    const left: string[] = []
    for (const file of files) {
      await shell.trashItem(file).catch(() => {
        if (existsSync(file)) left.push(basename(file))
      })
    }
    if (left.length) {
      throw new Error(
        `Deleted, but Windows kept its ${left.length === 1 ? 'file' : 'files'} (${left.join(', ')}): no Recycle Bin on this drive, or in use. Delete ${left.length === 1 ? 'it' : 'them'} from the session folder if needed.`
      )
    }
  }

  // --- Session edits, review and Companion -------------------------------------------

  /** A session command from the app's windows (`device` null) or from a Companion device. */
  private async execute(name: SessionCommandName, args: unknown[], device: CompanionDevice | null): Promise<void> {
    const command = Object.hasOwn(this.commands, name)
      ? (this.commands[name] as (...args: unknown[]) => Promise<void>)
      : undefined
    if (!command || !Array.isArray(args)) throw new Error('Unknown command')
    if (!device) return command(...args)
    // A device reaches only the session it shows: never the others in the archive.
    if (SESSION_SCOPED.has(name)) {
      const folderName = args[0]
      if (folderName !== this.state.recording?.folderName && folderName !== this.state.review?.folderName) {
        throw new Error('That session is not open')
      }
    }
    switch (name) {
      case 'startNote':
        return this.startNote(device.id)
      case 'stopNote':
        return this.stopNote(device.id)
      case 'holdPtt':
        return this.holdPtt(args[0], device)
      case 'releasePtt':
        return this.releasePtt(args[0], device.id)
      case 'addMarker':
      case 'toggleRange': {
        const last = this.lastCompanionMarker.get(device.id) ?? 0
        if (Date.now() - last < MIN_COMPANION_MARKER_MS) throw new Error('One marker at a time')
        this.lastCompanionMarker.set(device.id, Date.now())
        return command(...args)
      }
      default:
        return command(...args)
    }
  }

  /** Full path of a session folder given its name, refusing anything outside the sessions folder. */
  private sessionFolder(folderName: string): string {
    const folder = typeof folderName === 'string' ? sessionFilePath([folderName]) : null
    // Windows drops trailing dots and spaces: "..." or " " would be the sessions folder itself.
    if (!folder || /[\\/:]|[. ]$/.test(folderName) || !existsSync(join(folder, 'session.json'))) {
      throw new Error('Unknown session')
    }
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
      const current = session ?? (await this.store.read(folder))
      this.patch({ review: { ...review, markers: structuredClone(current.markers) } })
    }
    this.broadcast('sessions:changed', null)
  }

  private async openReview(folderName: string): Promise<void> {
    const folder = this.sessionFolder(folderName)
    if (this.active?.folder === folder) throw new Error('This session is still being recorded')
    await this.recoverRecording(folder, true).catch((error: unknown) => console.error('Recording not recovered', error))
    // Read only: a session on a read-only drive can still be reviewed.
    const session = await this.store.read(folder)
    this.patch({
      review: {
        folderName,
        metadata: session.metadata,
        durationMs: session.recording?.durationMs ?? 0,
        hasRecording: Boolean(session.recording?.file),
        recordingFile: session.recording?.file ?? null,
        markers: structuredClone(session.markers),
        player: { positionMs: 0, playing: false, rate: 1, sampledAt: Date.now() }
      }
    })
    await this.transcriber.resume(folder, session).catch((error: unknown) => console.error(error))
  }

  /** The review player lives in the main window; other views steer it through here. */
  private sendPlayerCommand(command: PlayerCommand): void {
    if (!this.state.review) throw new Error('No session is open for review')
    this.broadcast('player:command', validPlayerCommand(command))
  }

  private companionState(): CompanionState {
    const { pttKeys } = this.state.companionSettings
    return {
      recording: this.state.recording,
      review: this.state.review,
      hiddenWindowsError: this.state.hiddenWindowsError,
      categories: this.state.markerSettings.categories,
      voiceNoteHotkey: this.state.markerSettings.hotkeys.voiceNote?.label ?? null,
      pttKeys: PTT_TARGETS.flatMap((target) => {
        const key = pttKeys[target]
        return key ? [{ target, label: key.label }] : []
      }),
      pttHolds: this.state.pttHolds
    }
  }

  // --- Companion push-to-talk --------------------------------------------------------

  /**
   * Holds the voice chat's or Aurora's push-to-talk key while a Companion
   * device's button is held. The device repeats this every second (keep-alive):
   * the key goes up if it stops (a phone locked mid-press, Wi-Fi gone), after
   * PTT_MAX_MS in any case, and when the recording or review ends.
   */
  private holdPtt(target: unknown, device: CompanionDevice): void {
    if (!PTT_TARGETS.includes(target as PttTarget)) throw new Error('Unknown push-to-talk button')
    const button = target as PttTarget
    if (!this.state.recording && !this.state.review) {
      throw new Error('Push-to-talk buttons work during a recording or a review')
    }
    const key = getSettings().companion.pttKeys[button]
    if (!key) throw new Error('No push-to-talk key set: see Setup → Companion')
    const held = this.pttHolds.get(button)
    if (held) {
      if (held.deviceId !== device.id) throw new Error(`${PTT_NAMES[button]} is held on ${held.deviceName}`)
      held.keepalive.refresh()
      return
    }
    const paused = this.pttPaused.get(button)
    if (paused?.deviceId === device.id && (paused.mustRelease || Date.now() < paused.until)) {
      throw new Error(
        `${PTT_NAMES[button]} was released after ${PTT_MAX_MS[button] / 1000} s: let go of the button and press it again`
      )
    }
    const release = this.hotkeys.hold(key)
    const limit = setTimeout(() => {
      this.releasePtt(button, FROM_APP)
      this.pttPaused.set(button, { deviceId: device.id, until: Date.now() + PTT_PAUSE_MS, mustRelease: true })
      this.feedback('error')
    }, PTT_MAX_MS[button])
    const keepalive = setTimeout(() => this.releasePtt(button, FROM_APP), PTT_KEEPALIVE_MS)
    this.pttHolds.set(button, { release, deviceId: device.id, deviceName: device.name, limit, keepalive })
    this.publishPtt()
  }

  /** `from`: the device that holds it, or the app (limit, keep-alive, the PC's Release button, end of session). */
  private releasePtt(target: unknown, from: string): void {
    if (!PTT_TARGETS.includes(target as PttTarget)) throw new Error('Unknown push-to-talk button')
    const button = target as PttTarget
    const paused = this.pttPaused.get(button)
    // The device let go after its limit: it may press again after the pause.
    if (paused && paused.deviceId === from) paused.mustRelease = false
    const hold = this.pttHolds.get(button)
    // Another device's release must not cut this one off.
    if (!hold || (from !== FROM_APP && from !== hold.deviceId)) return
    this.pttHolds.delete(button)
    clearTimeout(hold.limit)
    clearTimeout(hold.keepalive)
    hold.release()
    this.publishPtt()
  }

  private releaseAllPtt(): void {
    for (const target of [...this.pttHolds.keys()]) this.releasePtt(target, FROM_APP)
  }

  private publishPtt(): void {
    this.patch({
      pttHolds: [...this.pttHolds].map(([target, hold]) => ({
        target,
        deviceId: hold.deviceId,
        deviceName: hold.deviceName
      }))
    })
  }

  /** A device's last connection closed: its release will never arrive. */
  private deviceGone(device: CompanionDevice): void {
    for (const [target, hold] of [...this.pttHolds]) if (hold.deviceId === device.id) this.releasePtt(target, FROM_APP)
    if (this.dictation?.owner === device.id) this.run(() => this.stopNote(device.id))
    this.lastCompanionMarker.delete(device.id)
  }

  /** The files a device may download: the screenshots and voice notes of the session it shows. */
  private companionMayRead(folderName: string, path: string): boolean {
    const markers =
      this.state.recording?.folderName === folderName
        ? this.state.recording.markers
        : this.state.review?.folderName === folderName
          ? this.state.review.markers
          : null
    return (
      markers?.some((marker) => marker.screenshot === path || marker.notes.some((note) => note.audio === path)) ?? false
    )
  }

  /** Transcribes notes left over from a previous run (app closed mid-queue) and recovers orphaned recordings. */
  private async resumeTranscriptions(): Promise<void> {
    for (const summary of await listSessions(getSettings().sessionsDir)) {
      // One odd session must not stop the others from being picked up.
      try {
        await this.recoverRecording(summary.folder).catch(() => undefined)
        const session = await loadSession(summary.folder).catch(() => null)
        if (session) await this.transcriber.resume(summary.folder, session)
      } catch (error) {
        console.error(`Session ${summary.folderName} not resumed`, error)
      }
    }
  }

  private transcriptionState(): TranscriptionState {
    return {
      installedModels: this.transcriber.installedModels(),
      download: this.transcriber.currentDownload(),
      downloadError: this.transcriber.downloadError,
      error: this.transcriber.lastError,
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

  /** Busy while any of these runs: the first one to finish must not say "done" for the others. */
  private busyCount = 0

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busyCount++ === 0) this.patch({ busy: true })
    try {
      return await fn()
    } finally {
      if (--this.busyCount === 0) this.patch({ busy: false })
    }
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    const shareable = this.state.review !== null && this.state.recording === null
    if (shareable !== this.shareable) {
      this.shareable = shareable
      this.onShareableChanged(shareable)
    }
    this.broadcast('state:changed', this.state)
    this.companion.broadcast()
  }

  private broadcast(channel: string, payload: AppState | AudioLevels | MarkerFeedback | PlayerCommand | null): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
}

/**
 * Why a sessions folder puts the recordings at risk, if it does: synchronised
 * with OneDrive (recordings with other people's voices uploaded to the cloud),
 * or outside the user's folder (other accounts on the PC may open it).
 */
function sessionsDirWarning(dir: string): string | null {
  const inside = (parent: string | undefined): boolean =>
    Boolean(parent) &&
    resolve(dir)
      .toLowerCase()
      .startsWith(resolve(parent!).toLowerCase() + sep)
  if ([process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].some(inside)) {
    return 'This folder is synchronised with OneDrive: the recordings (with the voices of everyone in the call), notes and screenshots are uploaded to the cloud. Choose a folder outside OneDrive.'
  }
  if (!inside(homedir())) {
    return 'This folder is outside your user folder: other accounts on this PC may be able to open the recordings.'
  }
  return null
}

/** The New session details as the app expects them (the form checks them too, but a page can't be trusted). */
function validMetadata(metadata: SessionMetadata): SessionMetadata {
  const text = (value: unknown, max: number): string =>
    String(value ?? '')
      .trim()
      .slice(0, max)
  const clean: SessionMetadata = {
    traineeVid: text(metadata?.traineeVid, 20),
    traineeName: text(metadata?.traineeName, 100),
    position: text(metadata?.position, 30).toUpperCase(),
    trainingType: text(metadata?.trainingType, 40) || 'Training',
    trainerVid: text(metadata?.trainerVid, 20),
    date: text(metadata?.date, 10)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) throw new Error('Enter the date of the session')
  if (!/^\d+$/.test(clean.traineeVid)) throw new Error('The trainee VID must be a number')
  if (!/^\d*$/.test(clean.trainerVid)) throw new Error('Your VID must be a number')
  if (!clean.position) throw new Error('The position is required')
  return clean
}

function sameDisplay(a: DisplayOption, b: DisplayOption): boolean {
  return a.id === b.id && a.name === b.name && a.width === b.width && a.height === b.height
}

/** Why a file operation failed, in words (no paths: they carry the Windows user name). */
function describeFileError(error: unknown): string {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ENOSPC':
      return 'the disk is full'
    case 'EPERM':
    case 'EACCES':
    case 'EBUSY':
      return 'the file is in use or read-only'
    case 'ENOENT':
      return 'the folder is gone (a removed drive?)'
    default:
      return 'Windows refused to write it'
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
  // Only a connection that failed: OBS's own answers ("…Stop it in OBS, then connect again.") are kept as they are.
  if (/ECONNREFUSED|ECONNRESET|socket hang up|OBS did not answer|connection (closed|refused)/i.test(message)) {
    return 'Cannot reach OBS. Make sure OBS is running and the WebSocket server is enabled (Tools → WebSocket Server Settings).'
  }
  return message
}
