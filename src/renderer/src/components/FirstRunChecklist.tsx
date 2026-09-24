import { useState } from 'react'
import { Button } from '@ivao/atmosphere-react'
import { CircleCheck, Circle, Settings2 } from 'lucide-react'
import type { AppState } from '@shared/types'

const DISMISSED_KEY = 'trs.checklist.dismissed'

interface Step {
  label: string
  hint: string
  done: boolean
}

function steps(state: AppState): Step[] {
  const { noteSettings, transcription, markerSettings } = state
  return [
    {
      label: 'Connect to OBS',
      hint: 'Setup → OBS Studio',
      done: state.obs.status === 'connected'
    },
    {
      label: 'Choose the monitor where Aurora runs',
      hint: 'Setup → Display',
      done: state.capture.display !== null
    },
    {
      label: 'Add the audio sources',
      hint: 'Setup → Audio: Aurora, your voice client, your microphone',
      done: state.capture.audioSources.length > 0
    },
    {
      label: 'Choose a hold-to-dictate hotkey for voice notes',
      hint: 'Setup → Markers and hotkeys',
      done: markerSettings.hotkeys.voiceNote !== null
    },
    {
      label: 'Download the transcription model',
      hint: 'Setup → Voice notes',
      done: !noteSettings.transcribe || transcription.installedModels.includes(noteSettings.model)
    }
  ]
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * What to set up before the first session. Hidden once everything is done, or
 * when the trainer hides it (the steps needed to record still show as an alert).
 */
export function useChecklist(state: AppState): { steps: Step[]; visible: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(readDismissed)
  const list = steps(state)
  return {
    steps: list,
    visible: !dismissed && list.some((step) => !step.done),
    dismiss: () => {
      setDismissed(true)
      try {
        localStorage.setItem(DISMISSED_KEY, '1')
      } catch {
        // Hidden for this run only.
      }
    }
  }
}

export function FirstRunChecklist({
  steps,
  onOpenSetup,
  onDismiss
}: {
  steps: Step[]
  onOpenSetup: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const remaining = steps.filter((step) => !step.done).length
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">Before your first session</span>
        <span className="text-sm text-muted-foreground">{remaining} left</span>
      </div>
      <ul className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-2.5 text-sm">
            {step.done ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-semantic-green-600" aria-label="Done" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="To do" />
            )}
            <span className={step.done ? 'text-muted-foreground line-through' : undefined}>
              {step.label}
              {!step.done && <span className="block text-xs text-muted-foreground">{step.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" onClick={onOpenSetup}>
          <Settings2 className="size-4" aria-hidden />
          Open Setup
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Hide this list
        </Button>
      </div>
    </div>
  )
}
