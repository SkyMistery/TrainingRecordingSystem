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

export interface SessionFile {
  schemaVersion: 1
  id: string
  createdAt: string
  metadata: SessionMetadata
  recording: RecordingInfo | null
}

export interface SessionSummary {
  id: string
  folder: string
  metadata: SessionMetadata
  durationMs: number | null
  hasRecording: boolean
}

export interface RecordingState {
  sessionId: string
  metadata: SessionMetadata
  /** Recording time (ms) at `sampledAt` (epoch ms); the UI extrapolates between updates. */
  elapsedMs: number
  sampledAt: number
}

export interface AppState {
  obs: { status: ObsStatus; error: string | null; version: string | null }
  recording: RecordingState | null
  capture: CaptureConfig
  busy: boolean
}

/** Peak level per audio source id, in dBFS (-60 … 0). */
export type AudioLevels = Record<string, number>
