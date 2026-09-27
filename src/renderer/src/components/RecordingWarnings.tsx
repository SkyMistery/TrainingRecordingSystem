import { Alert } from '@ivao/atmosphere-react'
import { EyeOff, TriangleAlert } from 'lucide-react'

/** Problems of the recording in progress: private windows not covered, notes not muted, saves failed… */
export function RecordingWarnings({
  hiddenWindowsError,
  warnings
}: {
  hiddenWindowsError: string | null
  warnings: string[]
}): React.JSX.Element | null {
  if (!hiddenWindowsError && warnings.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {hiddenWindowsError && (
        <Alert
          variant="destructive"
          Icon={EyeOff}
          title="Private windows are NOT covered in the recording"
          description={`${hiddenWindowsError} Until this is fixed, whatever they show (e.g. Aurora’s COM BOX) is recorded and in marker screenshots.`}
        />
      )}
      {warnings.map((warning) => (
        <Alert
          key={warning}
          variant="destructive"
          Icon={TriangleAlert}
          title="Recording problem"
          description={warning}
        />
      ))}
    </div>
  )
}
