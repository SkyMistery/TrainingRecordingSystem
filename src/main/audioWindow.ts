import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import type { AudioCommand, NoteAudio } from '../shared/types'

/**
 * Hidden window that keeps the trainer's microphone open during a session,
 * so push-to-talk starts instantly, and turns each dictation into a 16 kHz
 * mono WAV (the format whisper.cpp expects).
 */
export class AudioCapture {
  private window: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, (audio: NoteAudio | null) => void>()

  constructor(private readonly onError: (message: string) => void) {
    ipcMain.handle('audio:note', (_event, token: string, audio: NoteAudio | null) => {
      this.pending.get(token)?.(audio)
      this.pending.delete(token)
    })
    ipcMain.handle('audio:error', (_event, message: string) => this.onError(message))
  }

  private ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    this.window.on('closed', () => {
      this.window = null
      this.ready = null
    })
    this.ready = process.env['ELECTRON_RENDERER_URL']
      ? this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#audio`)
      : this.window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'audio' })
    return this.ready
  }

  private async send(command: AudioCommand): Promise<void> {
    await this.ensureWindow()
    this.window?.webContents.send('audio:command', command)
  }

  open(deviceId: string): Promise<void> {
    return this.send({ type: 'open', deviceId })
  }

  start(token: string): Promise<void> {
    return this.send({ type: 'start', token })
  }

  /** Resolves with the dictated audio, or null if nothing was captured. */
  async stop(token: string): Promise<NoteAudio | null> {
    const result = new Promise<NoteAudio | null>((resolve) => {
      this.pending.set(token, resolve)
      setTimeout(() => {
        if (this.pending.delete(token)) resolve(null)
      }, 5000)
    })
    await this.send({ type: 'stop', token })
    return result
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('audio:command', { type: 'close' })
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.ready = null
  }
}
