import { EventEmitter } from 'node:events'
import koffi from 'koffi'
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi'
import type { Hotkey } from '../shared/types'
import { virtualKey } from './keymap'

// SendInput for every simulated key and mouse button: its result tells whether Windows took it.
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
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)')
const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)')
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)')
const GetForegroundWindow = user32.func('void *__stdcall GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func(
  'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
)
const GetTickCount = kernel32.func('uint32_t __stdcall GetTickCount()')
const OpenProcess = kernel32.func('void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const GetCurrentProcess = kernel32.func('void *__stdcall GetCurrentProcess()')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)')
const OpenProcessToken = advapi32.func(
  'bool __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)'
)
const GetTokenInformation = advapi32.func(
  'bool __stdcall GetTokenInformation(void *token, int infoClass, _Out_ uint32_t *info, uint32_t size, _Out_ uint32_t *returned)'
)

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const MAPVK_VK_TO_VSC_EX = 4
const MOUSEEVENTF_MIDDLEDOWN = 0x20
const MOUSEEVENTF_MIDDLEUP = 0x40
const MOUSEEVENTF_XDOWN = 0x80
const MOUSEEVENTF_XUP = 0x100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x8
const TOKEN_ELEVATION = 20
/** Keys whose real presses carry the E0 "extended" flag: without it AltGr reaches Discord as Left Alt. */
const EXTENDED_VKS = new Set([
  0xa3, 0xa5, 0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x6f, 0x90, 0x2c, 0x5b, 0x5c, 0x5d
])
/** uiohook's code for the numeric keypad's Enter (VK_RETURN with the extended flag). */
const NUMPAD_ENTER = 0x0e1c
/** Virtual keys of the mouse buttons that can be bound (3 = middle, 4/5 = side buttons). */
const MOUSE_VKS: Record<number, number> = { 3: 0x04, 4: 0x05, 5: 0x06 }

function send(input: object): boolean {
  return SendInput(1, [input], koffi.sizeof(INPUT)) === 1
}

/** Presses or releases a keyboard key (uiohook code); false if Windows refused it (e.g. the lock screen). */
function sendKey(code: number, down: boolean): boolean {
  const vk = virtualKey(code)
  if (!vk) throw new Error('This key can’t be pressed by the app: choose another one')
  const extended = EXTENDED_VKS.has(vk) || code === NUMPAD_ENTER
  const ki = {
    wVk: vk,
    wScan: MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX) & 0xff,
    dwFlags: (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP),
    time: 0,
    dwExtraInfo: 0
  }
  return send({ type: INPUT_KEYBOARD, u: { ki } })
}

function sendMouseButton(button: number, down: boolean): boolean {
  const middle = button === 3
  const flags = middle
    ? down
      ? MOUSEEVENTF_MIDDLEDOWN
      : MOUSEEVENTF_MIDDLEUP
    : down
      ? MOUSEEVENTF_XDOWN
      : MOUSEEVENTF_XUP
  const mi = { dx: 0, dy: 0, mouseData: middle ? 0 : button - 3, dwFlags: flags, time: 0, dwExtraInfo: 0 }
  return send({ type: INPUT_MOUSE, u: { mi } })
}

/** Whether a key or button is down for Windows right now (pressed by hand, by the app, or stuck). */
function isDownNow(device: Hotkey['device'], code: number): boolean {
  const vk = device === 'mouse' ? MOUSE_VKS[code] : virtualKey(code)
  return Boolean(vk) && (GetAsyncKeyState(vk) & 0x8000) !== 0
}

/** Whether a process runs elevated (as administrator); null if Windows won't tell. */
function processElevated(process: unknown): boolean | null {
  const token = [null]
  if (!OpenProcessToken(process, TOKEN_QUERY, token)) return null
  try {
    const elevated = [0]
    const size = [0]
    return GetTokenInformation(token[0], TOKEN_ELEVATION, elevated, 4, size) ? elevated[0] !== 0 : null
  } finally {
    CloseHandle(token[0])
  }
}

const selfElevated = processElevated(GetCurrentProcess()) === true

/**
 * True when the window in front belongs to a program running as administrator
 * while this app doesn't: Windows then drops the keys the app sends to it,
 * silently (UIPI), so a push-to-talk key could be pressed but never released.
 */
