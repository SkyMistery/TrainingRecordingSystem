/**
 * Opens the chosen microphone. Browser device ids are per-origin and can change
 * (driver updates, replugging, dev vs packaged app), so the saved id is tried
 * first, then the device with the same name, then the Windows default.
 */
export async function openMicrophone(
  deviceId: string,
  label: string,
  constraints: MediaTrackConstraints = {}
): Promise<{ stream: MediaStream; fallback: boolean }> {
  const open = (id?: string): Promise<MediaStream> =>
    navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: id ? { exact: id } : undefined } })

  if (deviceId && deviceId !== 'default') {
    try {
      return { stream: await open(deviceId), fallback: false }
    } catch (error) {
      const name = (error as DOMException).name
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    const sameName = devices.find((device) => device.kind === 'audioinput' && device.label === label)
    if (sameName) return { stream: await open(sameName.deviceId), fallback: false }
    return { stream: await open(), fallback: true }
  }
  return { stream: await open(), fallback: false }
}

/** DOMException messages are often empty: include the name. */
export function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}${error.message ? `: ${error.message}` : ''}`
  return error instanceof Error ? error.message : String(error)
}
