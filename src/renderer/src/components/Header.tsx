import { useState } from 'react'
import { Alert, Button, Dialog, Switch } from '@ivao/atmosphere-react'
import {
  BookOpen,
  CircleAlert,
  Download,
  Monitor,
  Moon,
  Plug,
  QrCode,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sun
} from 'lucide-react'
import type { CompanionInfo, CompanionSettings, ObsStatus, UpdateState } from '@shared/types'
import logo from '../assets/trs-logo.svg'
import { CompanionPairing } from './CompanionCard'
import { expandSection } from './SetupSection'
import type { ThemePreference } from '@shared/theme'

export type Page = 'sessions' | 'setup'

const USER_GUIDE_URL = 'https://github.com/SkyMistery/TrainingRecordingSystem/blob/main/docs/USER_GUIDE.md'

const THEME_OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'day', label: 'Day', Icon: Sun },
  { value: 'night', label: 'Night', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor }
]

const PAGES: { value: Page; label: string }[] = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'setup', label: 'Setup' }
]

const OBS_LABEL: Record<ObsStatus, string> = {
  connected: 'OBS connected',
  connecting: 'Connecting to OBS…',
  disconnected: 'OBS not connected',
  error: 'OBS not connected'
}

const OBS_DOT: Record<ObsStatus, string> = {
  connected: 'bg-semantic-green-500',
  connecting: 'bg-semantic-yellow-500',
  disconnected: 'bg-fuselage-400',
  error: 'bg-semantic-red-500'
}

