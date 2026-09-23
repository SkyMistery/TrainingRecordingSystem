import { Button, Slider, Switch } from '@ivao/atmosphere-react'
import { AppWindow, Mic, MicOff, Speaker, Trash2, Volume2, VolumeX } from 'lucide-react'
import type { AudioLevels, AudioSourceConfig, AudioSourceKind } from '@shared/types'

const KIND_ICON: Record<AudioSourceKind, typeof Mic> = {
  application: AppWindow,
  desktop: Speaker,
  microphone: Mic
}

const MIN_DB = -60

/** OBS-style peak meter: green, yellow from -20 dB, red from -9 dB. */
function LevelMeter({ db, muted }: { db: number; muted: boolean }): React.JSX.Element {
  const fraction = muted ? 0 : Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB))
  const pct = (value: number): string => `${((value - MIN_DB) / -MIN_DB) * 100}%`
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-sm bg-fuselage-150 dark:bg-fuselage-700" aria-hidden>
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-75"
        style={{
          width: `${fraction * 100}%`,
          backgroundImage: `linear-gradient(to right, var(--ivao-color-semantic-green-500) 0 ${pct(-20)}, var(--ivao-color-semantic-yellow-500) ${pct(-20)} ${pct(-9)}, var(--ivao-color-semantic-red-500) ${pct(-9)})`,
          backgroundSize: `${fraction > 0 ? 100 / fraction : 100}% 100%`
        }}
      />
    </div>
  )
}

interface AudioMixerProps {
  sources: AudioSourceConfig[]
  levels: AudioLevels
  onMutedChange: (id: string, muted: boolean) => void
  onVolumeChange?: (id: string, volumeDb: number) => void
  onVolumeCommit?: (id: string, volumeDb: number) => void
  onNotesMuteChange?: (id: string, value: boolean) => void
  onRemove?: (id: string) => void
}

export function AudioMixer(props: AudioMixerProps): React.JSX.Element {
  if (props.sources.length === 0) {
    return <p className="text-sm text-muted-foreground">No audio sources yet.</p>
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {props.sources.map((source) => {
        const Icon = source.kind === 'microphone' && source.muted ? MicOff : KIND_ICON[source.kind]
        return (
          <li key={source.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <div className="flex items-center gap-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={source.label}>
                {source.label}
              </span>
              <Button
                variant={source.muted ? 'destructive' : 'outline'}
                size="sm"
                aria-pressed={source.muted}
                onClick={() => props.onMutedChange(source.id, !source.muted)}
              >
                {source.muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
                {source.muted ? 'Muted' : 'Mute'}
              </Button>
              {props.onRemove && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${source.label}`}
                  onClick={() => props.onRemove!(source.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </div>
            <LevelMeter db={props.levels[source.id] ?? MIN_DB} muted={source.muted} />
            {props.onVolumeChange && (
              <div className="flex items-center gap-3">
                <Slider
                  className="flex-1"
                  min={MIN_DB}
                  max={0}
                  step={0.5}
                  value={[source.volumeDb]}
                  aria-label={`${source.label} volume`}
                  onValueChange={([value]) => props.onVolumeChange!(source.id, value)}
                  onValueCommit={([value]) => props.onVolumeCommit?.(source.id, value)}
                />
                <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                  {source.volumeDb.toFixed(1)} dB
                </span>
              </div>
            )}
            {source.kind === 'microphone' && props.onNotesMuteChange && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={source.muteDuringNotes}
                  onCheckedChange={(checked) => props.onNotesMuteChange!(source.id, checked)}
                />
                Mute in the recording while I dictate a voice note
              </label>
            )}
          </li>
        )
      })}
    </ul>
  )
}
