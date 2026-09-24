import type {
  AudioLevels,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  DisplayOption,
  MaskRect
} from '../../shared/types'

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
  /**
   * Covers these parts of the captured display (private windows) in the
   * recording, previews and screenshots; an empty list uncovers everything.
   * Called often: repeating the same masks must be cheap.
   */
  setMasks(masks: MaskRect[]): Promise<void>
  /** Small JPEG of the captured display as a data URL, for previews. */
  preview(width: number): Promise<string | null>

  start(outputDir: string): Promise<void>
  /** Stops recording once the file is complete, and returns its path. */
  stop(): Promise<string | null>
  isRecording(): boolean
  /** Current position in the recording, in milliseconds. */
  currentTimeMs(): number
  /** Saves a full-resolution screenshot of the captured display. */
  screenshot(filePath: string): Promise<void>

  /**
   * A recording this app started that is still running after the connection
   * was lost (e.g. a network hiccup, or the app restarted): where it is being
   * written and how long it is. Null if none.
   */
  recordingInProgress(): Promise<{ outputDir: string; durationMs: number } | null>
  /** Picks up that recording again, so markers can continue. */
  continueRecording(durationMs: number): void
}

export interface RecorderEvents {
  /** `durationMs` is the recording length when the connection was lost during a recording. */
  onDisconnected(reason: string, durationMs?: number): void
  onLevels(levels: AudioLevels): void
  onRecordingStopped(filePath: string | null, durationMs: number): void
}
