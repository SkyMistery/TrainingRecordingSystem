import type { AudioLevels, AudioSourceKind, AudioTargetOption, CaptureConfig, DisplayOption } from '../../shared/types'

/**
 * A recording engine. OBS is the first implementation; a native engine can be
 * added later without touching sessions, markers, notes or the UI.
 */
export interface Recorder {
  connect(): Promise<{ version: string }>
  disconnect(): Promise<void>
  isConnected(): boolean

  listDisplays(): Promise<DisplayOption[]>
  listAudioTargets(kind: AudioSourceKind): Promise<AudioTargetOption[]>
  /** Applies display, encoder and audio sources. Not allowed while recording. */
  configure(config: CaptureConfig): Promise<void>
  setMuted(sourceId: string, muted: boolean): Promise<void>
  setVolume(sourceId: string, volumeDb: number): Promise<void>
  /** Small JPEG of the captured display as a data URL, for previews. */
  preview(width: number): Promise<string | null>

  start(outputDir: string): Promise<void>
  /** Stops recording and returns the path of the recorded file. */
  stop(): Promise<string | null>
  isRecording(): boolean
  /** Current position in the recording, in milliseconds. */
  currentTimeMs(): number
  /** Saves a full-resolution screenshot of the captured display. */
  screenshot(filePath: string): Promise<void>
}

export interface RecorderEvents {
  onDisconnected(reason: string): void
  onLevels(levels: AudioLevels): void
  onRecordingStopped(filePath: string | null): void
}
