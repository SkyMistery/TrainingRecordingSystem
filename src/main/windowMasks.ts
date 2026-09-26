import type { CaptureConfig, HiddenWindowRule, MaskRect, MaskSlots, WindowOption } from '../shared/types'
import { IGNORED_EXECUTABLES } from './programs'
import type { Recorder } from './recorder/Recorder'
import type { DesktopWindow } from './windows'

/** How often window positions are read: a moved or newly opened window is covered this fast. */
const POLL_MS = 50
/** Extra margin around a covered window, in pixels. */
const PADDING = 6
/**
 * A moving window is covered over its last few positions too, and where it is
 * heading next: the recording shows the screen a moment after the mask was placed.
 */
const TRAIL = 3
/**
 * A window that just went away (minimised, closed, another virtual desktop)
 * stays covered a little longer: Windows animates it out after reporting it gone.
 */
const GRACE_MS = 600

type WindowsModule = typeof import('./windows')

function matchesRule(rule: HiddenWindowRule, window: Pick<DesktopWindow, 'exe' | 'title'>): boolean {
  return (
    rule.enabled &&
    rule.exe.toLowerCase() === window.exe.toLowerCase() &&
    (rule.title === null || rule.title === window.title)
  )
}

/** Top-left corner of the display in screen pixels, from the "@ x,y" in the OBS monitor name; null if absent. */
export function displayOrigin(name: string): { x: number; y: number } | null {
  const match = /@\s*(-?\d+)\s*,\s*(-?\d+)/.exec(name)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null
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
  /** Windows gone a moment ago: their last cover and until when it stays. */
  private leaving = new Map<string, { rect: MaskRect; until: number }>()
  /** Which window each mask follows; a window keeps its mask while it is on screen. */
  private slots: (string | null)[] = []
  private failing = false
  private found: string[] = []

  constructor(
    private readonly recorder: Recorder,
    private readonly capture: () => CaptureConfig,
    private readonly onError: (message: string | null) => void,
    /** Rules with a matching window on screen, when that changes (for Setup). */
    private readonly onFound: (ruleIds: string[]) => void
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

  /** Covers the hidden windows now and waits until the recorder shows the masks (before recording). */
  async refreshNow(): Promise<void> {
    if (!this.windows || !this.recorder.isConnected()) return
    await this.recorder.setMasks(this.currentMasks(this.windows))
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
      this.reset()
      // The top bar shows the lost connection; an old problem with the masks no longer applies.
      this.report(null)
      return
    }
    let masks: MaskSlots
    try {
      masks = this.currentMasks(this.windows)
    } catch (error) {
      // Every 50 ms: an exception here must never escape into the main process.
      this.report(error instanceof Error ? error.message : String(error))
      return
    }
    this.recorder.setMasks(masks).then(
      () => this.report(null),
      (error: unknown) => this.report(error instanceof Error ? error.message : String(error))
    )
  }

  private reset(): void {
    this.trails.clear()
    this.leaving.clear()
    this.slots = []
  }

  private currentMasks(windows: WindowsModule): MaskSlots {
    const { display, hiddenWindows } = this.capture()
    const rules = hiddenWindows.filter((rule) => rule.enabled)
    if (!display || rules.length === 0) {
      this.reset()
      this.setFound([])
      return []
    }
    const origin = displayOrigin(display.name)
    if (!origin) throw new Error('the position of the recorded monitor is unknown: choose it again in Setup → Display.')
    const programs = new Set(rules.map((rule) => rule.exe.toLowerCase()))
    const open = windows.listDesktopWindows((exe) => programs.has(exe.toLowerCase()))
    const matched = open.filter((window) => rules.some((rule) => matchesRule(rule, window)))
    this.setFound(rules.filter((rule) => open.some((window) => matchesRule(rule, window))).map((rule) => rule.id))
    // Popups, menus and tooltips of a hidden window (owned by it) can show its content too.
    const hiddenIds = new Set(matched.map((window) => window.id))
    const owned = open.filter(
      (window) =>
        !hiddenIds.has(window.id) &&
        window.ownerId !== null &&
        hiddenIds.has(window.ownerId) &&
        matched.some((owner) => owner.exe.toLowerCase() === window.exe.toLowerCase())
    )

    const now = Date.now()
    const covers = new Map<string, MaskRect>()
    const trails = new Map<string, MaskRect[]>()
    for (const window of [...matched, ...owned]) {
      const rect = {
        x: window.x - origin.x - PADDING,
        y: window.y - origin.y - PADDING,
        width: window.width + 2 * PADDING,
        height: window.height + 2 * PADDING
      }
      const trail = [...(this.trails.get(window.id) ?? []), rect].slice(-TRAIL)
      trails.set(window.id, trail)
      const covered = clip(union([...trail, ahead(trail)]), display.width, display.height)
      if (covered) covers.set(window.id, covered)
    }
    for (const [id, trail] of this.trails) {
      if (trails.has(id)) continue
      const covered = clip(union(trail), display.width, display.height)
      if (covered) this.leaving.set(id, { rect: covered, until: now + GRACE_MS })
    }
    this.trails = trails
    for (const [id, { rect, until }] of this.leaving) {
      if (until < now || covers.has(id)) this.leaving.delete(id)
      else covers.set(id, rect)
    }
    return this.assign(covers)
  }

  /** Masks by slot: a window keeps its slot, a new one takes the first free slot. */
  private assign(covers: Map<string, MaskRect>): MaskSlots {
    this.slots = this.slots.map((id) => (id !== null && covers.has(id) ? id : null))
    for (const id of covers.keys()) {
      if (this.slots.includes(id)) continue
      const free = this.slots.indexOf(null)
      if (free >= 0) this.slots[free] = id
      else this.slots.push(id)
    }
    while (this.slots.length > 0 && this.slots.at(-1) === null) this.slots.pop()
    return this.slots.map((id) => (id === null ? null : covers.get(id)!))
  }

  private setFound(ruleIds: string[]): void {
    if (ruleIds.length === this.found.length && ruleIds.every((id, i) => id === this.found[i])) return
    this.found = ruleIds
    this.onFound(ruleIds)
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

/** Where a moving window will be at the next poll, from its last two positions. */
function ahead(trail: MaskRect[]): MaskRect {
  const last = trail.at(-1)!
  const previous = trail.at(-2) ?? last
  return { ...last, x: 2 * last.x - previous.x, y: 2 * last.y - previous.y }
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
