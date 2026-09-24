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
}

/** Click, then press any key (with modifiers) or a middle/side mouse button. */
export function HotkeyInput({ value, onChange, conflict, label }: HotkeyInputProps): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  // Read through a ref so re-renders during capture don't restart it.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!capturing) return
    let cancelled = false
    void window.api.captureHotkey().then((hotkey) => {
      if (cancelled) return
      setCapturing(false)
      if (hotkey) onChangeRef.current(hotkey)
    })
    return () => {
      cancelled = true
      void window.api.cancelHotkeyCapture()
    }
  }, [capturing])

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
      {conflict && !capturing && <span className="text-xs text-semantic-red-600">Also used for “{conflict}”.</span>}
    </div>
  )
}
