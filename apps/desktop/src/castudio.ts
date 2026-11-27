/** Trusted application-frame IPC for the local CAStudio API and project streams. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CASTUDIO_IPC, type CAStudioEventMessage } from './castudio-protocol.ts'
import { requireCAStudioReady, type CAStudioService } from './castudio-service.ts'
import { caStudioApiUrl, caStudioOrigin, caStudioProjectId, consumeCAStudioEvents, requestCAStudio } from './castudio-transport.ts'

/**
 * Install CAStudio IPC. Window navigation, closure, and application shutdown release streams. Requests and
 * subscriptions wait while the service starts and reject with `CAStudioUnavailableError` text once it failed or exited;
 * a window that read the status receives every later status on `CASTUDIO_IPC.statusChanged`.
 * @param assertOwner - Rejects subframes, shell pages, and foreign windows.
 * @param service - Service manager owning the CAStudio process at `configuredOrigin`.
 * @param configuredOrigin - Local service address from the desktop launch environment.
 * @returns Cleanup for all IPC handlers and outstanding subscriptions.
 */
export function installCAStudio(
  assertOwner: (event: IpcMainInvokeEvent) => BrowserWindow, service: CAStudioService, configuredOrigin: string,
): () => void {
  const origin = caStudioOrigin(configuredOrigin)
  const watchers = new Set<BrowserWindow>()
  const unwatch = service.onStatus((status) => {
    for (const owner of watchers) if (!owner.webContents.isDestroyed()) owner.webContents.send(CASTUDIO_IPC.statusChanged, status)
  })
  const owners = new Map<BrowserWindow, { streams: Map<string, AbortController>; detach: () => void }>()
  function streamsFor(owner: BrowserWindow): Map<string, AbortController> {
    const existing = owners.get(owner)
    if (existing) return existing.streams
    const streams = new Map<string, AbortController>()
    const cancel = (): void => { for (const controller of streams.values()) controller.abort(); streams.clear() }
    const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, main: boolean): void => { if (main) cancel() }
    const closed = (): void => { cancel(); owners.delete(owner) }
    owner.webContents.on('did-start-navigation', navigate)
    owner.once('closed', closed)
    owners.set(owner, { streams, detach: () => {
      cancel()
      if (!owner.webContents.isDestroyed()) owner.webContents.off('did-start-navigation', navigate)
      owner.off('closed', closed)
    } })
    return streams
  }
  function subscriptionId(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid CAStudio subscription')
    return value
  }
  ipcMain.handle(CASTUDIO_IPC.request, async (event, path: unknown, method: unknown, body: unknown) => {
    assertOwner(event)
    await requireCAStudioReady(service)
    return requestCAStudio(origin, path, method, body)
  })
  ipcMain.handle(CASTUDIO_IPC.status, (event) => {
    const owner = assertOwner(event)
    if (!watchers.has(owner)) {
      watchers.add(owner)
      owner.once('closed', () => { watchers.delete(owner) })
    }
    return service.status()
  })
  ipcMain.handle(CASTUDIO_IPC.restart, (event) => {
    assertOwner(event)
    return service.restart()
  })
  ipcMain.handle(CASTUDIO_IPC.workspace, (event, project: unknown) => {
    assertOwner(event)
    const url = new URL('/', origin)
    url.searchParams.set('embedded', '1')
    url.searchParams.set('project', caStudioProjectId(project))
    return url.href
  })
  ipcMain.handle(CASTUDIO_IPC.unsubscribe, (event, id: unknown) => {
    const owner = assertOwner(event)
    const key = subscriptionId(id)
    const streams = owners.get(owner)?.streams
    streams?.get(key)?.abort()
    streams?.delete(key)
  })
  ipcMain.handle(CASTUDIO_IPC.subscribe, async (event, project: unknown, id: unknown, after: unknown) => {
    const owner = assertOwner(event)
    const projectId = caStudioProjectId(project)
    const key = subscriptionId(id)
    if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) throw new Error('Invalid CAStudio event cursor')
    await requireCAStudioReady(service)
    const streams = streamsFor(owner)
    streams.get(key)?.abort()
    const controller = new AbortController()
    streams.set(key, controller)
    const send = (message: CAStudioEventMessage): void => {
      if (!controller.signal.aborted && !owner.webContents.isDestroyed()) owner.webContents.send(CASTUDIO_IPC.event, message)
    }
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response: Response
    try {
      response = await fetch(caStudioApiUrl(origin, `/api/projects/${projectId}/events`), {
        signal: controller.signal, redirect: 'error', headers: after === undefined ? {} : { 'last-event-id': String(after) },
      })
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel()
        throw new Error(`CAStudio event stream unavailable (${response.status})`)
      }
    } catch (error) {
      if (streams.get(key) === controller) streams.delete(key)
      throw error
    } finally { clearTimeout(timer) }
    void consumeCAStudioEvents(response, value => send({ subscriptionId: key, event: value }))
      .then(() => send({ subscriptionId: key, error: 'CAStudio event stream closed' }))
      .catch((error: unknown) => send({ subscriptionId: key, error: error instanceof Error ? error.message : 'CAStudio event stream failed' }))
      .finally(() => { if (streams.get(key) === controller) streams.delete(key) })
  })
  return () => {
    unwatch()
    watchers.clear()
    for (const owner of owners.values()) owner.detach()
    owners.clear()
    for (const channel of [
      CASTUDIO_IPC.request, CASTUDIO_IPC.subscribe, CASTUDIO_IPC.unsubscribe,
      CASTUDIO_IPC.workspace, CASTUDIO_IPC.status, CASTUDIO_IPC.restart,
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}
