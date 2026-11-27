/**
 * Opt-in request-preparation CAStudio context. Eligible step attempts append
 * durable, source-attributed context naming the CAD projects a local CAStudio
 * service manages, where each project's workspace lives, and which CAD
 * workbenches the user currently has open with a live viewport, so a session
 * can learn about open CAD work without sharing the project's workspace.
 *
 * The plugin pulls state once per turn, for the first request (`step === 1`),
 * through `GET /api/dsh/projects`, `GET /api/dsh/viewports`, and
 * `GET /api/parametric/runtime` against the configured service origin. It
 * re-injects only when the rendered project set, workbench summary, or
 * parametric-runtime status changes since the last injection, with an
 * optional `refreshIntervalMs` floor between injections. An unreachable
 * service, a non-OK response, or a malformed payload is a no-op, never an
 * error: the probes are contained so the turn continues. The origin resolver
 * and wire helpers are exported for `@deepseek-ai/dsh-tool-castudio`, which
 * speaks to the same service.
 *
 * @module @deepseek-ai/dsh-castudio-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** CAStudio service and project attribution; readers preserve the content
     * without this producer. Its projection uses the kind to avoid repeated
     * injection.
     * @persistenceAttribution
     */
    'castudio-context': { kind: 'castudio-context' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'castudio-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents', 'sessionProjections']

/** CAStudio service scheduling and response bounds. Invalid values fail plugin load. */
export interface Config {
  /** Service origin such as `http://127.0.0.1:4317`. Omit to read `COSERVE_CASTUDIO_URL`, then the default loopback origin. */
  url?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject on every eligible change. */
  refreshIntervalMs?: number
  /** Maximum projects listed in one reading; the remainder is summarized as a count. */
  maxProjects?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  url: z.string(),
  timeoutMs: z.number(),
  refreshIntervalMs: z.number(),
  maxProjects: z.number(),
})

/** Loopback origin the desktop shell probes when neither config nor environment names one. */
const DEFAULT_URL = 'http://127.0.0.1:4317'

/** Bound one project-list request so a hung service cannot stall request preparation. */
const DEFAULT_TIMEOUT_MS = 2_000

/** Bound one reading's project list; larger catalogs degrade to a count. */
const DEFAULT_MAX_PROJECTS = 20

/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = 'CAStudio CAD service (turn '

/** One project row of `GET /api/dsh/projects`, limited to the fields the reading uses. */
interface CaStudioProject {
  id: string
  name: string
  workspacePath: string
}

/** Workbench tabs a CAStudio viewport can report, in wire order. */
export type CAStudioWorkspace = 'model' | 'parametric' | 'structural' | 'thermal'

/** One reported mesh of a live viewport; `id` is what commands address. */
export interface CAStudioViewportMesh {
  id: string
  name: string
  visible: boolean
  triangles: number
  group?: string
  cylinderObjectId?: string
}

/** The part or CAD face the user currently has selected in the viewport. */
export interface CAStudioViewportSelection {
  meshId: string
  name: string
  triangle?: number
  point?: number[]
  bounds: number[]
  triangles: number
  cadFace?: unknown
  cylinderObjectId?: string
}

/** Display options the viewport reports; defaults are edges/grid on, ortho off, section 100, explode 0, component mode. */
export interface CAStudioViewportOptions {
  edges: boolean
  grid: boolean
  ortho: boolean
  section: number
  explode: number
  mode: 'component' | 'face'
}

/** Camera pose reported with a viewport state; context never renders it because it changes constantly. */
export interface CAStudioViewportCamera {
  position: [number, number, number]
  target: [number, number, number]
  projection: 'perspective' | 'orthographic'
}

/** The `state` payload a workbench page reports for `GET /api/projects/:id/viewport/state`. */
export interface CAStudioViewportState {
  workspace: CAStudioWorkspace
  model: {
    path: string | null
    demo: boolean
    status: 'empty' | 'loading' | 'ready' | 'error'
    error?: string
  }
  meshes: CAStudioViewportMesh[]
  selection: CAStudioViewportSelection | null
  options: CAStudioViewportOptions
  camera: CAStudioViewportCamera | null
  /** The CAD part the viewer shows; `model.path` is relative to that part's folder. Absent from pages that predate parts, which show part `default`. */
  part?: { slug: string; name: string }
}

/** One row of `GET /api/dsh/viewports`: a project whose workbench viewport is currently live. */
export interface CAStudioConnectedViewport {
  id: string
  /** CAD instance id: the session that owns this workbench view. */
  client: string
  name: string
  workspacePath: string
  ageMs: number
  state: CAStudioViewportState
}

