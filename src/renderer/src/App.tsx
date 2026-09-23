import { useEffect, useState } from 'react'
import { Badge, Button, CardContent, CardDescription, CardHeader, CardRoot, CardTitle } from '@ivao/atmosphere-react'
import { Circle, FolderOpen, Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@shared/theme'
import { useTheme } from './useTheme'

const THEME_OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'day', label: 'Day', Icon: Sun },
  { value: 'night', label: 'Night', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor }
]

function ThemeSwitch({ preference, setPreference }: Omit<ReturnType<typeof useTheme>, 'theme'>): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-1 rounded-md bg-white/10 p-1">
      {THEME_OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={preference === value}
          onClick={() => setPreference(value)}
          className={`flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors ${
            preference === value ? 'bg-white text-atmos-700 dark:text-fuselage-800' : 'text-white/80 hover:text-white'
          }`}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const { preference, setPreference } = useTheme()

  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])

  return (
    <div className="flex h-full flex-col bg-body">
      <header className="flex items-center justify-between bg-atmos-700 px-4 py-3 text-white dark:bg-fuselage-800">
        <div className="flex items-baseline gap-3">
          <span className="font-head text-lg font-semibold">Training Recording System</span>
          {version && <span className="text-xs text-white/70">v{version}</span>}
        </div>
        <ThemeSwitch preference={preference} setPreference={setPreference} />
      </header>

      <main className="container flex-1 overflow-auto py-8">
        <div className="grid gap-6 md:grid-cols-2">
          <CardRoot>
            <CardHeader>
              <CardTitle>New training session</CardTitle>
              <CardDescription>
                Record the Aurora screen, mark significant moments and dictate voice notes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <Button disabled>
                <Circle className="size-4" aria-hidden />
                Start session
              </Button>
              <Badge text="Coming in M1" color="gray" size="sm" />
            </CardContent>
          </CardRoot>

          <CardRoot>
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>Open a recorded session to review it during the debriefing.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <Button variant="secondary" disabled>
                <FolderOpen className="size-4" aria-hidden />
                Open sessions folder
              </Button>
              <span className="text-sm text-muted-foreground">No sessions yet.</span>
            </CardContent>
          </CardRoot>
        </div>
      </main>
    </div>
  )
}
