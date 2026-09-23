import { useCallback, useEffect, useState } from 'react'
import type { Theme, ThemePreference } from '@shared/theme'

interface ThemeState {
  theme: Theme
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

/**
 * Keeps the Atmosphere `dark` class on <html> in sync with the theme chosen in
 * the main process (Day, Night or following Windows).
 */
export function useTheme(): ThemeState {
  const [theme, setTheme] = useState<Theme>('day')
  const [preference, setPreferenceState] = useState<ThemePreference>('system')

  useEffect(() => {
    void window.api.getTheme().then((state) => {
      setTheme(state.theme)
      setPreferenceState(state.preference)
    })
    return window.api.onThemeChanged(setTheme)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'night')
  }, [theme])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    void window.api.setTheme(next).then(setTheme)
  }, [])

  return { theme, preference, setPreference }
}
