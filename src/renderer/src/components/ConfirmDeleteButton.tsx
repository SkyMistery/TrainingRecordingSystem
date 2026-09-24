import { useEffect, useState } from 'react'
import { Button } from '@ivao/atmosphere-react'
import { Trash2 } from 'lucide-react'

/** How long the confirmation stays up before the button goes back to the icon. */
const CONFIRM_MS = 4000

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
        onClick={() => {
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
      onClick={() => setAsking(true)}
    >
      <Trash2 className="size-4" aria-hidden />
    </Button>
  )
}
