import { Monitor, Moon, Sun } from 'lucide-react'
import type { ObsStatus } from '@shared/types'
import type { ThemePreference } from '@shared/theme'

export type Page = 'sessions' | 'setup'

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

export function Header(props: HeaderProps): React.JSX.Element {
  return (
    <header className="flex items-center justify-between gap-4 bg-atmos-700 px-4 py-3 text-white dark:bg-fuselage-800">
      <div className="flex items-center gap-6">
        <div className="flex items-baseline gap-3">
          <span className="font-head text-lg font-semibold">Training Recording System</span>
          {props.version && <span className="text-xs text-white/70">v{props.version}</span>}
        </div>
        {props.page && (
          <Segmented label="Pages" role="tablist" options={PAGES} value={props.page} onChange={props.onNavigate} />
        )}
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 text-xs text-white/80">
          <span className={`size-2 rounded-full ${OBS_DOT[props.obsStatus]}`} aria-hidden />
          {OBS_LABEL[props.obsStatus]}
        </span>
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
