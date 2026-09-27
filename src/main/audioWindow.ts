import { join } from 'node:path'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { loadAppPage } from './appPages'
import type { AudioCommand, NoteAudio } from '../shared/types'

/** The hidden window has this long to load and open its message channel. */
const READY_TIMEOUT_MS = 15_000
/** A note's audio arrives this long after the stop at the latest (the tail is 250 ms). */
const STOP_TIMEOUT_MS = 5_000

/**
 * What a dictation gave: its audio; "tap" for a press too short to be a note;
 * "failed" when the microphone window didn't answer (never taken for a tap:
 * the marker made for the note is kept and the problem shown).
 */
export type NoteResult = NoteAudio | 'tap' | 'failed'

/**
 * Hidden window that keeps the trainer's microphone open during a session,
 * so push-to-talk starts instantly, and turns each dictation into a 16 kHz
 * mono WAV (the format whisper.cpp expects).
 */
export class AudioCapture {
  private window: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private markReady: (() => void) | null = null
  private readonly pending = new Map<string, (result: NoteResult) => void>()
  /** The microphone of the session, to open it again in a new window after a crash. */
  private device: { deviceId: string; label: string } | null = null

  constructor(private readonly onStatus: (problem: string | null) => void) {
    // Only the hidden window itself may answer.
    const fromWindow = (event: IpcMainInvokeEvent): boolean => event.sender === this.window?.webContents
    ipcMain.handle('audio:note', (event, token: string, audio: NoteAudio | null) => {
      if (!fromWindow(event)) return
      this.pending.get(token)?.(audio ?? 'tap')
      this.pending.delete(token)
    })
    ipcMain.handle('audio:status', (event, problem: string | null) => {
      if (fromWindow(event)) this.onStatus(typeof problem === 'string' ? problem : null)
    })
    ipcMain.handle('audio:ready', (event) => {
      if (fromWindow(event)) this.markReady?.()
    })
  }

  private ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    this.window = window
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.ready = null
      }
    })
    // Crashed or frozen: a new window takes over, with the same microphone.
    const replace = (reason: string): void => {
      if (this.window !== window) return
      console.error('Microphone window:', reason)
      this.onStatus('The microphone stopped working (the app restarted it): check the last voice note.')
      this.failPending()
      this.window = null
      this.ready = null
      if (!window.isDestroyed()) window.destroy()
      if (this.device) void this.open(this.device.deviceId, this.device.label).catch(() => undefined)
    }
    window.webContents.on('render-process-gone', (_event, details) => replace(details.reason))
    window.on('unresponsive', () => replace('not responding'))
    // Ready once the page subscribed to commands, not merely loaded: a command
    // sent in between would be lost.
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve
      setTimeout(() => reject(new Error('The microphone could not be started')), READY_TIMEOUT_MS)
    })
    this.ready.catch(() => {
      if (this.window === window) replace('did not start')
    })
    void loadAppPage(window, 'audio')
    return this.ready
  }

  private failPending(): void {
    for (const resolve of this.pending.values()) resolve('failed')
    this.pending.clear()
  }

  private async send(command: AudioCommand): Promise<void> {
    await this.ensureWindow()
    this.window?.webContents.send('audio:command', command)
  }

  open(deviceId: string, label: string): Promise<void> {
    this.device = { deviceId, label }
    return this.send({ type: 'open', deviceId, label })
  }

  start(token: string): Promise<void> {
    return this.send({ type: 'start', token })
  }

  /** The dictated audio, "tap" if nothing worth keeping was captured, "failed" if the window didn't answer. */
  async stop(token: string): Promise<NoteResult> {
    const result = new Promise<NoteResult>((resolve) => {
      this.pending.set(token, resolve)
      setTimeout(() => {
        if (this.pending.delete(token)) resolve('failed')
      }, STOP_TIMEOUT_MS)
    })
    await this.send({ type: 'stop', token }).catch(() => undefined)
    return result
  }

  close(): void {
    this.device = null
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('audio:command', { type: 'close' })
  }

  destroy(): void {
    this.device = null
    this.failPending()
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.ready = null
  }
}
