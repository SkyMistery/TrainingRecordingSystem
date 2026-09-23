import { useState } from 'react'
import { Alert, Button, CardContent, CardDescription, CardHeader, CardRoot, CardTitle } from '@ivao/atmosphere-react'
import { CircleAlert, Flag, MoveHorizontal, Square } from 'lucide-react'
import type { AppState, RecordingState } from '@shared/types'
import { AudioMixer } from '../components/AudioMixer'
import { MarkerList } from '../components/MarkerList'
import { formatDuration } from '../format'
import { useAudioLevels, useNow } from '../hooks'

export function RecordingPage({ state, recording }: { state: AppState; recording: RecordingState }): React.JSX.Element {
  const now = useNow(true)
  const levels = useAudioLevels()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const elapsed = recording.elapsedMs + (now - recording.sampledAt)
  const { metadata } = recording
  const { hotkeys } = state.markerSettings

  const run = (action: () => Promise<void>): void => {
    setError(null)
    action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

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
              <div className="font-mono text-5xl font-medium tabular-nums" aria-label="Elapsed time">
                {formatDuration(elapsed)}
              </div>
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
                <Button variant="destructive" isLoading={state.busy} onClick={() => run(() => window.api.stopSession())}>
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

      {error && <Alert variant="destructive" Icon={CircleAlert} title="Something went wrong" description={error} />}

      <CardRoot>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Markers</CardTitle>
            <CardDescription>
              Hotkeys: marker {hotkeys.marker?.label ?? '(not set)'} · range {hotkeys.range?.label ?? '(not set)'}.
              Markers are placed {state.markerSettings.preRollSeconds} s before the key press.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => run(() => window.api.addMarker())}>
              <Flag className="size-4" aria-hidden />
              Add marker
            </Button>
            <Button variant="outline" onClick={() => run(() => window.api.toggleRange())}>
              <MoveHorizontal className="size-4" aria-hidden />
              {recording.openRangeId ? 'End range' : 'Start range'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <MarkerList
            markers={recording.markers}
            categories={state.markerSettings.categories}
            folderName={recording.folderName}
            openRangeId={recording.openRangeId}
            onCategoryChange={(markerId, categoryId) => run(() => window.api.setMarkerCategory(markerId, categoryId))}
            onDelete={(markerId) => run(() => window.api.deleteMarker(markerId))}
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
            levels={levels}
            onMutedChange={(id, muted) => run(() => window.api.setSourceMuted(id, muted))}
          />
        </CardContent>
      </CardRoot>
    </div>
  )
}
