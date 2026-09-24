import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Label, Select } from '@ivao/atmosphere-react'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  FolderInput,
  FolderOpen,
  Plug,
  Plus,
  RefreshCw
} from 'lucide-react'
import type {
  AppState,
  AudioSourceConfig,
  AudioSourceKind,
  AudioTargetOption,
  CaptureConfig,
  DisplayOption,
  EncoderId,
  OutputScale
} from '@shared/types'
import { AudioMixer } from '../components/AudioMixer'
import { CompanionCard } from '../components/CompanionCard'
import { HiddenWindowsCard } from '../components/HiddenWindowsCard'
import { MarkersCard } from '../components/MarkersCard'
import { SetupSection, useCollapsedSections, type SectionProps } from '../components/SetupSection'
import { VoiceNotesCard } from '../components/VoiceNotesCard'
import { type SettingsPatch, useAudioLevels, usePatchSaver } from '../hooks'

function useAction(): [string | null, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }, [])
  return [error, run]
}

function ErrorAlert({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return <Alert variant="destructive" Icon={CircleAlert} title="Something went wrong" description={message} />
}

// --- OBS connection ------------------------------------------------------------

function ObsConnectionCard({ state, section }: { state: AppState; section: SectionProps }): React.JSX.Element {
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('4455')
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [error, run] = useAction()

  useEffect(() => {
    void window.api.getObsConnection().then((config) => {
      setHost(config.host)
      setPort(String(config.port))
      setHasPassword(Boolean(config.hasPassword))
    })
  }, [])

  const connect = (): void => {
    void run(async () => {
      await window.api.connectObs({
        host,
        port: Number(port) || 4455,
        password: password !== '' ? password : undefined
      })
      if (password !== '') setHasPassword(true)
      setPassword('')
    })
  }

  const { obs } = state
  return (
    <SetupSection
      title="OBS Studio"
      description={
        <>
          OBS 30.2 or later records the session. In OBS open Tools → WebSocket Server Settings, tick “Enable WebSocket
          server” and copy the password here. The app uses its own OBS profile and scenes, and gives yours back when it
          closes.
        </>
      }
      contentClassName="flex flex-col gap-4"
      {...section}
    >
      <form
        className="grid grid-cols-[1fr_7rem_1fr_auto] items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          connect()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obs-host">Host</Label>
          <Input id="obs-host" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obs-port">Port</Label>
          <Input id="obs-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="obs-password">Password</Label>
          <Input
            id="obs-password"
            type="password"
            autoComplete="off"
            placeholder={hasPassword ? 'Saved — type to change' : 'WebSocket server password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" isLoading={obs.status === 'connecting'} disabled={state.recording !== null}>
          <Plug className="size-4" aria-hidden />
          {obs.status === 'connected' ? 'Reconnect' : 'Connect'}
        </Button>
      </form>
      {obs.status === 'connected' && <p className="text-sm text-muted-foreground">Connected to OBS {obs.version}.</p>}
      <ErrorAlert message={error ?? (obs.status === 'error' ? obs.error : null)} />
    </SetupSection>
  )
}

// --- Display and video -----------------------------------------------------------

const ENCODERS: { value: EncoderId; label: string }[] = [
  { value: 'nvenc', label: 'NVIDIA NVENC (hardware)' },
  { value: 'amd', label: 'AMD AMF (hardware)' },
  { value: 'qsv', label: 'Intel Quick Sync (hardware)' },
  { value: 'x264', label: 'x264 (software, uses the CPU)' }
]

function DisplayCard({
  state,
  save,
  section
}: {
  state: AppState
  save: (patch: SettingsPatch<CaptureConfig>) => void
  section: SectionProps
}): React.JSX.Element {
  const connected = state.obs.status === 'connected'
  const { capture } = state
  const [displays, setDisplays] = useState<DisplayOption[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [error, run] = useAction()

  const loadDisplays = useCallback(() => {
    void run(async () => setDisplays(await window.api.listDisplays()))
  }, [run])

  useEffect(() => {
    if (connected) loadDisplays()
  }, [connected, loadDisplays])

  useEffect(() => {
    if (!connected || !capture.display || !section.open) {
      setPreview(null)
      return
    }
    let cancelled = false
    const refresh = (): void => {
      window.api
        .getPreview()
        .then((image) => !cancelled && setPreview(image))
        .catch(() => !cancelled && setPreview(null))
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connected, capture.display, section.open])

  const scaleOptions: { value: OutputScale; label: string }[] = [
    {
      value: 'native',
      label: capture.display ? `Native (${capture.display.width}×${capture.display.height})` : 'Native'
    },
    { value: '1080p', label: 'Downscale to 1080p (smaller files)' }
  ]

  return (
    <SetupSection
      title="Display"
      description="The whole monitor is recorded, so Aurora’s insets and floating windows are included."
      contentClassName="flex flex-col gap-4"
      {...section}
    >
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Monitor where Aurora runs</Label>
          <Select
            disabled={!connected || state.recording !== null}
            placeholder={connected ? 'Choose a monitor' : 'Connect to OBS first'}
            value={capture.display?.id}
            onValueChange={(id) => {
              const display = displays.find((item) => item.id === id)
              if (display) save({ display })
            }}
            items={displays.map((display) => ({ value: display.id, label: display.name }))}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh monitors"
          disabled={!connected}
          onClick={loadDisplays}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="mx-auto flex aspect-video w-full max-w-2xl items-center justify-center overflow-hidden rounded-md border border-border bg-fuselage-100 dark:bg-fuselage-900">
        {preview ? (
          <img src={preview} alt="Preview of the recorded monitor" className="size-full object-contain" />
        ) : (
          <span className="text-sm text-muted-foreground">No preview</span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Recording resolution</Label>
          <Select
            disabled={state.recording !== null}
            value={capture.outputScale}
            onValueChange={(value) => save({ outputScale: value as OutputScale })}
            items={scaleOptions}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Frame rate</Label>
          <Select
            disabled={state.recording !== null}
            value={String(capture.fps)}
            onValueChange={(value) => save({ fps: Number(value) as 30 | 60 })}
            items={[
              { value: '30', label: '30 fps (recommended)' },
              { value: '60', label: '60 fps' }
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Encoder</Label>
          <Select
            disabled={state.recording !== null}
            value={capture.encoder}
            onValueChange={(value) => save({ encoder: value as EncoderId })}
            items={ENCODERS}
          />
        </div>
      </div>
      <ErrorAlert message={error} />
    </SetupSection>
  )
}

// --- Audio -------------------------------------------------------------------------

const KIND_OPTIONS: { value: AudioSourceKind; label: string }[] = [
  { value: 'application', label: 'Application (e.g. Aurora, Discord, TeamSpeak)' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'desktop', label: 'Desktop audio (everything you hear)' }
]

function AudioCard({
  state,
  save,
  section
}: {
  state: AppState
  save: (patch: SettingsPatch<CaptureConfig>) => void
  section: SectionProps
}): React.JSX.Element {
  const connected = state.obs.status === 'connected'
  const levels = useAudioLevels()
  const [kind, setKind] = useState<AudioSourceKind>('application')
  const [targets, setTargets] = useState<AudioTargetOption[]>([])
  const [target, setTarget] = useState<string | undefined>()
  const [dragVolume, setDragVolume] = useState<Record<string, number>>({})
  const [error, run] = useAction()
  const sources = state.capture.audioSources

  const loadTargets = useCallback(() => {
    setTarget(undefined)
    void run(async () => setTargets(await window.api.listAudioTargets(kind)))
  }, [kind, run])

  useEffect(() => {
    if (connected) loadTargets()
  }, [connected, loadTargets])

  const add = (): void => {
    const option = targets.find((item) => item.value === target)
    if (!option) return
    const source: AudioSourceConfig = {
      id: crypto.randomUUID().slice(0, 8),
      kind,
      target: option.value,
      label: option.label,
      muted: false,
      volumeDb: 0,
      muteDuringNotes: kind === 'microphone'
    }
    save((current) => ({ audioSources: [...current.audioSources, source] }))
    setTarget(undefined)
  }

  const shown = sources.map((source) =>
    dragVolume[source.id] !== undefined ? { ...source, volumeDb: dragVolume[source.id] } : source
  )

  return (
    <SetupSection
      title="Audio"
      description={
        <>
          Each source has its own mute and volume, like in OBS. A typical setup: Aurora, your voice client and your
          microphone.
        </>
      }
      contentClassName="flex flex-col gap-5"
      {...section}
    >
      <AudioMixer
        sources={shown}
        levels={levels}
        onMutedChange={(id, muted) => void run(() => window.api.setSourceMuted(id, muted))}
        onVolumeChange={(id, volumeDb) => setDragVolume((current) => ({ ...current, [id]: volumeDb }))}
        onVolumeCommit={(id, volumeDb) =>
          void run(async () => {
            await window.api.setSourceVolume(id, volumeDb)
            setDragVolume(({ [id]: _, ...rest }) => rest)
          })
        }
        onNotesMuteChange={(id, value) =>
          save((current) => ({
            audioSources: current.audioSources.map((s) => (s.id === id ? { ...s, muteDuringNotes: value } : s))
          }))
        }
        onRemove={
          state.recording
            ? undefined
            : (id) => save((current) => ({ audioSources: current.audioSources.filter((s) => s.id !== id) }))
        }
      />

      {!state.recording && (
        <div className="grid grid-cols-[14rem_1fr_auto_auto] items-end gap-3 border-t border-border pt-4">
          <div className="flex flex-col gap-1.5">
            <Label>Source type</Label>
            <Select
              disabled={!connected}
              value={kind}
              onValueChange={(value) => setKind(value as AudioSourceKind)}
              items={KIND_OPTIONS}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{kind === 'application' ? 'Application' : 'Device'}</Label>
            <Select
              disabled={!connected}
              placeholder={
                !connected
                  ? 'Connect to OBS first'
                  : kind === 'application'
                    ? 'Choose a running application'
                    : 'Choose a device'
              }
              value={target}
              onValueChange={setTarget}
              items={targets}
            />
          </div>
          <Button variant="outline" size="icon" aria-label="Refresh list" disabled={!connected} onClick={loadTargets}>
            <RefreshCw className="size-4" aria-hidden />
          </Button>
          <Button disabled={!connected || !target} onClick={add}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      )}
      {kind === 'application' && !state.recording && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Only running applications are listed: start Aurora and your voice client first.
        </p>
      )}
      <ErrorAlert message={error} />
    </SetupSection>
  )
}

// --- Sessions folder -----------------------------------------------------------------

function SessionsFolderCard({ state, section }: { state: AppState; section: SectionProps }): React.JSX.Element {
  const [error, run] = useAction()
  return (
    <SetupSection
      title="Sessions folder"
      description="Where recordings, screenshots and voice notes are saved. Changing it doesn’t move existing sessions: move their folders yourself if you want them in the list."
      contentClassName="flex flex-col gap-4"
      {...section}
    >
      <code className="select-text break-all rounded-sm bg-fuselage-100 p-2 font-mono text-xs dark:bg-fuselage-800">
        {state.sessionsDir}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={state.recording !== null}
          onClick={() => void run(() => window.api.chooseSessionsFolder())}
        >
          <FolderInput className="size-4" aria-hidden />
          Change…
        </Button>
        <Button variant="ghost" onClick={() => void run(() => window.api.openSessionsFolder())}>
          <FolderOpen className="size-4" aria-hidden />
          Open
        </Button>
      </div>
      <ErrorAlert message={error} />
    </SetupSection>
  )
}

// --- Page ----------------------------------------------------------------------------

const SECTIONS = [
  'obs',
  'display',
  'hiddenWindows',
  'audio',
  'markers',
  'voiceNotes',
  'companion',
  'sessionsFolder'
] as const
type SectionId = (typeof SECTIONS)[number]

export function SetupPage({ state }: { state: AppState }): React.JSX.Element {
  const [error, run] = useAction()
  const saver = usePatchSaver(state.capture, window.api.saveCapture)
  const save = useCallback((patch: SettingsPatch<CaptureConfig>) => void run(() => saver(patch)), [run, saver])

  const sections = useCollapsedSections()
  const section = (id: SectionId): SectionProps => ({ open: sections.isOpen(id), onToggle: () => sections.toggle(id) })
  const allOpen = SECTIONS.every((id) => sections.isOpen(id))

  return (
    <div className="flex flex-col gap-6">
      <div className="-mb-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => sections.setAll(allOpen ? [...SECTIONS] : null)}>
          {allOpen ? (
            <ChevronsDownUp className="size-4" aria-hidden />
          ) : (
            <ChevronsUpDown className="size-4" aria-hidden />
          )}
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>
      <ObsConnectionCard state={state} section={section('obs')} />
      <DisplayCard state={state} save={save} section={section('display')} />
      <HiddenWindowsCard state={state} save={save} section={section('hiddenWindows')} />
      <AudioCard state={state} save={save} section={section('audio')} />
      <MarkersCard settings={state.markerSettings} section={section('markers')} />
      <VoiceNotesCard state={state} section={section('voiceNotes')} />
      <CompanionCard state={state} settings={state.companionSettings} section={section('companion')} />
      <SessionsFolderCard state={state} section={section('sessionsFolder')} />
      <ErrorAlert message={error} />
    </div>
  )
}