/**
 * Resolve the service origin from config, then `COSERVE_CASTUDIO_URL` (the same
 * variable the desktop shell reads), then the loopback default. Only http(s)
 * origins are accepted; anything else fails plugin load.
 * @param configured - the `url` config field, when present.
 * @returns the normalized origin, without a trailing path or slash.
 */
export function resolveCAStudioOrigin(configured: string | undefined): string {
  const raw = configured ?? process.env['COSERVE_CASTUDIO_URL'] ?? DEFAULT_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`castudio-context: url must be a valid URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`castudio-context: url must use http or https, got ${JSON.stringify(raw)}`)
  }
  return url.origin
}

/** One CAStudio request: JSON in and out, a cooperative timeout combined with caller cancellation. */
export interface CAStudioRequest {
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  timeoutMs: number
  signal: AbortSignal
}

/**
 * Issue one request against a resolved CAStudio origin. Network failures and
 * aborts propagate to the caller; HTTP status interpretation stays with the
 * consumer so reads can degrade silently while tools can report the status.
 * @param origin - value from {@link resolveCAStudioOrigin}.
 * @param path - absolute API path such as `/api/dsh/viewports`.
 * @param request - method, optional JSON body, timeout, and caller signal.
 * @returns the raw response; the caller checks `ok` and parses the body.
 */
export async function caStudioFetch(
  origin: string,
  path: string,
  request: CAStudioRequest,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
  })
}

/** Reject scheduling and bound values that cannot represent their contracts. */
function validateConfig(config: {
  timeoutMs?: number
  refreshIntervalMs?: number
  maxProjects?: number
}): { timeoutMs: number; maxProjects: number } {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxProjects = config.maxProjects ?? DEFAULT_MAX_PROJECTS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`castudio-context: timeoutMs must be a positive safe integer, got ${String(config.timeoutMs)}`)
  }
  if (config.refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(config.refreshIntervalMs)
    || config.refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `castudio-context: refreshIntervalMs must be a non-negative safe integer, got ${String(config.refreshIntervalMs)}`,
    )
  }
  if (!Number.isSafeInteger(maxProjects) || maxProjects <= 0) {
    throw new TypeError(`castudio-context: maxProjects must be a positive safe integer, got ${String(config.maxProjects)}`)
  }
  return { timeoutMs, maxProjects }
}

/**
 * Parse the wire payload into the fields the reading uses. The endpoint is a
 * wire boundary, so a non-array body or an entry missing a required string
 * rejects the whole reading rather than dropping rows silently.
 * @param body - decoded JSON response.
 * @returns the project rows, or `undefined` when the shape is unexpected.
 */
function parseProjects(body: unknown): CaStudioProject[] | undefined {
  if (!Array.isArray(body)) return undefined
  const projects: CaStudioProject[] = []
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { id, name, workspacePath } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0
      || typeof name !== 'string' || name.length === 0
      || typeof workspacePath !== 'string' || workspacePath.length === 0) return undefined
    projects.push({ id, name, workspacePath })
  }
  return projects
}

/**
 * Read the service's project list, or `undefined` when the service is absent,
 * answers non-OK, or returns a malformed payload. Connection failures are the
 * expected "service not running" case and stay silent; a successful but
 * malformed response is anomalous and is reported once per attempt.
 * @param origin - resolved service origin.
 * @param timeoutMs - request timeout forwarded through an abort signal.
 * @param signal - caller cancellation combined with the timeout.
 * @param logger - receives a warning when a successful response is malformed.
 * @returns the project rows, or `undefined` on any failure.
 */
async function queryProjects(
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
  logger: Context['logger'],
): Promise<CaStudioProject[] | undefined> {
  let response: Response
  try {
    response = await caStudioFetch(origin, '/api/dsh/projects', { timeoutMs, signal })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let body: unknown
  try {
    body = await response.json()
  } catch {
    logger.warn('castudio-context: CAStudio project list is not valid JSON; injecting no context this turn')
    return undefined
  }
  const projects = parseProjects(body)
  if (projects === undefined) {
    logger.warn('castudio-context: CAStudio project list has an unexpected shape; injecting no context this turn')
  }
  return projects
}

/**
 * Parse one reported viewport state at the wire boundary. The discriminant
 * fields the summary and tool rely on — workspace, model status, mesh and
 * option containers — must match; scalar details inside them are trusted to
 * the producers' own validators and guarded again where rendered.
 * @param body - decoded JSON `state` value.
 * @returns the typed state, or `undefined` when the shape is unexpected.
 */
export function parseCAStudioViewportState(body: unknown): CAStudioViewportState | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = body as Record<string, unknown>
  if (raw.workspace !== 'model' && raw.workspace !== 'parametric'
    && raw.workspace !== 'structural' && raw.workspace !== 'thermal') return undefined
  if (typeof raw.model !== 'object' || raw.model === null) return undefined
  const model = raw.model as Record<string, unknown>
  if (model.status !== 'empty' && model.status !== 'loading'
    && model.status !== 'ready' && model.status !== 'error') return undefined
  if (!Array.isArray(raw.meshes)) return undefined
  if (raw.selection !== null && (typeof raw.selection !== 'object' || raw.selection === undefined)) return undefined
  if (typeof raw.options !== 'object' || raw.options === null) return undefined
  if (raw.camera !== null && raw.camera !== undefined && typeof raw.camera !== 'object') return undefined
  if (raw.part !== undefined) {
    if (typeof raw.part !== 'object' || raw.part === null) return undefined
    const { slug, name } = raw.part as Record<string, unknown>
    if (typeof slug !== 'string' || typeof name !== 'string') return undefined
  }
  return body as CAStudioViewportState
}

/**
 * Parse the `GET /api/dsh/viewports` payload into connected workbenches.
 * @param body - decoded JSON response.
 * @returns the viewport rows, or `undefined` when the shape is unexpected.
 */
export function parseCAStudioViewports(body: unknown): CAStudioConnectedViewport[] | undefined {
  if (!Array.isArray(body)) return undefined
  const viewports: CAStudioConnectedViewport[] = []
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { id, name, workspacePath, ageMs, state } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0
      || typeof name !== 'string' || name.length === 0
      || typeof workspacePath !== 'string' || workspacePath.length === 0
      || typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return undefined
    // An older service reports one viewport per project and no instance id.
    const client = typeof (entry as Record<string, unknown>).client === 'string' ? (entry as Record<string, unknown>).client as string : 'main'
    const parsed = parseCAStudioViewportState(state)
    if (parsed === undefined) return undefined
    viewports.push({ id, client, name, workspacePath, ageMs, state: parsed })
  }
  return viewports
}

/**
 * Read the service's connected-workbench list, or `undefined` on any failure.
 * The workbench section is additive: an older service without the endpoint, a
 * hung probe, or a malformed payload degrades to the project-only reading
 * rather than suppressing it, so failures here never warn as anomalies unless
 * a successful response is malformed.
 * @param origin - resolved service origin.
 * @param timeoutMs - request timeout forwarded through an abort signal.
 * @param signal - caller cancellation combined with the timeout.
 * @param logger - receives a warning when a successful response is malformed.
 * @returns the connected viewport rows, or `undefined` on any failure.
 */
async function queryViewports(
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
  logger: Context['logger'],
): Promise<CAStudioConnectedViewport[] | undefined> {
  let response: Response
  try {
    response = await caStudioFetch(origin, '/api/dsh/viewports', { timeoutMs, signal })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let body: unknown
  try {
    body = await response.json()
  } catch {
    logger.warn('castudio-context: CAStudio workbench list is not valid JSON; injecting project context without workbenches this turn')
    return undefined
  }
  const viewports = parseCAStudioViewports(body)
  if (viewports === undefined) {
    logger.warn('castudio-context: CAStudio workbench list has an unexpected shape; injecting project context without workbenches this turn')
  }
  return viewports
}

/**
 * Read whether the service's parametric CAD environment is configured, or
 * `undefined` on any failure. Like the workbench list this probe is additive:
 * an older service without the endpoint, a hung request, or a malformed
 * payload degrades to omitting the status line rather than suppressing the
 * reading, so failures here never warn unless a successful response is
 * malformed.
 * @param origin - resolved service origin.
 * @param timeoutMs - request timeout forwarded through an abort signal.
 * @param signal - caller cancellation combined with the timeout.
 * @param logger - receives a warning when a successful response is malformed.
 * @returns `configured`, or `undefined` when the status is unknown.
 */
async function queryParametricRuntime(
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
  logger: Context['logger'],
): Promise<boolean | undefined> {
  let response: Response
  try {
    response = await caStudioFetch(origin, '/api/parametric/runtime', { timeoutMs, signal })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let body: unknown
  try {
    body = await response.json()
  } catch {
    logger.warn('castudio-context: CAStudio parametric runtime status is not valid JSON; injecting context without it this turn')
    return undefined
  }
  if (typeof body !== 'object' || body === null
    || typeof (body as Record<string, unknown>).configured !== 'boolean') {
    logger.warn('castudio-context: CAStudio parametric runtime status has an unexpected shape; injecting context without it this turn')
    return undefined
  }
  return (body as { configured: boolean }).configured
}

/** Plain-language names for the workbench tabs a viewport can report. */
const WORKSPACE_LABELS: Record<CAStudioWorkspace, string> = {
  model: 'model preview',
  parametric: 'parametric modeling',
  structural: 'structural simulation',
  thermal: 'thermal simulation',
}

/** Plain-language model load states for the workbench summary. */
const MODEL_STATUS_LABELS: Record<CAStudioViewportState['model']['status'], string> = {
  empty: 'no model loaded',
  loading: 'loading',
  ready: 'loaded',
  error: 'failed to load',
}

/** Compare projects and workbenches by id so rendered order never depends on service activity. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Describe the loaded model from the model's point of view: file path or demonstration geometry, plus load state. */
function renderModel(model: CAStudioViewportState['model']): string {
  const subject = model.demo
    ? 'demonstration geometry'
    : typeof model.path === 'string' && model.path.length > 0 ? model.path : 'no model file'
  const status = MODEL_STATUS_LABELS[model.status] ?? 'unknown state'
  return `${subject} — ${status}`
}

/** Describe the current selection, or that nothing is selected. */
function renderSelection(selection: CAStudioViewportState['selection']): string {
  if (selection === null || typeof selection !== 'object') return 'nothing selected'
  const name = typeof selection.name === 'string' && selection.name.length > 0 ? selection.name : undefined
  const id = typeof selection.meshId === 'string' && selection.meshId.length > 0 ? selection.meshId : undefined
  if (name === undefined && id === undefined) return 'nothing selected'
  return name === undefined ? `part id ${id}` : `"${name}"${id === undefined ? '' : ` (${id})`}`
}

/** List only the view options that differ from the defaults, or nothing when all are default. */
function renderViewOptions(options: CAStudioViewportState['options']): string | undefined {
  const notes: string[] = []
  if (options.ortho === true) notes.push('orthographic projection')
  if (typeof options.section === 'number' && options.section !== 100) notes.push(`section at ${options.section}%`)
  if (typeof options.explode === 'number' && options.explode !== 0) notes.push(`explode ${options.explode}`)
  if (options.mode === 'face') notes.push('face selection mode')
  return notes.length === 0 ? undefined : notes.join('; ')
}

/** Render one connected workbench as a stable, model-facing summary block. */
function renderViewport(viewport: CAStudioConnectedViewport): string {
  const { state } = viewport
  const hidden = state.meshes.filter(mesh => mesh.visible === false).length
  const part = state.part ?? { slug: 'default', name: 'default' }
  const files = part.slug === 'default' ? 'the workspace root' : `parts/${part.slug}/ under the workspace root`
  const lines = [
    `- "${viewport.name}" — id ${viewport.id}, instance ${viewport.client.slice(0, 8)}, tab: ${WORKSPACE_LABELS[state.workspace] ?? state.workspace}`,
    `  Project / Part: "${viewport.name}" / "${part.name}" (${part.slug}) — part files are in ${files}; model paths are relative to it`,
    `  Model: ${renderModel(state.model)}`,
    `  Meshes: ${state.meshes.length} total${hidden > 0 ? `, ${hidden} hidden` : ''}`,
    `  Selection: ${renderSelection(state.selection)}`,
  ]
  const view = renderViewOptions(state.options)
  if (view !== undefined) lines.push(`  View: ${view}`)
  lines.push('  You can inspect and operate this workbench with the cad_workbench tool.')
  return lines.join('\n')
}

/**
 * Absolute path of a project's castudio skill guide inside its prepared workspace, joined with the
 * workspace path's own separator: backslash for a path with backslashes and no forward slash, else forward slash.
 */
function skillGuidePath(workspacePath: string): string {
  const separator = workspacePath.includes('\\') && !workspacePath.includes('/') ? '\\' : '/'
  return [workspacePath.replace(/[\\/]+$/, ''), '.agents', 'skills', 'castudio', 'SKILL.md'].join(separator)
}

/**
 * Render the stable state block: the part of a reading compared for change
 * suppression. It excludes the turn preamble and every volatile field
 * (timestamps, report ages, camera poses, ordering by recent activity) so
 * re-injection is driven only by the project set, workbench summaries, and
 * parametric-runtime status the model can act on.
 */
function renderState(
  origin: string,
  projects: readonly CaStudioProject[],
  viewports: readonly CAStudioConnectedViewport[],
  parametricConfigured: boolean | undefined,
  maxProjects: number,
): string {
  const shown = projects.slice(0, maxProjects)
  const hidden = projects.length - shown.length
  const listing = projects.length === 0
    ? 'It manages no CAD projects yet.'
    : `It manages these CAD projects:\n${shown.map(project =>
      `- ${JSON.stringify(project.name)} — id ${project.id}, workspace ${project.workspacePath}; `
      + `CAD skill guide: ${skillGuidePath(project.workspacePath)}`).join('\n')}`
      + (hidden > 0 ? `\n- …and ${hidden} more project${hidden === 1 ? '' : 's'}` : '')
  const orderedViewports = [...viewports].sort(byId)
  const shownViewports = orderedViewports.slice(0, maxProjects)
  const hiddenViewports = orderedViewports.length - shownViewports.length
  const workbenchListing = orderedViewports.length === 0
    ? ''
    : `\n\nThe user currently has these CAD workbenches open:\n${shownViewports.map(renderViewport).join('\n')}`
      + (hiddenViewports > 0 ? `\n- …and ${hiddenViewports} more workbench${hiddenViewports === 1 ? '' : 'es'}` : '')
  const parametricLine = parametricConfigured === undefined ? ''
    : parametricConfigured
      ? ' The parametric CAD environment is configured, so geometry, colour and parameter edits through the parametric code API are available.'
      : ' The optional parametric CAD environment is not installed, so geometry, colour and material edits are unavailable until the user installs it; the install steps are in the castudio skill\'s "Installing the CAD environment" section.'
  return `A local CAStudio CAD service is running at ${origin}. ${listing}\n`
    + `Each project exposes a HTTP API at ${origin}/api/projects/<id> for parametric editing, builds, `
    + 'measurements, and structural and thermal simulation; project files live in the workspace path. '
    + 'A prepared project workspace carries AGENTS.md and .agents/skills (castudio, cadflow, '
    + 'structural-sim, thermal-sim) documenting its API — read the castudio skill guide listed per project '
    + 'before CAD work. '
    + "Use ordinary shell and file tools against the API; do not call the service's /prompt endpoint."
    + parametricLine
    + workbenchListing
}

/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(
  origin: string,
  projects: readonly CaStudioProject[],
  viewports: readonly CAStudioConnectedViewport[],
  parametricConfigured: boolean | undefined,
  turn: number,
  maxProjects: number,
): string {
  return `${READING_PREFIX}${turn}):\n${renderState(origin, projects, viewports, parametricConfigured, maxProjects)}`
}

const castudioContextStateSchema = zod.object({
  state: zod.string(),
  time: zod.number(),
}).nullable()

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * Steps admitted during activation await the projection registration; a
 * registration failure or owner disposal prevents the request from proceeding.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - service origin, timeout, refresh scheduling, and list bound.
 * @returns when the listener and projection are ready.
 * @throws when the service origin or a numeric field is invalid.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = resolveCAStudioOrigin(config.url)
  const { timeoutMs, maxProjects } = validateConfig(config)
  const refreshIntervalMs = config.refreshIntervalMs

  const projectionReady = ctx.sessionProjections.register({
    key: 'castudioContext',
    stateVersion: 1,
    stateSchema: castudioContextStateSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type !== 'user/message'
        || event.data.source.kind !== name) return state
      const [block] = event.data.content
      if (block?.type !== 'text') return state
      const newline = block.text.indexOf('\n')
      const stableState = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state: stableState, time: event.time }
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const castudioContextProjectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const previous = castudioContextProjectionHandle.stateOf(agent.session)
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== null) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const [projects, viewports, parametricConfigured] = await Promise.all([
      queryProjects(origin, timeoutMs, signal, ctx.logger),
      queryViewports(origin, timeoutMs, signal, ctx.logger),
      queryParametricRuntime(origin, timeoutMs, signal, ctx.logger),
    ])
    if (projects === undefined) return decision
    projects.sort(byId)
    // Each session owns its CAD instances: the same project may be open in
    // another conversation, and that workbench is not this session's to read.
    // A page that reports no instance id (a plain browser tab) stays visible.
    const owner = String(agent.session.id)
    const connected = (viewports ?? []).filter(viewport => viewport.client === owner || viewport.client === 'main')
    const state = renderState(origin, projects, connected, parametricConfigured, maxProjects)
    if (previous !== null && previous.state === state) return decision
    const text = renderReading(origin, projects, connected, parametricConfigured, turn, maxProjects)
    return {
      ...decision,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })
  await projectionReady
}
