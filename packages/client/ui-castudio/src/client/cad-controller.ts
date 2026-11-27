import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StudioBridge, StudioServiceStatus } from './types.ts'

/** A CAD project is an ordinary DSH filesystem workspace. */
export interface CadProject { id: string; name: string; workspacePath: string; workspaceUrl: string }
/** A transport that never answered is unreachable; anything else was answered with a rejection. */
export type CadErrorKind = 'connection' | 'operation'
export interface CadError { kind: CadErrorKind; message: string }
/**
 * What the last project action left behind: a created project waiting to be opened,
 * or a created project whose workspace could not be opened. Both stay recoverable.
 */
export interface CadNotice { kind: 'created' | 'open-failed'; projectId: string; projectName: string; message?: string }
/**
 * What the workbench opens: a file, a part, or a file of a part. `path` is relative to the part workspace. `part` is
 * `default` or the slug of a `parts/<slug>/` part; a file opened from the file tree omits it for the default part, and
 * a chosen part without a model file omits `path`.
 */
export interface CadOpenTarget { projectId: string; path?: string; part?: string }
/** The latest request to show a file in one Session's CAD frame; `seq` increases with every request so the frame can tell a new one from one it already sent. */
export interface CadOpenRequest extends CadOpenTarget { seq: number; sessionId: SessionId }
/**
 * `theme` is the host color scheme and `locale` the active DSH locale id the embedded workbench starts with.
 * `service` is the desktop-managed CAStudio status, null in a browser or before the first report.
 */
export interface CadState { projects: CadProject[]; pending: boolean; error: CadError | null; notice: CadNotice | null; theme: 'light' | 'dark'; locale: string; openRequest: CadOpenRequest | null; service: StudioServiceStatus | null; serviceEpoch: number }

/** Part status a parts row reports; each flag is present when the row's field of that name is set. */
export type CadPartFlag = 'published' | 'structural' | 'thermal'
/**
 * One part of a CAD project, as `GET /api/projects/:rootId/parts` lists it. `slug` is `default` for the
 * project root, otherwise the folder name under `parts/`; `updatedAt` is epoch milliseconds when reported.
 */
export interface CadPart { id: string; slug: string; name: string; updatedAt?: number; flags: readonly CadPartFlag[] }

const PART_FLAGS: readonly CadPartFlag[] = ['published', 'structural', 'thermal']
const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

/** Match the canonical Windows path without depending on Node in the renderer. */
export function projectForWorkspace(projects: readonly CadProject[], directory: string | undefined): CadProject | undefined {
  return directory ? projects.find(project => normalizePath(project.workspacePath) === normalizePath(directory)) : undefined
}

/**
 * Validate one parts response; the status fields are optional and only their presence is read.
 * @param response - JSON body of the parts listing.
 * @returns the parts in service order.
 * @throws when the body is not a list of parts.
 */
export function parseParts(response: unknown): CadPart[] {
  if (!Array.isArray(response)) throw new Error('Invalid CAD part response')
  return response.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('id' in row) || !('slug' in row) || !('name' in row)
      || typeof row.id !== 'string' || typeof row.slug !== 'string' || typeof row.name !== 'string') throw new Error('Invalid CAD part response')
    const fields = new Map(Object.entries(row))
    const updatedAt = typeof fields.get('updatedAt') === 'string' ? Date.parse(String(fields.get('updatedAt'))) : Number.NaN
    const flags = PART_FLAGS.filter((flag) => {
      const value = fields.get(flag)
      return value !== undefined && value !== null && value !== false && value !== ''
    })
    return { id: row.id, slug: row.slug, name: row.name, ...(Number.isFinite(updatedAt) && { updatedAt }), flags }
  })
}

/** The service rejecting a request is an operation failure; an unanswered request is a connection failure. */
export function cadErrorKind(error: unknown): CadErrorKind {
  const message = String((error as Error)?.message ?? error)
  return /fetch failed|failed to fetch|networkerror|econnrefused|econnreset|etimedout|socket hang up/i.test(message) ? 'connection' : 'operation'
}

/**
 * Own project discovery and lifecycle only. Conversation, models and execution remain with DSH.
 *
 * Creating a project and showing it are two separate steps: the project always exists after a
 * successful create, while opening its workspace can fail on its own and stays retryable.
 */
