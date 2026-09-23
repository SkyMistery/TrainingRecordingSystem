/** UI theme preference. "system" follows the Windows light/dark setting. */
export type ThemePreference = 'day' | 'night' | 'system'

/** Theme actually applied to the UI. */
export type Theme = 'day' | 'night'

export interface ThemeState {
  theme: Theme
  preference: ThemePreference
}
