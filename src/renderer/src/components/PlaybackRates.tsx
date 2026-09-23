export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2]

/** Playback speed buttons, shared by the review player and the notes window. */
export function PlaybackRates({
  rate,
  onChange
}: {
  rate: number
  onChange: (rate: number) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Playback speed">
      {PLAYBACK_RATES.map((value) => (
        <button
          key={value}
          role="radio"
          aria-checked={rate === value}
          aria-label={`${value}× speed`}
          onClick={() => onChange(value)}
          className={`rounded-sm px-2 py-1 font-mono text-xs ${
            rate === value
              ? 'bg-atmos-700 text-white dark:bg-fuselage-50 dark:text-fuselage-800'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {value}×
        </button>
      ))}
    </div>
  )
}