export class CadController {
  readonly snapshot = createSnapshotStore<CadState>({ projects: [], pending: false, error: null, notice: null, theme: 'light', locale: 'en', openRequest: null, service: null, serviceEpoch: 0 })
  private disposed = false
  /** The service has been ready before, so its next `ready` follows a restart. */
  private wasReady = false
  /** The last project load failed; the service becoming ready loads again. */
  private loadFailed = false
  private readonly unwatchService: () => void
  constructor(
    private readonly bridge: StudioBridge,
    /** Register the project's DSH workspace and navigate to it. */
    private readonly openWorkspace: (project: CadProject) => Promise<void>,
    /** Drop the empty DSH workspace a deleted project would otherwise leave in the sidebar. */
    private readonly forgetWorkspace: (project: CadProject) => Promise<void> = async () => {},
  ) {
    const service = bridge.service
    this.unwatchService = service?.onStatus(status => this.serviceStatus(status)) ?? (() => {})
    void service?.status().then(status => this.serviceStatus(status), (error: unknown) => console.warn('castudio: service status unavailable', error))
  }

  private serviceStatus(status: StudioServiceStatus): void {
    if (this.disposed) return
    // A restarted service has lost the embedded page's connections, so a new epoch remounts the workspace frame.
    const restarted = status.state === 'ready' && this.wasReady && this.snapshot.getSnapshot().service?.state !== 'ready'
    this.snapshot.update((state) => { state.service = status; if (restarted) state.serviceEpoch += 1 })
    if (status.state === 'ready') this.wasReady = true
    if (status.state === 'ready' && this.loadFailed) void this.load()
  }

  private async projects(): Promise<void> {
    const response = await this.bridge.request('/api/dsh/projects')
    if (!Array.isArray(response) || !response.every(project => project && typeof project.id === 'string'
      && typeof project.name === 'string' && typeof project.workspacePath === 'string')) throw new Error('Invalid CAD project response')
    const projects = await Promise.all(response.map(async (project) => {
      const url = new URL(await this.bridge.workspaceUrl(project.id))
      url.searchParams.set('harness', 'dsh')
      return {
        id: project.id as string, name: project.name as string,
        workspacePath: project.workspacePath as string, workspaceUrl: url.href,
      }
    }))
    if (!this.disposed) this.snapshot.update((state) => { state.projects = projects })
  }

  private notice(notice: CadNotice | null): void {
    if (!this.disposed) this.snapshot.update((state) => { state.notice = notice })
  }

  /** Resolves to whether the action completed, so the editor can stay open on a rejected name. */
  private async run(action: () => Promise<void>): Promise<boolean> {
    if (this.disposed || this.snapshot.getSnapshot().pending) return false
    this.snapshot.update((state) => { state.pending = true; state.error = null })
    try { await action(); return !this.disposed }
    catch (error) {
      if (!this.disposed) {
        const message = String((error as Error)?.message ?? error)
        this.snapshot.update((state) => { state.error = { kind: cadErrorKind(error), message } })
      }
      return false
    }
    finally { if (!this.disposed) this.snapshot.update((state) => { state.pending = false }) }
  }

  async load(): Promise<boolean> {
    const loaded = await this.run(() => this.projects())
    this.loadFailed = !loaded
    return loaded
  }

  /** Restart the desktop-managed service; its `ready` status reloads a failed project list. Without one, load again. */
  async restartService(): Promise<void> {
    const service = this.bridge.service
    if (service === undefined) { await this.load(); return }
    try { await service.restart() }
    catch (error) {
      if (!this.disposed) this.snapshot.update((state) => { state.error = { kind: cadErrorKind(error), message: String((error as Error)?.message ?? error) } })
    }
  }

  private async openProject(id: string): Promise<void> {
    const project = this.snapshot.getSnapshot().projects.find(item => item.id === id)
    if (!project) throw new Error('CAD project not found')
    await this.bridge.request(`/api/dsh/projects/${encodeURIComponent(id)}/prepare`, 'POST')
    if (!this.disposed) await this.openWorkspace(project)
  }

  async open(id: string): Promise<boolean> { return this.run(() => this.openProject(id)) }

