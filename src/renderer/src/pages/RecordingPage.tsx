import { memo, useCallback, useState } from 'react'
import { Alert, Button, CardContent, CardDescription, CardHeader, CardRoot, CardTitle } from '@ivao/atmosphere-react'
import { CircleAlert, Flag, Mic, MoveHorizontal, Square } from 'lucide-react'
import type { AppState, RecordingState } from '@shared/types'
import type { SendCommand } from '../commands'
import { AudioMixer } from '../components/AudioMixer'
import { MarkerList } from '../components/MarkerList'
import { RecordingWarnings } from '../components/RecordingWarnings'
import { recordingTime } from '@shared/markers'
import { formatDuration } from '../format'
import { useNow } from '../hooks'

/** The clock ticks four times a second: only this part re-renders, not the marker list. */
const ElapsedTime = memo(function ElapsedTime({ recording }: { recording: RecordingState }): React.JSX.Element {
  const now = useNow(true)
  return (
    <div className="font-mono text-5xl font-medium tabular-nums" aria-label="Elapsed time">
      {formatDuration(recordingTime(recording, now))}
      {recording.paused && <span className="ml-3 align-middle text-base text-semantic-yellow-700">Paused in OBS</span>}
    </div>
  )
})

const Markers = memo(MarkerList)

export function RecordingPage({ state, recording }: { state: AppState; recording: RecordingState }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { metadata } = recording
  const { hotkeys } = state.markerSettings

  const run = useCallback((action: () => Promise<void>): void => {
    setError(null)
    action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  // Stable, so the marker list only re-renders when the markers change.
  const send = useCallback<SendCommand>((name, ...args) => run(() => window.api.command(name, ...args)), [run])

  return (
    <div className="flex flex-col gap-6">
      <CardRoot>
        <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
          <div className="flex items-center gap-5">
            <span className="relative flex size-4" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-semantic-red-500 opacity-60" />
              <span className="relative inline-flex size-4 rounded-full bg-semantic-red-500" />
            </span>
            <div>
              <ElapsedTime recording={recording} />
              <div className="mt-1 text-sm text-muted-foreground">
                <span className="font-mono">{metadata.position}</span> · {metadata.trainingType} · trainee{' '}
                {metadata.traineeVid}
                {metadata.traineeName && ` (${metadata.traineeName})`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {confirming ? (
              <>
                <span className="text-sm text-muted-foreground">Stop the recording?</span>
                <Button variant="outline" onClick={() => setConfirming(false)}>
                  Keep recording
                </Button>
                <Button
                  variant="destructive"
                  isLoading={state.busy}
                  onClick={() => run(() => window.api.stopSession())}
                >
                  <Square className="size-4 fill-current" aria-hidden />
                  Stop
                </Button>
              </>
            ) : (
              <Button variant="destructive" size="lg" onClick={() => setConfirming(true)}>
                <Square className="size-4 fill-current" aria-hidden />
                Stop recording
              </Button>
            )}
          </div>
        </CardContent>
      </CardRoot>

      <RecordingWarnings hiddenWindowsError={state.hiddenWindowsError} warnings={recording.warnings} />
      {error && <Alert variant="destructive" Icon={CircleAlert} title="Something went wrong" description={error} />}
      {state.microphoneError && (
        <Alert
          variant="destructive"
          Icon={CircleAlert}
          title="Voice notes: microphone problem"
          description={`${state.microphoneError} Check the microphone in Setup → Voice notes.`}
        />
      )}

      <CardRoot>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Markers</CardTitle>
            <CardDescription>
              Hotkeys: marker {hotkeys.marker?.label ?? '(not set)'} · range {hotkeys.range?.label ?? '(not set)'} ·
              voice note {hotkeys.voiceNote?.label ?? '(not set)'} (hold). Markers are placed{' '}
              {state.markerSettings.preRollSeconds} s before the key press.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant={recording.dictatingMarkerId ? 'primary' : 'outline'}
              title="Hold to dictate a voice note"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                send('startNote')
              }}
              onPointerUp={() => send('stopNote')}
              onPointerCancel={() => send('stopNote')}
            >
              <Mic className="size-4" aria-hidden />
              {recording.dictatingMarkerId ? 'Release to save' : 'Hold to dictate'}
            </Button>
            <Button variant="outline" onClick={() => send('addMarker')}>
              <Flag className="size-4" aria-hidden />
              Add marker
            </Button>
            <Button variant="outline" onClick={() => send('toggleRange')}>
              <MoveHorizontal className="size-4" aria-hidden />
              {recording.openRangeId ? 'End range' : 'Start range'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Markers
            markers={recording.markers}
            categories={state.markerSettings.categories}
            folderName={recording.folderName}
            openRangeId={recording.openRangeId}
            dictatingMarkerId={recording.dictatingMarkerId}
            send={send}
            // On this PC a note would play into the recording (desktop audio) and the voice chat.
            notesPlayable={false}
          />
        </CardContent>
      </CardRoot>

      <CardRoot>
        <CardHeader>
          <CardTitle>Audio</CardTitle>
        </CardHeader>
        <CardContent>
          <AudioMixer
            sources={state.capture.audioSources}
            onMutedChange={(id, muted) => run(() => window.api.setSourceMuted(id, muted))}
          />
        </CardContent>
      </CardRoot>
    </div>
  )
}
