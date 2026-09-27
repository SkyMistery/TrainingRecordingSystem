import type { Hotkey } from './types'

/** The same key or button with the same modifiers (for conflicts between bindings). */
export function sameHotkey(a: Hotkey | null, b: Hotkey | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.device === b.device &&
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  )
}

/** The same key or button, whatever the modifiers: one press can't serve two bindings safely. */
export function sameKey(a: Hotkey | null, b: Hotkey | null): boolean {
  return a !== null && b !== null && a.device === b.device && a.code === b.code
}

/**
 * Whether a press triggers a binding: same key, and every modifier the binding
 * asks for is held. Extra modifiers don't matter: the trainer may be holding
 * Right Ctrl (Aurora) or AltGr (Discord) to talk while pressing F9.
 */
export function pressMatches(pressed: Hotkey, binding: Hotkey | null): boolean {
  return (
    binding !== null &&
    pressed.device === binding.device &&
    pressed.code === binding.code &&
    (!binding.ctrl || pressed.ctrl) &&
    (!binding.alt || pressed.alt) &&
    (!binding.shift || pressed.shift)
  )
}

/** Among the bindings a press matches, the one asking for the most modifiers (Ctrl + F9 before F9). */
export function bestMatch<T>(pressed: Hotkey, bindings: { binding: Hotkey | null; value: T }[]): T | undefined {
  const modifiers = (hotkey: Hotkey): number => Number(hotkey.ctrl) + Number(hotkey.alt) + Number(hotkey.shift)
  return bindings
    .filter(({ binding }) => pressMatches(pressed, binding))
    .sort((a, b) => modifiers(b.binding!) - modifiers(a.binding!))[0]?.value
}