export function foregroundBlocksKeys(): boolean {
  if (selfElevated) return false
  const hwnd = GetForegroundWindow()
  if (!hwnd) return false
  const pid = [0]
  GetWindowThreadProcessId(hwnd, pid)
  if (!pid[0] || pid[0] === process.pid) return false
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
  if (!handle) return false
  try {
    // A non-elevated app can't read an elevated one's token: that refusal says as much.
    return processElevated(handle) !== false
  } finally {
    CloseHandle(handle)
  }
}

/** Simulated presses come back through the hook: they are ignored if they come within this time of being sent. */
const SYNTHETIC_EVENT_MS = 1000
/** A release Windows refused (lock screen, UAC prompt) is tried again this often. */
const RETRY_RELEASE_MS = 500

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
/** A capture nobody finishes (the renderer reloaded) must not swallow a key pressed hours later. */
const CAPTURE_TIMEOUT_MS = 30_000

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

/** Whether the app can press this key or button itself (push-to-talk keys, the note key held for buttons). */
export function canSimulate(hotkey: Hotkey): boolean {
  return hotkey.device === 'mouse' ? hotkey.code in MOUSE_VKS : virtualKey(hotkey.code) !== 0
}

interface HotkeyEvents {
  down: [Hotkey]
  up: [Hotkey]
  /** A simulated key could not be released yet (it is tried again), or was released after all (null). */
  stuck: [string | null]
}

interface Key {
  device: Hotkey['device']
  code: number
  label: string
}

/**
 * System-wide keyboard and mouse hook: works while Aurora (or any other app)
 * has focus, and reports both press and release, which push-to-talk needs.
 * Key auto-repeat is filtered out, so holding a key produces a single "down".
 */
export class GlobalHotkeys extends EventEmitter<HotkeyEvents> {
  /** Keys/buttons currently down; null for a press consumed by capture. */
  private readonly held = new Map<string, Hotkey | null>()
  private capture: { id: string; resolve: (hotkey: Hotkey | null) => void; timer: NodeJS.Timeout } | null = null
  private started = false
  /** Tick counts (GetTickCount) of simulated presses and releases still to come back through the hook, by event. */
  private readonly synthetic = new Map<string, number[]>()
  /** Releases of the hotkeys held by hold(). */
  private readonly holds = new Set<() => void>()
  /** Releases Windows refused: tried again until they go through. */
  private readonly pendingUps = new Map<string, Key>()
  private retryTimer: NodeJS.Timeout | null = null
  /** The current capture accepts a modifier key alone (Right Ctrl, AltGr…). */
  private captureModifiers = false
  /** Modifier pressed during such a capture: it is the key if released before any other key. */
  private modifierCandidate: number | null = null

  start(): void {
    if (this.started) return
    uIOhook.on('keydown', (e) => this.onDown('keyboard', e.keycode, e))
    uIOhook.on('keyup', (e) => this.onUp('keyboard', e.keycode, e.time))
    uIOhook.on('mousedown', (e) => this.onDown('mouse', Number(e.button), e))
    uIOhook.on('mouseup', (e) => this.onUp('mouse', Number(e.button), e.time))
    uIOhook.start()
    this.started = true
  }

  isStarted(): boolean {
    return this.started
  }

  stop(): void {
    this.releaseAll()
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = null
    if (!this.started) return
    try {
      uIOhook.stop()
    } catch (error) {
      console.error('Could not stop the keyboard hook', error)
    }
    this.started = false
  }

  /** Releases everything the app holds (quit, lock screen, sleep, an unexpected error). */
  releaseAll(): void {
    for (const release of [...this.holds]) release()
  }

  /** Whether the app is holding any key right now, or failed to release one. */
  holding(): boolean {
    return this.holds.size > 0 || this.pendingUps.size > 0
  }

  /**
   * Keys left down by an earlier run that ended while holding them (a crash):
   * Windows still thinks they are pressed, and Aurora may be transmitting. Only
   * keys the app can press itself, and that no one may be holding (at startup).
   */
  releaseIfDown(hotkeys: (Hotkey | null)[]): void {
    for (const hotkey of hotkeys) {
      if (!hotkey || !canSimulate(hotkey) || !isDownNow(hotkey.device, hotkey.code)) continue
      console.warn(`${hotkey.label} was still down: released`)
      this.sendUp({ device: hotkey.device, code: hotkey.code, label: hotkey.label })
    }
  }

