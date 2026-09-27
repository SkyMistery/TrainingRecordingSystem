import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button } from '@ivao/atmosphere-react'
import {
  Circle,
  CircleAlert,
  Flag,
  Headphones,
  Mic,
  Moon,
  MoveHorizontal,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sun,
  TowerControl
} from 'lucide-react'
import { byTime, currentMarker, livePosition, recordingTime } from '@shared/markers'
import type { CompanionState, Marker, PlayerCommand, PttTarget, RecordingState, ReviewState } from '@shared/types'
import type { SendCommand } from '../commands'
import {
  CategoryChips,
  CategoryStripe,
  MarkerList,
  markerColors,
  markerTimeLabel,
  paint
} from '../components/MarkerList'
import { ConfirmDeleteButton } from '../components/ConfirmDeleteButton'
import { NoteItem } from '../components/NoteItem'
import { PlaybackRates } from '../components/PlaybackRates'
import { RecordingWarnings } from '../components/RecordingWarnings'
import { SkipButton } from '../components/SkipButton'
import { Timeline } from '../components/Timeline'
import { formatDuration } from '../format'
import { useNow } from '../hooks'
import { useCompanionConnection, type ConnectionStatus } from './connection'
import logo from '../assets/trs-logo.svg'
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

/**
 * The notes window on the trainer's PC shows this page too: a voice note played
 * there comes out of the PC, into the recording (desktop audio) or a shared screen.
 */
const ON_THIS_PC = /Electron\//.test(navigator.userAgent)

const PTT_BUTTONS: Record<PttTarget, { name: string; Icon: typeof Mic }> = {
  voiceChat: { name: 'Voice chat', Icon: Headphones },
  aurora: { name: 'Aurora', Icon: TowerControl }
}

/** While a button is held the app is told again this often; it lets go if that stops (see the app's keep-alive). */
const PTT_KEEPALIVE_MS = 1000

/**
 * Hold to talk: the PC holds the voice chat's or Aurora's push-to-talk key
 * meanwhile. The button shows what the PC really does, not only the finger.
 */
