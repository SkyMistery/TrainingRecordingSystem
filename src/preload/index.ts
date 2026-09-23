import { contextBridge, ipcRenderer } from 'electron'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'
import type {
  AppState,
  AudioLevels,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  DisplayOption,
  Hotkey,
  MarkerFeedback,
  MarkerSettings,
  ObsConnectionConfig,
  SessionMetadata,
  SessionSummary
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

  listDisplays: () => invoke<DisplayOption[]>('capture:listDisplays'),
  listAudioTargets: (kind: AudioSourceKind) => invoke<AudioTargetOption[]>('capture:listAudioTargets', kind),
  getPreview: () => invoke<string | null>('capture:preview'),
  saveCapture: (capture: CaptureConfig) => invoke<void>('capture:save', capture),
  setSourceMuted: (sourceId: string, muted: boolean) => invoke<void>('capture:setMuted', sourceId, muted),
  setSourceVolume: (sourceId: string, volumeDb: number) => invoke<void>('capture:setVolume', sourceId, volumeDb),

  listSessions: () => invoke<SessionSummary[]>('sessions:list'),
  openSessionsFolder: (folder?: string) => invoke<void>('sessions:openFolder', folder),
  getSessionDefaults: () => invoke<{ trainerVid: string }>('sessions:defaults'),
  onSessionsChanged: (listener: () => void) => subscribe('sessions:changed', listener),
  startSession: (metadata: SessionMetadata) => invoke<void>('session:start', metadata),
  stopSession: () => invoke<void>('session:stop'),

  addMarker: () => invoke<void>('markers:add'),
  toggleRange: () => invoke<void>('markers:toggleRange'),
  setMarkerCategory: (markerId: string | null, categoryId: string | null) =>
    invoke<void>('markers:setCategory', markerId, categoryId),
  deleteMarker: (markerId: string) => invoke<void>('markers:delete', markerId),
  saveMarkerSettings: (settings: MarkerSettings) => invoke<void>('markers:saveSettings', settings),
  onMarkerFeedback: (listener: (kind: MarkerFeedback) => void) => subscribe('marker:feedback', listener),
  captureHotkey: () => invoke<Hotkey | null>('hotkeys:capture'),
  cancelHotkeyCapture: () => invoke<void>('hotkeys:cancelCapture')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
