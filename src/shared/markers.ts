import type { Marker, PlayerState } from './types'

/** A point marker stays "current" for this long after its time. */
const POINT_SPAN_MS = 20_000

export function markerEnd(marker: Marker): number {
  return marker.kind === 'range' && marker.endMs !== null ? marker.endMs : marker.timeMs + POINT_SPAN_MS
}

export function byTime(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.timeMs - b.timeMs)
}

/** The marker the playhead is in: the latest one started and not yet over. */
export function currentMarker(markers: Marker[], positionMs: number): Marker | null {
  const started = byTime(markers).filter((marker) => marker.timeMs <= positionMs + 250)
  for (let i = started.length - 1; i >= 0; i--) {
    if (positionMs <= markerEnd(started[i])) return started[i]
  }
  return null
}

export function nextMarker(markers: Marker[], positionMs: number): Marker | null {
  return byTime(markers).find((marker) => marker.timeMs > positionMs + 500) ?? null
}

/** Pressing "previous" just after a marker starts goes to the one before it. */
export function previousMarker(markers: Marker[], positionMs: number): Marker | null {
  const before = byTime(markers).filter((marker) => marker.timeMs < positionMs - 1500)
  return before.at(-1) ?? null
}

/** Position now, extrapolated from the last report while playing. */
export function livePosition(player: PlayerState, now: number, durationMs: number): number {
  const position = player.playing ? player.positionMs + (now - player.sampledAt) * player.rate : player.positionMs
  return Math.max(0, Math.min(durationMs || position, position))
}
