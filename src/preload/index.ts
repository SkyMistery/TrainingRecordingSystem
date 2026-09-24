import { contextBridge, ipcRenderer } from 'electron'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import type {
  AppState,
  AudioCommand,
  AudioLevels,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  CompanionSettings,
  DisplayOption,
  Hotkey,
  MarkerFeedback,
  MarkerSettings,
  NoteAudio,
  NoteSettings,
  ObsConnectionConfig,
  PlayerCommand,
  PlayerState,
  SessionCommandName,
  SessionCommands,
  SessionDetails,
  SessionMetadata,
  SessionSummary,
  WhisperModelId
} from '../shared/types'

/** Invokes a main-process handler and rethrows its error with a clean message. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  getVersion: () => invoke<string>('app:version'),
  getTheme: () => invoke<ThemeState>('theme:get'),
  setTheme: (preference: ThemePreference) => invoke<Theme>('theme:set', preference),
  onThemeChanged: (listener: (theme: Theme) => void) => subscribe('theme:changed', listener),

  getState: () => invoke<AppState>('state:get'),
  onState: (listener: (state: AppState) => void) => subscribe('state:changed', listener),
  onAudioLevels: (listener: (levels: AudioLevels) => void) => subscribe('audio:levels', listener),

  getObsConnection: () => invoke<ObsConnectionConfig>('obs:getConnection'),
  connectObs: (config: ObsConnectionConfig) => invoke<void>('obs:connect', config),
  reconnectObs: () => invoke<void>('obs:reconnect'),

  listDisplays: () => invoke<DisplayOption[]>('capture:listDisplays'),
  listAudioTargets: (kind: AudioSourceKind) => invoke<AudioTargetOption[]>('capture:listAudioTargets', kind),
  getPreview: () => invoke<string | null>('capture:preview'),
  saveCapture: (capture: Partial<CaptureConfig>) => invoke<void>('capture:save', capture),
  setSourceMuted: (sourceId: string, muted: boolean) => invoke<void>('capture:setMuted', sourceId, muted),
  setSourceVolume: (sourceId: string, volumeDb: number) => invoke<void>('capture:setVolume', sourceId, volumeDb),

  listSessions: () => invoke<SessionSummary[]>('sessions:list'),
  openSessionsFolder: (folderName?: string) => invoke<void>('sessions:openFolder', folderName),
  getSessionDefaults: () => invoke<{ trainerVid: string }>('sessions:defaults'),
  chooseSessionsFolder: () => invoke<void>('sessions:chooseFolder'),
  deleteSession: (folderName: string) => invoke<void>('session:delete', folderName),
  retranscribeSession: (folderName: string) => invoke<void>('session:retranscribe', folderName),
  /** Returns the session's folder name after the rename. */
  updateSessionDetails: (folderName: string, details: SessionDetails) =>
    invoke<string>('session:updateDetails', folderName, details),
  onSessionsChanged: (listener: () => void) => subscribe('sessions:changed', listener),
  startSession: (metadata: SessionMetadata) => invoke<void>('session:start', metadata),
  stopSession: () => invoke<void>('session:stop'),

  /** Session edits and live actions (markers, notes, player), shared with the Companion page. */
  command: <K extends SessionCommandName>(name: K, ...args: SessionCommands[K]) => invoke<void>('command', name, args),
  saveMarkerSettings: (settings: Partial<MarkerSettings>) => invoke<void>('markers:saveSettings', settings),
  onMarkerFeedback: (listener: (kind: MarkerFeedback) => void) => subscribe('marker:feedback', listener),
  saveNoteSettings: (settings: Partial<NoteSettings>) => invoke<void>('notes:saveSettings', settings),
  downloadModel: (model: WhisperModelId) => invoke<void>('models:download', model),
  cancelModelDownload: () => invoke<void>('models:cancelDownload'),

  openReview: (folderName: string) => invoke<void>('review:open', folderName),
  closeReview: () => invoke<void>('review:close'),
  reportPlayer: (player: PlayerState) => invoke<void>('player:report', player),
  onPlayerCommand: (listener: (command: PlayerCommand) => void) => subscribe('player:command', listener),

  saveCompanionSettings: (settings: Partial<CompanionSettings>) => invoke<void>('companion:save', settings),
  newCompanionToken: () => invoke<void>('companion:newToken'),
  refreshCompanion: () => invoke<void>('companion:refresh'),
  openNotesWindow: () => invoke<void>('companion:openWindow'),
  openCompanionInBrowser: () => invoke<void>('companion:openBrowser'),

  // Hidden microphone window.
  onAudioCommand: (listener: (command: AudioCommand) => void) => subscribe('audio:command', listener),
  sendNoteAudio: (token: string, audio: NoteAudio | null) => invoke<void>('audio:note', token, audio),
  /** null: the microphone works; otherwise what is wrong. */
  reportAudioStatus: (problem: string | null) => invoke<void>('audio:status', problem),
  reportAudioReady: () => invoke<void>('audio:ready'),

  captureHotkey: () => invoke<Hotkey | null>('hotkeys:capture'),
  cancelHotkeyCapture: () => invoke<void>('hotkeys:cancelCapture')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
