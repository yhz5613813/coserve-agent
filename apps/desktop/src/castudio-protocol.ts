/** Private Electron channels for the local CAStudio service. */
export const CASTUDIO_IPC = {
  request: 'coserve-castudio:request',
  subscribe: 'coserve-castudio:subscribe',
  unsubscribe: 'coserve-castudio:unsubscribe',
  event: 'coserve-castudio:event',
  workspace: 'coserve-castudio:workspace',
  status: 'coserve-castudio:status',
  statusChanged: 'coserve-castudio:status-changed',
  restart: 'coserve-castudio:restart',
} as const

/**
 * Why CAStudio is not serving: `data-locked` (exit 75) and `port-in-use` (exit 76) are CAStudio's own exit codes,
 * `exited` is any other exit, `unreachable` is an external origin whose health check never answered.
 */
export type CAStudioFailure = 'unavailable' | 'spawn-failed' | 'data-locked' | 'port-in-use' | 'exited' | 'timeout' | 'unreachable' | 'stopped'

/** Service status the desktop reports to the CAD panel; `exited` means the service stopped after it was ready. */
export type CAStudioServiceStatus =
  | { readonly state: 'starting' }
  | { readonly state: 'ready' }
  | { readonly state: 'failed' | 'exited'; readonly reason: CAStudioFailure; readonly detail: string }

/** Event envelope emitted by the CAStudio project event stream. */
export interface CAStudioEvent {
  id: number
  type: string
  data: unknown
}

/** One desktop subscription's data or terminal connection failure. */
export interface CAStudioEventMessage {
  subscriptionId: string
  event?: CAStudioEvent
  error?: string
}
