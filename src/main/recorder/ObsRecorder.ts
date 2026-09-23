import { EventSubscription, OBSWebSocket } from 'obs-websocket-js'
import type {
  AudioSourceConfig,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  DisplayOption
} from '../../shared/types'
import type { Recorder, RecorderEvents } from './Recorder'

/** OBS objects owned by the app. The trainer's own profile and scenes are never modified. */
const PROFILE = 'IVAO TRS'
const COLLECTION = 'IVAO TRS'
const SCENE = 'TRS Recording'
const DISPLAY_INPUT = 'TRS Display'
const AUDIO_PREFIX = 'TRS Audio '
const PROBE_PREFIX = 'TRS Probe '

const INPUT_KIND: Record<AudioSourceKind, string> = {
  application: 'wasapi_process_output_capture',
  desktop: 'wasapi_output_capture',
  microphone: 'wasapi_input_capture'
}

const TARGET_PROPERTY: Record<AudioSourceKind, string> = {
  application: 'window',
  desktop: 'device_id',
  microphone: 'device_id'
}

/** Application audio matches the window by executable, so title changes don't break it. */
const WINDOW_PRIORITY_EXE = 2

const MIN_OBS_VERSION = [30, 2]
const START_TIMEOUT_MS = 10_000
const CLOCK_SYNC_MS = 2_000

export interface ObsConnectionParams {
  url: string
  password?: string
}

export class ObsRecorder implements Recorder {
  private readonly obs = new OBSWebSocket()
  private connected = false
  private recording = false
  /** Trainer's profile and scene collection, restored on disconnect. */
  private previous: { profile: string; collection: string } | null = null
  private clock = { durationMs: 0, sampledAt: 0 }
  private clockTimer: NodeJS.Timeout | null = null
  private startWaiter: ((started: boolean) => void) | null = null
  private stopping = false

