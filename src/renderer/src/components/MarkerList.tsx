import { Button } from '@ivao/atmosphere-react'
import { Flag, MoveHorizontal, Trash2 } from 'lucide-react'
import { mediaUrl } from '@shared/media'
import type { Marker, MarkerCategory } from '@shared/types'
import { formatDuration } from '../format'

const UNCATEGORISED = '#8b8ca9'

export function categoryColor(categories: MarkerCategory[], categoryId: string | null): string {
  return categories.find((category) => category.id === categoryId)?.color ?? UNCATEGORISED
}

/** Dark text on light category colours (e.g. yellow), white otherwise. */
export function textOn(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#21212e' : '#ffffff'
}

export function markerTimeLabel(marker: Marker, openRangeId: string | null): string {
  if (marker.kind === 'point') return formatDuration(marker.timeMs)
  const end = marker.id === openRangeId ? '…' : marker.endMs !== null ? formatDuration(marker.endMs) : '?'
  return `${formatDuration(marker.timeMs)} – ${end}`
}

interface MarkerListProps {
  markers: Marker[]
  categories: MarkerCategory[]
  folderName: string
  openRangeId: string | null
  onCategoryChange: (markerId: string, categoryId: string | null) => void
  onDelete: (markerId: string) => void
}

/** Newest first; each marker shows its screenshot, time, kind and category. */
export function MarkerList(props: MarkerListProps): React.JSX.Element {
  if (props.markers.length === 0) {
    return <p className="text-sm text-muted-foreground">No markers yet.</p>
  }
  return (
    <ul className="flex flex-col gap-3">
      {[...props.markers].reverse().map((marker) => {
        const color = categoryColor(props.categories, marker.categoryId)
        const open = marker.id === props.openRangeId
        return (
          <li
            key={marker.id}
            className="flex items-center gap-4 rounded-md border border-border bg-background p-2 pr-3"
            style={{ borderLeft: `4px solid ${color}` }}
          >
            <div className="aspect-video w-36 shrink-0 overflow-hidden rounded-sm bg-fuselage-150 dark:bg-fuselage-800">
              {marker.screenshot && (
                <img
                  src={mediaUrl(props.folderName, marker.screenshot)}
                  alt={`Screenshot of marker ${marker.number}`}
                  className="size-full object-cover"
                  loading="lazy"
                />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-2 text-sm">
                {marker.kind === 'range' ? (
                  <MoveHorizontal className="size-4 text-muted-foreground" aria-label="Range" />
                ) : (
                  <Flag className="size-4 text-muted-foreground" aria-label="Marker" />
                )}
                <span className="font-semibold">#{marker.number}</span>
                <span className="font-mono tabular-nums">{markerTimeLabel(marker, props.openRangeId)}</span>
                {open && (
                  <span className="rounded-sm bg-semantic-red-500 px-1.5 py-0.5 text-xs font-semibold text-white">
                    Open range
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Category of marker ${marker.number}`}>
                {props.categories.map((category) => {
                  const selected = marker.categoryId === category.id
                  return (
                    <button
                      key={category.id}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => props.onCategoryChange(marker.id, selected ? null : category.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        selected
                          ? 'border-transparent font-semibold'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                      style={selected ? { backgroundColor: category.color, color: textOn(category.color) } : undefined}
                    >
                      {!selected && <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />}
                      {category.name}
                    </button>
                  )
                })}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete marker ${marker.number}`}
              onClick={() => props.onDelete(marker.id)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