  /** Whether a hotkey's key or button is physically down (a release the hook may have missed). */
  isDown(hotkey: Hotkey): boolean {
    return canSimulate(hotkey) && isDownNow(hotkey.device, hotkey.code)
  }

  /**
   * Presses the hotkey (with its modifiers) as if the user held it down, so
   * other apps bound to the same key react too, e.g. Discord's push-to-mute.
   * These presses don't trigger the app's own hotkeys. Returns the release,
   * which never throws and is safe to call more than once; stop() releases
   * everything. Throws if the key can't be pressed (the lock screen, a window
   * in front running as administrator): nothing is left pressed then.
   */
  hold(hotkey: Hotkey): () => void {
    if (!canSimulate(hotkey)) throw new Error(`${hotkey.label} can’t be pressed by the app: choose another key`)
    if (foregroundBlocksKeys()) {
      throw new Error(
        `The window in front runs as administrator: Windows doesn’t let the app press ${hotkey.label} in it. Start Training Recording System as administrator too, or that program without.`
      )
    }
    const keys: Key[] = []
    if (hotkey.ctrl) keys.push({ device: 'keyboard', code: UiohookKey.Ctrl, label: 'Ctrl' })
    if (hotkey.alt) keys.push({ device: 'keyboard', code: UiohookKey.Alt, label: 'Alt' })
    if (hotkey.shift) keys.push({ device: 'keyboard', code: UiohookKey.Shift, label: 'Shift' })
    keys.push({ device: hotkey.device, code: hotkey.code, label: hotkey.label })
    const pressed: Key[] = []
    for (const key of keys) {
      if (!this.sendDown(key)) {
        for (const done of pressed.reverse()) this.sendUp(done)
        throw new Error(`Windows refused to press ${hotkey.label} (is the screen locked?)`)
      }
      pressed.push(key)
    }
    const release = (): void => {
      if (!this.holds.delete(release)) return
      // Each key on its own: one refused release must not leave the others (Ctrl…) down.
      for (const key of [...pressed].reverse()) this.sendUp(key)
    }
    this.holds.add(release)
    return release
  }

  private sendDown(key: Key): boolean {
    const event = `down:${key.device}:${key.code}`
    const tick = this.expect(event)
    const ok = key.device === 'keyboard' ? sendKey(key.code, true) : sendMouseButton(key.code, true)
    if (!ok) this.forget(event, tick)
    return ok
  }

  /** Releases a key; if Windows refuses, it is tried again until it goes through. */
  private sendUp(key: Key): void {
    const event = `up:${key.device}:${key.code}`
    const tick = this.expect(event)
    let ok = false
    try {
      ok = key.device === 'keyboard' ? sendKey(key.code, false) : sendMouseButton(key.code, false)
    } catch (error) {
      console.error(`Could not release ${key.label}`, error)
    }
    if (ok) return
    this.forget(event, tick)
    this.pendingUps.set(`${key.device}:${key.code}`, key)
    this.emit(
      'stuck',
      `${key.label} could not be released: the app keeps trying. If it stays pressed, press it once yourself.`
    )
    this.retryTimer ??= setInterval(() => this.retryReleases(), RETRY_RELEASE_MS)
  }

  private retryReleases(): void {
    for (const [id, key] of [...this.pendingUps]) {
      const event = `up:${key.device}:${key.code}`
      const tick = this.expect(event)
      let ok = false
      try {
        ok = key.device === 'keyboard' ? sendKey(key.code, false) : sendMouseButton(key.code, false)
      } catch {
        ok = false
      }
      if (ok) this.pendingUps.delete(id)
      else this.forget(event, tick)
    }
    if (this.pendingUps.size === 0) {
      if (this.retryTimer) clearInterval(this.retryTimer)
      this.retryTimer = null
      this.emit('stuck', null)
    }
  }

  /** Remembers that this event will come back through the hook, stamped with Windows' clock. */
  private expect(event: string): number {
    const tick = GetTickCount()
    // Modifier keys never reach the hotkey handling (onDown/onUp), so nothing comes back to ignore.
    if (MODIFIER_KEYS.has(Number(event.split(':').at(-1))) && event.includes(':keyboard:')) return tick
    this.synthetic.set(event, [...(this.synthetic.get(event) ?? []), tick])
    return tick
  }

