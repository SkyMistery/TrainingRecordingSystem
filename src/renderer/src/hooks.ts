import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, AudioLevels } from '@shared/types'

/** Application state owned by the main process, kept in sync through IPC. */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])
  return state
}

export function useAudioLevels(): AudioLevels {
  const [levels, setLevels] = useState<AudioLevels>({})
  useEffect(() => window.api.onAudioLevels(setLevels), [])
  return levels
}

/** A change to settings: the fields to set, or a function of the latest settings (for lists). */
export type SettingsPatch<T> = Partial<T> | ((current: T) => Partial<T>)

/**
 * Saves settings as patches on top of the latest value, counting the patches
 * still on their way to the main process: two quick edits (rename a
 * category, then add one) must not undo each other.
 */
export function usePatchSaver<T extends object>(
  value: T,
  send: (patch: Partial<T>) => Promise<unknown>
): (patch: SettingsPatch<T>) => Promise<void> {
  const latest = useRef(value)
  latest.current = value
  const pending = useRef<Partial<T>[]>([])
  return useCallback(
    async (patch: SettingsPatch<T>) => {
      const current = Object.assign({}, latest.current, ...pending.current) as T
      const resolved = typeof patch === 'function' ? patch(current) : patch
      pending.current.push(resolved)
      try {
        await send(resolved)
      } finally {
        pending.current = pending.current.filter((item) => item !== resolved)
      }
    },
    [send]
  )
}

/** Re-renders every `intervalMs` while `active`, returning the current time. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
