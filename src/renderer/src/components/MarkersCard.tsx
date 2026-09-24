import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Label, Switch } from '@ivao/atmosphere-react'
import { Info, Plus, Trash2 } from 'lucide-react'
import { sameHotkey } from '@shared/hotkey'
import type { Hotkey, HotkeyAction, MarkerCategory, MarkerSettings } from '@shared/types'
import { HotkeyInput } from './HotkeyInput'
import { SetupSection, type SectionProps } from './SetupSection'

/** Colours from the IVAO brand palette (atmos, ocean, semantic and product colours). */
const PALETTE = [
  '#1342e4',
  '#3c55ac',
  '#7ea2d6',
  '#e93434',
  '#e5802e',
  '#f9cc2c',
  '#2ec662',
  '#4b7f7e',
  '#8b5cf6',
  '#8b8ca9'
]

const ACTIONS: { action: HotkeyAction; label: string; hint: string }[] = [
  { action: 'marker', label: 'Marker', hint: 'Screenshot + marker, moved back by the pre-roll.' },
  { action: 'range', label: 'Range start / end', hint: 'First press starts a range, the second ends it.' },
  { action: 'voiceNote', label: 'Voice note (hold)', hint: 'Hold to dictate a note, release to save it.' }
]

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }): React.JSX.Element {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Colour">
      {PALETTE.map((color) => (
        <button
          key={color}
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={`size-5 rounded-full border-2 transition-transform ${
            value === color ? 'scale-110 border-foreground' : 'border-transparent hover:scale-110'
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  )
}

function CategoryRow({
  category,
  conflict,
  onChange,
  onRemove
}: {
  category: MarkerCategory
  conflict: string | null
  onChange: (category: MarkerCategory) => void
  onRemove: () => void
}): React.JSX.Element {
  const [name, setName] = useState(category.name)
  useEffect(() => setName(category.name), [category.name])
  const onHotkey = useCallback((hotkey: Hotkey | null) => onChange({ ...category, hotkey }), [category, onChange])

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-56 flex-1 flex-col gap-2">
        <Input
          aria-label="Category name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name.trim() && name !== category.name && onChange({ ...category, name: name.trim() })}
        />
        <ColorPicker value={category.color} onChange={(color) => onChange({ ...category, color })} />
      </div>
      <HotkeyInput label={category.name} value={category.hotkey} onChange={onHotkey} conflict={conflict} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${category.name}`} onClick={onRemove}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </li>
  )
}

export function MarkersCard({
  settings,
  section
}: {
  settings: MarkerSettings
  section: SectionProps
}): React.JSX.Element {
  const [preRoll, setPreRoll] = useState(String(settings.preRollSeconds))
  useEffect(() => setPreRoll(String(settings.preRollSeconds)), [settings.preRollSeconds])

  const save = useCallback(
    (patch: Partial<MarkerSettings>) => void window.api.saveMarkerSettings({ ...settings, ...patch }),
    [settings]
  )

  /** Every bound hotkey with the name of what it does, to flag duplicates. */
  const bindings: [Hotkey | null, string][] = [
    ...ACTIONS.map(({ action, label }): [Hotkey | null, string] => [settings.hotkeys[action], label]),
    ...settings.categories.map((category): [Hotkey | null, string] => [category.hotkey, category.name])
  ]
  const conflictFor = (hotkey: Hotkey | null, own: string): string | null =>
    bindings.find(([other, name]) => name !== own && sameHotkey(hotkey, other))?.[1] ?? null

  const setAction = (action: HotkeyAction) => (hotkey: Hotkey | null) =>
    save({ hotkeys: { ...settings.hotkeys, [action]: hotkey } })

  const updateCategory = (updated: MarkerCategory): void =>
    save({ categories: settings.categories.map((c) => (c.id === updated.id ? updated : c)) })

  const addCategory = (): void => {
    const used = new Set(settings.categories.map((c) => c.color))
    const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[0]
    save({
      categories: [
        ...settings.categories,
        { id: crypto.randomUUID().slice(0, 8), name: 'New category', color, hotkey: null }
      ]
    })
  }

  return (
    <SetupSection
      title="Markers and hotkeys"
      description={
        <>
          Hotkeys work while Aurora has focus. Use keys or mouse buttons Aurora doesn’t use: they still reach Aurora
          too.
        </>
      }
      contentClassName="flex flex-col gap-6"
      {...section}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pre-roll">Pre-roll</Label>
        <div className="flex items-center gap-3">
          <Input
            id="pre-roll"
            className="w-24"
            inputMode="numeric"
            value={preRoll}
            onChange={(event) => setPreRoll(event.target.value)}
            onBlur={() => {
              const seconds = Math.min(120, Math.max(0, Math.round(Number(preRoll) || 0)))
              setPreRoll(String(seconds))
              if (seconds !== settings.preRollSeconds) save({ preRollSeconds: seconds })
            }}
          />
          <span className="text-sm text-muted-foreground">
            seconds — markers are placed this much before the key press, since you usually notice a moment after it
            happens.
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base">Actions</h3>
        <ul className="flex flex-col gap-3">
          {ACTIONS.map(({ action, label, hint }) => (
            <li key={action} className="grid grid-cols-[12rem_1fr] items-start gap-4">
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{hint}</div>
              </div>
              <HotkeyInput
                label={label}
                value={settings.hotkeys[action]}
                onChange={setAction(action)}
                conflict={conflictFor(settings.hotkeys[action], label)}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-base">Categories</h3>
          <p className="text-xs text-muted-foreground">
            Optional. A category hotkey tags the latest marker; you can also tag markers later.
          </p>
        </div>
        <ul className="flex flex-col divide-y divide-border">
          {settings.categories.map((category) => (
            <CategoryRow
              key={category.id}
              category={category}
              conflict={conflictFor(category.hotkey, category.name)}
              onChange={updateCategory}
              onRemove={() => save({ categories: settings.categories.filter((c) => c.id !== category.id) })}
            />
          ))}
        </ul>
        <div>
          <Button variant="outline" size="sm" onClick={addCategory}>
            <Plus className="size-4" aria-hidden />
            Add category
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={settings.statusWindow} onCheckedChange={(statusWindow) => save({ statusWindow })} />
          Show a small always-on-top status window while recording (placed on a monitor that isn’t recorded)
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={settings.sound} onCheckedChange={(sound) => save({ sound })} />
          Confirmation sound on hotkeys (it is recorded only if you capture desktop audio)
        </label>
      </div>

      <Alert
        Icon={Info}
        title="Aurora running as administrator?"
        description="Windows doesn’t pass keys pressed in an administrator app to normal apps. If hotkeys don’t react while Aurora has focus, run this app as administrator too."
      />
    </SetupSection>
  )
}
