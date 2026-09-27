import { useEffect, useState } from 'react'
import type { MarkerFeedback } from '@shared/types'
import { recordingTime } from '@shared/markers'
import { formatDuration } from './format'
import { useAppState, useNow } from './hooks'
import { markerColors, paint, markerTimeLabel } from './components/MarkerList'
import { useTheme } from './useTheme'

const FLASH_LABEL: Record<MarkerFeedback, string> = {
  marker: 'Marker added',
  rangeStart: 'Range started',
  rangeEnd: 'Range ended',
  category: 'Category set',
  noteStart: 'Recording voice note…',
  noteEnd: 'Voice note saved',
  error: 'Something went wrong'
}

/**
 * Compact always-on-top window shown while recording. It never takes focus,
 * so it can sit next to Aurora; drag it anywhere by its body.
 */
export function StatusView(): React.JSX.Element {
  useTheme()
  const state = useAppState()
  const recording = state?.recording ?? null
  const now = useNow(recording !== null)
  const [flash, setFlash] = useState<MarkerFeedback | null>(null)

  useEffect(
    () =>
      window.api.onMarkerFeedback((kind) => {
        setFlash(kind)
        window.setTimeout(() => setFlash((current) => (current === kind ? null : current)), 1500)
      }),
    []
  )

  if (!state || !recording) {
    return <div className="h-full bg-body" />
  }
  const last = recording.markers.at(-1)
  const categories = state.markerSettings.categories
  const lastCategories = categories.filter((category) => last?.categoryIds.includes(category.id))
  // Shown until it is fixed: the trainer may not be looking at the main window.
  const problem = state.hiddenWindowsError
    ? 'Private windows NOT covered — see the app'
    : recording.warnings.length > 0
      ? `${recording.warnings.at(-1)}`
      : null

  return (
    <div
      className={`flex h-full flex-col justify-center gap-1.5 border-2 bg-body px-4 transition-colors [-webkit-app-region:drag] ${
        flash === 'error' || state.hiddenWindowsError
          ? 'border-semantic-red-500'
          : flash
            ? 'border-atmos-500'
            : 'border-border'
      }`}
      title={problem ?? undefined}
    >
      <div className="flex items-center gap-3">
        <span className="size-3 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
        <span className="font-mono text-2xl font-medium tabular-nums">
          {formatDuration(recordingTime(recording, now))}
        </span>
        <span className="ml-auto text-right text-sm leading-tight text-muted-foreground">
          {recording.markers.length} marker{recording.markers.length === 1 ? '' : 's'}
          {state.transcription.queued > 0 && (
            <span className="block text-xs">{state.transcription.queued} to transcribe</span>
          )}
        </span>
      </div>
      <div className="flex h-5 items-center gap-2 truncate text-sm">
        {state.pttHolds.length > 0 ? (
          <span className="truncate font-semibold text-semantic-red-600">
            Talking: {state.pttHolds.map((hold) => (hold.target === 'aurora' ? 'Aurora' : 'voice chat')).join(', ')} ·{' '}
            {state.pttHolds[0].deviceName}
          </span>
        ) : state.hiddenWindowsError ? (
          <span className="truncate font-semibold text-semantic-red-600">{problem}</span>
        ) : recording.dictatingMarkerId ? (
          <span className="flex items-center gap-2 font-semibold text-semantic-red-600">
            <span className="size-2.5 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
            Recording voice note — release to save
          </span>
        ) : flash ? (
          <span className="font-semibold">{FLASH_LABEL[flash]}</span>
        ) : recording.openRangeId ? (
          <span className="font-semibold text-semantic-red-600">Range open — press again to end it</span>
        ) : problem ? (
          <span className="truncate font-semibold text-semantic-red-600">⚠ {problem}</span>
        ) : last ? (
          <>
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: paint(markerColors(categories, last.categoryIds)) }}
              aria-hidden
            />
            <span className="truncate">
              #{last.number} at {markerTimeLabel(last, recording.openRangeId)}
              {lastCategories.length > 0 && ` · ${lastCategories.map((category) => category.name).join(', ')}`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No markers yet</span>
        )}
      </div>
    </div>
  )
}
