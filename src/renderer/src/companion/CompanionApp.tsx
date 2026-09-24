import { useEffect, useState } from 'react'
import { Alert, Button } from '@ivao/atmosphere-react'
import {
  Circle,
  CircleAlert,
  FastForward,
  Flag,
  Mic,
  Moon,
  MoveHorizontal,
  Pause,
  Play,
  Rewind,
  SkipBack,
  SkipForward,
  Sun
} from 'lucide-react'
import { byTime, currentMarker, livePosition } from '@shared/markers'
import type { CompanionState, Marker, PlayerCommand, RecordingState, ReviewState } from '@shared/types'
import type { SendCommand } from '../commands'
import { MarkerList, categoryColor, markerTimeLabel, textOn } from '../components/MarkerList'
import { NoteItem } from '../components/NoteItem'
import { PlaybackRates } from '../components/PlaybackRates'
import { Timeline } from '../components/Timeline'
import { formatDuration } from '../format'
import { useNow } from '../hooks'
import { useCompanionConnection, type ConnectionStatus } from './connection'
import symbol from '../assets/it-symbol-white.svg'
import { AppFooter } from '../components/AppFooter'

/** Day/Night for the Companion page, remembered by this browser. */
function useCompanionTheme(): [boolean, () => void] {
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const [night, setNight] = useState(() => {
    try {
      const saved = localStorage.getItem('trs-theme')
      if (saved) return saved === 'night'
    } catch {
      // Storage unavailable: follow the device.
    }
    return system.matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', night)
  }, [night])
  const toggle = (): void =>
    setNight((value) => {
      try {
        localStorage.setItem('trs-theme', value ? 'day' : 'night')
      } catch {
        // Not remembered, still applied.
      }
      return !value
    })
  return [night, toggle]
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Reconnecting…',
  unpaired: 'Not paired'
}

function RecordingView({
  recording,
  state,
  send
}: {
  recording: RecordingState
  state: CompanionState
  send: SendCommand
}): React.JSX.Element {
  const now = useNow(true)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="size-3 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
        <span className="font-mono text-3xl tabular-nums">
          {formatDuration(recording.elapsedMs + (now - recording.sampledAt))}
        </span>
        <span className="text-sm text-muted-foreground">
          <span className="font-mono">{recording.metadata.position}</span> · trainee {recording.metadata.traineeVid}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button size="lg" variant="outline" className="h-16" onClick={() => send('addMarker')}>
          <Flag className="size-5" aria-hidden />
          Marker
        </Button>
        <Button size="lg" variant="outline" className="h-16" onClick={() => send('toggleRange')}>
          <MoveHorizontal className="size-5" aria-hidden />
          {recording.openRangeId ? 'End range' : 'Range'}
        </Button>
        <Button
          size="lg"
          variant={recording.dictatingMarkerId ? 'destructive' : 'outline'}
          className="h-16 touch-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            send('startNote')
          }}
          onPointerUp={() => send('stopNote')}
          onPointerCancel={() => send('stopNote')}
        >
          <Mic className="size-5" aria-hidden />
          {recording.dictatingMarkerId ? 'Release' : 'Hold: note'}
        </Button>
      </div>
      {state.voiceNoteHotkey && (
        <p className="-mt-2 text-xs text-muted-foreground">
          The note is recorded by the PC’s microphone. Push-to-talk on the PC: {state.voiceNoteHotkey}.
        </p>
      )}
      <MarkerList
        markers={recording.markers}
        categories={state.categories}
        folderName={recording.folderName}
        openRangeId={recording.openRangeId}
        dictatingMarkerId={recording.dictatingMarkerId}
        send={send}
      />
    </div>
  )
}

function MarkerDetail({
  marker,
  review,
  state,
  positionMs,
  send
}: {
  marker: Marker
  review: ReviewState
  state: CompanionState
  positionMs: number
  send: SendCommand
}): React.JSX.Element {
  const color = categoryColor(state.categories, marker.categoryId)
  const at = Math.round(positionMs)
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4"
      style={{ borderLeft: `6px solid ${color}` }}
      aria-label={`Marker ${marker.number}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-head text-xl font-semibold">#{marker.number}</span>
        <button
          className="font-mono text-lg underline-offset-4 hover:underline"
          onClick={() => send('playerCommand', { type: 'seek', positionMs: marker.timeMs })}
        >
          {markerTimeLabel(marker, null)}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {state.categories.map((category) => {
          const selected = marker.categoryId === category.id
          return (
            <button
              key={category.id}
              onClick={() => send('setMarkerCategory', review.folderName, marker.id, selected ? null : category.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${selected ? 'border-transparent font-semibold' : 'border-border text-muted-foreground'}`}
              style={selected ? { backgroundColor: category.color, color: textOn(category.color) } : undefined}
            >
              {category.name}
            </button>
          )
        })}
      </div>
      {marker.notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No voice notes on this marker.</p>
      ) : (
        <div className="flex flex-col gap-2 text-base">
          {marker.notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              folderName={review.folderName}
              onTextChange={(text) => send('setNoteText', review.folderName, marker.id, note.id, text)}
              onRetranscribe={() => send('retranscribeNote', review.folderName, marker.id, note.id)}
              onDelete={() => send('deleteNote', review.folderName, marker.id, note.id)}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {marker.kind === 'range' ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => send('setMarkerTimes', review.folderName, marker.id, { timeMs: at })}
            >
              Start at {formatDuration(at)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => send('setMarkerTimes', review.folderName, marker.id, { endMs: at })}
            >
              End at {formatDuration(at)}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => send('setMarkerTimes', review.folderName, marker.id, { timeMs: at })}
          >
            Move to {formatDuration(at)}
          </Button>
        )}
      </div>
    </section>
  )
}