  constructor(
    private readonly connection: () => ObsConnectionParams,
    private readonly events: RecorderEvents
  ) {
    this.obs.on('ConnectionClosed', (error) => {
      const wasConnected = this.connected
      this.connected = false
      this.setRecording(false)
      if (wasConnected) this.events.onDisconnected(error.message || 'Connection to OBS closed')
    })

    this.obs.on('InputVolumeMeters', ({ inputs }) => {
      const levels: Record<string, number> = {}
      for (const input of inputs) {
        const name = String(input.inputName)
        if (!name.startsWith(AUDIO_PREFIX)) continue
        const channels = (input.inputLevelsMul ?? []) as number[][]
        const peak = Math.max(0, ...channels.map((channel) => channel[1] ?? 0))
        levels[name.slice(AUDIO_PREFIX.length)] = peak > 0 ? Math.max(-60, 20 * Math.log10(peak)) : -60
      }
      this.events.onLevels(levels)
    })

    this.obs.on('RecordStateChanged', ({ outputState, outputPath }) => {
      if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
        this.startWaiter?.(true)
      } else if (outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        this.startWaiter?.(false)
        const wasRecording = this.recording
        this.setRecording(false)
        // Stopped from OBS itself (or OBS failed): let the app finalise the session.
        if (wasRecording && !this.stopping) this.events.onRecordingStopped(outputPath ?? null)
      }
    })
  }

  async connect(): Promise<{ version: string }> {
    const { url, password } = this.connection()
    await this.obs.connect(url, password, {
      rpcVersion: 1,
      eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters
    })
    this.connected = true
    try {
      const { obsVersion } = await this.obs.call('GetVersion')
      if (!isVersionAtLeast(obsVersion, MIN_OBS_VERSION)) {
        throw new Error(`OBS ${obsVersion} is too old: version ${MIN_OBS_VERSION.join('.')} or later is required`)
      }
      await this.enterWorkspace()
      return { version: obsVersion }
    } catch (error) {
      await this.obs.disconnect()
      this.connected = false
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    try {
      await this.restoreWorkspace()
    } finally {
      this.connected = false
      await this.obs.disconnect()
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  async listDisplays(): Promise<DisplayOption[]> {
    const { propertyItems } = await this.obs.call('GetInputPropertiesListPropertyItems', {
      inputName: DISPLAY_INPUT,
      propertyName: 'monitor_id'
    })
    return propertyItems
      .filter((item) => item.itemValue && item.itemEnabled !== false)
      .map((item) => {
        // Built-in panels often have no model name (": 1920x1200 @ 1920,0").
        const name = String(item.itemName).replace(/^\s*:\s*/, 'Display: ')
        const size = /(\d{3,5})\s*x\s*(\d{3,5})/.exec(name)
        return {
          id: String(item.itemValue),
          name,
          width: size ? Number(size[1]) : 1920,
          height: size ? Number(size[2]) : 1080
        }
      })
  }

  async listAudioTargets(kind: AudioSourceKind): Promise<AudioTargetOption[]> {
    // OBS only lists applications/devices through an input of that kind, so a
    // hidden probe input is created and removed.
    const probe = `${PROBE_PREFIX}${kind}`
    await this.removeInputIfExists(probe)
    await this.obs.call('CreateInput', {
      sceneName: SCENE,
      inputName: probe,
      inputKind: INPUT_KIND[kind],
      sceneItemEnabled: false
    })
    try {
      const { propertyItems } = await this.obs.call('GetInputPropertiesListPropertyItems', {
        inputName: probe,
        propertyName: TARGET_PROPERTY[kind]
      })
      const options = propertyItems
        .filter((item) => item.itemValue && item.itemEnabled !== false)
        .map((item) => ({ value: String(item.itemValue), label: String(item.itemName) }))
      return kind === 'application' ? groupByExecutable(options) : options
    } finally {
      await this.removeInputIfExists(probe)
    }
  }

  async configure(config: CaptureConfig): Promise<void> {
    if (this.recording) throw new Error('Capture settings cannot be changed while recording')
    await this.applyOutputSettings(config)
    if (config.display) await this.applyDisplay(config)
    await this.applyAudioSources(config.audioSources)
  }

  async setMuted(sourceId: string, muted: boolean): Promise<void> {
    await this.obs.call('SetInputMute', { inputName: AUDIO_PREFIX + sourceId, inputMuted: muted })
  }

  async setVolume(sourceId: string, volumeDb: number): Promise<void> {
    await this.obs.call('SetInputVolume', { inputName: AUDIO_PREFIX + sourceId, inputVolumeDb: volumeDb })
  }

  async preview(width: number): Promise<string | null> {
    try {
      const { imageData } = await this.obs.call('GetSourceScreenshot', {
        sourceName: DISPLAY_INPUT,
        imageFormat: 'jpg',
        imageWidth: width,
        imageCompressionQuality: 70
      })
      return imageData
    } catch {
      return null
    }
  }

  async start(outputDir: string): Promise<void> {
    if (this.recording) throw new Error('Already recording')
    const status = await this.obs.call('GetRecordStatus')
    if (status.outputActive) throw new Error('OBS is already recording. Stop that recording first.')

    await this.obs.call('SetRecordDirectory', { recordDirectory: outputDir })
    const started = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), START_TIMEOUT_MS)
      this.startWaiter = (ok) => {
        clearTimeout(timer)
        this.startWaiter = null
        resolve(ok)
      }
    })
    await this.obs.call('StartRecord')
    if (!(await started)) throw new Error('OBS did not start recording')
    this.clock = { durationMs: 0, sampledAt: Date.now() }
    this.setRecording(true)
  }

  async stop(): Promise<string | null> {
    if (!this.recording) return null
    this.stopping = true
    try {
      const { outputPath } = await this.obs.call('StopRecord')
      this.setRecording(false)
      return outputPath ?? null
    } finally {
      this.stopping = false
    }
  }

  isRecording(): boolean {
    return this.recording
  }

  currentTimeMs(): number {
    if (!this.recording) return 0
    return this.clock.durationMs + (Date.now() - this.clock.sampledAt)
  }

  async screenshot(filePath: string): Promise<void> {
    await this.obs.call('SaveSourceScreenshot', {
      sourceName: DISPLAY_INPUT,
      imageFormat: 'png',
      imageFilePath: filePath
    })
  }

  // ---------------------------------------------------------------------------

  private setRecording(recording: boolean): void {
    this.recording = recording
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = null
    if (recording) {
      this.clockTimer = setInterval(() => void this.syncClock(), CLOCK_SYNC_MS)
    }
  }

  /** Re-anchors the local clock on the recording duration reported by OBS. */
  private async syncClock(): Promise<void> {
    try {
      const requestedAt = Date.now()
      const { outputActive, outputDuration } = await this.obs.call('GetRecordStatus')
      if (!outputActive) return
      const receivedAt = Date.now()
      this.clock = { durationMs: outputDuration, sampledAt: requestedAt + (receivedAt - requestedAt) / 2 }
    } catch {
      // Keep extrapolating; a lost connection is reported by ConnectionClosed.
    }
  }

  /** Switches OBS to the app's own profile, scene collection and scene. */
  private async enterWorkspace(): Promise<void> {
    const collections = await this.obs.call('GetSceneCollectionList')
    const profiles = await this.obs.call('GetProfileList')
    this.previous =
      collections.currentSceneCollectionName !== COLLECTION || profiles.currentProfileName !== PROFILE
        ? { profile: profiles.currentProfileName, collection: collections.currentSceneCollectionName }
        : null

    if (profiles.currentProfileName !== PROFILE) {
      if (profiles.profiles.includes(PROFILE)) {
        await this.obs.call('SetCurrentProfile', { profileName: PROFILE })
      } else {
        await this.obs.call('CreateProfile', { profileName: PROFILE })
      }
    }

    if (collections.currentSceneCollectionName !== COLLECTION) {
      if (collections.sceneCollections.includes(COLLECTION)) {
        await this.obs.call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION })
      } else {
        await this.obs.call('CreateSceneCollection', { sceneCollectionName: COLLECTION })
      }
    }

    const { scenes } = await this.obs.call('GetSceneList')
    if (!scenes.some((scene) => scene.sceneName === SCENE)) {
      await this.obs.call('CreateScene', { sceneName: SCENE })
    }
    await this.obs.call('SetCurrentProgramScene', { sceneName: SCENE })

    // Global "Desktop Audio" / "Mic/Aux" would bypass the app's mixer.
    const special = await this.obs.call('GetSpecialInputs')
    for (const name of Object.values(special)) {
      if (typeof name === 'string' && name) await this.removeInputIfExists(name)
    }

    const { inputs } = await this.obs.call('GetInputList')
    for (const input of inputs) {
      if (String(input.inputName).startsWith(PROBE_PREFIX)) await this.removeInputIfExists(String(input.inputName))
    }
    if (!inputs.some((input) => input.inputName === DISPLAY_INPUT)) {
      await this.obs.call('CreateInput', {
        sceneName: SCENE,
        inputName: DISPLAY_INPUT,
        inputKind: 'monitor_capture',
        inputSettings: { capture_cursor: true }
      })
    }
  }

  private async restoreWorkspace(): Promise<void> {
    if (!this.previous || this.recording) return
    const { profile, collection } = this.previous
    await this.obs.call('SetCurrentSceneCollection', { sceneCollectionName: collection })
    await this.obs.call('SetCurrentProfile', { profileName: profile })
    this.previous = null
  }

  /** Simple output, quality-based recording, hybrid MP4 (crash-safe, playable in the app). */
  private async applyOutputSettings(config: CaptureConfig): Promise<void> {
    const wanted: [string, string, string][] = [
      ['Output', 'Mode', 'Simple'],
      ['SimpleOutput', 'RecQuality', 'Small'],
      ['SimpleOutput', 'RecEncoder', config.encoder],
      ['SimpleOutput', 'RecFormat2', 'hybrid_mp4'],
      ['SimpleOutput', 'RecRB', 'false']
    ]
    let changed = false
    for (const [parameterCategory, parameterName, value] of wanted) {
      const { parameterValue } = await this.obs.call('GetProfileParameter', { parameterCategory, parameterName })
      if (parameterValue !== value) {
        await this.obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue: value })
        changed = true
      }
    }
    // OBS rebuilds its outputs (and so picks up the encoder) only when a
    // profile is loaded, so briefly switch away and back.
    if (changed) {
      const { profiles } = await this.obs.call('GetProfileList')
      const other = profiles.find((profile) => profile !== PROFILE)
      if (other) {
        await this.obs.call('SetCurrentProfile', { profileName: other })
        await this.obs.call('SetCurrentProfile', { profileName: PROFILE })
      }
    }
  }

  private async applyDisplay(config: CaptureConfig): Promise<void> {
    const display = config.display!
    const base = { width: even(display.width), height: even(display.height) }
    const output =
      config.outputScale === '1080p' && base.height > 1080
        ? { width: even((base.width * 1080) / base.height), height: 1080 }
        : base

    const video = await this.obs.call('GetVideoSettings')
    if (
      video.baseWidth !== base.width ||
      video.baseHeight !== base.height ||
      video.outputWidth !== output.width ||
      video.outputHeight !== output.height ||
      video.fpsNumerator / video.fpsDenominator !== config.fps
    ) {
      await this.obs.call('SetVideoSettings', {
        baseWidth: base.width,
        baseHeight: base.height,
        outputWidth: output.width,
        outputHeight: output.height,
        fpsNumerator: config.fps,
        fpsDenominator: 1
      })
    }

    await this.obs.call('SetInputSettings', {
      inputName: DISPLAY_INPUT,
      inputSettings: { monitor_id: display.id, capture_cursor: true }
    })
    const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName: SCENE, sourceName: DISPLAY_INPUT })
    await this.obs.call('SetSceneItemTransform', {
      sceneName: SCENE,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        rotation: 0,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0,
        boundsWidth: base.width,
        boundsHeight: base.height
      }
    })
  }

  private async applyAudioSources(sources: AudioSourceConfig[]): Promise<void> {
    const { inputs } = await this.obs.call('GetInputList')
    const existing = new Set(inputs.map((input) => String(input.inputName)))
    const wanted = new Set(sources.map((source) => AUDIO_PREFIX + source.id))

    for (const name of existing) {
      if (name.startsWith(AUDIO_PREFIX) && !wanted.has(name)) await this.removeInputIfExists(name)
    }

    for (const source of sources) {
      const inputName = AUDIO_PREFIX + source.id
      const inputSettings: Record<string, string | number> =
        source.kind === 'application'
          ? { window: source.target, priority: WINDOW_PRIORITY_EXE }
          : { device_id: source.target }
      if (existing.has(inputName)) {
        await this.obs.call('SetInputSettings', { inputName, inputSettings })
      } else {
        await this.obs.call('CreateInput', {
          sceneName: SCENE,
          inputName,
          inputKind: INPUT_KIND[source.kind],
          inputSettings
        })
      }
      await this.setMuted(source.id, source.muted)
      await this.setVolume(source.id, source.volumeDb)
    }
  }

  private async removeInputIfExists(inputName: string): Promise<void> {
    try {
      await this.obs.call('RemoveInput', { inputName })
    } catch {
      // Not found.
    }
  }
}

/** Processes whose windows are never an audio source worth recording. */
const IGNORED_EXECUTABLES = new Set(['explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'textinputhost.exe'])

/**
 * OBS lists one entry per window ("title:class:exe"); Aurora alone has one per
 * inset. Audio is matched by executable, so keep one entry per program.
 */
function groupByExecutable(options: AudioTargetOption[]): AudioTargetOption[] {
  const byExe = new Map<string, AudioTargetOption>()
  for (const option of options) {
    const exe = option.value.split(':').pop() ?? ''
    const key = exe.toLowerCase()
    if (!exe || IGNORED_EXECUTABLES.has(key) || byExe.has(key)) continue
    if (option.label.includes('Training Recording System')) continue
    byExe.set(key, { value: option.value, label: `${exe.replace(/\.exe$/i, '')} (${exe})` })
  }
  return [...byExe.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

function even(value: number): number {
  return Math.round(value / 2) * 2
}

function isVersionAtLeast(version: string, minimum: number[]): boolean {
  const parts = version.split('.').map((part) => parseInt(part, 10) || 0)
  for (let i = 0; i < minimum.length; i++) {
    if ((parts[i] ?? 0) !== minimum[i]) return (parts[i] ?? 0) > minimum[i]
  }
  return true
}
