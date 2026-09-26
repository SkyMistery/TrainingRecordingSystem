import { EventEmitter } from 'node:events'
import koffi from 'koffi'
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi'
import type { Hotkey } from '../shared/types'

// SendInput for mouse buttons and extended keys (uiohook simulates the other keys).
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})
const INPUT = koffi.struct('INPUT', {
  type: 'uint32_t',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
})
const user32 = koffi.load('user32.dll')
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)')
const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)')
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const MAPVK_VSC_TO_VK_EX = 3
const MOUSEEVENTF_MIDDLEDOWN = 0x20
const MOUSEEVENTF_MIDDLEUP = 0x40
const MOUSEEVENTF_XDOWN = 0x80
const MOUSEEVENTF_XUP = 0x100

function sendMouseButton(button: number, down: boolean): void {
  const middle = button === 3
  const flags = middle
    ? down
      ? MOUSEEVENTF_MIDDLEDOWN
      : MOUSEEVENTF_MIDDLEUP
    : down
      ? MOUSEEVENTF_XDOWN
      : MOUSEEVENTF_XUP
  const mi = { dx: 0, dy: 0, mouseData: middle ? 0 : button - 3, dwFlags: flags, time: 0, dwExtraInfo: 0 }
  if (SendInput(1, [{ type: INPUT_MOUSE, u: { mi } }], koffi.sizeof(INPUT)) !== 1) throw new Error('SendInput failed')
}

/**
 * Presses or releases a key. Keys with an E0 scan code prefix (AltGr, Right
 * Ctrl, arrows…; uiohook codes 0x0Exx or 0xE0xx) go through SendInput with the
 * extended flag: uiohook drops it, so AltGr would reach apps like Discord as Left Alt.
 */
function sendKey(code: number, down: boolean): void {
  const prefix = code >> 8
  if (prefix !== 0x0e && prefix !== 0xe0) {
    uIOhook.keyToggle(code, down ? 'down' : 'up')
    return
  }
  const scan = code & 0xff
  const ki = {
    wVk: MapVirtualKeyW(0xe000 | scan, MAPVK_VSC_TO_VK_EX),
    wScan: scan,
    dwFlags: KEYEVENTF_EXTENDEDKEY | (down ? 0 : KEYEVENTF_KEYUP),
    time: 0,
    dwExtraInfo: 0
  }
  if (SendInput(1, [{ type: INPUT_KEYBOARD, u: { ki } }], koffi.sizeof(INPUT)) !== 1)
    throw new Error('SendInput failed')
}

/** Simulated presses come back through the hook: they are ignored if they arrive within this time. */
const SYNTHETIC_EVENT_MS = 1000

const KEY_NAMES = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]))

const MODIFIER_KEYS = new Set<number>([
  UiohookKey.Ctrl,
  UiohookKey.CtrlRight,
  UiohookKey.Alt,
  UiohookKey.AltRight,
  UiohookKey.Shift,
  UiohookKey.ShiftRight,
  UiohookKey.Meta,
  UiohookKey.MetaRight
])

/** Names of modifier keys bound alone (push-to-talk keys such as Right Ctrl or AltGr). */
const MODIFIER_NAMES = new Map<number, string>([
  [UiohookKey.Ctrl, 'Left Ctrl'],
  [UiohookKey.CtrlRight, 'Right Ctrl'],
  [UiohookKey.Alt, 'Left Alt'],
  [UiohookKey.AltRight, 'AltGr (Right Alt)'],
  [UiohookKey.Shift, 'Left Shift'],
  [UiohookKey.ShiftRight, 'Right Shift']
])

/** Left and right click stay free: only middle and side buttons can be bound. */
const MIN_MOUSE_BUTTON = 3

type InputEvent = UiohookKeyboardEvent | UiohookMouseEvent

function describe(device: Hotkey['device'], code: number, e: InputEvent): string {
  const base =
    device === 'mouse'
      ? code === 3
        ? 'Middle mouse button'
        : `Mouse button ${code}`
      : (KEY_NAMES.get(code) ?? `Key ${code}`)
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', base].filter(Boolean).join(' + ')
}

function toHotkey(device: Hotkey['device'], code: number, e: InputEvent): Hotkey {
  return { device, code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, label: describe(device, code, e) }
}

export interface HotkeyEvents {
  down: [Hotkey]
  up: [Hotkey]
}

/**
 * System-wide keyboard and mouse hook: works while Aurora (or any other app)
 * has focus, and reports both press and release, which push-to-talk needs.
 * Key auto-repeat is filtered out, so holding a key produces a single "down".
 */
export class GlobalHotkeys extends EventEmitter<HotkeyEvents> {
  /** Keys/buttons currently down; null for a press consumed by capture. */
  private readonly held = new Map<string, Hotkey | null>()
  private capture: ((hotkey: Hotkey | null) => void) | null = null
  private started = false
  /** Deadlines of the simulated presses and releases still to come back through the hook, by event. */
  private readonly synthetic = new Map<string, number[]>()
  /** Releases of the hotkeys held by hold(). */
  private readonly holds = new Set<() => void>()
  /** The current capture accepts a modifier key alone (Right Ctrl, AltGr…). */
  private captureModifiers = false
  /** Modifier pressed during such a capture: it is the key if released before any other key. */
  private modifierCandidate: number | null = null