function ReviewView({
  review,
  state,
  send
}: {
  review: ReviewState
  state: CompanionState
  send: SendCommand
}): React.JSX.Element {
  const now = useNow(review.player.playing, 200)
  const positionMs = livePosition(review.player, now, review.durationMs)
  const markers = byTime(review.markers)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const current = currentMarker(markers, positionMs)
  const shown = (follow ? current : markers.find((marker) => marker.id === selectedId)) ?? current
  const player = (command: PlayerCommand): void => send('playerCommand', command)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-head text-lg font-semibold">
          <span className="font-mono">{review.metadata.position}</span> · {review.metadata.trainingType}
        </div>
        <div className="text-sm text-muted-foreground">
          {review.metadata.date} · trainee {review.metadata.traineeVid}
          {review.metadata.traineeName && ` (${review.metadata.traineeName})`}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous marker"
          onClick={() => player({ type: 'marker', direction: -1 })}
        >
          <SkipBack className="size-4" aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Back 5 seconds"
          onClick={() => player({ type: 'skip', deltaMs: -5000 })}
        >
          <Rewind className="size-4" aria-hidden />
        </Button>
        <Button
          size="lg"
          aria-label={review.player.playing ? 'Pause' : 'Play'}
          onClick={() => player({ type: 'toggle' })}
        >
          {review.player.playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5" aria-hidden />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Forward 5 seconds"
          onClick={() => player({ type: 'skip', deltaMs: 5000 })}
        >
          <FastForward className="size-4" aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next marker"
          onClick={() => player({ type: 'marker', direction: 1 })}
        >
          <SkipForward className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="flex justify-center">
        <PlaybackRates rate={review.player.rate} onChange={(rate) => player({ type: 'rate', rate })} />
      </div>

      <Timeline
        durationMs={review.durationMs}
        positionMs={positionMs}
        markers={markers}
        categories={state.categories}
        currentMarkerId={shown?.id ?? null}
        onSeek={(ms) => player({ type: 'seek', positionMs: ms })}
      />

      <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
        Follow playback
      </label>

      {shown ? (
        <MarkerDetail marker={shown} review={review} state={state} positionMs={positionMs} send={send} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {markers.length ? 'No marker at this point: press ⏭ or pick one below.' : 'This session has no markers.'}
        </p>
      )}

      {markers.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="All markers">
          {markers.map((marker) => {
            const first = marker.notes[0]
            const text = first ? (first.text ?? first.transcript ?? '') : ''
            return (
              <li key={marker.id}>
                <button
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${marker.id === shown?.id ? 'bg-fuselage-100 dark:bg-fuselage-800' : ''}`}
                  onClick={() => {
                    setSelectedId(marker.id)
                    setFollow(false)
                    player({ type: 'seek', positionMs: marker.timeMs })
                  }}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: categoryColor(state.categories, marker.categoryId) }}
                  />
                  <span className="w-8 font-semibold">#{marker.number}</span>
                  <span className="w-28 shrink-0 font-mono text-xs">{markerTimeLabel(marker, null)}</span>
                  <span className="truncate text-muted-foreground">
                    {text || (marker.notes.length ? '…' : '')}
                    {marker.notes.length > 1 && ` (+${marker.notes.length - 1})`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function CompanionApp(): React.JSX.Element {
  const { status, state, send: request } = useCompanionConnection()
  const [night, toggleTheme] = useCompanionTheme()
  const [error, setError] = useState<string | null>(null)
  const send: SendCommand = (name, ...args) => {
    setError(null)
    request(name, ...args).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="flex min-h-full flex-col bg-body">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-atmos-700 px-4 py-3 text-white dark:bg-fuselage-800">
        <span className="flex items-center gap-2 font-head font-semibold">
          <img src={symbol} alt="IVAO Italy" className="size-7" />
          Trainer notes
        </span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-white/80">
            <Circle
              className={`size-2 ${status === 'connected' ? 'fill-semantic-green-500 text-semantic-green-500' : 'fill-semantic-yellow-500 text-semantic-yellow-500'}`}
              aria-hidden
            />
            {STATUS_TEXT[status]}
          </span>
          <button className="rounded-sm p-1 hover:bg-white/10" aria-label="Switch Day/Night" onClick={toggleTheme}>
            {night ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </button>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4">
        {error && <Alert variant="destructive" Icon={CircleAlert} title="Something went wrong" description={error} />}
        {status === 'unpaired' ? (
          <Alert
            Icon={CircleAlert}
            title="This device is not paired"
            description="Open Setup → Companion in the app and scan the QR code again."
          />
        ) : !state ? (
          <p className="text-sm text-muted-foreground">Connecting to Training Recording System…</p>
        ) : state.recording ? (
          <RecordingView recording={state.recording} state={state} send={send} />
        ) : state.review ? (
          <ReviewView key={state.review.folderName} review={state.review} state={state} send={send} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing to show yet: start a recording, or open a session for review in the app.
          </p>
        )}
      </main>
      <AppFooter />
    </div>
  )
}
