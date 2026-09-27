import { useEffect, useRef, useState } from 'react'
import type { CompanionState, PlayerState, SessionCommandName, SessionCommands } from '@shared/types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unpaired'

interface Connection {
  status: ConnectionStatus
  state: CompanionState | null
  /** This device's id, as the app knows it (to tell its own push-to-talk from another device's). */
  deviceId: string | null
  /** The app's clock minus this device's: times from the app (the player, the recording) are on its clock. */
  clockOffsetMs: number
  send: <K extends SessionCommandName>(name: K, ...args: SessionCommands[K]) => Promise<void>
}

type Message =
  | { type: 'hello'; deviceId: string }
  | { type: 'state'; state: CompanionState; serverNow: number }
  | { type: 'player'; player: PlayerState; serverNow: number }
  | { type: 'result'; id: number | null; error?: string }

const RETRY_MS = 2000
/** A half-open connection (phone waking up) never answers: give up on a command after this. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * WebSocket link to the app. It reconnects on its own (Wi-Fi drops, app
 * restarts); the pairing cookie is sent automatically by the browser.
 */
export function useCompanionConnection(): Connection {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [state, setState] = useState<CompanionState | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [clockOffsetMs, setClockOffset] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const pending = useRef(new Map<number, { resolve: () => void; reject: (error: Error) => void }>())
  const nextId = useRef(1)

  useEffect(() => {
    let stopped = false
    let retry: number | undefined

    const connect = (): void => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.current = ws
      let opened = false
      ws.onopen = () => {
        if (socket.current !== ws) return
        opened = true
        setStatus('connected')
      }
      ws.onmessage = (event) => {
        let message: Message
        try {
          message = JSON.parse(String(event.data)) as Message
        } catch {
          return
        }
        if (message.type === 'hello') {
          setDeviceId(message.deviceId)
        } else if (message.type === 'state') {
          setClockOffset(message.serverNow - Date.now())
          setState(message.state)
        } else if (message.type === 'player') {
          setClockOffset(message.serverNow - Date.now())
          setState((current) =>
            current?.review ? { ...current, review: { ...current.review, player: message.player } } : current
          )
        } else if (message.id !== null) {
          const request = pending.current.get(message.id)
          pending.current.delete(message.id)
          if (message.error) request?.reject(new Error(message.error))
          else request?.resolve()
        }
      }
      ws.onclose = () => {
        // A socket already replaced (reconnect, or React re-running the effect)
        // must not clear the live one.
        if (socket.current !== ws) return
        socket.current = null
        for (const request of pending.current.values()) request.reject(new Error('Disconnected'))
        pending.current.clear()
        if (stopped) return
        // A refused handshake before opening usually means this device isn't paired (any more).
        // The answer may come after the retry already reconnected: then it is stale.
        const stillDown = (): boolean => socket.current === null || socket.current.readyState !== WebSocket.OPEN
        void fetch('/', { method: 'HEAD' })
          .then((response) => stillDown() && setStatus(response.status === 401 ? 'unpaired' : 'disconnected'))
          .catch(() => stillDown() && setStatus('disconnected'))
        if (!opened) setStatus('disconnected')
        retry = window.setTimeout(connect, RETRY_MS)
      }
    }
    connect()
    return () => {
      stopped = true
      window.clearTimeout(retry)
      socket.current?.close()
    }
  }, [])

  const send = <K extends SessionCommandName>(name: K, ...args: SessionCommands[K]): Promise<void> =>
    new Promise((resolve, reject) => {
      const ws = socket.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to the app'))
        return
      }
      const id = nextId.current++
      const timer = window.setTimeout(() => {
        if (!pending.current.delete(id)) return
        reject(new Error('The app did not answer'))
        // Most likely a dead connection: start over.
        if (socket.current === ws) ws.close()
      }, REQUEST_TIMEOUT_MS)
      pending.current.set(id, {
        resolve: () => {
          window.clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          window.clearTimeout(timer)
          reject(error)
        }
      })
      ws.send(JSON.stringify({ id, name, args }))
    })

  return { status, state, deviceId, clockOffsetMs, send }
}
