import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adoptRecording, loadSession, sessionPath } from '../../src/main/sessions'

test('paths stored in session.json stay inside the session', () => {
  assert.equal(sessionPath('notes/n-0001.wav'), 'notes/n-0001.wav')
  assert.equal(sessionPath('shots\\m-0001.png'), 'shots/m-0001.png')
  for (const bad of [
    '../x.png',
    '..\\..\\Desktop',
    'C:\\Windows\\x',
    '\\\\server\\share\\x',
    'a/./b',
    'x.wav:stream',
    '',
    null,
    42
  ]) {
    assert.equal(sessionPath(bad), null, String(bad))
  }
})

test('a hand-edited or foreign session.json is made safe when read', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trs-unit-session-'))
  try {
    const session = {
      schemaVersion: 1,
      id: 'x',
      createdAt: '2026-09-27T10:00:00.000Z',
      metadata: {
        date: '2026-09-27',
        traineeVid: '1',
        traineeName: '',
        position: 'X',
        trainingType: 'Training',
        trainerVid: ''
      },
      recording: { file: 'C:\\Users\\someone\\elsewhere.mp4', startedAt: '', durationMs: 'x', display: null },
      markers: [
        null,
        {
          id: 'a',
          number: 1,
          kind: 'point',
          timeMs: 1000,
          screenshot: '..\\..\\Desktop',
          categoryId: 'positive',
          notes: [
            {
              id: 'n1',
              audio: 'notes/n-0001.wav',
              durationMs: 1000,
              recordedAtMs: 0,
              transcript: null,
              status: 'done',
              text: null
            },
            {
              id: 'n2',
              audio: '..\\secret.wav',
              durationMs: 1000,
              recordedAtMs: 0,
              transcript: null,
              status: 'done',
              text: null
            }
          ]
        },
        { id: 'b', kind: 'range', timeMs: 'bad', notes: 'not a list' }
      ]
    }
    // Saved with a byte order mark, as Notepad may do.
    writeFileSync(join(folder, 'session.json'), '\uFEFF' + JSON.stringify(session))
    const loaded = await loadSession(folder)
    assert.equal(loaded.recording?.file, null, 'an absolute path elsewhere is dropped')
    assert.equal(loaded.markers.length, 2, 'non-objects are dropped')
    assert.equal(loaded.markers[0].screenshot, null)
    assert.deepEqual(loaded.markers[0].categoryIds, ['positive'], 'v1.0 single category converted')
    assert.deepEqual(
      loaded.markers[0].notes.map((note) => note.id),
      ['n1'],
      'a note whose audio is outside the session is dropped'
    )
    assert.equal(loaded.markers[1].timeMs, 0)
    assert.deepEqual(loaded.markers[1].notes, [])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a damaged session.json is read from its backup, and kept aside', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trs-unit-session-'))
  try {
    const good = {
      schemaVersion: 1,
      id: 'x',
      createdAt: 'now',
      metadata: { date: '2026-09-27' },
      recording: null,
      markers: []
    }
    writeFileSync(join(folder, 'session.json'), '{ broken')
    writeFileSync(join(folder, 'session.json.bak'), JSON.stringify(good))
    const loaded = await loadSession(folder)
    assert.equal(loaded.id, 'x')
    assert.equal(readFileSync(join(folder, 'session.damaged.json'), 'utf8'), '{ broken')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a recording is never moved over another one', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trs-unit-adopt-'))
  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'recording.mp4'), 'first')
    writeFileSync(join(folder, 'obs.mp4'), 'second')
    const name = await adoptRecording(folder, join(folder, 'obs.mp4'))
    assert.equal(name, 'recording-2.mp4')
    assert.equal(readFileSync(join(folder, 'recording.mp4'), 'utf8'), 'first')
    assert.equal(readFileSync(join(folder, 'recording-2.mp4'), 'utf8'), 'second')
    assert.equal(existsSync(join(folder, 'obs.mp4')), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
