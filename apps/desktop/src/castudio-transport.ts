/** HTTP and SSE transport to the separately owned, loopback-only CAStudio process. */
import { createParser } from 'eventsource-parser'
import type { CAStudioEvent } from './castudio-protocol.ts'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Validate the locally configured service address before any request. The desktop and the service manager both use
 * this check, so every accepted origin is one the service manager can probe.
 * @param value - Desktop launch configuration, never supplied by the renderer.
 * @returns The service origin, with no path or credentials.
 * @throws when the origin is not HTTP(S) on 127.0.0.1, localhost, or [::1], or names port 0.
 */
export function caStudioOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTNAMES.has(url.hostname) || url.port === '0'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`CAStudio must use an HTTP(S) origin on 127.0.0.1, localhost, or [::1] with a nonzero port: ${value}`)
  }
  return url.origin
}

/**
 * Resolve an IPC API path without allowing navigation to another origin.
 * @param origin - Validated local service origin.
 * @param path - Renderer-supplied API path.
 * @returns The local API URL.
 */
export function caStudioApiUrl(origin: string, path: unknown): URL {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) throw new Error('Invalid CAStudio API path')
  const url = new URL(path, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.hash) throw new Error('Invalid CAStudio API path')
  return url
}

/**
 * Validate a project identifier received over IPC.
 * @param value - Untrusted project identifier.
 * @returns Identifier accepted by CAStudio's project routes.
 */
export function caStudioProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid CAStudio project')
  return value
}

/**
 * Perform one JSON API request; text files return text. Mutations are never retried.
 * @param origin - Validated service origin.
 * @param path - Local API route.
 * @param method - HTTP operation.
 * @param body - JSON payload, omitted for requests without a body.
 * @returns The server response; non-success status rejects the operation.
 */
export async function requestCAStudio(origin: string, path: unknown, method: unknown = 'GET', body?: unknown): Promise<unknown> {
  const url = caStudioApiUrl(origin, path)
  if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Invalid CAStudio method')
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const value: unknown = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text
  if (!response.ok) {
    const detail = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? `: ${value.error.slice(0, 500)}` : ''
    throw new Error(`CAStudio HTTP ${response.status}${detail}`)
  }
  return value
}

/**
 * Read a live stream through its terminal close or the owner's cancellation.
 * @param response - An accepted CAStudio SSE response.
 * @param receive - Receives validated event envelopes in server order.
 * @returns Completion when the server closes; the owner reports that close as disconnected.
 */
export async function consumeCAStudioEvents(response: Response, receive: (event: CAStudioEvent) => void): Promise<void> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || response.body === null) {
    await response.body?.cancel()
    throw new Error(`CAStudio event stream unavailable (${response.status})`)
  }
  const parser = createParser({
    onEvent(message) {
      const value: unknown = JSON.parse(message.data)
      if (typeof value !== 'object' || value === null || !('id' in value) || !Number.isSafeInteger(value.id)
        || typeof value.id !== 'number' || !('type' in value) || typeof value.type !== 'string' || !('data' in value)) {
        throw new Error('Invalid CAStudio event')
      }
      receive({ id: value.id, type: value.type, data: value.data })
    },
    onError(error) { throw error },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      parser.feed(decoder.decode(result.value, { stream: true }))
    }
    parser.feed(decoder.decode())
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
