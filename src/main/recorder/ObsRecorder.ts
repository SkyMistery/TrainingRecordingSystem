import { dirname } from 'node:path'
import { EventSubscription, OBSWebSocket, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js'
import type {
  AudioSourceConfig,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  DisplayOption,
  MaskRect
} from '../../shared/types'
import type { Recorder, RecorderEvents } from './Recorder'

/** OBS objects owned by the app. The trainer's own profile and scenes are never modified. */
const PROFILE = 'IVAO TRS'
const COLLECTION = 'IVAO TRS'
const SCENE = 'TRS Recording'
const DISPLAY_INPUT = 'TRS Display'
const AUDIO_PREFIX = 'TRS Audio '
const PROBE_PREFIX = 'TRS Probe '
/** Plain rectangles covering private windows, above the display. */
const MASK_PREFIX = 'TRS Mask '
/** Opaque dark grey, as OBS stores colours (0xAABBGGRR). */
const MASK_COLOR = 0xff262626
/** Masks are sent again now and then, in case they were changed or hidden in OBS. */
const MASK_REFRESH_MS = 2_000

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
/** OBS finishes writing the file after StopRecord answers; long recordings take a moment. */
const STOP_TIMEOUT_MS = 30_000
const CLOCK_SYNC_MS = 2_000
/** A frozen OBS (or one closed mid-request) never answers: don't wait forever. */
const REQUEST_TIMEOUT_MS = 10_000
/** Switching profile or scene collection makes OBS reload them. */
const SWITCH_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
/**
 * OBS reports a recording as stopped a moment before its output is really
 * idle; a profile switch (restoring the trainer's) needs it idle.
 */
const IDLE_WAIT_MS = 5_000

const SLOW_REQUESTS = new Set<keyof OBSRequestTypes>([
  'SetCurrentProfile',
  'CreateProfile',
  'SetCurrentSceneCollection',
  'CreateSceneCollection',
  'StopRecord'
])

type RecordState = 'OBS_WEBSOCKET_OUTPUT_STARTED' | 'OBS_WEBSOCKET_OUTPUT_STOPPED'

export interface ObsConnectionParams {
  url: string
  password?: string
}

/** The trainer's own profile and scene collection; either half may be unknown. */
export interface ObsWorkspace {
  profile: string | null
  collection: string | null
}

/**
 * Keeps the trainer's own OBS profile and scene collection on disk, so they are
 * restored even if the app crashed while OBS was on the app's workspace.
 */
export interface WorkspaceStore {
  get(): ObsWorkspace | null
  set(workspace: ObsWorkspace | null): void
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export class ObsRecorder implements Recorder {
  private readonly obs = new OBSWebSocket()
  private connected = false
  private recording = false
  private paused = false
  private clock = { durationMs: 0, sampledAt: 0 }
  private clockTimer: NodeJS.Timeout | null = null
  private readonly stateWaiters = new Set<(state: RecordState, outputPath: string | null) => void>()
  private stopping = false
  /** Operations that change OBS's setup run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Canvas pixels per display pixel (the canvas is the display size, rounded to even). */
  private canvasScale = { x: 1, y: 1 }
  private wantedMasks: MaskRect[] = []
  /** What OBS shows (JSON of the masks) and when it was sent; null when unknown. */
  private shownMasks: { key: string; at: number } | null = null
  /** Scene item id of each mask input, in order; null until read from the scene. */
  private maskItems: number[] | null = null
  private maskUpdate: Promise<void> | null = null
  /**
   * OBS is on the app's scene collection with its scene set up. Not yet while
   * connecting (OBS still on the trainer's own), nor after a switch away from it.
   */
  private sceneReady = false
  private enteringWorkspace = false

  constructor(
    private readonly connection: () => ObsConnectionParams,
    private readonly events: RecorderEvents,
    private readonly workspace: WorkspaceStore
  ) {
    this.obs.on('ConnectionClosed', (error) => {
      const wasConnected = this.connected
      const durationMs = this.recording ? this.currentTimeMs() : undefined
      this.connected = false
      this.sceneReady = false
      this.setRecording(false)
      if (wasConnected) this.events.onDisconnected(error.message || 'Connection to OBS closed', durationMs)
    })

    // Masks wait while OBS is on another scene collection (or the app is still setting up its own).
    this.obs.on('CurrentSceneCollectionChanging', () => {
      this.sceneReady = false
      this.forgetMasks()
    })
    this.obs.on('CurrentSceneCollectionChanged', ({ sceneCollectionName }) => {
      // Switched back by hand; when the app switches, enterWorkspace marks it ready once the scene is set up.
      if (sceneCollectionName === COLLECTION && !this.enteringWorkspace) this.sceneReady = true
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
      switch (outputState) {
        case 'OBS_WEBSOCKET_OUTPUT_STARTED':
          for (const waiter of this.stateWaiters) waiter(outputState, null)
          break
        case 'OBS_WEBSOCKET_OUTPUT_PAUSED':
          // Paused in OBS: the recording (and so marker times) doesn't advance.
          this.clock = { durationMs: this.currentTimeMs(), sampledAt: Date.now() }
          this.paused = true
          break
        case 'OBS_WEBSOCKET_OUTPUT_RESUMED':
          this.clock = { durationMs: this.clock.durationMs, sampledAt: Date.now() }
          this.paused = false
          break
        case 'OBS_WEBSOCKET_OUTPUT_STOPPED': {
          for (const waiter of this.stateWaiters) waiter(outputState, outputPath ?? null)
          const wasRecording = this.recording
          const durationMs = this.currentTimeMs()
          if (this.stopping) break // stop() finishes the job
          this.setRecording(false)
          // Stopped from OBS itself (or OBS failed): let the app finalise the session.
          if (wasRecording) this.events.onRecordingStopped(outputPath ?? null, durationMs)
          break
        }
      }
    })
  }

  async connect(): Promise<{ version: string }> {
    const { url, password } = this.connection()
    try {
      await withTimeout(
        this.obs.connect(url, password, {
          rpcVersion: 1,
          eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters
        }),
        CONNECT_TIMEOUT_MS,
        'OBS did not answer'
      )
    } catch (error) {
      await this.obs.disconnect().catch(() => undefined)
      throw error
    }
    this.connected = true
    this.sceneReady = false
    this.forgetMasks()
    try {
      const { obsVersion } = await this.call('GetVersion')
      if (!isVersionAtLeast(obsVersion, MIN_OBS_VERSION)) {
        throw new Error(`OBS ${obsVersion} is too old: version ${MIN_OBS_VERSION.join('.')} or later is required`)
      }
      await this.exclusive(() => this.enterWorkspace())
      return { version: obsVersion }
    } catch (error) {
      // Half-way through, OBS may already be on the app's profile: give the trainer's back.
      await this.restoreWorkspace().catch(() => undefined)
      this.connected = false
      await this.obs.disconnect().catch(() => undefined)
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    try {
      await this.exclusive(() => this.restoreWorkspace())
    } finally {
      this.connected = false
      this.sceneReady = false
      this.setRecording(false)
      await this.obs.disconnect()
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  listDisplays(): Promise<DisplayOption[]> {
    return this.exclusive(async () => {
      await this.ensureWorkspace()
      const { propertyItems } = await this.call('GetInputPropertiesListPropertyItems', {
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
    })
  }

  listAudioTargets(kind: AudioSourceKind): Promise<AudioTargetOption[]> {
    return this.exclusive(async () => {
      await this.ensureWorkspace()
      // OBS only lists applications/devices through an input of that kind, so a
      // hidden probe input is created and removed.
      // A unique name, so two lists requested at once don't collide; leftovers
      // from a crash are removed on the next connection.
      const probe = `${PROBE_PREFIX}${kind} ${Math.random().toString(36).slice(2, 8)}`
      await this.call('CreateInput', {
        sceneName: SCENE,
        inputName: probe,
        inputKind: INPUT_KIND[kind],
        sceneItemEnabled: false
      })
      try {
        const { propertyItems } = await this.call('GetInputPropertiesListPropertyItems', {
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
    })
  }

  configure(config: CaptureConfig): Promise<void> {
    return this.exclusive(async () => {
      if (this.recording) throw new Error('Capture settings cannot be changed while recording')
      if (await this.obsOutputActive()) {
        throw new Error('OBS is recording or streaming right now: settings will be applied once it stops.')
      }
      // The trainer may have switched OBS to their own profile meanwhile: never write into it.
      await this.ensureWorkspace()
      await this.applyOutputSettings(config)
      if (config.display) await this.applyDisplay(config)
      await this.applyAudioSources(config.audioSources)
    })
  }

  async setMuted(sourceId: string, muted: boolean): Promise<void> {
    await this.call('SetInputMute', { inputName: AUDIO_PREFIX + sourceId, inputMuted: muted })
  }

  async setVolume(sourceId: string, volumeDb: number): Promise<void> {
    await this.call('SetInputVolume', { inputName: AUDIO_PREFIX + sourceId, inputVolumeDb: volumeDb })
  }

  setMasks(masks: MaskRect[]): Promise<void> {
    this.wantedMasks = masks
    if (!this.sceneReady) {
      // Still connecting, or OBS is on the trainer's own scenes: shown once the app's scene is set up
      // (masks are asked for again every few ms). A recording of other scenes can't be covered, though.
      return this.recording
        ? Promise.reject(new Error(`OBS was switched to another scene collection: switch it back to “${COLLECTION}”.`))
        : Promise.resolve()
    }
    // One update at a time; it keeps going until OBS shows the latest masks.
    this.maskUpdate ??= this.updateMasks().finally(() => {
      this.maskUpdate = null
    })
    return this.maskUpdate
  }

  async preview(width: number): Promise<string | null> {
    try {
      // The scene, not the display: previews show the masks too.
      const { imageData } = await this.call('GetSourceScreenshot', {
        sourceName: SCENE,
        imageFormat: 'jpg',
        imageWidth: width,
        imageCompressionQuality: 70
      })
      return imageData
    } catch {
      return null
    }
  }

  start(outputDir: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.recording) throw new Error('Already recording')
      const status = await this.call('GetRecordStatus')
      if (status.outputActive) throw new Error('OBS is already recording. Stop that recording first.')

      await this.call('SetRecordDirectory', { recordDirectory: outputDir })
      const started = this.waitForState('OBS_WEBSOCKET_OUTPUT_STARTED', START_TIMEOUT_MS)
      await this.call('StartRecord')
      if ((await started) === undefined) {
        // Late start: stop it, or it would record into a session the app gives up on.
        const late = await this.call('GetRecordStatus').catch(() => null)
        if (late?.outputActive) await this.call('StopRecord').catch(() => undefined)
        throw new Error('OBS did not start recording')
      }
      this.paused = false
      this.clock = { durationMs: 0, sampledAt: Date.now() }
      this.setRecording(true)
    })
  }

  async stop(): Promise<string | null> {
    if (!this.recording) return null
    this.stopping = true
    try {
      const outputDir = await this.call('GetRecordDirectory')
        .then((reply) => reply.recordDirectory)
        .catch(() => null)
      // StopRecord answers before the file is complete: wait for OBS to report it stopped.
      const stopped = this.waitForState('OBS_WEBSOCKET_OUTPUT_STOPPED', STOP_TIMEOUT_MS)
      const { outputPath } = await this.call('StopRecord')
      const finalPath = await stopped
      this.setRecording(false)
      await this.waitUntilIdle(IDLE_WAIT_MS)
      // A recording started from OBS itself must not land in this session's folder.
      if (outputDir)
        await this.call('SetRecordDirectory', { recordDirectory: dirname(outputDir) }).catch(() => undefined)
      return finalPath ?? outputPath ?? null
    } finally {
      this.stopping = false
    }
  }

  isRecording(): boolean {
    return this.recording
  }

  currentTimeMs(): number {
    if (!this.recording) return 0
    if (this.paused) return this.clock.durationMs
    return this.clock.durationMs + (Date.now() - this.clock.sampledAt)
  }

  async screenshot(filePath: string): Promise<void> {
    // The scene, so private windows stay covered in screenshots.
    await this.call('SaveSourceScreenshot', {
      sourceName: SCENE,
      imageFormat: 'png',
      imageFilePath: filePath
    })
  }

  async recordingInProgress(): Promise<{ outputDir: string; durationMs: number } | null> {
    if (!this.connected || this.recording) return null
    const status = await this.call('GetRecordStatus')
    if (!status.outputActive) return null
    // Only a recording made with the app's own profile can be one of its sessions.
    const { currentProfileName } = await this.call('GetProfileList')
    if (currentProfileName !== PROFILE) return null
    const { recordDirectory } = await this.call('GetRecordDirectory')
    return { outputDir: recordDirectory, durationMs: status.outputDuration }
  }

  continueRecording(durationMs: number): void {
    this.paused = false
    this.clock = { durationMs, sampledAt: Date.now() }
    this.setRecording(true)
  }

  // ---------------------------------------------------------------------------

  /** obs.call with a time limit. */
  private call<Type extends keyof OBSRequestTypes>(
    requestType: Type,
    requestData?: OBSRequestTypes[Type]
  ): Promise<OBSResponseTypes[Type]> {
    const ms = SLOW_REQUESTS.has(requestType) ? SWITCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    return withTimeout(this.obs.call(requestType, requestData), ms, `OBS did not answer (${requestType})`)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Resolves with the output path when OBS reports `state`, or undefined after `ms`. */
  private waitForState(state: RecordState, ms: number): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      const waiter = (reported: RecordState, outputPath: string | null): void => {
        if (reported !== state) return
        clearTimeout(timer)
        this.stateWaiters.delete(waiter)
        resolve(outputPath)
      }
      const timer = setTimeout(() => {
        this.stateWaiters.delete(waiter)
        resolve(undefined)
      }, ms)
      this.stateWaiters.add(waiter)
    })
  }

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
      const { outputActive, outputDuration, outputPaused } = await this.call('GetRecordStatus')
      if (!outputActive || !this.recording) return
      const receivedAt = Date.now()
      this.paused = outputPaused
      this.clock = { durationMs: outputDuration, sampledAt: requestedAt + (receivedAt - requestedAt) / 2 }
    } catch {
      // Keep extrapolating; a lost connection is reported by ConnectionClosed.
    }
  }

  /** True while OBS records, streams or otherwise shows the scene (virtual camera, replay buffer). */
  private async obsOutputActive(): Promise<boolean> {
    const [record, stream] = await Promise.all([this.call('GetRecordStatus'), this.call('GetStreamStatus')])
    // These answer with an error when the feature isn't available or set up at all.
    const inactive = { outputActive: false }
    const virtualCam = await this.call('GetVirtualCamStatus').catch(() => inactive)
    const replay = await this.call('GetReplayBufferStatus').catch(() => inactive)
    return record.outputActive || stream.outputActive || virtualCam.outputActive || replay.outputActive
  }

  /** True once nothing is recording, streaming or using the scene; false if still busy after `ms`. */
  private async waitUntilIdle(ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (await this.obsOutputActive()) {
      if (Date.now() >= until) return false
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return true
  }

  /** Re-enters the app's workspace if the trainer switched OBS to another profile or collection. */
  private async ensureWorkspace(): Promise<void> {
    const [profiles, collections] = await Promise.all([
      this.call('GetProfileList'),
      this.call('GetSceneCollectionList')
    ])
    if (profiles.currentProfileName === PROFILE && collections.currentSceneCollectionName === COLLECTION) return
    await this.enterWorkspace()
  }

  /** Switches OBS to the app's own profile, scene collection and scene. */
  private async enterWorkspace(): Promise<void> {
    this.enteringWorkspace = true
    try {
      await this.setUpWorkspace()
      this.sceneReady = true
    } finally {
      this.enteringWorkspace = false
    }
  }

  private async setUpWorkspace(): Promise<void> {
    const collections = await this.call('GetSceneCollectionList')
    const profiles = await this.call('GetProfileList')
    const needsSwitch = collections.currentSceneCollectionName !== COLLECTION || profiles.currentProfileName !== PROFILE
    // Switching scenes would change what an ongoing recording, stream or call captures.
    if (needsSwitch && (await this.obsOutputActive())) {
      throw new Error(
        'OBS is recording, streaming or using its virtual camera right now. Stop it in OBS, then connect again.'
      )
    }
    if (needsSwitch) {
      // Remember each half on its own: after an interrupted restore one half may
      // still be the app's own, and what was remembered for it is kept.
      const remembered = this.workspace.get()
      this.workspace.set({
        profile: profiles.currentProfileName !== PROFILE ? profiles.currentProfileName : (remembered?.profile ?? null),
        collection:
          collections.currentSceneCollectionName !== COLLECTION
            ? collections.currentSceneCollectionName
            : (remembered?.collection ?? null)
      })
    }

    if (profiles.currentProfileName !== PROFILE) {
      if (profiles.profiles.includes(PROFILE)) {
        await this.call('SetCurrentProfile', { profileName: PROFILE })
      } else {
        await this.call('CreateProfile', { profileName: PROFILE })
      }
    }

    if (collections.currentSceneCollectionName !== COLLECTION) {
      if (collections.sceneCollections.includes(COLLECTION)) {
        await this.call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION })
      } else {
        await this.call('CreateSceneCollection', { sceneCollectionName: COLLECTION })
      }
    }

    this.forgetMasks()
    const { scenes } = await this.call('GetSceneList')
    if (!scenes.some((scene) => scene.sceneName === SCENE)) {
      await this.call('CreateScene', { sceneName: SCENE })
    }
    await this.call('SetCurrentProgramScene', { sceneName: SCENE })

    // Global "Desktop Audio" / "Mic/Aux" would bypass the app's mixer.
    const special = await this.call('GetSpecialInputs')
    for (const name of Object.values(special)) {
      if (typeof name === 'string' && name) await this.removeInputIfExists(name)
    }

    const { inputs } = await this.call('GetInputList')
    for (const input of inputs) {
      if (String(input.inputName).startsWith(PROBE_PREFIX)) await this.removeInputIfExists(String(input.inputName))
    }
    if (!inputs.some((input) => input.inputName === DISPLAY_INPUT)) {
      await this.call('CreateInput', {
        sceneName: SCENE,
        inputName: DISPLAY_INPUT,
        inputKind: 'monitor_capture',
        inputSettings: { capture_cursor: true }
      })
    } else {
      // The scene may have been renamed or recreated in OBS: put the display back in it.
      await this.ensureInScene(DISPLAY_INPUT)
    }
  }

  private async restoreWorkspace(): Promise<void> {
    const previous = this.workspace.get()
    if (!previous || this.recording) return
    // Still busy after a few seconds: OBS is in use (e.g. streaming), leave it be.
    if (!(await this.waitUntilIdle(IDLE_WAIT_MS))) return
    // The trainer may have renamed or deleted them in the meantime.
    const { sceneCollections } = await this.call('GetSceneCollectionList')
    const { profiles } = await this.call('GetProfileList')
    if (previous.collection && sceneCollections.includes(previous.collection)) {
      // Before the switch: a mask update still waiting for OBS then fails quietly.
      this.sceneReady = false
      await this.call('SetCurrentSceneCollection', { sceneCollectionName: previous.collection })
    }
    if (previous.profile && profiles.includes(previous.profile)) {
      await this.call('SetCurrentProfile', { profileName: previous.profile })
    }
    this.workspace.set(null)
  }

  /** Adds an existing input to the app's scene if it isn't in it. */
  private async ensureInScene(inputName: string): Promise<void> {
    try {
      await this.call('GetSceneItemId', { sceneName: SCENE, sourceName: inputName })
    } catch {
      await this.call('CreateSceneItem', { sceneName: SCENE, sourceName: inputName })
    }
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
      const { parameterValue } = await this.call('GetProfileParameter', { parameterCategory, parameterName })
      if (parameterValue !== value) {
        await this.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue: value })
        changed = true
      }
    }
    // OBS rebuilds its outputs (and so picks up the encoder) only when a
    // profile is loaded, so briefly switch away and back.
    if (changed) {
      const { profiles } = await this.call('GetProfileList')
      const other = profiles.find((profile) => profile !== PROFILE)
      if (other) {
        await this.call('SetCurrentProfile', { profileName: other })
        await this.call('SetCurrentProfile', { profileName: PROFILE })
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

    const video = await this.call('GetVideoSettings')
    if (
      video.baseWidth !== base.width ||
      video.baseHeight !== base.height ||
      video.outputWidth !== output.width ||
      video.outputHeight !== output.height ||
      video.fpsNumerator / video.fpsDenominator !== config.fps
    ) {
      await this.call('SetVideoSettings', {
        baseWidth: base.width,
        baseHeight: base.height,
        outputWidth: output.width,
        outputHeight: output.height,
        fpsNumerator: config.fps,
        fpsDenominator: 1
      })
    }

    await this.call('SetInputSettings', {
      inputName: DISPLAY_INPUT,
      inputSettings: { monitor_id: display.id, capture_cursor: true }
    })
    this.canvasScale = { x: base.width / display.width, y: base.height / display.height }
    await this.ensureInScene(DISPLAY_INPUT)
    const { sceneItemId } = await this.call('GetSceneItemId', { sceneName: SCENE, sourceName: DISPLAY_INPUT })
    // Below everything else, so the masks cover it (a display added back lands on top).
    await this.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId, sceneItemIndex: 0 })
    await this.call('SetSceneItemTransform', {
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
    const { inputs } = await this.call('GetInputList')
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
        await this.call('SetInputSettings', { inputName, inputSettings })
        // An input outside the scene would silently be missing from the recording.
        await this.ensureInScene(inputName)
      } else {
        await this.call('CreateInput', {
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

  private forgetMasks(): void {
    this.shownMasks = null
    this.maskItems = null
  }

  private async updateMasks(): Promise<void> {
    for (;;) {
      if (!this.sceneReady) return
      const masks = this.wantedMasks
      const key = JSON.stringify(masks)
      if (this.shownMasks?.key === key && Date.now() - this.shownMasks.at < MASK_REFRESH_MS) return
      try {
        await this.showMasks(masks)
        this.shownMasks = { key, at: Date.now() }
      } catch (error) {
        // Read everything from OBS again next time (e.g. the scene collection was switched).
        this.forgetMasks()
        // Switched away meanwhile: setMasks reports it if that matters (during a recording).
        if (!this.sceneReady) return
        throw error
      }
    }
  }

  /** Moves one mask input over each rectangle, and hides the ones not needed. */
  private async showMasks(masks: MaskRect[]): Promise<void> {
    if (!this.maskItems) {
      const { sceneItems } = await this.call('GetSceneItemList', { sceneName: SCENE })
      const inScene = new Map(sceneItems.map((item) => [String(item.sourceName), Number(item.sceneItemId)]))
      // Leftovers from an earlier run are reused (and hidden if not needed).
      const found: number[] = []
      for (let i = 1; inScene.has(MASK_PREFIX + i); i++) found.push(inScene.get(MASK_PREFIX + i)!)
      this.maskItems = found
    }
    const items = this.maskItems
    while (items.length < masks.length) {
      const inputName = MASK_PREFIX + (items.length + 1)
      // Created hidden, on top of the scene; an input by that name outside the scene is replaced.
      const { sceneItemId } = await this.exclusive(async () => {
        await this.removeInputIfExists(inputName)
        return this.call('CreateInput', {
          sceneName: SCENE,
          inputName,
          inputKind: 'color_source_v3',
          inputSettings: { color: MASK_COLOR, width: 16, height: 16 },
          sceneItemEnabled: false
        })
      })
      items.push(sceneItemId)
    }
    const { x: scaleX, y: scaleY } = this.canvasScale
    for (const [i, sceneItemId] of items.entries()) {
      const mask = masks[i]
      if (mask) {
        await this.call('SetSceneItemTransform', {
          sceneName: SCENE,
          sceneItemId,
          sceneItemTransform: {
            positionX: Math.floor(mask.x * scaleX),
            positionY: Math.floor(mask.y * scaleY),
            alignment: 5, // top left
            rotation: 0,
            boundsType: 'OBS_BOUNDS_STRETCH',
            boundsAlignment: 0,
            boundsWidth: Math.max(1, Math.ceil(mask.width * scaleX)),
            boundsHeight: Math.max(1, Math.ceil(mask.height * scaleY))
          }
        })
      }
      await this.call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId, sceneItemEnabled: Boolean(mask) })
    }
  }

  private async removeInputIfExists(inputName: string): Promise<void> {
    try {
      await this.call('RemoveInput', { inputName })
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
