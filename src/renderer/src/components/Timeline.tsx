import { useRef, useState } from 'react'
import type { Marker, MarkerCategory } from '@shared/types'
import { formatDuration } from '../format'
import { markerColors, paint, textOn } from './MarkerList'

interface TimelineProps {
  durationMs: number
  positionMs: number
  markers: Marker[]
  categories: MarkerCategory[]
  currentMarkerId: string | null
  onSeek: (positionMs: number) => void
}

/**
 * Recording timeline: ranges as coloured bands, point markers as numbered
 * pins, click or drag to seek.
 */
export function Timeline(props: TimelineProps): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const duration = Math.max(1, props.durationMs)
  const pct = (ms: number): string => `${(Math.min(duration, Math.max(0, ms)) / duration) * 100}%`

  const timeAt = (clientX: number): number => {
    const rect = track.current!.getBoundingClientRect()
    return Math.round(((clientX - rect.left) / rect.width) * duration)
  }

  return (
    <div className="flex flex-col gap-1 select-none">
      <div
        ref={track}
        role="slider"
        tabIndex={-1}
        aria-label="Recording position"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={props.positionMs}
        aria-valuetext={formatDuration(props.positionMs)}
        className="relative h-14 cursor-pointer"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          props.onSeek(timeAt(event.clientX))
        }}
        onPointerMove={(event) => {
          setHover(timeAt(event.clientX))
          if (event.buttons === 1) props.onSeek(timeAt(event.clientX))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {/* Track (ranges are drawn as bands just above it) */}
        <div className="absolute inset-x-0 top-7 h-2 rounded-full bg-fuselage-200 dark:bg-fuselage-700" />
        <div
          className="absolute left-0 top-7 h-2 rounded-full bg-atmos-700/40 dark:bg-fuselage-400/50"
          style={{ width: pct(props.positionMs) }}
        />

        {props.markers.map((marker) => {
          const colors = markerColors(props.categories, marker.categoryIds)
          const current = marker.id === props.currentMarkerId
          return (
            <div key={marker.id}>
              {marker.kind === 'range' && marker.endMs !== null && (
                <div
                  className="absolute top-[15px] h-2 rounded-full"
                  style={{
                    left: pct(marker.timeMs),
                    width: `max(4px, calc(${pct(marker.endMs)} - ${pct(marker.timeMs)}))`,
                    background: paint(colors)
                  }}
                />
              )}
              <button
                className={`absolute top-0 flex -translate-x-1/2 flex-col items-center ${current ? 'z-10' : ''}`}
                style={{ left: pct(marker.timeMs) }}
                title={`#${marker.number} · ${formatDuration(marker.timeMs)}`}
                aria-label={`Go to marker ${marker.number}`}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  props.onSeek(marker.timeMs)
                }}
              >
                <span
                  className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold ${
                    current ? 'ring-2 ring-foreground ring-offset-1 ring-offset-body' : ''
                  }`}
                  style={{ background: paint(colors), color: textOn(colors[0]) }}
                >
                  {marker.number}
                </span>
                <span className="h-6 w-0.5" style={{ background: paint(colors, '180deg') }} />
              </button>
            </div>
          )
        })}

        {/* Playhead */}
        <div
          className="pointer-events-none absolute top-3 h-9 w-1 -translate-x-1/2 rounded-full bg-atmos-700 dark:bg-fuselage-50"
          style={{ left: pct(props.positionMs) }}
        />
        {hover !== null && (
          <div
            className="pointer-events-none absolute -bottom-1 -translate-x-1/2 rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[10px] text-body"
            style={{ left: pct(hover) }}
          >
            {formatDuration(hover)}
          </div>
        )}
      </div>
      <div className="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
        <span>{formatDuration(props.positionMs)}</span>
        <span>{formatDuration(props.durationMs)}</span>
      </div>
    </div>
  )
}
