import { useState } from 'react'
import {
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  Button,
  Checkbox,
  Label
} from '@ivao/atmosphere-react'
import { TERMS_VERSION } from '@shared/terms'
import terms from '../../../../docs/TERMS.md?raw'

const REPOSITORY = 'https://github.com/SkyMistery/TrainingRecordingSystem/blob/main'

/** Links, bold and code of one line of the terms; relative links point to the repository. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const href = link[2].startsWith('http') ? link[2] : `${REPOSITORY}/${link[2].replace(/^\.\.\//, '')}`
      return (
        <a key={i} href={href} target="_blank" rel="noreferrer" className="underline">
          {link[1]}
        </a>
      )
    }
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

/** The few Markdown forms TERMS.md uses: headings, paragraphs, bullet and numbered lists. */
function TermsText({ source }: { source: string }): React.JSX.Element {
  const blocks: React.JSX.Element[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = (): void => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>)
    paragraph = []
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>)
      blocks.push(
        list.ordered ? (
          <ol key={blocks.length} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={blocks.length} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        )
      )
    }
    list = null
  }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    const item = /^(-|\d+\.)\s+(.*)$/.exec(line)
    if (!line) {
      flush()
    } else if (line.startsWith('#')) {
      flush()
      // The dialog already shows the title; section headings stay.
      if (line.startsWith('## ')) {
        blocks.push(
          <h3 key={blocks.length} className="pt-2 text-base font-semibold">
            {line.slice(3)}
          </h3>
        )
      }
    } else if (item) {
      const ordered = item[1] !== '-'
      if (paragraph.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(item[2])
    } else if (list) {
      // Continuation of a list item.
      list.items[list.items.length - 1] += ` ${line}`
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return <div className="flex flex-col gap-3 text-sm">{blocks}</div>
}

/**
 * Shown before the app can be used, and again when the terms change: the user
 * must accept them (or quit). An alert dialog: no close button, and neither
 * Escape nor a click outside dismisses it.
 */
export function TermsDialog({ open }: { open: boolean }): React.JSX.Element {
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <AlertDialogRoot open={open}>
      <AlertDialogPortal>
        <AlertDialogOverlay />
        <AlertDialogContent className="max-w-2xl bg-body">
          <AlertDialogHeader>
            <AlertDialogTitle>Terms of use</AlertDialogTitle>
            <AlertDialogDescription>
              Please read them before using Training Recording System. They protect the people you record, and you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border p-4">
            <TermsText source={terms} />
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="accept-terms" checked={agreed} onCheckedChange={(value) => setAgreed(value === true)} />
            <Label htmlFor="accept-terms" className="text-sm font-normal leading-snug">
              I have read the terms of use and I accept them.
            </Label>
          </div>
          {error && <p className="text-sm text-semantic-red-600">{error}</p>}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => window.close()}>
              Quit
            </Button>
            <Button
              disabled={!agreed}
              isLoading={saving}
              onClick={() => {
                setSaving(true)
                setError(null)
                window.api
                  .acceptTerms(TERMS_VERSION)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setSaving(false))
              }}
            >
              Accept
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  )
}