function PttButtons({
  state,
  deviceId,
  connected,
  request,
  onError
}: {
  state: CompanionState
  deviceId: string | null
  connected: boolean
  request: (name: 'holdPtt' | 'releasePtt', target: PttTarget) => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element | null {
  // Buttons under the finger right now.
  const [pressed, setPressed] = useState<PttTarget[]>([])
  const pressedRef = useRef(pressed)
  pressedRef.current = pressed

  const release = useCallback(
    (target: PttTarget) => {
      setPressed((current) => current.filter((item) => item !== target))
      void request('releasePtt', target).catch(() => undefined)
    },
    [request]
  )
  const hold = useCallback(
    (target: PttTarget) =>
      request('holdPtt', target).catch((error: unknown) => {
        // Refused (a recording isn't open, the time limit, another device…): stop asking.
        setPressed((current) => current.filter((item) => item !== target))
        onError(error instanceof Error ? error.message : String(error))
      }),
    [request, onError]
  )

  // "Still holding" every second: a locked phone or a lost Wi-Fi stops it, and the PC lets go.
  useEffect(() => {
    if (pressed.length === 0) return
    const timer = window.setInterval(() => pressedRef.current.forEach((target) => void hold(target)), PTT_KEEPALIVE_MS)
    return () => window.clearInterval(timer)
  }, [pressed.length, hold])

  // The page goes to the background (home button, a call, the screen off): let go at once.
  useEffect(() => {
    const releaseAll = (): void => pressedRef.current.forEach(release)
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') releaseAll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', releaseAll)
    window.addEventListener('blur', releaseAll)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', releaseAll)
      window.removeEventListener('blur', releaseAll)
    }
  }, [release])

  if (state.pttKeys.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-2">
      {state.pttKeys.map(({ target, label }) => {
        const { name, Icon } = PTT_BUTTONS[target]
        const holder = state.pttHolds.find((item) => item.target === target)
        const mine = holder !== undefined && holder.deviceId === deviceId
        const finger = pressed.includes(target)
        const text = mine
          ? `Talking: ${name}`
          : holder
            ? `Held on ${holder.deviceName}`
            : finger
              ? 'Pressing…'
              : `Hold: ${name}`
        return (
          <Button
            key={target}
            size="lg"
            variant={mine ? 'destructive' : 'outline'}
            className="h-16 touch-none select-none"
            disabled={!connected || (holder !== undefined && !mine)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setPressed((current) => (current.includes(target) ? current : [...current, target]))
              void hold(target)
            }}
            onPointerUp={() => release(target)}
            onPointerCancel={() => release(target)}
            onLostPointerCapture={() => pressedRef.current.includes(target) && release(target)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <Icon className="size-5" aria-hidden />
            <span className="flex flex-col items-start leading-tight">
              {text}
              <span className="text-xs font-normal opacity-70">{label}</span>
            </span>
          </Button>
        )
      })}
    </div>
  )
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
  send,
  clockOffsetMs
}: {
  recording: RecordingState
  state: CompanionState
  send: SendCommand
  clockOffsetMs: number
}): React.JSX.Element {
  // The app's clock: this device's may be off by seconds.
  const now = useNow(true) + clockOffsetMs
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="size-3 animate-pulse rounded-full bg-semantic-red-500" aria-hidden />
        <span className="font-mono text-3xl tabular-nums">{formatDuration(recordingTime(recording, now))}</span>
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
      <RecordingWarnings hiddenWindowsError={state.hiddenWindowsError} warnings={recording.warnings} />
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
        notesPlayable={!ON_THIS_PC}
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
  const colors = markerColors(state.categories, marker.categoryIds)
  const at = Math.round(positionMs)
  return (
    <section
      className="relative flex flex-col gap-3 overflow-hidden rounded-lg border border-border bg-background p-4 pl-6"
      aria-label={`Marker ${marker.number}`}
    >
      <CategoryStripe colors={colors} width={6} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-head text-xl font-semibold">#{marker.number}</span>
        <button
          className="font-mono text-lg underline-offset-4 hover:underline"
          onClick={() => send('playerCommand', { type: 'seek', positionMs: marker.timeMs })}
        >
          {markerTimeLabel(marker, null)}
        </button>
        <ConfirmDeleteButton
          className="ml-auto"
          label={`Delete marker ${marker.number}`}
          onConfirm={() => send('deleteMarker', review.folderName, marker.id)}
        />
      </div>
      <CategoryChips
        categories={state.categories}
        selectedIds={marker.categoryIds}
        label={`Categories of marker ${marker.number}`}
        size="md"
        onToggle={(categoryId) => send('toggleMarkerCategory', review.folderName, marker.id, categoryId)}
      />
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
  send,
  clockOffsetMs
}: {
  review: ReviewState
  state: CompanionState
  send: SendCommand
  clockOffsetMs: number
}): React.JSX.Element {
  // The app's clock: at 10x a second of difference would be ten seconds of video.
  const now = useNow(review.player.playing, 200) + clockOffsetMs
  const positionMs = livePosition(review.player, now, review.durationMs)
  const markers = byTime(review.markers)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const current = currentMarker(markers, positionMs)
  const shown = (follow ? current : markers.find((marker) => marker.id === selectedId)) ?? current
  const player = (command: PlayerCommand): void => send('playerCommand', command)
  const skip = (deltaMs: number): void => player({ type: 'skip', deltaMs })

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

      {/* A grid, so the seven buttons shrink to fit a phone. */}
      <div className="mx-auto grid w-full max-w-md grid-cols-[auto_1fr_1fr_1.5fr_1fr_1fr_auto] items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous marker"
          onClick={() => player({ type: 'marker', direction: -1 })}
        >
          <SkipBack className="size-4" aria-hidden />
        </Button>
        <SkipButton seconds={-10} className="w-full px-0" onSkip={skip} />
        <SkipButton seconds={-5} className="w-full px-0" onSkip={skip} />
        <Button
          size="lg"
          className="w-full px-0"
          aria-label={review.player.playing ? 'Pause' : 'Play'}
          onClick={() => player({ type: 'toggle' })}
        >
          {review.player.playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5" aria-hidden />}
        </Button>
        <SkipButton seconds={5} className="w-full px-0" onSkip={skip} />
        <SkipButton seconds={10} className="w-full px-0" onSkip={skip} />
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
      {ON_THIS_PC && (
        <p className="text-xs text-muted-foreground">
          Voice notes played here come out of this PC: if you share Training Recording System on Discord with its sound,
          the trainee hears them. Listen on a phone or tablet, or share without sound.
        </p>
      )}

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
                    style={{ background: paint(markerColors(state.categories, marker.categoryIds)) }}
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
  const { status, state, deviceId, clockOffsetMs, send: request } = useCompanionConnection()
  const pttRequest = useCallback(
    (name: 'holdPtt' | 'releasePtt', target: PttTarget) => request(name, target),
    [request]
  )
  const showError = useCallback((message: string) => setError(message), [])
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
          <img src={logo} alt="Training Recording System" className="size-7" />
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
        {status !== 'unpaired' && state && (
          <PttButtons
            state={state}
            deviceId={deviceId}
            connected={status === 'connected'}
            request={pttRequest}
            onError={showError}
          />
        )}
        {status === 'unpaired' ? (
          <Alert
            Icon={CircleAlert}
            title="This device is not paired"
            description="Open Setup → Companion in the app and scan the QR code again."
          />
        ) : !state ? (
          <p className="text-sm text-muted-foreground">Connecting to Training Recording System…</p>
        ) : state.recording ? (
          <RecordingView recording={state.recording} state={state} send={send} clockOffsetMs={clockOffsetMs} />
        ) : state.review ? (
          <ReviewView
            key={state.review.folderName}
            review={state.review}
            state={state}
            send={send}
            clockOffsetMs={clockOffsetMs}
          />
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
