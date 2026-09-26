import type { CaptureConfig, HiddenWindowRule, MaskRect, WindowOption } from '../shared/types'
import type { Recorder } from './recorder/Recorder'
import type { DesktopWindow } from './windows'

/** How often window positions are read: a moved or newly opened window is covered this fast. */
const POLL_MS = 50
/** Extra margin around a covered window, in pixels. */
const PADDING = 6
/**
 * A moving window is covered over its last few positions too: the recording
 * shows the screen a moment after the mask was placed.
 */
const TRAIL = 3

type WindowsModule = typeof import('./windows')

/** Programs never offered as a hidden window. */
const IGNORED_EXECUTABLES = new Set(['explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'textinputhost.exe'])

function matchesRule(rule: HiddenWindowRule, window: Pick<DesktopWindow, 'exe' | 'title'>): boolean {
  return (
    rule.enabled &&
    rule.exe.toLowerCase() === window.exe.toLowerCase() &&
    (rule.title === null || rule.title === window.title)
  )
}

/** Top-left corner of the display in screen pixels, from the "@ x,y" in the OBS monitor name. */
function displayOrigin(name: string): { x: number; y: number } {
  const match = /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(name)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 }
}

/**
 * Keeps private windows (Setup → Hidden windows) covered in the recording:
 * follows them on the recorded display and moves the recorder's masks over them.
 */
export class WindowMasks {
  private timer: NodeJS.Timeout | null = null
  private windows: WindowsModule | null = null
  /** Recent positions of each covered window (display pixels), newest last. */
  private trails = new Map<string, MaskRect[]>()
  private failing = false

  constructor(
    private readonly recorder: Recorder,
    private readonly capture: () => CaptureConfig,
    private readonly onError: (message: string | null) => void
  ) {}

  async start(): Promise<void> {
    try {
      // Loaded here, so a missing native library can't stop the app from starting.
      this.windows = await import('./windows')
    } catch (error) {
      console.error('Window tracking unavailable', error)
      this.onError('Hidden windows can’t be covered: the window tracking library failed to load.')
      return
    }
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Open windows that can be hidden, one entry per program and title. */
  listWindows(): WindowOption[] {
    if (!this.windows) throw new Error('Window tracking is not available')
    const seen = new Set<string>()
    const options: WindowOption[] = []
    for (const { exe, title } of this.windows.listDesktopWindows()) {
      const key = `${exe.toLowerCase()}\n${title}`
      if (!title || IGNORED_EXECUTABLES.has(exe.toLowerCase()) || seen.has(key)) continue
      seen.add(key)
      options.push({ exe, title })
    }
    return options.sort(
      (a, b) =>
        a.exe.localeCompare(b.exe, undefined, { sensitivity: 'base' }) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    )
  }

  private tick(): void {
    if (!this.windows || !this.recorder.isConnected()) {
      this.trails.clear()
      // The top bar shows the lost connection; an old problem with the masks no longer applies.
      this.report(null)
      return
    }
    const masks = this.currentMasks(this.windows)
    this.recorder.setMasks(masks).then(
      () => this.report(null),
      (error: unknown) => this.report(error instanceof Error ? error.message : String(error))
    )
  }

  private currentMasks(windows: WindowsModule): MaskRect[] {
    const { display, hiddenWindows } = this.capture()
    const rules = hiddenWindows.filter((rule) => rule.enabled)
    if (!display || rules.length === 0) {
      this.trails.clear()
      return []
    }
    const origin = displayOrigin(display.name)
    const programs = new Set(rules.map((rule) => rule.exe.toLowerCase()))
    const trails = new Map<string, MaskRect[]>()
    const masks: MaskRect[] = []
    for (const window of windows.listDesktopWindows((exe) => programs.has(exe.toLowerCase()))) {
      if (!rules.some((rule) => matchesRule(rule, window))) continue
      const rect = {
        x: window.x - origin.x - PADDING,
        y: window.y - origin.y - PADDING,
        width: window.width + 2 * PADDING,
        height: window.height + 2 * PADDING
      }
      const trail = [...(this.trails.get(window.id) ?? []), rect].slice(-TRAIL)
      trails.set(window.id, trail)
      const covered = clip(union(trail), display.width, display.height)
      if (covered) masks.push(covered)
    }
    this.trails = trails
    return masks
  }

  /** Logged once per problem, not every 50 ms. */
  private report(problem: string | null): void {
    if (problem && !this.failing) console.error('Could not cover hidden windows:', problem)
    if (Boolean(problem) !== this.failing) {
      this.failing = Boolean(problem)
      this.onError(problem ? `Hidden windows can’t be covered right now: ${problem}` : null)
    }
  }
}

function union(rects: MaskRect[]): MaskRect {
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The part of the rectangle on the display, or null if it is elsewhere. */
function clip(rect: MaskRect, width: number, height: number): MaskRect | null {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(width, rect.x + rect.width)
  const bottom = Math.min(height, rect.y + rect.height)
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
}
