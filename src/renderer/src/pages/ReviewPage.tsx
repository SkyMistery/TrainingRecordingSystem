import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button } from '@ivao/atmosphere-react'
import {
  ArrowLeft,
  Expand,
  NotebookPen,
  Pause,
  Play,
  Shrink,
  SkipBack,
  SkipForward,
  VideoOff,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { mediaUrl } from '@shared/media'
import { byTime, currentMarker, nextMarker, previousMarker } from '@shared/markers'
import type { AppState, PlayerCommand, ReviewState } from '@shared/types'
import { markerColors, paint } from '../components/MarkerList'
import { PlaybackRates } from '../components/PlaybackRates'
import { SkipButton } from '../components/SkipButton'
import { Timeline } from '../components/Timeline'
import { useZoom } from '../components/useZoom'
import { formatDuration } from '../format'

const REPORT_INTERVAL_MS = 400

/**
 * The debriefing player. It never shows the trainer's notes, so this window
 * can be shared on Discord; notes live in the notes window / Companion page.
 */
export function ReviewPage({ state, review }: { state: AppState; review: ReviewState }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [positionMs, setPositionMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [videoDurationMs, setVideoDurationMs] = useState(0)
  const [theatre, setTheatre] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastReport = useRef(0)
  const markers = byTime(review.markers)
  const markersRef = useRef(markers)
  markersRef.current = markers
  const durationMs = videoDurationMs || review.durationMs
  const categories = state.markerSettings.categories
  const current = currentMarker(markers, positionMs)

  const report = useCallback((force: boolean) => {
    const element = video.current
    if (!element) return
    const now = Date.now()
    if (!force && now - lastReport.current < REPORT_INTERVAL_MS) return
    lastReport.current = now
    void window.api.reportPlayer({
      positionMs: Math.round(element.currentTime * 1000),
      playing: !element.paused,
      rate: element.playbackRate,
      sampledAt: now
    })
  }, [])

  const apply = useCallback((command: PlayerCommand) => {
    const element = video.current
    if (!element) return
    const seek = (ms: number): void => {
      if (!Number.isFinite(ms)) return // commands also come from Companion devices
      element.currentTime = Math.max(0, ms) / 1000
    }
    // play() is rejected when a pause interrupts it (quick double toggle): that is expected.
    const play = (): void => {
      element.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setError(String(error))
      })
    }
    const position = element.currentTime * 1000
    switch (command.type) {
      case 'toggle':
        if (element.paused) play()
        else element.pause()
        break
      case 'play':
        play()
        break
      case 'pause':
        element.pause()
        break
      case 'seek':
        seek(command.positionMs)
        break
      case 'skip':
        seek(position + command.deltaMs)
        break
      case 'marker': {
        const target =
          command.direction > 0
            ? nextMarker(markersRef.current, position)
            : previousMarker(markersRef.current, position)
        if (target) seek(target.timeMs)
        break
      }
      case 'rate':
        element.playbackRate = command.rate
        break
    }
  }, [])

  const { zoom, frameProps, zoomBy, reset: resetZoom } = useZoom(() => apply({ type: 'toggle' }))

  // Commands from the notes window and Companion devices.
  useEffect(() => window.api.onPlayerCommand(apply), [apply])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      // Dialogs (e.g. the Companion QR code) and focused controls keep their own keys.
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return
      if (
        (event.key === ' ' || event.key === 'Enter') &&
        target?.closest('button, [role="switch"], [role="slider"], select, a')
      )
        return
      const step = event.shiftKey ? 30_000 : 5_000
      const actions: Record<string, () => void> = {
        ' ': () => apply({ type: 'toggle' }),
        k: () => apply({ type: 'toggle' }),
        ArrowLeft: () => apply({ type: 'skip', deltaMs: -step }),
        ArrowRight: () => apply({ type: 'skip', deltaMs: step }),
        j: () => apply({ type: 'skip', deltaMs: -10_000 }),
        l: () => apply({ type: 'skip', deltaMs: 10_000 }),
        PageUp: () => apply({ type: 'marker', direction: -1 }),
        PageDown: () => apply({ type: 'marker', direction: 1 }),
        '[': () => apply({ type: 'marker', direction: -1 }),
        ']': () => apply({ type: 'marker', direction: 1 }),
        f: () => setTheatre((value) => !value),
        '+': () => zoomBy(1.5),
        '=': () => zoomBy(1.5),
        '-': () => zoomBy(1 / 1.5),
        '0': () => resetZoom(),
        Escape: () => setTheatre(false)
      }
      const action = actions[event.key]
      if (action) {
        event.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply, zoomBy, resetZoom])

  const { metadata } = review
  const src = mediaUrl(review.folderName, 'recording.mp4')

  const skip = (deltaMs: number): void => apply({ type: 'skip', deltaMs })

  const player = (
    <div className="flex flex-col gap-3">
      {review.hasRecording ? (
        <div
          {...frameProps}
          className={`relative mx-auto w-fit max-w-full overflow-hidden rounded-md bg-black ${zoom.scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
          title="Click: play/pause · Wheel: zoom · Drag: move · Double-click: reset zoom"
        >
          <video
            ref={video}
            src={src}
            className={`block origin-top-left ${theatre ? 'max-h-[calc(100vh-10rem)]' : 'max-h-[calc(100vh-19rem)]'}`}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
            onLoadedMetadata={(event) => {
              // A recording cut short by a crash can report an unknown (Infinity/NaN) duration.
              const seconds = event.currentTarget.duration
              setVideoDurationMs(Number.isFinite(seconds) ? seconds * 1000 : 0)
            }}
            onTimeUpdate={(event) => {
              setPositionMs(event.currentTarget.currentTime * 1000)
              report(false)
            }}
            onPlay={() => {
              setPlaying(true)
              report(true)
            }}
            onPause={() => {
              setPlaying(false)
              report(true)
            }}
            onSeeked={() => report(true)}
            onRateChange={(event) => {
              setRate(event.currentTarget.playbackRate)
              report(true)
            }}
            onError={() =>
              setError('The recording could not be played. It may still be finishing, or the file is missing.')
            }
          />
          {zoom.scale > 1 && (
            <span className="pointer-events-none absolute right-2 top-2 rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-xs text-white">
              {zoom.scale.toFixed(1)}×
            </span>
          )}
        </div>
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md bg-fuselage-100 text-muted-foreground dark:bg-fuselage-900">
          <VideoOff className="size-8" aria-hidden />
          This session has no recording.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous marker"
          title="Previous marker ( [ )"
          onClick={() => apply({ type: 'marker', direction: -1 })}
        >
          <SkipBack className="size-4" aria-hidden />
        </Button>
        <SkipButton seconds={-10} hint="J" onSkip={skip} />
        <SkipButton seconds={-5} hint="←" onSkip={skip} />
        <Button size="lg" aria-label={playing ? 'Pause' : 'Play'} onClick={() => apply({ type: 'toggle' })}>
          {playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5" aria-hidden />}
        </Button>
        <SkipButton seconds={5} hint="→" onSkip={skip} />
        <SkipButton seconds={10} hint="L" onSkip={skip} />
        <Button
          variant="outline"
          size="icon"
          aria-label="Next marker"
          title="Next marker ( ] )"
          onClick={() => apply({ type: 'marker', direction: 1 })}
        >
          <SkipForward className="size-4" aria-hidden />
        </Button>
        <div className="ml-4 flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            title="Zoom out (−)"
            onClick={() => zoomBy(1 / 1.5)}
          >
            <ZoomOut className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            title="Zoom in (+), or use the mouse wheel on the video"
            onClick={() => zoomBy(1.5)}
          >
            <ZoomIn className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="ml-2">
          <PlaybackRates rate={rate} onChange={(value) => apply({ type: 'rate', rate: value })} />
        </div>
      </div>

      <Timeline
        durationMs={durationMs}
        positionMs={positionMs}
        markers={markers}
        categories={categories}
        currentMarkerId={current?.id ?? null}
        onSeek={(ms) => apply({ type: 'seek', positionMs: ms })}
      />
    </div>
  )

  // One tree for both layouts: switching to full window only changes classes,
  // so the video element (position, zoom, wheel listener) is kept.
  return (
    <div className="flex flex-col gap-4">
      {!theatre && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => void window.api.closeReview()}>
              <ArrowLeft className="size-4" aria-hidden />
              Sessions
            </Button>
            <div>
              <div className="font-head text-lg font-semibold">
                <span className="font-mono">{metadata.position}</span> · {metadata.trainingType}
              </div>
              <div className="text-sm text-muted-foreground">
                {metadata.date} · trainee {metadata.traineeVid}
                {metadata.traineeName && ` (${metadata.traineeName})`}
              </div>
              <div className="text-xs text-muted-foreground">
                Share this window only with the trainee. Don’t publish the recording.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void window.api.openNotesWindow()}
              title="Your notes, on another monitor"
            >
              <NotebookPen className="size-4" aria-hidden />
              Notes window
            </Button>
            <Button variant="outline" onClick={() => setTheatre(true)} title="Full window (F)">
              <Expand className="size-4" aria-hidden />
              Full window
            </Button>
          </div>
        </div>
      )}

      {error && <Alert variant="destructive" title="Playback problem" description={error} />}

      <div
        className={
          theatre
            ? 'fixed inset-0 z-50 flex flex-col justify-center gap-3 bg-body p-6'
            : 'rounded-lg border border-border bg-card p-6 shadow-xs'
        }
      >
        {player}
        {theatre && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setTheatre(false)}>
              <Shrink className="size-4" aria-hidden />
              Exit full window (Esc)
            </Button>
          </div>
        )}
      </div>

      {!theatre && markers.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-2" aria-label="Markers">
          {markers.map((marker) => {
            const active = marker.id === current?.id
            return (
              <button
                key={marker.id}
                onClick={() => apply({ type: 'seek', positionMs: marker.timeMs })}
                className={`flex w-44 shrink-0 flex-col gap-1.5 rounded-md border-2 bg-background p-1.5 text-left transition-colors ${
                  active ? 'border-atmos-700 dark:border-fuselage-50' : 'border-transparent hover:border-border'
                }`}
              >
                <div className="aspect-video w-full overflow-hidden rounded-sm bg-fuselage-150 dark:bg-fuselage-800">
                  {marker.screenshot && (
                    <img
                      src={mediaUrl(review.folderName, marker.screenshot)}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5 px-0.5 text-xs">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: paint(markerColors(categories, marker.categoryIds)) }}
                  />
                  <span className="font-semibold">#{marker.number}</span>
                  <span className="font-mono text-muted-foreground">
                    {formatDuration(marker.timeMs)}
                    {marker.kind === 'range' && marker.endMs !== null && `–${formatDuration(marker.endMs)}`}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {!theatre && (
        <p className="text-center text-xs text-muted-foreground">
          Space play/pause · ← → 5 s (Shift: 30 s) · [ ] previous/next marker · wheel or + − zoom, 0 reset · F full
          window. Your notes are not shown here: open the notes window on another monitor, or the Companion page on a
          tablet.
        </p>
      )}
    </div>
  )
}
