import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UiohookKey } from 'uiohook-napi'
import { bestMatch, pressMatches } from '../../src/shared/hotkey'
import type { Hotkey } from '../../src/shared/types'
import { checkKeyConflicts, validPlayerCommand, validPttKey } from '../../src/main/validate'

const key = (code: number, label: string, mods: Partial<Hotkey> = {}): Hotkey => ({
  device: 'keyboard',
  code,
  ctrl: false,
  alt: false,
  shift: false,
  label,
  ...mods
})
const F9 = key(UiohookKey.F9, 'F9')

test('a hotkey fires with extra modifiers held (talking on Right Ctrl or AltGr)', () => {
  assert.equal(pressMatches(key(UiohookKey.F9, 'Ctrl + F9', { ctrl: true }), F9), true)
  assert.equal(pressMatches(key(UiohookKey.F9, 'Ctrl + Alt + F9', { ctrl: true, alt: true }), F9), true)
  assert.equal(pressMatches(F9, key(UiohookKey.F9, 'Ctrl + F9', { ctrl: true })), false)
})

test('the most specific binding wins', () => {
  const bindings = [
    { binding: F9, value: 'marker' },
    { binding: key(UiohookKey.F9, 'Ctrl + F9', { ctrl: true }), value: 'range' }
  ]
  assert.equal(bestMatch(key(UiohookKey.F9, 'Ctrl + F9', { ctrl: true }), bindings), 'range')
  assert.equal(bestMatch(F9, bindings), 'marker')
  assert.equal(bestMatch(key(UiohookKey.F10, 'F10'), bindings), undefined)
})

test('push-to-talk keys that would act on the window in front are refused', () => {
  for (const bad of [
    key(UiohookKey.Enter, 'Enter'),
    key(UiohookKey.Space, 'Space'),
    key(UiohookKey.F4, 'Alt + F4', { alt: true }),
    key(UiohookKey.W, 'Ctrl + W', { ctrl: true })
  ]) {
    assert.throws(() => validPttKey('aurora', bad), Error, bad.label)
  }
  assert.equal(validPttKey('aurora', key(UiohookKey.CtrlRight, 'Right Ctrl'))?.label, 'Right Ctrl')
  assert.equal(validPttKey('voiceChat', key(UiohookKey.F16, 'Ctrl + F16', { ctrl: true }))?.label, 'Ctrl + F16')
  assert.equal(validPttKey('voiceChat', null), null)
})

test('the voice-note key can’t be a push-to-talk key', () => {
  const rightCtrl = key(UiohookKey.CtrlRight, 'Right Ctrl')
  assert.throws(() => checkKeyConflicts({ voiceChat: null, aurora: rightCtrl }, rightCtrl), /frequency/)
  assert.throws(() => checkKeyConflicts({ voiceChat: rightCtrl, aurora: null }, rightCtrl), /voice chat/)
  assert.throws(() => checkKeyConflicts({ voiceChat: rightCtrl, aurora: rightCtrl }, null))
  assert.doesNotThrow(() => checkKeyConflicts({ voiceChat: F9, aurora: rightCtrl }, key(UiohookKey.F10, 'F10')))
})

test('player commands are checked', () => {
  assert.deepEqual(validPlayerCommand({ type: 'seek', positionMs: 1000 }), { type: 'seek', positionMs: 1000 })
  assert.deepEqual(validPlayerCommand({ type: 'rate', rate: 10 }), { type: 'rate', rate: 10 })
  for (const bad of [null, { type: 'rate', rate: 1e9 }, { type: 'seek', positionMs: NaN }, { type: 'eval' }]) {
    assert.throws(() => validPlayerCommand(bad), Error, JSON.stringify(bad))
  }
})
