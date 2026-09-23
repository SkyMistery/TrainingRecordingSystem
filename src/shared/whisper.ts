import type { WhisperModelId } from './types'

export interface WhisperModelInfo {
  id: WhisperModelId
  label: string
  sizeMb: number
  description: string
}

/** Multilingual whisper.cpp models, downloaded on demand from Hugging Face. */
export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'base', label: 'Base', sizeMb: 142, description: 'Fastest, fine for clear speech' },
  { id: 'small', label: 'Small', sizeMb: 466, description: 'Recommended: accurate and quick' },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 Turbo',
    sizeMb: 547,
    description: 'Most accurate, slower on older CPUs'
  }
]

export const WHISPER_LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'pt', label: 'Português' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'el', label: 'Ελληνικά' },
  { value: 'ru', label: 'Русский' },
  { value: 'ar', label: 'العربية' }
]
