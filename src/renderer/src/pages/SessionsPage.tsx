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
  DropdownMenu,
  Input,
  Label,
  Select,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow
} from '@ivao/atmosphere-react'
import { Circle, CircleAlert, Ellipsis, FolderOpen, Pencil, Play, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import type { AppState, SessionDetails, SessionMetadata, SessionSummary } from '@shared/types'
import { FirstRunChecklist, useChecklist } from '../components/FirstRunChecklist'
import { formatDuration, todayIso } from '../format'

const SESSION_TYPES = [
  { value: 'Training', label: 'Training' },
  { value: 'Exam', label: 'Exam' }
]

/** `onBusyChange` keeps the dialog open while starting: closing it would hide an error. */
function NewSessionForm({
  onCancel,
  onStarted,
  onBusyChange
}: {
  onCancel: () => void
  onStarted: () => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
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
    window.api
      .getSessionDefaults()
      .then(({ trainerVid }) => setForm((f) => ({ ...f, trainerVid })))
      .catch(() => undefined)
  }, [])

  const set = (field: keyof SessionMetadata) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: field === 'position' ? event.target.value.toUpperCase() : event.target.value }))

  const valid =
    /^\d+$/.test(form.traineeVid.trim()) &&
    form.position.trim() !== '' &&
    /^\d*$/.test(form.trainerVid.trim()) &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.date)

  const start = async (): Promise<void> => {
    setStarting(true)
    onBusyChange(true)
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
      onBusyChange(false)
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
          <Label>Session type</Label>
          <Select
            value={form.trainingType}
            onValueChange={(trainingType) => setForm((f) => ({ ...f, trainingType }))}
            items={SESSION_TYPES}
          />
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
        <Button type="button" variant="outline" onClick={onCancel} disabled={starting}>
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

/** Corrects typos in a recorded session; the folder is renamed to match. */
function EditDetailsForm({
  session,
  onClose,
  onBusyChange
}: {
  session: SessionSummary
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const [form, setForm] = useState<SessionDetails>({
    traineeVid: session.metadata.traineeVid,
    traineeName: session.metadata.traineeName,
    position: session.metadata.position,
    trainingType: session.metadata.trainingType
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Sessions recorded before v1.1 may have another type (e.g. "Checkout"): keep it selectable.
  const types = SESSION_TYPES.some((type) => type.value === session.metadata.trainingType)
    ? SESSION_TYPES
    : [...SESSION_TYPES, { value: session.metadata.trainingType, label: session.metadata.trainingType }]
  const set = (field: keyof SessionDetails) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: field === 'position' ? event.target.value.toUpperCase() : event.target.value }))
  const valid = /^\d+$/.test(form.traineeVid.trim()) && form.position.trim() !== ''

  const save = async (): Promise<void> => {
    setSaving(true)
    onBusyChange(true)
    setError(null)
    try {
      await window.api.updateSessionDetails(session.folderName, form)
      onBusyChange(false)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      onBusyChange(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) void save()
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-trainee-vid">Trainee VID</Label>
          <Input id="edit-trainee-vid" inputMode="numeric" value={form.traineeVid} onChange={set('traineeVid')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-trainee-name">Trainee name (optional)</Label>
          <Input id="edit-trainee-name" value={form.traineeName} onChange={set('traineeName')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-position">Position</Label>
          <Input id="edit-position" value={form.position} onChange={set('position')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Session type</Label>
          <Select
            value={form.trainingType}
            onValueChange={(trainingType) => setForm((f) => ({ ...f, trainingType }))}
            items={types}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The session folder and its screenshots folder are renamed to match. Close File Explorer windows showing them
        first.
      </p>
      {error && <Alert variant="destructive" Icon={CircleAlert} title="Could not save" description={error} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid} isLoading={saving}>
          Save
        </Button>
      </div>
    </form>
  )
}

export function SessionsPage({ state, onOpenSetup }: { state: AppState; onOpenSetup: () => void }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  /** A form in the New session or Edit dialog is working: Escape or a click outside must not close it. */
  const [formBusy, setFormBusy] = useState(false)
  const [listError, setListError] = useState<{ title: string; message: string } | null>(null)
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null)
  const [toEdit, setToEdit] = useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const checklist = useChecklist(state)

  const act = (title: string, action: () => Promise<void>): Promise<void> => {
    setListError(null)
    return action().catch((e: unknown) => setListError({ title, message: e instanceof Error ? e.message : String(e) }))
  }
  const openReview = (folderName: string): void =>
    void act('Could not open the session', () => window.api.openReview(folderName))
  const confirmDelete = async (): Promise<void> => {
    if (!toDelete) return
    setDeleting(true)
    await act('Could not delete the session', () => window.api.deleteSession(toDelete.folderName))
    setDeleting(false)
    setToDelete(null)
  }

  useEffect(() => {
    // Only the latest request counts: an earlier, slower answer would show stale folders.
    let latest = 0
    const load = (): void => {
      const request = ++latest
      window.api
        .listSessions()
        .then((list) => request === latest && setSessions(list))
        .catch((error: unknown) => console.error('Could not list the sessions', error))
    }
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
          <CardTitle>New session</CardTitle>
          <CardDescription>Record the Aurora screen, mark significant moments and dictate voice notes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {checklist.visible ? (
            <FirstRunChecklist steps={checklist.steps} onOpenSetup={onOpenSetup} onDismiss={checklist.dismiss} />
          ) : (
            !ready && (
              <Alert
                Icon={Settings2}
                title={obsReady ? 'Choose the monitor to record' : 'Connect to OBS'}
                description={
                  obsReady
                    ? 'Open Setup and choose the monitor where Aurora runs.'
                    : 'Start OBS and connect to it from Setup before recording.'
                }
              />
            )
          )}
          <div className="flex gap-3">
            <Dialog
              open={dialogOpen}
              onOpenChange={(open) => (open || !formBusy) && setDialogOpen(open)}
              title="New session"
              description="These details name the session folder and help you find it later."
              trigger={
                <Button disabled={!ready}>
                  <Circle className="size-4 fill-current" aria-hidden />
                  New session
                </Button>
              }
            >
              <NewSessionForm
                onCancel={() => setDialogOpen(false)}
                onStarted={() => setDialogOpen(false)}
                onBusyChange={setFormBusy}
              />
            </Dialog>
            {!ready && !checklist.visible && (
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
            <CardDescription>Open a session to review it with the trainee during the debriefing.</CardDescription>
          </div>
          <Button
            variant="secondary"
            onClick={() => void act('Could not open the folder', () => window.api.openSessionsFolder())}
          >
            <FolderOpen className="size-4" aria-hidden />
            Open sessions folder
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {listError && (
            <Alert variant="destructive" Icon={CircleAlert} title={listError.title} description={listError.message} />
          )}
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
                  <TableHead className="text-right" />
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
                        variant="primary"
                        size="sm"
                        className="mr-1"
                        disabled={state.recording !== null}
                        onClick={() => openReview(session.folderName)}
                      >
                        <Play className="size-4" aria-hidden />
                        Review
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Open the session folder"
                        onClick={() =>
                          void act('Could not open the folder', () => window.api.openSessionsFolder(session.folderName))
                        }
                      >
                        <FolderOpen className="size-4" aria-hidden />
                        Files
                      </Button>
                      <DropdownMenu
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="More actions"
                            disabled={state.recording !== null}
                          >
                            <Ellipsis className="size-4" aria-hidden />
                          </Button>
                        }
                        items={[
                          {
                            label: 'Edit details…',
                            icon: <Pencil className="size-4" aria-hidden />,
                            onSelect: () => setToEdit(session)
                          },
                          {
                            label: 'Transcribe voice notes again',
                            icon: <RefreshCw className="size-4" aria-hidden />,
                            disabled: session.noteCount === 0,
                            onSelect: () =>
                              void act('Could not transcribe the notes', () =>
                                window.api.retranscribeSession(session.folderName)
                              )
                          },
                          {
                            label: 'Delete session…',
                            icon: <Trash2 className="size-4" aria-hidden />,
                            onSelect: () => setToDelete(session)
                          }
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          )}
        </CardContent>
      </CardRoot>

      <Dialog
        open={toEdit !== null}
        onOpenChange={(open) => !open && !formBusy && setToEdit(null)}
        title="Edit session details"
        description={
          toEdit
            ? `Recorded on ${toEdit.metadata.date}. Fix typos in the trainee, position or session type.`
            : undefined
        }
      >
        {toEdit && (
          <EditDetailsForm
            key={toEdit.folderName}
            session={toEdit}
            onClose={() => setToEdit(null)}
            onBusyChange={setFormBusy}
          />
        )}
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && !deleting && setToDelete(null)}
        title="Delete this session?"
        description="The recording, screenshots and voice notes go to the Windows Recycle Bin: restore the folder from there if you change your mind."
      >
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {toDelete.metadata.date} · {toDelete.metadata.traineeVid}
              {toDelete.metadata.traineeName && ` · ${toDelete.metadata.traineeName}`} ·{' '}
              <span className="font-mono">{toDelete.metadata.position}</span>
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={deleting} onClick={() => setToDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" isLoading={deleting} onClick={() => void confirmDelete()}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
