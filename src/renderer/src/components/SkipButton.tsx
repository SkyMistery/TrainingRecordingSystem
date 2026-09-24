import { Button } from '@ivao/atmosphere-react'
import { FastForward, Rewind } from 'lucide-react'

/** Jumps back (negative) or forward by some seconds; shared by the review player and the notes window. */
export function SkipButton({
  seconds,
  hint,
  className,
  onSkip
}: {
  seconds: number
  /** Keyboard shortcut shown in the tooltip. */
  hint?: string
  className?: string
  onSkip: (deltaMs: number) => void
}): React.JSX.Element {
  const back = seconds < 0
  const amount = Math.abs(seconds)
  const Icon = back ? Rewind : FastForward
  return (
    <Button
      variant="outline"
      className={`gap-1 ${className || 'px-2.5'}`}
      aria-label={`${back ? 'Back' : 'Forward'} ${amount} seconds`}
      title={`${back ? 'Back' : 'Forward'} ${amount} s${hint ? ` (${hint})` : ''}`}
      onClick={() => onSkip(seconds * 1000)}
    >
      {back && <Icon className="size-4" aria-hidden />}
      <span className="font-mono text-xs">{amount}</span>
      {!back && <Icon className="size-4" aria-hidden />}
    </Button>
  )
}
