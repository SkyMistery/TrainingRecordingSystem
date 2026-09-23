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

export interface CaptureConfig {
  display: DisplayOption | null
  outputScale: OutputScale
  fps: 30 | 60
  encoder: EncoderId
  audioSources: AudioSourceConfig[]
}

export interface SessionMetadata {
  traineeVid: string
  traineeName: string
  position: string
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
  categoryId: string | null
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
}

export interface SessionSummary {
  id: string
  folder: string
  metadata: SessionMetadata
  durationMs: number | null
  hasRecording: boolean
  markerCount: number
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

export interface AppState {
  obs: { status: ObsStatus; error: string | null; version: string | null }
  recording: RecordingState | null
  capture: CaptureConfig
  markerSettings: MarkerSettings
  noteSettings: NoteSettings
  transcription: TranscriptionState
  busy: boolean
}

/** Sent to windows when a hotkey or button changes markers, for audio/visual feedback. */
export type MarkerFeedback = 'marker' | 'rangeStart' | 'rangeEnd' | 'category' | 'noteStart' | 'noteEnd' | 'error'

/** Peak level per audio source id, in dBFS (-60 … 0). */
export type AudioLevels = Record<string, number>

/** Commands from the main process to the hidden microphone window. */
export type AudioCommand =
  | { type: 'open'; deviceId: string }
  | { type: 'start'; token: string }
  | { type: 'stop'; token: string }
  | { type: 'close' }

export interface NoteAudio {
  wav: ArrayBuffer
  durationMs: number
}
