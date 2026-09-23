import { useEffect, useRef, useState } from 'react'
import type { CompanionState, SessionCommandName, SessionCommands } from '@shared/types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unpaired'

interface Connection {
  status: ConnectionStatus
  state: CompanionState | null
  send: <K extends SessionCommandName>(name: K, ...args: SessionCommands[K]) => Promise<void>
}

const RETRY_MS = 2000

/**
 * WebSocket link to the app. It reconnects on its own (Wi-Fi drops, app
 * restarts); the pairing cookie is sent automatically by the browser.
 */
export function useCompanionConnection(): Connection {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [state, setState] = useState<CompanionState | null>(null)
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
        const message = JSON.parse(String(event.data)) as
          { type: 'state'; state: CompanionState } | { type: 'result'; id: number; error?: string }
        if (message.type === 'state') {
          setState(message.state)
        } else {
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
        void fetch('/', { method: 'HEAD' })
          .then((response) => setStatus(response.status === 401 ? 'unpaired' : 'disconnected'))
          .catch(() => setStatus('disconnected'))
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
      pending.current.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, name, args }))
    })

  return { status, state, send }
}
