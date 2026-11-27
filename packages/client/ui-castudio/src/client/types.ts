/** CAstudio's existing REST and SSE wire contracts, independent of DSH Sessions. */
export interface StudioEvent { id: number; type: string; data: unknown }
export interface StudioEventEnvelope { subscriptionId: string; event?: StudioEvent; error?: string }
/** Why the desktop-managed CAStudio service is not serving; the desktop's `CAStudioFailure` values. */
export type StudioServiceFailure = 'unavailable' | 'spawn-failed' | 'data-locked' | 'port-in-use' | 'exited' | 'timeout' | 'unreachable' | 'stopped'
/** Desktop-managed service status; `exited` means the service stopped after it was ready. */
export type StudioServiceStatus =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'failed' | 'exited'; reason: StudioServiceFailure; detail: string }
/** Status and restart of the CAStudio process the desktop owns; `onStatus` delivers changes after the first `status()`. */
export interface StudioService {
  status(): Promise<StudioServiceStatus>
  restart(): Promise<void>
  onStatus(listener: (status: StudioServiceStatus) => void): () => void
}
export interface StudioBridge {
  request(path: string, method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<unknown>
  subscribe(projectId: string, subscriptionId: string, afterEventId?: number): Promise<void>
  unsubscribe(subscriptionId: string): Promise<void>
  onEvent(listener: (message: StudioEventEnvelope) => void): () => void
  workspaceUrl(projectId: string): Promise<string>
  /** Present only under the desktop; a browser's gateway owns CAStudio. */
  service?: StudioService
}
