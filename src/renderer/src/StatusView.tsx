import { useEffect, useState } from 'react'
import type { MarkerFeedback } from '@shared/types'
import { formatDuration } from './format'
import { useAppState, useNow } from './hooks'
import { categoryColor, markerTimeLabel } from './components/MarkerList'
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
  const lastCategory = categories.find((category) => category.id === last?.categoryId)

  return (
    <div
      className={`flex h-full flex-col justify-center gap-1.5 border-2 bg-body px-4 transition-colors [-webkit-app-region:drag] ${
        flash === 'error' ? 'border-semantic-red-500' : flash ? 'border-atmos-500' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="size-3 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
        <span className="font-mono text-2xl font-medium tabular-nums">
          {formatDuration(recording.elapsedMs + (now - recording.sampledAt))}
        </span>
        <span className="ml-auto text-sm text-muted-foreground">
          {recording.markers.length} marker{recording.markers.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex h-5 items-center gap-2 truncate text-sm">
        {recording.dictatingMarkerId ? (
          <span className="flex items-center gap-2 font-semibold text-semantic-red-600">
            <span className="size-2.5 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
            Recording voice note — release to save
          </span>
        ) : flash ? (
          <span className="font-semibold">{FLASH_LABEL[flash]}</span>
        ) : recording.openRangeId ? (
          <span className="font-semibold text-semantic-red-600">Range open — press again to end it</span>
        ) : last ? (
          <>
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: categoryColor(categories, last.categoryId) }}
              aria-hidden
            />
            <span className="truncate">
              #{last.number} at {markerTimeLabel(last, recording.openRangeId)}
              {lastCategory && ` · ${lastCategory.name}`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No markers yet</span>
        )}
      </div>
    </div>
  )
}
