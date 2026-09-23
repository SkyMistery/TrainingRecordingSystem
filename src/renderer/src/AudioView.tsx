import { useEffect } from 'react'
import type { AudioCommand } from '@shared/types'
import { encodeWav } from './wav'

const SAMPLE_RATE = 16_000
/** Audio kept from just before the key press, so the first syllable isn't cut. */
const PRE_ROLL_MS = 400
const PRE_ROLL_SAMPLES = (SAMPLE_RATE * PRE_ROLL_MS) / 1000
/** Keeps recording briefly after release: people let go while finishing a word. */
const TAIL_MS = 250
/** Shorter presses are treated as accidental taps. */
const MIN_NOTE_MS = 300

interface Capture {
  stream: MediaStream
  context: AudioContext
  processor: ScriptProcessorNode
}

let capture: Capture | null = null
let ring: Float32Array[] = []
let collecting: Float32Array[] | null = null

function ringSamples(): number {
  return ring.reduce((sum, chunk) => sum + chunk.length, 0)
}

async function open(deviceId: string): Promise<void> {
  close()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  // The context resamples the microphone to 16 kHz for us.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(2048, 1, 1)
  processor.onaudioprocess = (event) => {
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0))
    if (collecting) {
      collecting.push(chunk)
    } else {
      ring.push(chunk)
      while (ring.length > 1 && ringSamples() - ring[0].length >= PRE_ROLL_SAMPLES) ring.shift()
    }
  }
  source.connect(processor)
  processor.connect(context.destination)
  capture = { stream, context, processor }
}

function close(): void {
  if (!capture) return
  capture.processor.disconnect()
  capture.stream.getTracks().forEach((track) => track.stop())
  void capture.context.close()
  capture = null
  ring = []
  collecting = null
}

function start(): void {
  collecting = [...ring]
  ring = []
}

async function stop(token: string): Promise<void> {
  // Keep filling this note during the tail; a new note started meanwhile gets its own buffer.
  const chunks = collecting ?? []
  await new Promise((resolve) => setTimeout(resolve, TAIL_MS))
  if (collecting === chunks) collecting = null
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const durationMs = (samples / SAMPLE_RATE) * 1000
  if (!capture || durationMs < PRE_ROLL_MS + MIN_NOTE_MS + TAIL_MS) {
    await window.api.sendNoteAudio(token, null)
    return
  }
  await window.api.sendNoteAudio(token, { wav: encodeWav(chunks, SAMPLE_RATE), durationMs: Math.round(durationMs) })
}

/** Rendered in the hidden audio window: no UI, only microphone capture. */
export function AudioView(): null {
  useEffect(() => {
    const unsubscribe = window.api.onAudioCommand((command: AudioCommand) => {
      const run = async (): Promise<void> => {
        switch (command.type) {
          case 'open':
            return open(command.deviceId)
          case 'start':
            if (!capture) throw new Error('Microphone is not open')
            return start()
          case 'stop':
            return stop(command.token)
          case 'close':
            return close()
        }
      }
      run().catch((error: unknown) => {
        void window.api.reportAudioError(error instanceof Error ? error.message : String(error))
        if (command.type === 'stop') void window.api.sendNoteAudio(command.token, null)
      })
    })
    void window.api.reportAudioReady()
    return unsubscribe
  }, [])
  return null
}
