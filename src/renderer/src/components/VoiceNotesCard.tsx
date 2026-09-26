import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Input, Label, Progress, Select, Switch, Textarea } from '@ivao/atmosphere-react'
import { CircleAlert, Download, X } from 'lucide-react'
import { MAX_VOCABULARY_LENGTH, WHISPER_LANGUAGES, WHISPER_MODELS } from '@shared/whisper'
import type { AppState, NoteSettings, WhisperModelId } from '@shared/types'
import { usePatchSaver } from '../hooks'
import { openMicrophone } from '../microphone'
import { SetupSection, type SectionProps } from './SetupSection'

interface Microphone {
  deviceId: string
  label: string
}

/** Microphone names are only visible to pages that have used the microphone once. */
async function listMicrophones(): Promise<Microphone[]> {
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
  probe.getTracks().forEach((track) => track.stop())
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'communications')
    .map((device) => ({
      deviceId: device.deviceId,
      label:
        device.deviceId === 'default' ? `Windows default (${device.label.replace(/^Default - /, '')})` : device.label
    }))
}

/** Live level of the chosen microphone, so the trainer can check it before a session. */
function MicLevel({ deviceId, label }: { deviceId: string; label: string }): React.JSX.Element {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let frame = 0
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let stopped = false
    void openMicrophone(deviceId, label)
      .then(({ stream: media }) => {
        if (stopped) return media.getTracks().forEach((track) => track.stop())
        stream = media
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        context.createMediaStreamSource(media).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        const tick = (): void => {
          analyser.getFloatTimeDomainData(data)
          const peak = data.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
          const db = peak > 0 ? 20 * Math.log10(peak) : -60
          setLevel(Math.max(0, Math.min(1, (db + 60) / 60)))
          frame = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => setLevel(0))
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
    }
  }, [deviceId, label])

  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-fuselage-150 dark:bg-fuselage-700" aria-hidden>
      <div
        className="h-full bg-semantic-green-500 transition-[width] duration-75"
        style={{ width: `${level * 100}%` }}
      />
    </div>
  )
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function VoiceNotesCard({ state, section }: { state: AppState; section: SectionProps }): React.JSX.Element {
  const settings = state.noteSettings
  const { transcription } = state
  const [microphones, setMicrophones] = useState<Microphone[]>([])
  const [micError, setMicError] = useState<string | null>(null)
  const [attach, setAttach] = useState(String(settings.attachWindowSeconds))
  useEffect(() => setAttach(String(settings.attachWindowSeconds)), [settings.attachWindowSeconds])
  const [vocabulary, setVocabulary] = useState(settings.vocabulary)
  useEffect(() => setVocabulary(settings.vocabulary), [settings.vocabulary])

  const saver = usePatchSaver(settings, window.api.saveNoteSettings)
  const save = useCallback(
    (patch: Partial<NoteSettings>) =>
      void saver(patch).catch((error: unknown) => console.error('Could not save the voice note settings', error)),
    [saver]
  )

  useEffect(() => {
    listMicrophones()
      .then((list) => {
        setMicrophones(list)
        // Device ids change between app versions and driver updates: follow the name.
        if (!list.some((mic) => mic.deviceId === settings.micDeviceId)) {
          const sameName = list.find((mic) => mic.label === settings.micLabel)
          if (sameName) save({ micDeviceId: sameName.deviceId })
        }
      })
      .catch((error: unknown) => setMicError(error instanceof Error ? error.message : String(error)))
  }, [])

  const download = (model: WhisperModelId): void => {
    void window.api.downloadModel(model).catch(() => undefined)
  }
  const pttLabel = state.markerSettings.hotkeys.voiceNote?.label

  return (
    <SetupSection
      title="Voice notes"
      description={
        <>
          Hold {pttLabel ? <strong>{pttLabel}</strong> : 'the voice note hotkey'} to dictate a note on the current
          moment. Notes are transcribed on this computer: nothing is sent online.
        </>
      }
      contentClassName="flex flex-col gap-6"
      {...section}
    >
      {!pttLabel && (
        <Alert
          Icon={CircleAlert}
          title="No push-to-talk key yet"
          description="Set the “Voice note (hold)” hotkey in Markers and hotkeys below."
        />
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Microphone for voice notes</Label>
        <Select
          value={microphones.some((mic) => mic.deviceId === settings.micDeviceId) ? settings.micDeviceId : undefined}
          placeholder={micError ? 'Microphone not available' : settings.micLabel}
          onValueChange={(deviceId) => {
            const mic = microphones.find((item) => item.deviceId === deviceId)
            if (mic) save({ micDeviceId: mic.deviceId, micLabel: mic.label })
          }}
          items={microphones.map((mic) => ({ value: mic.deviceId, label: mic.label }))}
        />
        <MicLevel deviceId={settings.micDeviceId} label={settings.micLabel} />
        <span className="text-xs text-muted-foreground">
          Speak: the bar should move. While you dictate, microphones marked “Mute in the recording while I dictate” in
          Audio are muted in OBS, so your notes don’t end up in the video.
        </span>
        {micError && <span className="text-xs text-semantic-red-600">{micError}</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.holdHotkeyFromButtons}
            disabled={!pttLabel}
            onCheckedChange={(holdHotkeyFromButtons) => save({ holdHotkeyFromButtons })}
          />
          Also press {pttLabel ? <strong>{pttLabel}</strong> : 'the voice note hotkey'} for notes started from a button
        </label>
        <span className="text-xs text-muted-foreground">
          For voice chats: set the same key as push-to-mute in Discord, and it mutes you while you dictate from the
          Companion (tablet, phone) or the button in the app, as it does when you hold the key. The key also reaches the
          window in front, as when you press it yourself.
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={settings.transcribe} onCheckedChange={(transcribe) => save({ transcribe })} />
          Transcribe voice notes automatically
        </label>

        {!transcription.available && (
          <Alert
            variant="destructive"
            Icon={CircleAlert}
            title="Transcription program missing"
            description="Reinstall the app to restore it. Voice notes are still recorded."
          />
        )}

        <div role="radiogroup" aria-label="Transcription model" className="grid gap-2 md:grid-cols-3">
          {WHISPER_MODELS.map((model) => {
            const installed = transcription.installedModels.includes(model.id)
            const downloading = transcription.download?.model === model.id ? transcription.download : null
            const selected = settings.model === model.id
            return (
              <div
                key={model.id}
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onClick={() => save({ model: model.id })}
                onKeyDown={(event) => (event.key === ' ' || event.key === 'Enter') && save({ model: model.id })}
                className={`flex cursor-pointer flex-col gap-2 rounded-md border p-3 transition-colors ${
                  selected
                    ? 'border-atmos-700 bg-atmos-50/30 dark:border-fuselage-50 dark:bg-fuselage-800'
                    : 'border-border hover:border-fuselage-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{model.label}</span>
                  {installed ? (
                    <Badge text="Installed" color="green" size="sm" />
                  ) : (
                    <span className="text-xs text-muted-foreground">{model.sizeMb} MB</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">{model.description}</span>
                {!installed && !downloading && (
                  <Button
                    size="sm"
                    variant={selected ? 'primary' : 'outline'}
                    disabled={transcription.download !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      save({ model: model.id })
                      download(model.id)
                    }}
                  >
                    <Download className="size-4" aria-hidden />
                    Download
                  </Button>
                )}
                {downloading && (
                  <div className="flex items-center gap-2">
                    <Progress
                      className="flex-1"
                      value={downloading.totalBytes ? (downloading.receivedBytes / downloading.totalBytes) * 100 : 0}
                    />
                    <span className="w-24 text-right font-mono text-xs text-muted-foreground">
                      {formatMb(downloading.receivedBytes)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Cancel download"
                      onClick={(event) => {
                        event.stopPropagation()
                        void window.api.cancelModelDownload()
                      }}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {transcription.downloadError && (
          <span className="text-xs text-semantic-red-600">Download failed: {transcription.downloadError}</span>
        )}
        {settings.transcribe && !transcription.installedModels.includes(settings.model) && !transcription.download && (
          <span className="text-xs text-muted-foreground">
            Download the selected model once; notes recorded before that are transcribed as soon as it is ready.
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Language you dictate in</Label>
          <Select
            value={settings.language}
            onValueChange={(language) => save({ language })}
            items={WHISPER_LANGUAGES}
          />
          <span className="text-xs text-muted-foreground">
            Choosing it is more reliable than detection for short notes.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="attach-window">Attach to the latest marker if placed within</Label>
          <div className="flex items-center gap-3">
            <Input
              id="attach-window"
              className="w-24"
              inputMode="numeric"
              value={attach}
              onChange={(event) => setAttach(event.target.value)}
              onBlur={() => {
                const seconds = Math.min(600, Math.max(0, Math.round(Number(attach) || 0)))
                setAttach(String(seconds))
                if (seconds !== settings.attachWindowSeconds) save({ attachWindowSeconds: seconds })
              }}
            />
            <span className="text-sm text-muted-foreground">seconds, otherwise the note creates a new marker</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="vocabulary">Words to recognise</Label>
        <Textarea
          id="vocabulary"
          className="min-h-16"
          maxLength={MAX_VOCABULARY_LENGTH}
          placeholder="e.g. LIRF, UXUTO 1Q, NASUM, Ryanair, Speedbird, reason"
          value={vocabulary}
          onChange={(event) => setVocabulary(event.target.value)}
          onBlur={() => {
            const value = vocabulary.trim()
            if (value !== settings.vocabulary) save({ vocabulary: value })
          }}
        />
        <span className="text-xs text-muted-foreground">
          Callsigns, fixes, SIDs, airports and English words you use, separated by commas: they help the transcription
          spell them right. Common ATC terms and the ICAO alphabet are already included. Notes already transcribed can
          be transcribed again from the sessions list.
        </span>
      </div>
    </SetupSection>
  )
}
