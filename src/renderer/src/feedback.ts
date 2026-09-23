import { useEffect } from 'react'
import type { MarkerFeedback } from '@shared/types'

let context: AudioContext | null = null

/** [start Hz, end Hz, duration s, delay s] per tone. */
const TONES: Record<MarkerFeedback, [number, number, number, number][]> = {
  marker: [[880, 880, 0.08, 0]],
  rangeStart: [[660, 990, 0.14, 0]],
  rangeEnd: [[990, 660, 0.14, 0]],
  category: [
    [1200, 1200, 0.05, 0],
    [1200, 1200, 0.05, 0.08]
  ],
  noteStart: [[520, 780, 0.1, 0]],
  noteEnd: [[780, 520, 0.1, 0]],
  error: [[220, 220, 0.2, 0]]
}

function play(kind: MarkerFeedback): void {
  context ??= new AudioContext()
  const now = context.currentTime
  for (const [from, to, duration, delay] of TONES[kind]) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.setValueAtTime(from, now + delay)
    oscillator.frequency.linearRampToValueAtTime(to, now + delay + duration)
    gain.gain.setValueAtTime(0.0001, now + delay)
    gain.gain.exponentialRampToValueAtTime(0.25, now + delay + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(now + delay)
    oscillator.stop(now + delay + duration + 0.02)
  }
}

/** Short confirmation tones for hotkeys, which are pressed without looking at the app. */
export function useMarkerFeedbackSound(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    return window.api.onMarkerFeedback(play)
  }, [enabled])
}
