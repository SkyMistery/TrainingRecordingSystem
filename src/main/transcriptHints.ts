import { readFile } from 'node:fs/promises'
import { MAX_VOCABULARY_LENGTH } from '../shared/whisper'

/** English ATC terms trainers use whatever language they dictate in. */
const ATC_TERMS =
  'tower, ground, approach, departure, delivery, radar, clearance, readback, squawk, QNH, runway, taxi, ' +
  'holding point, line up, takeoff, go around, handoff, callsign, traffic, heading, vectors, flight level, ' +
  'ILS, SID, STAR, ATIS'

const ICAO_ALPHABET =
  'Alfa, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliett, Kilo, Lima, Mike, November, ' +
  'Oscar, Papa, Quebec, Romeo, Sierra, Tango, Uniform, Victor, Whiskey, X-ray, Yankee, Zulu'

/** How the hint starts, by dictation language: in that language, since whisper follows the prompt's style. */
const INTRO: Record<string, string> = {
  it: 'Note di un trainer ATC, in italiano con termini inglesi:',
  en: 'ATC trainer notes:'
}

/**
 * whisper-cli reads its arguments in the Windows ANSI code page: the hint is
 * kept to plain ASCII (accents dropped), which is enough to steer spelling.
 */
function toAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Vocabulary hint for whisper: ATC terms, the ICAO alphabet and the trainer's own words. */
export function buildPrompt(language: string, vocabulary: string): string {
  const own = toAscii(vocabulary.slice(0, MAX_VOCABULARY_LENGTH)).replace(/[\s,;]+$/, '')
  return `${INTRO[language] ?? INTRO.en} ${ATC_TERMS}. ${ICAO_ALPHABET}.${own ? ` ${own}.` : ''}`
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

/**
 * On silence whisper tends to repeat a stretch of the prompt ("QNH, squawk,
 * runway…"): that is no speech. A note that only uses words from the prompt
 * in its own order ("Taxi via Alfa, Bravo") is kept, as are one or two words.
 */
export function echoesPrompt(text: string, prompt: string): boolean {
  const said = words(text)
  if (said.length < 3) return false
  return ` ${words(prompt).join(' ')} `.includes(` ${said.join(' ')} `)
}

/** The loudest 100 ms of a voice note below this is no speech: whisper would only make words up. */
const SILENCE_DBFS = -50

/**
 * True when a 16-bit PCM WAV (as the app writes voice notes) holds no sound
 * louder than SILENCE_DBFS. Anything unexpected counts as not silent.
 */
export async function isSilent(wavPath: string): Promise<boolean> {
  const buffer = await readFile(wavPath)
  let offset = 12
  let rate = 0
  let bits = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      rate = buffer.readUInt32LE(offset + 12)
      bits = buffer.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      if (bits !== 16 || !rate) return false
      const data = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
      const count = Math.floor(data.length / 2)
      const window = Math.max(1, Math.round(rate / 10))
      const threshold = (10 ** (SILENCE_DBFS / 20) * 32768) ** 2
      for (let start = 0; start < count; start += window) {
        const end = Math.min(count, start + window)
        let sum = 0
        for (let i = start; i < end; i++) sum += data.readInt16LE(i * 2) ** 2
        if (sum / (end - start) > threshold) return false
      }
      return true
    }
    offset += 8 + size + (size % 2)
  }
  return false
}
