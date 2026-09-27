import { UiohookKey } from 'uiohook-napi'
import { sameKey } from '../shared/hotkey'
import { PLAYBACK_RATES } from '../shared/markers'
import type { Hotkey, MarkerSettings, PlayerCommand, PttTarget } from '../shared/types'
import { WHISPER_LANGUAGES, WHISPER_MODELS } from '../shared/whisper'
import { canSimulate } from './hotkeys'

/**
 * Checks on what the renderer and the Companion send: the main process never
 * trusts their values (a bug, or a page that isn't the app's, would otherwise
 * reach the settings file, OBS or the keyboard).
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A hotkey as the app records it; throws otherwise. */
export function validHotkey(value: unknown): Hotkey | null {
  if (value === null || value === undefined) return null
  if (
    !isObject(value) ||
    (value.device !== 'keyboard' && value.device !== 'mouse') ||
    !Number.isInteger(value.code) ||
    typeof value.ctrl !== 'boolean' ||
    typeof value.alt !== 'boolean' ||
    typeof value.shift !== 'boolean' ||
    typeof value.label !== 'string' ||
    value.label.length > 80
  ) {
    throw new Error('Invalid key')
  }
  return {
    device: value.device,
    code: value.code as number,
    ctrl: value.ctrl,
    alt: value.alt,
    shift: value.shift,
    label: value.label
  }
}

/** Keys that act on whatever window is in front: never pressed for a Companion button. */
const EDITING_KEYS = new Set<number>([
  UiohookKey.Enter,
  UiohookKey.Tab,
  UiohookKey.Escape,
  UiohookKey.Backspace,
  UiohookKey.Delete,
  UiohookKey.Space,
  UiohookKey.Meta,
  UiohookKey.MetaRight
])

const PTT_LABELS: Record<PttTarget, string> = { voiceChat: 'voice chat', aurora: 'Aurora' }

/**
 * A push-to-talk key the Companion may hold. The key also reaches the window
 * in front, so keys that do something there (Enter, Alt+F4, Ctrl+W…) are refused.
 */
export function validPttKey(target: PttTarget, value: unknown): Hotkey | null {
  const hotkey = validHotkey(value)
  if (!hotkey) return null
  const name = `The ${PTT_LABELS[target]} push-to-talk key`
  if (!canSimulate(hotkey)) throw new Error(`${name} (${hotkey.label}) can’t be pressed by the app: choose another one`)
  if (hotkey.alt)
    throw new Error(`${name} can’t use Alt: Alt combinations act on the window in front (Alt+F4 closes it)`)
  if (hotkey.device === 'keyboard' && EDITING_KEYS.has(hotkey.code)) {
    throw new Error(`${name} can’t be ${hotkey.label}: it would act on the window in front`)
  }
  if (hotkey.ctrl && hotkey.device === 'keyboard' && !/^F\d+$/.test(hotkey.label.split(' + ').at(-1) ?? '')) {
    throw new Error(
      `${name} can use Ctrl only with a function key (F1–F24): Ctrl+letter is a shortcut in most programs`
    )
  }
  return hotkey
}

/**
 * Push-to-talk keys and the voice-note key must differ: a note would go out
 * on the voice chat or on frequency, and a button would start a note.
 */
export function checkKeyConflicts(ptt: Record<PttTarget, Hotkey | null>, voiceNote: Hotkey | null): void {
  if (sameKey(ptt.voiceChat, ptt.aurora)) throw new Error('The two push-to-talk keys must be different')
  if (sameKey(ptt.aurora, voiceNote)) {
    throw new Error('The Aurora push-to-talk key is your voice-note key: your notes would be transmitted on frequency')
  }
  if (sameKey(ptt.voiceChat, voiceNote)) {
    throw new Error(
      'The voice chat push-to-talk key is your voice-note key: your notes would be heard in the voice chat'
    )
  }
}

export function validMarkerSettings(patch: unknown): Partial<MarkerSettings> {
  if (!isObject(patch)) throw new Error('Invalid settings')
  const result: Partial<MarkerSettings> = {}
  if ('preRollSeconds' in patch) {
    const value = Number(patch.preRollSeconds)
    if (!Number.isFinite(value) || value < 0 || value > 600) throw new Error('Invalid pre-roll')
    result.preRollSeconds = value
  }
  if ('sound' in patch) result.sound = Boolean(patch.sound)
  if ('statusWindow' in patch) result.statusWindow = Boolean(patch.statusWindow)
  if ('hotkeys' in patch) {
    if (!isObject(patch.hotkeys)) throw new Error('Invalid hotkeys')
    result.hotkeys = {
      marker: validHotkey(patch.hotkeys.marker),
      range: validHotkey(patch.hotkeys.range),
      voiceNote: validHotkey(patch.hotkeys.voiceNote)
    }
  }
  if ('categories' in patch) {
    if (!Array.isArray(patch.categories) || patch.categories.length > 50) throw new Error('Invalid categories')
    result.categories = patch.categories.map((category: unknown) => {
      if (
        !isObject(category) ||
        typeof category.id !== 'string' ||
        typeof category.name !== 'string' ||
        typeof category.color !== 'string' ||
        !/^#[0-9a-f]{6}$/i.test(category.color) ||
        category.name.length > 60
      ) {
        throw new Error('Invalid category')
      }
      return { id: category.id, name: category.name, color: category.color, hotkey: validHotkey(category.hotkey) }
    })
  }
  return result
}

export function validModel(value: unknown): (typeof WHISPER_MODELS)[number]['id'] {
  const model = WHISPER_MODELS.find((item) => item.id === value)
  if (!model) throw new Error('Unknown model')
  return model.id
}

export function validLanguage(value: unknown): string {
  if (!WHISPER_LANGUAGES.some((item) => item.value === value)) throw new Error('Unknown language')
  return value as string
}

/** A player command from any view (the Companion included). */
export function validPlayerCommand(value: unknown): PlayerCommand {
  if (!isObject(value)) throw new Error('Invalid player command')
  const finite = (key: string): number => {
    const number = value[key]
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error('Invalid player command')
    return number
  }
  switch (value.type) {
    case 'toggle':
    case 'play':
    case 'pause':
      return { type: value.type }
    case 'seek':
      return { type: 'seek', positionMs: finite('positionMs') }
    case 'skip':
      return { type: 'skip', deltaMs: finite('deltaMs') }
    case 'marker':
      return { type: 'marker', direction: finite('direction') > 0 ? 1 : -1 }
    case 'rate': {
      const rate = finite('rate')
      if (!PLAYBACK_RATES.includes(rate)) throw new Error('Invalid playback speed')
      return { type: 'rate', rate }
    }
    default:
      throw new Error('Invalid player command')
  }
}
