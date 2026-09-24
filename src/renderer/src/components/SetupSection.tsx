import { useCallback, useState } from 'react'
import { CardContent, CardDescription, CardHeader, CardRoot, CardTitle } from '@ivao/atmosphere-react'
import { ChevronDown } from 'lucide-react'

const STORAGE_KEY = 'trs.setup.collapsed'

function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Makes a section open the next time the Setup page is shown. */
export function expandSection(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readCollapsed().filter((item) => item !== id)))
  } catch {
    // Opens collapsed: the trainer can still click it.
  }
}

/** Which Setup sections are collapsed, remembered between launches. */
export function useCollapsedSections(): {
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  setAll: (ids: string[] | null) => void
} {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed)
  const update = useCallback((next: string[]) => {
    setCollapsed(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Not remembered: the sections still work.
    }
  }, [])
  return {
    isOpen: (id) => !collapsed.includes(id),
    toggle: (id) => update(collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id]),
    /** Collapses the given sections, or expands everything with null. */
    setAll: (ids) => update(ids ?? [])
  }
}

export interface SectionProps {
  open: boolean
  onToggle: () => void
}

export function SetupSection({
  title,
  description,
  open,
  onToggle,
  contentClassName,
  children
}: SectionProps & {
  title: string
  description: React.ReactNode
  contentClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <CardRoot>
      <CardHeader className={open ? undefined : 'pb-6'}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="-m-2 flex items-start gap-3 rounded-md p-2 text-left hover:bg-fuselage-100/60 dark:hover:bg-fuselage-800/60"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <CardTitle>{title}</CardTitle>
            {open && <CardDescription>{description}</CardDescription>}
          </div>
          <ChevronDown
            className={`mt-1 size-5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
      </CardHeader>
      {open && <CardContent className={contentClassName}>{children}</CardContent>}
    </CardRoot>
  )
}
