import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type {
  AppState,
  AudioLevels,
  AudioSourceKind,
  CaptureConfig,
  EncoderId,
  ObsConnectionConfig,
  SessionFile,
  SessionMetadata
} from '../shared/types'
import { ObsRecorder } from './recorder/ObsRecorder'
import type { Recorder } from './recorder/Recorder'
import { adoptRecording, createSession, listSessions, saveSession } from './sessions'
import { decryptSecret, encryptSecret, getSettings, updateSettings } from './settings'

interface ActiveSession {
  folder: string
  session: SessionFile
}

/**
 * Owns the application state. Windows (and later the Companion page) are views:
 * they receive state updates and send commands through IPC.
 */
export class Controller {
  private readonly recorder: Recorder
  private active: ActiveSession | null = null
  private state: AppState

  constructor() {
    this.state = {
      obs: { status: 'disconnected', error: null, version: null },
      recording: null,
      capture: getSettings().capture,
      busy: false
    }
    this.recorder = new ObsRecorder(
      () => {
        const { host, port, passwordEncrypted } = getSettings().obs
        return { url: `ws://${host}:${port}`, password: decryptSecret(passwordEncrypted) }
      },
      {
        onDisconnected: (reason) => {
          this.patch({ obs: { status: 'error', error: reason, version: null } })
          if (this.active) void this.finaliseSession(null)
        },
        onLevels: (levels) => this.broadcast('audio:levels', levels),
        onRecordingStopped: (outputPath) => void this.finaliseSession(outputPath)
      }
    )
  }

  async init(): Promise<void> {
    await this.detectDefaultEncoder()
    this.registerIpc()
    // Connect silently at startup; the Setup page shows the outcome.
    void this.connectObs().catch(() => undefined)
  }

  isRecording(): boolean {
    return this.active !== null
  }

  async shutdown(): Promise<void> {
    if (this.active) await this.stopSession()
    await this.recorder.disconnect().catch(() => undefined)
  }

  // ---------------------------------------------------------------------------

