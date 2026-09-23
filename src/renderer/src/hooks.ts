import { useEffect, useState } from 'react'
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
