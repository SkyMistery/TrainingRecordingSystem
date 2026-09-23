import { useEffect, useRef, useState } from 'react'
import { Button, Textarea } from '@ivao/atmosphere-react'
import { Loader2, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { mediaUrl } from '@shared/media'
import type { Note } from '@shared/types'
import { formatDuration } from '../format'

const STATUS_TEXT: Partial<Record<Note['status'], string>> = {
  pending: 'Waiting to be transcribed…',
  transcribing: 'Transcribing…',
  'no-model': 'Waiting for the transcription model (download it in Setup)',
  failed: 'Transcription failed'
}

interface NoteItemProps {
  note: Note
  folderName: string
  onTextChange: (text: string | null) => void
  onRetranscribe: () => void
  onDelete: () => void
}

/** One voice note: play it, read or edit its text, retry transcription. */
export function NoteItem({
  note,
  folderName,
  onTextChange,
  onRetranscribe,
  onDelete
}: NoteItemProps): React.JSX.Element {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const text = note.text ?? note.transcript ?? ''
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])

  const toggle = (): void => {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play()
    else element.pause()
  }

  return (
    <div className="flex items-start gap-2 rounded-sm bg-fuselage-100/60 p-2 dark:bg-fuselage-800/60">
      <audio
        ref={audio}
        src={mediaUrl(folderName, note.audio)}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <Button variant="ghost" size="icon" aria-label={playing ? 'Pause note' : 'Play note'} onClick={toggle}>
        {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
        <span className="font-mono text-xs text-muted-foreground">
          {formatDuration(note.recordedAtMs)} · {Math.max(1, Math.round(note.durationMs / 1000))} s
        </span>
        {editing ? (
          <Textarea
            autoFocus
            value={draft}
            className="min-h-16 select-text"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(text)
                setEditing(false)
              } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
            onBlur={() => {
              setEditing(false)
              if (draft.trim() !== text) onTextChange(draft)
            }}
          />
        ) : text ? (
          <button
            className="cursor-text select-text text-left text-sm"
            title="Click to edit"
            onClick={() => setEditing(true)}
          >
            {text}
          </button>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {note.status === 'transcribing' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {STATUS_TEXT[note.status] ?? (
              <button className="cursor-text italic" onClick={() => setEditing(true)}>
                No speech recognised — click to type a note
              </button>
            )}
          </span>
        )}
      </div>
      {(note.status === 'failed' || note.status === 'done') && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Transcribe again"
          title="Transcribe again"
          onClick={onRetranscribe}
        >
          <RotateCcw className="size-4" aria-hidden />
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label="Delete note" onClick={onDelete}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  )
}
