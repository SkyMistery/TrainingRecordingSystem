import { useState } from 'react'
import { Alert, Button, CardContent, CardHeader, CardRoot, CardTitle } from '@ivao/atmosphere-react'
import { CircleAlert, Square } from 'lucide-react'
import type { AppState, RecordingState } from '@shared/types'
import { AudioMixer } from '../components/AudioMixer'
import { formatDuration } from '../format'
import { useAudioLevels, useNow } from '../hooks'

export function RecordingPage({ state, recording }: { state: AppState; recording: RecordingState }): React.JSX.Element {
  const now = useNow(true)
  const levels = useAudioLevels()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const elapsed = recording.elapsedMs + (now - recording.sampledAt)
  const { metadata } = recording

  const stop = async (): Promise<void> => {
    setError(null)
    try {
      await window.api.stopSession()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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
                <Button variant="destructive" isLoading={state.busy} onClick={() => void stop()}>
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

      {error && <Alert variant="destructive" Icon={CircleAlert} title="Could not stop the recording" description={error} />}

      <CardRoot>
        <CardHeader>
          <CardTitle>Audio</CardTitle>
        </CardHeader>
        <CardContent>
          <AudioMixer
            sources={state.capture.audioSources}
            levels={levels}
            onMutedChange={(id, muted) => void window.api.setSourceMuted(id, muted)}
          />
        </CardContent>
      </CardRoot>
    </div>
  )
}
