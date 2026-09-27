import { Mic, TriangleAlert } from 'lucide-react'
import type { AppState, PttTarget } from '@shared/types'

const PTT_NAMES: Record<PttTarget, string> = { voiceChat: 'Voice chat', aurora: 'Aurora' }

/**
 * What the app is doing with the keyboard right now, on every page: a
 * push-to-talk key held for a Companion device (with a way to let go of it
 * from the PC), a key Windows didn't let it release, hotkeys that don't work.
 */
export function KeysBar({ state }: { state: AppState }): React.JSX.Element | null {
  if (state.pttHolds.length === 0 && !state.stuckKey && !state.hotkeysError) return null
  return (
    <div className="flex flex-col gap-1 bg-semantic-red-600 px-4 py-2 text-sm text-white" role="status">
      {state.pttHolds.map((hold) => (
        <div key={hold.target} className="flex items-center gap-3">
          <Mic className="size-4 animate-pulse" aria-hidden />
          <span>
            <strong>Talking: {PTT_NAMES[hold.target]}</strong> — held from {hold.deviceName}
          </span>
          <button
            className="ml-auto rounded-sm bg-white/20 px-3 py-0.5 text-xs font-semibold hover:bg-white/30"
            onClick={() => void window.api.releasePtt(hold.target).catch(() => undefined)}
          >
            Release
          </button>
        </div>
      ))}
      {[state.stuckKey, state.hotkeysError].filter(Boolean).map((problem) => (
        <div key={problem} className="flex items-center gap-3">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          <span>{problem}</span>
        </div>
      ))}
    </div>
  )
}
