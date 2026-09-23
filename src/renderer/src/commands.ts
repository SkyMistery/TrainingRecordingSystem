import type { SessionCommandName, SessionCommands } from '@shared/types'

/** Sends a session command: over IPC in the desktop app, over WebSocket in the Companion page. */
export type SendCommand = <K extends SessionCommandName>(name: K, ...args: SessionCommands[K]) => void