  private registerIpc(): void {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (_event, ...args) => fn(...args))
    }

    handle('state:get', () => this.state)

    handle('obs:getConnection', (): ObsConnectionConfig => {
      const { host, port, passwordEncrypted } = getSettings().obs
      return { host, port, hasPassword: Boolean(passwordEncrypted) }
    })
    handle('obs:connect', async (config: ObsConnectionConfig) => {
      const current = getSettings().obs
      await updateSettings({
        obs: {
          host: config.host.trim() || '127.0.0.1',
          port: config.port || 4455,
          passwordEncrypted: config.password !== undefined ? encryptSecret(config.password) : current.passwordEncrypted
        }
      })
      await this.connectObs()
    })

    handle('capture:listDisplays', () => this.requireObs().listDisplays())
    handle('capture:listAudioTargets', (kind: AudioSourceKind) => this.requireObs().listAudioTargets(kind))
    handle('capture:preview', () => (this.recorder.isConnected() ? this.recorder.preview(640) : null))
    handle('capture:save', async (capture: CaptureConfig) => {
      await updateSettings({ capture })
      this.patch({ capture })
      if (this.recorder.isConnected() && !this.recorder.isRecording()) {
        await this.withBusy(() => this.recorder.configure(capture))
      }
    })
    handle('capture:setMuted', async (sourceId: string, muted: boolean) => {
      await this.updateSource(sourceId, { muted })
      if (this.recorder.isConnected()) await this.recorder.setMuted(sourceId, muted)
    })
    handle('capture:setVolume', async (sourceId: string, volumeDb: number) => {
      await this.updateSource(sourceId, { volumeDb })
      if (this.recorder.isConnected()) await this.recorder.setVolume(sourceId, volumeDb)
    })

    handle('sessions:list', () => listSessions(getSettings().sessionsDir))
    handle('sessions:openFolder', async (folder?: string) => {
      const target = folder ?? getSettings().sessionsDir
      await import('node:fs/promises').then((fs) => fs.mkdir(target, { recursive: true }))
      await shell.openPath(target)
    })
    handle('sessions:defaults', () => ({ trainerVid: getSettings().trainerVid }))
    handle('session:start', (metadata: SessionMetadata) => this.startSession(metadata))
    handle('session:stop', () => this.stopSession())
  }

  private requireObs(): Recorder {
    if (!this.recorder.isConnected()) throw new Error('OBS is not connected')
    return this.recorder
  }

  private async connectObs(): Promise<void> {
    await this.recorder.disconnect().catch(() => undefined)
    this.patch({ obs: { status: 'connecting', error: null, version: null } })
    try {
      const { version } = await this.recorder.connect()
      this.patch({ obs: { status: 'connected', error: null, version } })
      if (this.state.capture.display) await this.withBusy(() => this.recorder.configure(this.state.capture))
    } catch (error) {
      this.patch({ obs: { status: 'error', error: describeObsError(error), version: null } })
      throw new Error(describeObsError(error))
    }
  }

  private async startSession(metadata: SessionMetadata): Promise<void> {
    if (this.active) throw new Error('A session is already being recorded')
    const recorder = this.requireObs()
    const capture = this.state.capture
    if (!capture.display) throw new Error('Choose the display to record in Setup first')

    await this.withBusy(async () => {
      await recorder.configure(capture)
      const { folder, session } = await createSession(getSettings().sessionsDir, metadata)
      await recorder.start(folder)
      session.recording = {
        file: null,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        display: { name: capture.display!.name, width: capture.display!.width, height: capture.display!.height }
      }
      await saveSession(folder, session)
      this.active = { folder, session }
      await updateSettings({ trainerVid: metadata.trainerVid })
    })
    this.publishRecording()
  }

  private async stopSession(): Promise<void> {
    if (!this.active) return
    const durationMs = this.recorder.currentTimeMs()
    const outputPath = await this.withBusy(() => this.recorder.stop())
    await this.finaliseSession(outputPath, durationMs)
  }

  /** Stores the recording in the session folder; also used when OBS stops or disconnects. */
  private async finaliseSession(outputPath: string | null, durationMs?: number): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = null
    const recording = active.session.recording
    if (recording) {
      recording.durationMs = durationMs ?? Date.now() - Date.parse(recording.startedAt)
      if (outputPath) {
        try {
          recording.file = await adoptRecording(active.folder, outputPath)
        } catch (error) {
          console.error('Could not move the recording into the session folder', error)
          recording.file = outputPath
        }
      }
    }
    await saveSession(active.folder, active.session)
    this.patch({ recording: null })
    this.broadcast('sessions:changed', null)
  }

  private publishRecording(): void {
    if (!this.active) return
    this.patch({
      recording: {
        sessionId: this.active.session.id,
        metadata: this.active.session.metadata,
        elapsedMs: this.recorder.currentTimeMs(),
        sampledAt: Date.now()
      }
    })
  }

  private async updateSource(sourceId: string, patch: { muted?: boolean; volumeDb?: number }): Promise<void> {
    const capture: CaptureConfig = {
      ...this.state.capture,
      audioSources: this.state.capture.audioSources.map((source) =>
        source.id === sourceId ? { ...source, ...patch } : source
      )
    }
    this.patch({ capture })
    await updateSettings({ capture })
  }

  /** On first run, prefer the GPU's hardware encoder so recording doesn't load the CPU. */
  private async detectDefaultEncoder(): Promise<void> {
    const settings = getSettings()
    if (settings.capture.display) return
    try {
      const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId: number; active?: boolean }[] }
      const gpu = info.gpuDevice?.find((device) => device.active) ?? info.gpuDevice?.[0]
      const byVendor: Record<number, EncoderId> = { 0x10de: 'nvenc', 0x1002: 'amd', 0x8086: 'qsv' }
      const encoder = gpu ? byVendor[gpu.vendorId] : undefined
      if (encoder && encoder !== settings.capture.encoder) {
        const capture = { ...settings.capture, encoder }
        await updateSettings({ capture })
        this.state.capture = capture
      }
    } catch {
      // Keep the software encoder.
    }
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.patch({ busy: true })
    try {
      return await fn()
    } finally {
      this.patch({ busy: false })
    }
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    this.broadcast('state:changed', this.state)
  }

  private broadcast(channel: string, payload: AppState | AudioLevels | null): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
}

function describeObsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|connect|socket|closed/i.test(message) && !/too old/.test(message)) {
    return 'Cannot reach OBS. Make sure OBS is running and the WebSocket server is enabled (Tools → WebSocket Server Settings).'
  }
  if (/auth/i.test(message)) return 'OBS rejected the password. Check the WebSocket server password.'
  return message
}
