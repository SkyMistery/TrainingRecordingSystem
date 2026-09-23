import { EventEmitter } from 'node:events'
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi'
import type { Hotkey } from '../shared/types'

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
    if (!this.started) return
    uIOhook.stop()
    this.started = false
  }

  /** Resolves with the next key or mouse button pressed; Escape cancels (null). */
  captureNext(): Promise<Hotkey | null> {
    this.capture?.(null)
    return new Promise((resolve) => {
      this.capture = (hotkey) => {
        this.capture = null
        resolve(hotkey)
      }
    })
  }

  cancelCapture(): void {
    this.capture?.(null)
  }

  private onDown(device: Hotkey['device'], code: number, e: InputEvent): void {
    if (device === 'keyboard' && MODIFIER_KEYS.has(code)) return
    if (device === 'mouse' && code < MIN_MOUSE_BUTTON) return
    const id = `${device}:${code}`
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
    const id = `${device}:${code}`
    if (!this.held.has(id)) return
    const hotkey = this.held.get(id)
    this.held.delete(id)
    if (hotkey) this.emit('up', hotkey)
  }
}
