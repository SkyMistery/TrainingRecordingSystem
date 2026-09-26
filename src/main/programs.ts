/** Parts of Windows itself: never offered as an audio source or as a window to hide. */
export const IGNORED_EXECUTABLES = new Set([
  'explorer.exe',
  'searchhost.exe',
  'shellexperiencehost.exe',
  'textinputhost.exe'
])
