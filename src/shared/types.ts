/** Types shared between the main process, the preload bridge and the UI. */

export interface ObsConnectionConfig {
  host: string
  port: number
  /** Only sent from the UI when changed; the main process stores it encrypted. */
  password?: string
  hasPassword?: boolean
}

export type ObsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DisplayOption {
  id: string
  name: string
  width: number
  height: number
}

export type AudioSourceKind = 'application' | 'desktop' | 'microphone'

/** A selectable target for an audio source: an application or a device. */
export interface AudioTargetOption {
  value: string
  label: string
}

export interface AudioSourceConfig {
  id: string
  kind: AudioSourceKind
  /** Application window spec or device id, as reported by OBS. */
  target: string
  label: string
  muted: boolean
  volumeDb: number
  /** Microphones only: mute this source in the recording while a voice note is dictated. */
  muteDuringNotes: boolean
}

/** Simple-output encoder ids understood by OBS. */
export type EncoderId = 'x264' | 'nvenc' | 'qsv' | 'amd'

export type OutputScale = 'native' | '1080p'

/**
 * A window kept out of the recording for privacy (e.g. Aurora's COM BOX, where
 * the trainer chats with other controllers): it is covered wherever it is on the
 * recorded monitor. Matched by program and window title.
 */
export interface HiddenWindowRule {
  id: string
  /** Executable file name, e.g. "Aurora.exe" (case-insensitive). */
  exe: string
  /** Exact window title; null covers every window of the program. */
  title: string | null
  enabled: boolean
}

/** An open window offered when adding a hidden window. */
export interface WindowOption {
  exe: string
  title: string
}

/** Part of the recorded display to cover, in display pixels. */
export interface MaskRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureConfig {
  display: DisplayOption | null
  outputScale: OutputScale
  fps: 30 | 60
  encoder: EncoderId
  audioSources: AudioSourceConfig[]
  hiddenWindows: HiddenWindowRule[]
}

export interface SessionMetadata {
  traineeVid: string
  traineeName: string
  position: string
  /** Session type shown as "Session type": Training or Exam (older sessions may hold other values). */
  trainingType: string
  trainerVid: string
  /** ISO date (yyyy-mm-dd). */
  date: string
}

export interface RecordingInfo {
  file: string | null
  startedAt: string
  durationMs: number
  display: { name: string; width: number; height: number } | null
}

/** A keyboard key or mouse button, with the modifiers held. */
export interface Hotkey {
  device: 'keyboard' | 'mouse'
  /** uiohook keycode, or mouse button number (3 = middle, 4/5 = side buttons). */
  code: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Human-readable name, e.g. "Ctrl + F9" or "Mouse button 4". */
  label: string
}

export type HotkeyAction = 'marker' | 'range' | 'voiceNote'

export interface MarkerCategory {
  id: string
  name: string
  color: string
  hotkey: Hotkey | null
}

export interface MarkerSettings {
  /** Point markers and range starts are moved back by this many seconds. */
  preRollSeconds: number
  hotkeys: Record<HotkeyAction, Hotkey | null>
  categories: MarkerCategory[]
  /** Short confirmation sound when a hotkey is used. */
  sound: boolean
  /** Compact always-on-top window while recording. */
  statusWindow: boolean
}

export type TranscriptionStatus = 'pending' | 'transcribing' | 'done' | 'failed' | 'no-model'

export interface Note {
  id: string
  /** WAV path relative to the session folder. */
  audio: string
  durationMs: number
  /** Recording time when dictation started. */
  recordedAtMs: number
  transcript: string | null
  status: TranscriptionStatus
  /** The trainer's edited text; null means "use the transcript". */
  text: string | null
}

export interface Marker {
  id: string
  /** 1-based, in creation order. */
  number: number
  kind: 'point' | 'range'
  /** Position in the recording (pre-roll applied). */
  timeMs: number
  /** Recording time when the key was pressed. */
  pressedAtMs: number
  /** Range end; null while a range is still open, always null for points. */
  endMs: number | null
  /** A marker can belong to several categories (e.g. phraseology and coordination). */
  categoryIds: string[]
  /** Screenshot path relative to the session folder. */
  screenshot: string | null
  createdAt: string
  notes: Note[]
}

export type WhisperModelId = 'base' | 'small' | 'large-v3-turbo-q5_0'

export interface NoteSettings {
  /** Browser media device id of the microphone used for voice notes. */
  micDeviceId: string
  micLabel: string
  model: WhisperModelId
  /** Whisper language code, or "auto" to detect it for each note. */
  language: string
  transcribe: boolean
  /** A note joins the latest marker if it was placed less than this long ago; otherwise it creates one. */
  attachWindowSeconds: number
}

export interface ModelDownload {
  model: WhisperModelId
  receivedBytes: number
  totalBytes: number
}

export interface TranscriptionState {
  installedModels: WhisperModelId[]
  download: ModelDownload | null
  downloadError: string | null
  /** Notes waiting for or being transcribed. */
  queued: number
  /** False when the whisper program is missing from the installation. */
  available: boolean
}

