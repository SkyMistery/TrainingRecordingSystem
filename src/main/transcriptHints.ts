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
export function toAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Vocabulary hint for whisper: the trainer's own words, ATC terms and the ICAO
 * alphabet. whisper keeps only the end of a long prompt, so the intro (the
 * language's style) and the trainer's words come last, where they are kept.
 */
export function buildPrompt(language: string, vocabulary: string): string {
  const own = toAscii(vocabulary.slice(0, MAX_VOCABULARY_LENGTH)).replace(/[\s,;]+$/, '')
  return `${ICAO_ALPHABET}. ${ATC_TERMS}. ${INTRO[language] ?? INTRO.en}${own ? ` ${own}.` : ''}`
}

/** Words in any script (a Greek or Russian note is not made of the prompt's words). */
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * On silence whisper tends to repeat a stretch of the prompt ("QNH, squawk,
 * runway, taxi, holding point…"): that is no speech. Only a long run of prompt
 * words in the prompt's own order counts: a real note that happens to use a
 * few of them ("Line up, takeoff", "Alfa Bravo Charlie") is kept.
 */
export function echoesPrompt(text: string, prompt: string): boolean {
  const said = words(text)
  if (said.length < 6) return false
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

/**
 * Whisper marks silence and noises with tags like [BLANK_AUDIO] or (wind
 * blowing): they go. Brackets with digits are words ("QNH (1013)") and stay.
 */
export function cleanTranscript(output: string, prompt: string): string {
  const text = output
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?![^)]*\d)[^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return echoesPrompt(text, prompt) ? '' : text
}