  /**
   * Create a project, optionally opening it.
   * `keep` leaves the current conversation alone: the project appears in the project menu.
   * `open` switches to a new session for the project. A failed open is reported as a notice and
   * never discards the project or masks the failure as a lost connection.
   */
  async create(name: string, mode: 'open' | 'keep' = 'open'): Promise<boolean> {
    this.notice(null)
    return this.run(async () => {
      const created = await this.bridge.request('/api/projects', 'POST', { name }) as { id: string }
      await this.projects()
      const project = this.snapshot.getSnapshot().projects.find(item => item.id === created.id)
      if (!project) throw new Error('CAD project not found after creation')
      if (mode === 'keep') { this.notice({ kind: 'created', projectId: project.id, projectName: project.name }); return }
      await this.openCreated(project)
    })
  }

  /** Open a just-created project; a workspace failure becomes a recovery notice, not a dead end. */
  private async openCreated(project: CadProject): Promise<void> {
    this.notice(null)
    try { await this.openProject(project.id) }
    catch (error) {
      if (this.disposed) return
      this.snapshot.update((state) => {
        state.error = null
        state.notice = { kind: 'open-failed', projectId: project.id, projectName: project.name, message: String((error as Error)?.message ?? error) }
      })
    }
  }

  async retryOpen(id: string): Promise<boolean> {
    return this.run(async () => {
      const project = this.snapshot.getSnapshot().projects.find(item => item.id === id)
      if (!project) throw new Error('CAD project not found')
      await this.openCreated(project)
    })
  }

  /** Deleting a project also removes the empty workspace registered for it. */
  async remove(id: string): Promise<boolean> {
    return this.run(async () => {
      const project = this.snapshot.getSnapshot().projects.find(item => item.id === id)
      if (!project) throw new Error('CAD project not found')
      await this.bridge.request(`/api/projects/${encodeURIComponent(id)}`, 'DELETE')
      await this.forgetWorkspace(project)
      await this.projects()
      this.notice(null)
    })
  }

  async rename(id: string, name: string): Promise<boolean> {
    return this.run(async () => {
      await this.bridge.request(`/api/projects/${encodeURIComponent(id)}`, 'PATCH', { name })
      await this.projects()
    })
  }

  /**
   * Ask one Session's CAD frame to show a file; the frame sends it once it is ready.
   * @param sessionId - the Session whose CAD tab shows the file.
   * @param target - project, part and part-relative path of the file.
   */
  requestOpen(sessionId: SessionId, target: CadOpenTarget): void {
    this.snapshot.update((state) => { state.openRequest = { ...target, sessionId, seq: (state.openRequest?.seq ?? 0) + 1 } })
  }

  /**
   * List one project's parts.
   * @param projectId - root project id.
   * @returns the parts in service order.
   */
  async parts(projectId: string): Promise<CadPart[]> {
    return parseParts(await this.bridge.request(`/api/projects/${encodeURIComponent(projectId)}/parts`))
  }

  /**
   * The part shown by the most recently reporting live CAD workbench of one project, in any Session.
   * @param project - root project whose workbenches count.
   * @returns the part slug, or undefined when no live workbench of the project reports one.
   */
  async shownPart(project: CadProject): Promise<string | undefined> {
    const rows = await this.bridge.request('/api/dsh/viewports')
    if (!Array.isArray(rows)) return undefined
    const root = normalizePath(project.workspacePath)
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || typeof row.workspacePath !== 'string') continue
      const path = normalizePath(row.workspacePath)
      if (path !== root && !path.startsWith(`${root}/parts/`)) continue
      const slug: unknown = row.state?.part?.slug
      if (typeof slug === 'string') return slug
    }
    return undefined
  }

  /**
   * The first model file of one part, which the workbench can open to show that part.
   * @param part - part whose files are listed.
   * @returns the part-relative model path, or undefined when the part has no model yet.
   */
  async firstModel(part: CadPart): Promise<string | undefined> {
    const files = await this.bridge.request(`/api/projects/${encodeURIComponent(part.id)}/files`)
    if (!Array.isArray(files)) return undefined
    const model = files.find(file => typeof file === 'object' && file !== null && file.kind === 'model' && typeof file.path === 'string')
    return model === undefined ? undefined : String(model.path)
  }

  dismissNotice(): void { this.notice(null) }
  setTheme(theme: 'light' | 'dark'): void { this.snapshot.update((state) => { state.theme = theme }) }
  setLocale(locale: string): void { this.snapshot.update((state) => { state.locale = locale }) }
  dispose(): void { this.disposed = true; this.unwatchService() }
}