export interface SessionFile {
  schemaVersion: 1
  id: string
  createdAt: string
  metadata: SessionMetadata
  recording: RecordingInfo | null
  markers: Marker[]
  /** The trainer's confirmation that everyone in the voice call agreed to be recorded (v1.3+). */
  consent?: { statement: string; confirmedAt: string }
}

/** Session details the trainer can correct after recording (typos); they also name the folder. */
export type SessionDetails = Pick<SessionMetadata, 'traineeVid' | 'traineeName' | 'position' | 'trainingType'>

export interface SessionSummary {
  id: string
  folder: string
  /** Folder name inside the sessions folder: how commands and media URLs refer to a session. */
  folderName: string
  metadata: SessionMetadata
  durationMs: number | null
  hasRecording: boolean
  markerCount: number
  noteCount: number
}

export interface RecordingState {
  sessionId: string
  metadata: SessionMetadata
  /** Recording time (ms) at `sampledAt` (epoch ms); the UI extrapolates between updates. */
  elapsedMs: number
  sampledAt: number
  /** Session folder name, used to build media URLs. */
  folderName: string
  markers: Marker[]
  openRangeId: string | null
  /** Marker receiving the voice note being dictated, if any. */
  dictatingMarkerId: string | null
}

/** A newer version of the app found on GitHub Releases. */
export interface UpdateState {
  /** "error": the download stopped; the next check tries again. */
  status: 'downloading' | 'ready' | 'error'
  version: string
  percent: number
}

export interface AppState {
  obs: { status: ObsStatus; error: string | null; version: string | null }
  recording: RecordingState | null
  capture: CaptureConfig
  markerSettings: MarkerSettings
  noteSettings: NoteSettings
  transcription: TranscriptionState
  review: ReviewState | null
  companion: CompanionInfo
  companionSettings: CompanionSettings
  /** Where new sessions are saved and the sessions list is read from. */
  sessionsDir: string
  /** Why hidden windows can't be covered right now, if anything. */
  hiddenWindowsError: string | null
  /** Why voice notes can't be recorded right now (microphone problem), if anything. */
  microphoneError: string | null
  update: UpdateState | null
  /** Version of the terms of use the user accepted (see shared/terms.ts), if any. */
  termsAcceptedVersion: number | null
  busy: boolean
}

/** Sent to windows when a hotkey or button changes markers, for audio/visual feedback. */
export type MarkerFeedback = 'marker' | 'rangeStart' | 'rangeEnd' | 'category' | 'noteStart' | 'noteEnd' | 'error'

/** Peak level per audio source id, in dBFS (-60 … 0). */
export type AudioLevels = Record<string, number>

/** Commands from the main process to the hidden microphone window. */
export type AudioCommand =
  | { type: 'open'; deviceId: string; label: string }
  | { type: 'start'; token: string }
  | { type: 'stop'; token: string }
  | { type: 'close' }

export interface NoteAudio {
  wav: ArrayBuffer
  durationMs: number
}

/** Playback position reported by the review player (extrapolate while playing). */
export interface PlayerState {
  positionMs: number
  playing: boolean
  rate: number
  /** Epoch ms when the position was sampled. */
  sampledAt: number
}

export type PlayerCommand =
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'skip'; deltaMs: number }
  | { type: 'marker'; direction: 1 | -1 }
  | { type: 'rate'; rate: number }

/** A finished session opened for the debriefing. */
export interface ReviewState {
  folderName: string
  metadata: SessionMetadata
  durationMs: number
  hasRecording: boolean
  markers: Marker[]
  player: PlayerState
}

export interface CompanionSettings {
  enabled: boolean
  /** Reachable from other devices on the local network (tablet), not only this PC. */
  lan: boolean
  port: number
}

export interface CompanionInfo {
  running: boolean
  error: string | null
  /** Pairing links: this PC first, then local network addresses when enabled. */
  urls: string[]
  /** QR code (data URL) for the best network link, or this PC's. */
  qr: string | null
  clients: number
  /** Windows network profile is Public: its firewall blocks tablets. */
  publicNetwork: boolean
}

/** What the Companion page receives: everything it shows, nothing else. */
export interface CompanionState {
  recording: RecordingState | null
  review: ReviewState | null
  categories: MarkerCategory[]
  voiceNoteHotkey: string | null
}

/**
 * Session edits and live actions available to every view: the desktop windows
 * (through IPC) and the Companion page (through its WebSocket).
 */
export interface SessionCommands {
  addMarker: []
  toggleRange: []
  startNote: []
  stopNote: []
  /** Adds the category to the marker, or removes it if the marker already has it. */
  toggleMarkerCategory: [folderName: string, markerId: string, categoryId: string]
  setMarkerTimes: [folderName: string, markerId: string, times: { timeMs?: number; endMs?: number | null }]
  deleteMarker: [folderName: string, markerId: string]
  setNoteText: [folderName: string, markerId: string, noteId: string, text: string | null]
  deleteNote: [folderName: string, markerId: string, noteId: string]
  retranscribeNote: [folderName: string, markerId: string, noteId: string]
  playerCommand: [command: PlayerCommand]
}

export type SessionCommandName = keyof SessionCommands
