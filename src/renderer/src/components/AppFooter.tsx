import { TERMS_URL } from '@shared/terms'
import symbol from '../assets/it-symbol.svg'
import symbolWhite from '../assets/it-symbol-white.svg'

export const AUTHOR = 'Carmine (704798)'
export const DIVISION = 'IVAO Italy Division'
export const COPYRIGHT = `© 2026 ${AUTHOR}`

/** Credits at the bottom of every page of the app and of the Companion. */
export function AppFooter({ version }: { version?: string }): React.JSX.Element {
  return (
    <footer className="flex items-center justify-center gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <img src={symbol} alt="" className="size-6 shrink-0 dark:hidden" />
      <img src={symbolWhite} alt="" className="hidden size-6 shrink-0 dark:block" />
      <p>
        Training Recording System{version && ` v${version}`} — made by{' '}
        <strong className="whitespace-nowrap font-semibold text-foreground">{AUTHOR}</strong> and the{' '}
        <strong className="whitespace-nowrap font-semibold text-foreground">{DIVISION}</strong>
        <span className="mx-2" aria-hidden>
          ·
        </span>
        <span className="whitespace-nowrap">{COPYRIGHT}</span>
        <span className="mx-2" aria-hidden>
          ·
        </span>
        <a href={TERMS_URL} target="_blank" rel="noreferrer" className="whitespace-nowrap underline">
          Terms of use
        </a>
      </p>
    </footer>
  )
}
