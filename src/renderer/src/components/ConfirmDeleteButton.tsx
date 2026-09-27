import { useEffect, useRef, useState } from 'react'
import { Button } from '@ivao/atmosphere-react'
import { Trash2 } from 'lucide-react'

/** How long the confirmation stays up before the button goes back to the icon. */
const CONFIRM_MS = 4000
/** A click sooner than this after "Delete?" appeared is the second half of a double click, not a yes. */
const MIN_CONFIRM_DELAY_MS = 400

/**
 * A delete icon that asks once more: the first tap turns it into "Delete?",
 * the second deletes. Works the same with a mouse and on a touch screen, and
 * a stray click next to the category chips no longer removes anything.
 */
export function ConfirmDeleteButton({
  label,
  onConfirm,
  disabled = false,
  className
}: {
  label: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const askedAt = useRef(0)
  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [asking])

  if (asking && !disabled) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={className}
        aria-label={`Confirm: ${label}`}
        onClick={(event) => {
          // The same button under the pointer: a double click would otherwise confirm by itself.
          if (event.detail > 1 || Date.now() - askedAt.current < MIN_CONFIRM_DELAY_MS) return
          setAsking(false)
          onConfirm()
        }}
      >
        Delete?
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      title={disabled ? 'A voice note is being recorded on it' : label}
      disabled={disabled}
      onClick={() => {
        askedAt.current = Date.now()
        setAsking(true)
      }}
    >
      <Trash2 className="size-4" aria-hidden />
    </Button>
  )
}
