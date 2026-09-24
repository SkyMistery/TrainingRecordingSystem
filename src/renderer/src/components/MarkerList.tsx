import { Flag, Mic, MoveHorizontal } from 'lucide-react'
import { mediaUrl } from '@shared/media'
import type { Marker, MarkerCategory } from '@shared/types'
import type { SendCommand } from '../commands'
import { formatDuration } from '../format'
import { ConfirmDeleteButton } from './ConfirmDeleteButton'
import { NoteItem } from './NoteItem'

const UNCATEGORISED = '#8b8ca9'

/** Colours of a marker's categories, in the order of the category list; grey when it has none. */
export function markerColors(categories: MarkerCategory[], categoryIds: string[]): string[] {
  const colors = categories.filter((category) => categoryIds.includes(category.id)).map((category) => category.color)
  return colors.length > 0 ? colors : [UNCATEGORISED]
}

/** CSS background: one colour, or equal stripes when a marker has several categories. */
export function paint(colors: string[], direction = '90deg'): string {
  if (colors.length === 1) return colors[0]
  const step = 100 / colors.length
  const stops = colors.map((color, i) => `${color} ${i * step}% ${(i + 1) * step}%`)
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

/** Coloured bar on the left edge of a marker card; the card needs `relative overflow-hidden`. */
export function CategoryStripe({ colors, width }: { colors: string[]; width: number }): React.JSX.Element {
  return (
    <span aria-hidden className="absolute inset-y-0 left-0" style={{ width, background: paint(colors, '180deg') }} />
  )
}

/** Category chips: each one toggles, so a marker can have several categories. */
export function CategoryChips({
  categories,
  selectedIds,
  label,
  onToggle,
  size = 'sm'
}: {
  categories: MarkerCategory[]
  selectedIds: string[]
  label: string
  onToggle: (categoryId: string) => void
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {categories.map((category) => {
        const selected = selectedIds.includes(category.id)
        return (
          <button
            key={category.id}
            aria-pressed={selected}
            onClick={() => onToggle(category.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border text-xs transition-colors ${
              size === 'md' ? 'px-2.5 py-1' : 'px-2 py-0.5'
            } ${selected ? 'border-transparent font-semibold' : 'border-border text-muted-foreground hover:text-foreground'}`}
            style={selected ? { backgroundColor: category.color, color: textOn(category.color) } : undefined}
          >
            {!selected && <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />}
            {category.name}
          </button>
        )
      })}
    </div>
  )
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
  dictatingMarkerId: string | null
  send: SendCommand
}

/** Newest first; each marker shows its screenshot, time, kind, category and voice notes. */
export function MarkerList(props: MarkerListProps): React.JSX.Element {
  if (props.markers.length === 0) {
    return <p className="text-sm text-muted-foreground">No markers yet.</p>
  }
  return (
    <ul className="flex flex-col gap-3">
      {[...props.markers].reverse().map((marker) => {
        const colors = markerColors(props.categories, marker.categoryIds)
        const open = marker.id === props.openRangeId
        return (
          <li
            key={marker.id}
            className="relative flex flex-col gap-2 overflow-hidden rounded-md border border-border bg-background p-2 pl-3 pr-3"
          >
            <CategoryStripe colors={colors} width={4} />
            {/* Screenshot with the header and categories beside it; notes below, full width on phones. */}
            <div className="flex items-start gap-3">
              <div className="aspect-video w-24 shrink-0 sm:w-36 overflow-hidden rounded-sm bg-fuselage-150 dark:bg-fuselage-800">
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
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
                  {marker.id === props.dictatingMarkerId && (
                    <span className="flex items-center gap-1 rounded-sm bg-atmos-700 px-1.5 py-0.5 text-xs font-semibold text-white dark:bg-atmos-500">
                      <Mic className="size-3 animate-pulse" aria-hidden />
                      Dictating
                    </span>
                  )}
                  <ConfirmDeleteButton
                    className="-my-2 ml-auto"
                    label={`Delete marker ${marker.number}`}
                    disabled={marker.id === props.dictatingMarkerId}
                    onConfirm={() => props.send('deleteMarker', props.folderName, marker.id)}
                  />
                </div>
                <CategoryChips
                  categories={props.categories}
                  selectedIds={marker.categoryIds}
                  label={`Categories of marker ${marker.number}`}
                  onToggle={(categoryId) => props.send('toggleMarkerCategory', props.folderName, marker.id, categoryId)}
                />
              </div>
            </div>
            {marker.notes.length > 0 && (
              <div className="flex flex-col gap-1.5 sm:pl-[9.75rem]">
                {marker.notes.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    folderName={props.folderName}
                    onTextChange={(text) => props.send('setNoteText', props.folderName, marker.id, note.id, text)}
                    onRetranscribe={() => props.send('retranscribeNote', props.folderName, marker.id, note.id)}
                    onDelete={() => props.send('deleteNote', props.folderName, marker.id, note.id)}
                  />
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
