import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildPrompt, cleanTranscript, echoesPrompt, isSilent } from '../../src/main/transcriptHints'

const prompt = buildPrompt('it', 'NASUM, UXUTO, Ciampino')

test('the prompt is plain ASCII and ends with the trainer’s own words', () => {
  assert.match(prompt, /^[\x20-\x7e]+$/)
  assert.ok(prompt.endsWith('NASUM, UXUTO, Ciampino.'))
  assert.ok(buildPrompt('en', 'Città Ελλάδα').endsWith('Citta.'))
})

test('a real note using a few prompt words is kept', () => {
  for (const note of [
    'Line up, takeoff.',
    'Takeoff, go around.',
    'Tower, ground, approach.',
    'Alfa Bravo Charlie Delta',
    'Traffic, heading, vectors.',
    'Ο εκπαιδευόμενος ξέχασε readback, squawk, QNH'
  ]) {
    assert.equal(echoesPrompt(note, prompt), false, note)
  }
})

test('a long run of the prompt read back (whisper on silence) is no speech', () => {
  assert.equal(echoesPrompt('Tower, ground, approach, departure, delivery, radar, clearance.', prompt), true)
  assert.equal(cleanTranscript('Tower, ground, approach, departure, delivery, radar.', prompt), '')
})

test('whisper’s tags go, numbers in brackets stay', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO] QNH (1013) please (wind blowing)', prompt), 'QNH (1013) please')
})

function wav(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('silence is recognised, a voice is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trs-unit-wav-'))
  try {
    const quiet = new Int16Array(16000).map(() => Math.round((Math.random() - 0.5) * 20))
    const loud = new Int16Array(16000).map((_, i) => Math.round(Math.sin(i / 5) * 8000))
    writeFileSync(join(dir, 'quiet.wav'), wav(quiet))
    writeFileSync(join(dir, 'loud.wav'), wav(loud))
    assert.equal(await isSilent(join(dir, 'quiet.wav')), true)
    assert.equal(await isSilent(join(dir, 'loud.wav')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
