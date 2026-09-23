import { contextBridge, ipcRenderer } from 'electron'
import type { Theme, ThemePreference, ThemeState } from '../shared/theme'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getTheme: (): Promise<ThemeState> => ipcRenderer.invoke('theme:get'),
  setTheme: (preference: ThemePreference): Promise<Theme> => ipcRenderer.invoke('theme:set', preference),
  onThemeChanged: (listener: (theme: Theme) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: Theme): void => listener(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.off('theme:changed', handler)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
