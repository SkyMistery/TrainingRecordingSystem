import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  CardContent,
  CardDescription,
  CardHeader,
  CardRoot,
  CardTitle,
  Dialog,
  Input,
  Label,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow
} from '@ivao/atmosphere-react'
import { Circle, CircleAlert, FolderOpen, Settings2 } from 'lucide-react'
import type { AppState, SessionMetadata, SessionSummary } from '@shared/types'
import { formatDuration, todayIso } from '../format'

const TRAINING_TYPES = ['Training', 'Exam', 'Checkout', 'Assessment']

function NewSessionForm({ onCancel, onStarted }: { onCancel: () => void; onStarted: () => void }): React.JSX.Element {
  const [form, setForm] = useState<SessionMetadata>({
    traineeVid: '',
    traineeName: '',
    position: '',
    trainingType: 'Training',
    trainerVid: '',
    date: todayIso()
  })
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    void window.api.getSessionDefaults().then(({ trainerVid }) => setForm((f) => ({ ...f, trainerVid })))
  }, [])

  const set = (field: keyof SessionMetadata) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: field === 'position' ? event.target.value.toUpperCase() : event.target.value }))

  const valid =
    /^\d+$/.test(form.traineeVid.trim()) && form.position.trim() !== '' && /^\d*$/.test(form.trainerVid.trim())

  const start = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      await window.api.startSession({
        ...form,
        traineeVid: form.traineeVid.trim(),
        traineeName: form.traineeName.trim(),
        position: form.position.trim(),
        trainingType: form.trainingType.trim(),
        trainerVid: form.trainerVid.trim()
      })
      onStarted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) void start()
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trainee-vid">Trainee VID</Label>
          <Input id="trainee-vid" inputMode="numeric" autoFocus value={form.traineeVid} onChange={set('traineeVid')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trainee-name">Trainee name (optional)</Label>
          <Input id="trainee-name" value={form.traineeName} onChange={set('traineeName')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="position">Position</Label>
          <Input id="position" placeholder="e.g. LIRF_APP" value={form.position} onChange={set('position')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="training-type">Training type</Label>
          <Input id="training-type" list="training-types" value={form.trainingType} onChange={set('trainingType')} />
          <datalist id="training-types">
            {TRAINING_TYPES.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trainer-vid">Your VID (trainer)</Label>
          <Input id="trainer-vid" inputMode="numeric" value={form.trainerVid} onChange={set('trainerVid')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="session-date">Date</Label>
          <Input id="session-date" type="date" value={form.date} onChange={set('date')} />
        </div>
      </div>
      {error && (
        <Alert variant="destructive" Icon={CircleAlert} title="Could not start recording" description={error} />
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid} isLoading={starting}>
          <Circle className="size-4 fill-current" aria-hidden />
          Start recording
        </Button>
      </div>
    </form>
  )
}

export function SessionsPage({ state, onOpenSetup }: { state: AppState; onOpenSetup: () => void }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    const load = (): void => void window.api.listSessions().then(setSessions)
    load()
    return window.api.onSessionsChanged(load)
  }, [])

  const obsReady = state.obs.status === 'connected'
  const displayReady = state.capture.display !== null
  const ready = obsReady && displayReady

  return (
    <div className="flex flex-col gap-6">
      <CardRoot>
        <CardHeader>
          <CardTitle>New training session</CardTitle>
          <CardDescription>Record the Aurora screen, mark significant moments and dictate voice notes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!ready && (
            <Alert
              Icon={Settings2}
              title={obsReady ? 'Choose the monitor to record' : 'Connect to OBS'}
              description={
                obsReady
                  ? 'Open Setup and choose the monitor where Aurora runs.'
                  : 'Start OBS and connect to it from Setup before recording.'
              }
            />
          )}
          <div className="flex gap-3">
            <Dialog
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              title="New training session"
              description="These details name the session folder and help you find it later."
              trigger={
                <Button disabled={!ready}>
                  <Circle className="size-4 fill-current" aria-hidden />
                  New session
                </Button>
              }
            >
              <NewSessionForm onCancel={() => setDialogOpen(false)} onStarted={() => setDialogOpen(false)} />
            </Dialog>
            {!ready && (
              <Button variant="outline" onClick={onOpenSetup}>
                <Settings2 className="size-4" aria-hidden />
                Open Setup
              </Button>
            )}
          </div>
        </CardContent>
      </CardRoot>

      <CardRoot>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Sessions</CardTitle>
            <CardDescription>Reviewing a session with its markers arrives in a later version.</CardDescription>
          </div>
          <Button variant="secondary" onClick={() => void window.api.openSessionsFolder()}>
            <FolderOpen className="size-4" aria-hidden />
            Open sessions folder
          </Button>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            <TableRoot>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Trainee</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Markers</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{session.metadata.date}</TableCell>
                    <TableCell>
                      {session.metadata.traineeVid}
                      {session.metadata.traineeName && (
                        <span className="text-muted-foreground"> · {session.metadata.traineeName}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{session.metadata.position}</TableCell>
                    <TableCell>{session.metadata.trainingType}</TableCell>
                    <TableCell>{session.durationMs !== null ? formatDuration(session.durationMs) : '—'}</TableCell>
                    <TableCell>{session.markerCount}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void window.api.openSessionsFolder(session.folder)}
                      >
                        <FolderOpen className="size-4" aria-hidden />
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          )}
        </CardContent>
      </CardRoot>
    </div>
  )
}