  private forget(event: string, tick: number): void {
    const pending = (this.synthetic.get(event) ?? []).filter((item) => item !== tick)
    if (pending.length) this.synthetic.set(event, pending)
    else this.synthetic.delete(event)
  }

  /**
   * True for an event caused by hold(), which is then forgotten. Compared on the
   * event's own time (Windows' clock), not when it gets here: a busy app must
   * not take its own presses for the trainer's.
   */
  private isSynthetic(event: string, eventTime: number): boolean {
    const pending = this.synthetic.get(event)
    if (!pending) return false
    // Signed 32-bit difference: GetTickCount wraps after 49 days.
    const index = pending.findIndex((tick) => {
      const delay = (eventTime - tick) | 0
      return delay >= -50 && delay <= SYNTHETIC_EVENT_MS
    })
    const now = GetTickCount()
    const left = pending.filter((tick, i) => i !== index && ((now - tick) | 0) <= 10 * SYNTHETIC_EVENT_MS)
    if (left.length) this.synthetic.set(event, left)
    else this.synthetic.delete(event)
    return index >= 0
  }

  /**
   * Resolves with the next key or mouse button pressed; Escape cancels (null).
   * `modifiersAlone`: a modifier pressed and released alone is the key (for
   * push-to-talk keys such as Right Ctrl or AltGr; the Windows key never is).
   * `id` identifies the capture, so cancelling an old one never ends a newer one.
   */
  captureNext(id: string, modifiersAlone = false): Promise<Hotkey | null> {
    if (!this.started) return Promise.reject(new Error('Hotkeys are not available (see Setup → Markers)'))
    this.finishCapture(null)
    this.captureModifiers = modifiersAlone
    this.modifierCandidate = null
    return new Promise((resolve) => {
      this.capture = { id, resolve, timer: setTimeout(() => this.finishCapture(null), CAPTURE_TIMEOUT_MS) }
    })
  }

  cancelCapture(id: string): void {
    if (this.capture?.id === id) this.finishCapture(null)
  }

  private finishCapture(hotkey: Hotkey | null): void {
    const capture = this.capture
    if (!capture) return
    this.capture = null
    this.captureModifiers = false
    this.modifierCandidate = null
    clearTimeout(capture.timer)
    capture.resolve(hotkey)
  }

  private onDown(device: Hotkey['device'], code: number, e: InputEvent): void {
    if (device === 'keyboard' && MODIFIER_KEYS.has(code)) {
      // AltGr arrives as Left Ctrl then Right Alt: the last one pressed wins.
      if (this.capture && this.captureModifiers && MODIFIER_NAMES.has(code)) this.modifierCandidate = code
      return
    }
    if (device === 'mouse' && code < MIN_MOUSE_BUTTON) return
    const id = `${device}:${code}`
    if (this.isSynthetic(`down:${id}`, e.time)) return
    if (this.held.has(id)) return // auto-repeat

    const hotkey = toHotkey(device, code, e)
    if (this.capture) {
      // Swallow this press (and its repeats and release) so binding a key
      // doesn't also trigger the action it is being bound to.
      this.held.set(id, null)
      this.finishCapture(device === 'keyboard' && code === UiohookKey.Escape ? null : hotkey)
      return
    }
    this.held.set(id, hotkey)
    this.emit('down', hotkey)
  }

  private onUp(device: Hotkey['device'], code: number, time: number): void {
    if (device === 'keyboard' && this.capture && this.modifierCandidate !== null && MODIFIER_KEYS.has(code)) {
      const key = this.modifierCandidate
      this.finishCapture({ device, code: key, ctrl: false, alt: false, shift: false, label: MODIFIER_NAMES.get(key)! })
      return
    }
    const id = `${device}:${code}`
    if (this.isSynthetic(`up:${id}`, time)) return
    if (!this.held.has(id)) return
    const hotkey = this.held.get(id)
    this.held.delete(id)
    if (hotkey) this.emit('up', hotkey)
  }

  /** A release the hook never reported (the key went up over the lock screen): forget it was down. */
  forgetHeld(hotkey: Hotkey): void {
    this.held.delete(`${hotkey.device}:${hotkey.code}`)
  }
}
