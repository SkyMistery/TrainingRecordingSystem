import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Label, Select, Switch } from '@ivao/atmosphere-react'
import { CircleAlert, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AppState, CaptureConfig, HiddenWindowRule, WindowOption } from '@shared/types'
import type { SettingsPatch } from '../hooks'
import { SetupSection, type SectionProps } from './SetupSection'

function programName(exe: string): string {
  return exe.replace(/\.exe$/i, '')
}

export function HiddenWindowsCard({
  state,
  save,
  section
}: {
  state: AppState
  save: (patch: SettingsPatch<CaptureConfig>) => void
  section: SectionProps
}): React.JSX.Element {
  const rules = state.capture.hiddenWindows
  const [windows, setWindows] = useState<WindowOption[]>([])
  const [selected, setSelected] = useState<string | undefined>()
  const [wholeProgram, setWholeProgram] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadWindows = useCallback(() => {
    setSelected(undefined)
    window.api.listWindows().then(
      (list) => {
        setError(null)
        setWindows(list)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  }, [])

  useEffect(() => {
    if (section.open) loadWindows()
  }, [section.open, loadWindows])

  const update = (id: string, patch: Partial<HiddenWindowRule>): void =>
    save((current) => ({
      hiddenWindows: current.hiddenWindows.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
    }))

  const add = (): void => {
    const option = windows[Number(selected)]
    if (!option) return
    const title = wholeProgram ? null : option.title
    save((current) => {
      const same = current.hiddenWindows.find(
        (rule) => rule.exe.toLowerCase() === option.exe.toLowerCase() && rule.title === title
      )
      if (same) return { hiddenWindows: current.hiddenWindows.map((r) => (r === same ? { ...r, enabled: true } : r)) }
      const rule: HiddenWindowRule = { id: crypto.randomUUID().slice(0, 8), exe: option.exe, title, enabled: true }
      return { hiddenWindows: [...current.hiddenWindows, rule] }
    })
    setSelected(undefined)
    setWholeProgram(false)
  }

  return (
    <SetupSection
      title="Hidden windows"
      description={
        <>
          Private windows are covered by a grey box in the recording and in screenshots, wherever you move them on the
          recorded monitor: for example Aurora’s COM BOX, where you chat with other controllers. Check the preview in
          Display.
        </>
      }
      contentClassName="flex flex-col gap-5"
      {...section}
    >
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hidden windows: everything on the monitor is recorded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <Switch
                aria-label={`Hide ${rule.title ?? programName(rule.exe)}`}
                checked={rule.enabled}
                onCheckedChange={(enabled) => update(rule.id, { enabled })}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{rule.title ?? 'Every window'}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {programName(rule.exe)} ({rule.exe})
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${rule.title ?? programName(rule.exe)}`}
                onClick={() =>
                  save((current) => ({ hiddenWindows: current.hiddenWindows.filter((r) => r.id !== rule.id) }))
                }
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Window</Label>
            <Select
              placeholder="Choose an open window"
              value={selected}
              onValueChange={setSelected}
              items={windows.map((option, index) => ({
                value: String(index),
                label: `${option.title} — ${programName(option.exe)}`
              }))}
            />
          </div>
          <Button variant="outline" size="icon" aria-label="Refresh windows" onClick={loadWindows}>
            <RefreshCw className="size-4" aria-hidden />
          </Button>
          <Button disabled={selected === undefined} onClick={add}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={wholeProgram} onCheckedChange={setWholeProgram} />
          Hide every window of this program
        </label>
        <p className="text-xs text-muted-foreground">
          Only open windows are listed: open the window first. A window is recognised by its program and title, so it
          stays hidden when you close and reopen it.
        </p>
      </div>

      {(state.hiddenWindowsError ?? error) && (
        <Alert
          variant="destructive"
          Icon={CircleAlert}
          title="Hidden windows"
          description={state.hiddenWindowsError ?? error}
        />
      )}
    </SetupSection>
  )
}
