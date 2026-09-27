import { useEffect, useRef, useState } from 'react'
import { Button } from '@ivao/atmosphere-react'
import { Keyboard, X } from 'lucide-react'
import type { Hotkey } from '@shared/types'

interface HotkeyInputProps {
  value: Hotkey | null
  onChange: (hotkey: Hotkey | null) => void
  /** Label of another action already using the same key, if any. */
  conflict?: string | null
  label: string
  /** A modifier key pressed alone (Right Ctrl, AltGr…) is a valid key: for push-to-talk keys. */
  modifiersAlone?: boolean
}

/** Keys that type something: as a global hotkey they also fire while writing in Aurora or Discord. */
const TYPING_KEYS =
  /^([A-Z0-9]|Space|Comma|Period|Slash|Semicolon|Quote|Backquote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/

function typesText(hotkey: Hotkey | null): boolean {
  return (
    hotkey !== null &&
    hotkey.device === 'keyboard' &&
    !hotkey.ctrl &&
    !hotkey.alt &&
    TYPING_KEYS.test(hotkey.label.replace(/^Shift \+ /, ''))
  )
}

/** Click, then press any key (with modifiers) or a middle/side mouse button. */
export function HotkeyInput({
  value,
  onChange,
  conflict,
  label,
  modifiersAlone = false
}: HotkeyInputProps): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read through a ref so re-renders during capture don't restart it.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!capturing) return
    let cancelled = false
    // Its own id: cancelling this capture (another field clicked) never ends the next one.
    const id = crypto.randomUUID()
    setError(null)
    window.api.captureHotkey(id, modifiersAlone).then(
      (hotkey) => {
        if (cancelled) return
        setCapturing(false)
        if (hotkey) onChangeRef.current(hotkey)
      },
      (e: unknown) => {
        if (cancelled) return
        setCapturing(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    )
    // Switching to another program ends the capture: a key typed there must not become the hotkey.
    const cancelOnBlur = (): void => setCapturing(false)
    window.addEventListener('blur', cancelOnBlur)
    return () => {
      cancelled = true
      window.removeEventListener('blur', cancelOnBlur)
      void window.api.cancelHotkeyCapture(id)
    }
  }, [capturing, modifiersAlone])

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          variant={capturing ? 'primary' : 'outline'}
          size="sm"
          className="min-w-44 justify-start"
          aria-label={`${label} hotkey`}
          onClick={(event) => {
            // Without focus, Space or Enter pressed to bind them can't also click this button.
            if (!capturing) event.currentTarget.blur()
            setCapturing((value) => !value)
          }}
        >
          <Keyboard className="size-4" aria-hidden />
          {capturing ? 'Press a key or mouse button…' : (value?.label ?? 'Not set')}
        </Button>
        {/* Always rendered (hidden when unused) so rows keep the same width. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Clear ${label} hotkey`}
          className={value && !capturing ? undefined : 'invisible'}
          onClick={() => onChange(null)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      {capturing && <span className="text-xs text-muted-foreground">Esc cancels.</span>}
      {error && !capturing && <span className="text-xs text-semantic-red-600">{error}</span>}
      {conflict && !capturing && <span className="text-xs text-semantic-red-600">Also used for “{conflict}”.</span>}
      {!capturing && !conflict && typesText(value) && (
        <span className="text-xs text-semantic-yellow-700 dark:text-semantic-yellow-400">
          This key types text: it also fires while you write in Aurora or Discord. A function key (F1–F24) or a mouse
          side button is safer.
        </span>
      )}
    </div>
  )
}
