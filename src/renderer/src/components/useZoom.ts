import { useCallback, useEffect, useRef, useState } from 'react'

export interface Zoom {
  scale: number
  x: number
  y: number
}

const MAX_SCALE = 8
const IDENTITY: Zoom = { scale: 1, x: 0, y: 0 }
/** Pointer travel (px) above which a press is a pan, not a click. */
const DRAG_THRESHOLD = 4

/** Keeps the zoomed content covering its frame (no empty borders). */
function clamp(zoom: Zoom, width: number, height: number): Zoom {
  const scale = Math.min(MAX_SCALE, Math.max(1, zoom.scale))
  return {
    scale,
    x: Math.min(0, Math.max(width - width * scale, zoom.x)),
    y: Math.min(0, Math.max(height - height * scale, zoom.y))
  }
}

/**
 * Wheel to zoom at the cursor, drag to pan, double-click to reset — to show a
 * trainee one label or area of the radar, readable even through Discord.
 */
export function useZoom(onClick: () => void): {
  zoom: Zoom
  frameProps: React.HTMLAttributes<HTMLDivElement> & { ref: React.RefObject<HTMLDivElement | null> }
  zoomBy: (factor: number) => void
  reset: () => void
} {
  const frame = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<Zoom>(IDENTITY)
  const drag = useRef<{ startX: number; startY: number; from: Zoom; moved: boolean } | null>(null)

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const element = frame.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const cx = (clientX ?? rect.left + rect.width / 2) - rect.left
    const cy = (clientY ?? rect.top + rect.height / 2) - rect.top
    setZoom((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(1, current.scale * factor))
      const ratio = scale / current.scale
      // The point under the cursor stays where it is.
      return clamp(
        { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio },
        rect.width,
        rect.height
      )
    })
  }, [])

  const reset = useCallback(() => setZoom(IDENTITY), [])

  // Native listener: React's wheel handlers are passive, so they can't stop the page from scrolling too.
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX, event.clientY)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const frameProps = {
    ref: frame,
    onDoubleClick: reset,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { startX: event.clientX, startY: event.clientY, from: zoom, moved: false }
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const current = drag.current
      if (!current) return
      const dx = event.clientX - current.startX
      const dy = event.clientY - current.startY
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      current.moved = true
      const rect = event.currentTarget.getBoundingClientRect()
      setZoom(clamp({ ...current.from, x: current.from.x + dx, y: current.from.y + dy }, rect.width, rect.height))
    },
    onPointerUp: () => {
      const current = drag.current
      drag.current = null
      if (current && !current.moved) onClick()
    }
  }

  return { zoom, frameProps, zoomBy: (factor) => zoomAt(factor), reset }
}