  start(): void {
    if (this.started) return
    uIOhook.on('keydown', (e) => this.onDown('keyboard', e.keycode, e))
    uIOhook.on('keyup', (e) => this.onUp('keyboard', e.keycode))
    uIOhook.on('mousedown', (e) => this.onDown('mouse', Number(e.button), e))
    uIOhook.on('mouseup', (e) => this.onUp('mouse', Number(e.button)))
    uIOhook.start()
    this.started = true
  }

  stop(): void {
    for (const release of [...this.holds]) release()
    if (!this.started) return
    uIOhook.stop()
    this.started = false
  }

  /**
   * Presses the hotkey (with its modifiers) as if the user held it down, so
   * other apps bound to the same key react too, e.g. Discord's push-to-mute.
   * These presses don't trigger the app's own hotkeys. Returns the release,
   * which never throws and is safe to call more than once; stop() releases everything.
   */
  hold(hotkey: Hotkey): () => void {
    const modifiers: number[] = []
    if (hotkey.ctrl) modifiers.push(UiohookKey.Ctrl)
    if (hotkey.alt) modifiers.push(UiohookKey.Alt)
    if (hotkey.shift) modifiers.push(UiohookKey.Shift)
    // Modifier keys never reach onDown/onUp's hotkey handling, so nothing comes back to ignore.
    const echoes = hotkey.device === 'mouse' || !MODIFIER_KEYS.has(hotkey.code)
    const press = (down: boolean): void => {
      if (echoes) this.expect(`${down ? 'down' : 'up'}:${hotkey.device}:${hotkey.code}`)
      if (hotkey.device === 'keyboard') sendKey(hotkey.code, down)
      else sendMouseButton(hotkey.code, down)
    }
    const releaseModifiers = (): void => {
      for (const key of [...modifiers].reverse()) uIOhook.keyToggle(key, 'up')
    }
    for (const key of modifiers) uIOhook.keyToggle(key, 'down')
    try {
      press(true)
    } catch (error) {
      releaseModifiers()
      throw error
    }
    const release = (): void => {
      if (!this.holds.delete(release)) return
      try {
        press(false)
        releaseModifiers()
      } catch (error) {
        console.error('Could not release the held hotkey', error)
      }
    }
    this.holds.add(release)
    return release
  }

  private expect(event: string): void {
    this.synthetic.set(event, [...(this.synthetic.get(event) ?? []), Date.now() + SYNTHETIC_EVENT_MS])
  }

  /** True for an event caused by hold(), which is then forgotten. */
  private isSynthetic(event: string): boolean {
    const now = Date.now()
    const pending = (this.synthetic.get(event) ?? []).filter((deadline) => deadline > now)
    const found = pending.shift() !== undefined
    if (pending.length) this.synthetic.set(event, pending)
    else this.synthetic.delete(event)
    return found
  }

  /**
   * Resolves with the next key or mouse button pressed; Escape cancels (null).
   * `modifiersAlone`: a modifier pressed and released alone is the key (for
   * push-to-talk keys such as Right Ctrl or AltGr; the Windows key never is).
   */
  captureNext(modifiersAlone = false): Promise<Hotkey | null> {
    this.capture?.(null)
    this.captureModifiers = modifiersAlone
    this.modifierCandidate = null
    return new Promise((resolve) => {
      this.capture = (hotkey) => {
        this.capture = null
        this.captureModifiers = false
        this.modifierCandidate = null
        resolve(hotkey)
      }
    })
  }

  cancelCapture(): void {
    this.capture?.(null)
  }

  private onDown(device: Hotkey['device'], code: number, e: InputEvent): void {
    if (device === 'keyboard' && MODIFIER_KEYS.has(code)) {
      // AltGr arrives as Left Ctrl then Right Alt: the last one pressed wins.
      if (this.capture && this.captureModifiers && MODIFIER_NAMES.has(code)) this.modifierCandidate = code
      return
    }
    if (device === 'mouse' && code < MIN_MOUSE_BUTTON) return
    const id = `${device}:${code}`
    if (this.isSynthetic(`down:${id}`)) return
    if (this.held.has(id)) return // auto-repeat

    const hotkey = toHotkey(device, code, e)
    if (this.capture) {
      // Swallow this press (and its repeats and release) so binding a key
      // doesn't also trigger the action it is being bound to.
      this.held.set(id, null)
      this.capture(device === 'keyboard' && code === UiohookKey.Escape ? null : hotkey)
      return
    }
    this.held.set(id, hotkey)
    this.emit('down', hotkey)
  }

  private onUp(device: Hotkey['device'], code: number): void {
    if (device === 'keyboard' && this.capture && this.modifierCandidate !== null && MODIFIER_KEYS.has(code)) {
      const key = this.modifierCandidate
      this.capture({ device, code: key, ctrl: false, alt: false, shift: false, label: MODIFIER_NAMES.get(key)! })
      return
    }
    const id = `${device}:${code}`
    if (this.isSynthetic(`up:${id}`)) return
    if (!this.held.has(id)) return
    const hotkey = this.held.get(id)
    this.held.delete(id)
    if (hotkey) this.emit('up', hotkey)
  }
}
