import type { StudioBridge, StudioEvent, StudioEventEnvelope } from './types.ts'

/**
 * Studio bridge for a plain browser, used when no desktop preload exposes `dshCAStudio`.
 * CAStudio must be reachable on the same origin at `castudio/` relative to the page, which
 * the deployment gateway provides; same-origin requests avoid CORS and carry no credentials
 * beyond what the gateway already accepts.
 * @param base - absolute URL of the CAStudio mount, ending in `/`.
 * @returns a bridge over CAStudio's REST and SSE endpoints.
 */
export function createBrowserBridge(base: URL): StudioBridge {
  const listeners = new Set<(message: StudioEventEnvelope) => void>()
  const streams = new Map<string, EventSource>()
  const emit = (message: StudioEventEnvelope): void => { for (const listener of listeners) listener(message) }
  const url = (path: string): URL => {
    if (!path.startsWith('/api/')) throw new Error(`CAStudio path must start with /api/: ${path}`)
    return new URL(path.slice(1), base)
  }
  return {
    async request(path, method = 'GET', body) {
      const response = await fetch(url(path), {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const json = (response.headers.get('content-type') ?? '').includes('application/json')
      const payload: unknown = json ? await response.json() : await response.text()
      if (!response.ok) {
        const detail = typeof payload === 'object' && payload !== null && 'error' in payload ? String(payload.error) : String(payload)
        throw new Error(`CAStudio HTTP ${response.status}: ${detail}`)
      }
      return payload
    },
    async subscribe(projectId, subscriptionId) {
      streams.get(subscriptionId)?.close()
      // EventSource resends Last-Event-ID on its own reconnects, so no event is replayed twice.
      const source = new EventSource(url(`/api/projects/${encodeURIComponent(projectId)}/events`))
      source.onmessage = (message) => { emit({ subscriptionId, event: JSON.parse(message.data) as StudioEvent }) }
      source.onerror = () => { if (source.readyState === EventSource.CLOSED) emit({ subscriptionId, error: 'CAStudio event stream closed' }) }
      streams.set(subscriptionId, source)
    },
    async unsubscribe(subscriptionId) {
      streams.get(subscriptionId)?.close()
      streams.delete(subscriptionId)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async workspaceUrl(projectId) {
      return new URL(`?embedded=1&project=${encodeURIComponent(projectId)}`, base).href
    },
  }
}
