import type { Hotkey } from './types'

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