interface HeaderProps {
  version: string
  page: Page | null
  onNavigate: (page: Page) => void
  obsStatus: ObsStatus
  themePreference: ThemePreference
  onThemeChange: (preference: ThemePreference) => void
  /** Shown once the app state is known and the Companion is enabled. */
  companion: { info: CompanionInfo; settings: CompanionSettings; reviewOpen: boolean } | null
  update: UpdateState | null
  recording: boolean
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  role
}: {
  label: string
  options: { value: T; label: string; Icon?: typeof Sun }[]
  value: T | null
  onChange: (value: T) => void
  role: 'radiogroup' | 'tablist'
}): React.JSX.Element {
  const itemRole = role === 'radiogroup' ? 'radio' : 'tab'
  return (
    <div role={role} aria-label={label} className="flex gap-1 rounded-md bg-white/10 p-1">
      {options.map(({ value: optionValue, label: optionLabel, Icon }) => {
        const selected = value === optionValue
        return (
          <button
            key={optionValue}
            role={itemRole}
            aria-checked={itemRole === 'radio' ? selected : undefined}
            aria-selected={itemRole === 'tab' ? selected : undefined}
            onClick={() => onChange(optionValue)}
            className={`flex h-7 items-center gap-1.5 rounded-sm px-3 text-xs font-medium transition-colors ${
              selected ? 'bg-white text-atmos-700 dark:text-fuselage-800' : 'text-white/80 hover:text-white'
            }`}
          >
            {Icon && <Icon className="size-3.5" aria-hidden />}
            {optionLabel}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A new version: its download progress, then a button to install it now.
 * Closing the app installs it too; never in the middle of a recording.
 */
function UpdateButton({ update, recording }: { update: UpdateState; recording: boolean }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  if (update.status !== 'ready') {
    return (
      <span
        className="flex h-7 items-center gap-1.5 px-2 text-xs text-white/80"
        title={
          update.status === 'error'
            ? 'The download stopped: it is tried again later.'
            : 'Downloading in the background: it installs when you close the app.'
        }
      >
        <Download className="size-3.5" aria-hidden />
        {update.status === 'error'
          ? `Update ${update.version} paused`
          : `Update ${update.version} · ${update.percent}%`}
      </span>
    )
  }
  return (
    <>
      <button
        className="flex h-7 items-center gap-1.5 rounded-sm bg-semantic-green-600 px-3 text-xs font-semibold text-white hover:bg-semantic-green-700 disabled:opacity-60"
        disabled={recording || installing}
        title={
          recording
            ? 'Stop the recording first. The update also installs when you close the app.'
            : `Install version ${update.version} now and restart`
        }
        onClick={() => {
          setError(null)
          setInstalling(true)
          window.api.installUpdate().catch((e: unknown) => {
            setInstalling(false)
            setError(e instanceof Error ? e.message : String(e))
          })
        }}
      >
        <RefreshCw className={`size-3.5 ${installing ? 'animate-spin' : ''}`} aria-hidden />
        {installing ? 'Updating…' : `Restart to update (${update.version})`}
      </button>
      <Dialog open={error !== null} onOpenChange={(open) => !open && setError(null)} title="Could not update">
        <Alert
          variant="destructive"
          Icon={CircleAlert}
          title="The update was not installed"
          description={error ?? ''}
        />
      </Dialog>
    </>
  )
}

/** The pairing QR code, one click away from any page. */
function CompanionButton({
  info,
  settings,
  reviewOpen
}: {
  info: CompanionInfo
  settings: CompanionSettings
  reviewOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Pair a tablet or phone"
      description="Open the Companion on another device: notes, transcriptions and player controls."
      trigger={
        <button
          className="flex h-7 items-center gap-1.5 rounded-sm bg-white/10 px-3 text-xs font-medium text-white/80 hover:text-white"
          aria-label="Companion QR code"
        >
          <QrCode className="size-3.5" aria-hidden />
          {info.clients === 0 ? 'Companion' : `Companion · ${info.clients}`}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.lan}
            onCheckedChange={(lan) =>
              void window.api.saveCompanionSettings({ lan }).catch((error: unknown) => console.error(error))
            }
          />
          Allow a tablet or phone on the same network
        </label>
        {settings.lan && <CompanionPairing info={info} concealed={reviewOpen} />}
        {settings.lan && (
          <Alert
            Icon={ShieldAlert}
            title="Local network only"
            description="Use it on your home network. On shared or public Wi-Fi, turn network access off."
          />
        )}
        {settings.lan && info.publicNetwork && (
          <Alert
            variant="destructive"
            Icon={ShieldAlert}
            title="Your network is set to Public"
            description="Windows blocks tablets from connecting on Public networks. Set the network profile to Private (see Setup → Companion)."
          />
        )}
        {info.error && (
          <Alert variant="destructive" Icon={CircleAlert} title="Companion not running" description={info.error} />
        )}
      </div>
    </Dialog>
  )
}

/**
 * OBS connection state. While disconnected it is a button that connects again
 * with the saved settings, so the trainer doesn't have to open Setup.
 */
function ObsStatusButton({
  status,
  onOpenSetup
}: {
  status: ObsStatus
  /** Absent while recording or reviewing, when the Setup page can't be shown. */
  onOpenSetup?: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  // A second click before "Connecting…" shows up would cut the first attempt short.
  const [pending, setPending] = useState(false)
  const dot = <span className={`size-2 rounded-full ${OBS_DOT[status]}`} aria-hidden />

  if (status === 'connected' || status === 'connecting') {
    return (
      <span className="flex items-center gap-2 text-xs text-white/80">
        {dot}
        {OBS_LABEL[status]}
      </span>
    )
  }
  return (
    <>
      <button
        className="flex h-7 items-center gap-2 rounded-sm bg-white/10 px-3 text-xs text-white/80 hover:text-white"
        title="Connect to OBS with the settings saved in Setup"
        disabled={pending}
        onClick={() => {
          setError(null)
          setPending(true)
          window.api
            .reconnectObs()
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setPending(false))
        }}
      >
        {dot}
        {OBS_LABEL[status]}
        <span className="flex items-center gap-1 font-semibold text-white">
          <Plug className="size-3.5" aria-hidden />
          Connect
        </span>
      </button>
      <Dialog open={error !== null} onOpenChange={(open) => !open && setError(null)} title="Could not connect to OBS">
        <div className="flex flex-col gap-4">
          <Alert variant="destructive" Icon={CircleAlert} title="OBS didn’t answer" description={error ?? ''} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setError(null)}>
              Close
            </Button>
            {onOpenSetup && (
              <Button
                onClick={() => {
                  setError(null)
                  expandSection('obs')
                  onOpenSetup()
                }}
              >
                <Settings2 className="size-4" aria-hidden />
                Open Setup
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  )
}

export function Header(props: HeaderProps): React.JSX.Element {
  return (
    <header className="flex items-center justify-between gap-4 bg-atmos-700 px-4 py-3 text-white dark:bg-fuselage-800">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Training Recording System" className="size-8" />
          <span className="font-head text-lg font-semibold">Training Recording System</span>
          {props.version && <span className="text-xs text-white/70">v{props.version}</span>}
        </div>
        {props.page && (
          <Segmented label="Pages" role="tablist" options={PAGES} value={props.page} onChange={props.onNavigate} />
        )}
      </div>
      <div className="flex items-center gap-4">
        <a
          href={USER_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-white/80 hover:text-white"
        >
          <BookOpen className="size-3.5" aria-hidden />
          Guide
        </a>
        {props.update && <UpdateButton update={props.update} recording={props.recording} />}
        {props.companion?.settings.enabled && <CompanionButton {...props.companion} />}
        <ObsStatusButton
          status={props.obsStatus}
          onOpenSetup={props.page ? () => props.onNavigate('setup') : undefined}
        />
        <Segmented
          label="Theme"
          role="radiogroup"
          options={THEME_OPTIONS}
          value={props.themePreference}
          onChange={props.onThemeChange}
        />
      </div>
    </header>
  )
}
