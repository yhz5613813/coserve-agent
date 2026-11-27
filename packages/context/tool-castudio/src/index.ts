/**
 * Model-facing `cad_workbench` tool for the live CAStudio CAD workbench. The
 * tool lists the workbenches whose viewport pages are currently reporting
 * (`GET /api/dsh/viewports`), resolves the target project, resolves part names
 * against the freshly reported mesh list, and dispatches the matching
 * whitelist command (`POST /api/projects/:id/viewport/command`) or reads the
 * viewport state (`GET /api/projects/:id/viewport/state`). Every command may
 * carry `partSlug`, sent as the command's `part`, and every result names the
 * part the viewer shows. It only ever talks
 * to the loopback CAStudio service and changes view state; the only file it
 * can produce is the viewport PNG the service itself writes for `snapshot`.
 *
 * The origin resolves exactly like `@deepseek-ai/dsh-castudio-context`
 * (config `url`, then `COSERVE_CASTUDIO_URL`, then the loopback default) and
 * the wire helpers are imported from that package rather than duplicated.
 *
 * @module @deepseek-ai/dsh-tool-castudio
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  caStudioFetch,
  parseCAStudioViewportState,
  parseCAStudioViewports,
  resolveCAStudioOrigin,
} from '@deepseek-ai/dsh-castudio-context'
import type {
  CAStudioConnectedViewport,
  CAStudioViewportMesh,
  CAStudioViewportState,
} from '@deepseek-ai/dsh-castudio-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-castudio'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

/** CAStudio service scheduling bounds. Invalid values fail plugin load. */
export interface Config {
  /** Service origin such as `http://127.0.0.1:4317`. Omit to read `COSERVE_CASTUDIO_URL`, then the default loopback origin. */
  url?: string
  /** Per-request timeout in milliseconds for workbench listing and state reads. */
  stateTimeoutMs?: number
  /** Per-request timeout in milliseconds for viewport commands; the service answers within 10 seconds. */
  commandTimeoutMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  url: z.string(),
  stateTimeoutMs: z.number(),
  commandTimeoutMs: z.number(),
})

/** Default bound for listing and reading viewport state. */
const DEFAULT_STATE_TIMEOUT_MS = 3_000

/** Default bound for one viewport command; above the service's own 10-second answer window. */
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000

/** Cap on part rows inside one state result so a large model cannot flood the context. */
const MAX_PART_ROWS = 200

/** Cap on part candidates named in resolution errors. */
const MAX_PART_CANDIDATES = 20

type Action = 'state' | 'snapshot' | 'fit' | 'select' | 'select_face' | 'visible' | 'options' | 'workspace' | 'open' | 'panel'

const ACTIONS = ['state', 'snapshot', 'fit', 'select', 'select_face', 'visible', 'options', 'workspace', 'open', 'panel'] as const

/** Fields each action accepts; anything else is rejected before any request. */
const ACTION_FIELDS: Record<Action, ReadonlySet<string>> = {
  state: new Set(['action', 'project', 'partSlug']),
  snapshot: new Set(['action', 'project', 'partSlug']),
  fit: new Set(['action', 'project', 'partSlug', 'view']),
  select: new Set(['action', 'project', 'partSlug', 'part']),
  select_face: new Set(['action', 'project', 'partSlug', 'part', 'face']),
  visible: new Set(['action', 'project', 'partSlug', 'part', 'visible']),
  options: new Set(['action', 'project', 'partSlug', 'options']),
  workspace: new Set(['action', 'project', 'partSlug', 'workspace']),
  open: new Set(['action', 'project', 'partSlug', 'path']),
  panel: new Set(['action', 'project', 'partSlug', 'panel', 'state']),
}

/** Fields each action requires beyond `action` itself. */
const ACTION_REQUIRED: Record<Action, readonly string[]> = {
  state: [],
  snapshot: [],
  fit: [],
  select: ['part'],
  select_face: ['part', 'face'],
  visible: ['part', 'visible'],
  options: ['options'],
  workspace: ['workspace'],
  open: ['path'],
  panel: ['panel', 'state'],
}

/** Short human titles for pending cards, keyed by action. */
const ACTION_TITLES: Record<Action, string> = {
  state: 'read state',
  snapshot: 'snapshot',
  fit: 'fit view',
  select: 'select part',
  select_face: 'select face',
  visible: 'set visibility',
  options: 'display options',
  workspace: 'switch workspace',
  open: 'open file',
  panel: 'panel',
}

/** Plain-language workbench tab names, mirroring the context reading. */
const WORKSPACE_LABELS: Record<CAStudioViewportState['workspace'], string> = {
  model: 'model preview',
  parametric: 'parametric modeling',
  structural: 'structural simulation',
  thermal: 'thermal simulation',
}

const MODEL_STATUS_LABELS: Record<CAStudioViewportState['model']['status'], string> = {
  empty: 'no model loaded',
  loading: 'loading',
  ready: 'loaded',
  error: 'failed to load',
}

/** Reject scheduling bounds that cannot represent their contracts. */
function validateConfig(config: { stateTimeoutMs?: number; commandTimeoutMs?: number }): {
  stateTimeoutMs: number
  commandTimeoutMs: number
} {
  const stateTimeoutMs = config.stateTimeoutMs ?? DEFAULT_STATE_TIMEOUT_MS
  const commandTimeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  if (!Number.isSafeInteger(stateTimeoutMs) || stateTimeoutMs <= 0) {
    throw new TypeError(`tool-castudio: stateTimeoutMs must be a positive safe integer, got ${String(config.stateTimeoutMs)}`)
  }
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new TypeError(`tool-castudio: commandTimeoutMs must be a positive safe integer, got ${String(config.commandTimeoutMs)}`)
  }
  return { stateTimeoutMs, commandTimeoutMs }
}

/** Re-throw caller cancellation; wrap every other transport failure in a model-facing message. */
function transportError(origin: string, error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return error instanceof Error ? error : new Error(String(error))
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`cad_workbench: cannot reach the CAStudio service at ${origin} (${detail})`)
}

/** List the connected workbenches, or throw a model-facing failure. */
async function listWorkbenches(
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CAStudioConnectedViewport[]> {
  let response: Response
  try {
    response = await caStudioFetch(origin, '/api/dsh/viewports', { timeoutMs, signal })
  } catch (error) {
    throw transportError(origin, error, signal)
  }
  if (!response.ok) {
    throw new Error(`cad_workbench: the CAStudio service answered HTTP ${response.status} while listing CAD workbenches`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('cad_workbench: the CAStudio workbench list is not valid JSON')
  }
  const viewports = parseCAStudioViewports(body)
  if (viewports === undefined) {
    throw new Error('cad_workbench: the CAStudio workbench list has an unexpected shape')
  }
  return viewports
}

/** One row of `GET /api/projects/:id/viewport/state`. */
interface ViewportReport {
  connected: boolean
  ageMs: number | null
  state: CAStudioViewportState | null
}

/** Read one workbench's live viewport state, or throw a model-facing failure. */
async function readViewportState(
  origin: string,
  viewport: CAStudioConnectedViewport,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ViewportReport> {
  let response: Response
  try {
    response = await caStudioFetch(origin, `/api/projects/${viewport.id}/viewport/state?client=${encodeURIComponent(viewport.client)}`, { timeoutMs, signal })
  } catch (error) {
    throw transportError(origin, error, signal)
  }
  if (!response.ok) {
    throw new Error(
      `cad_workbench: workbench "${viewport.name}" (id ${viewport.id}) is not reporting state (HTTP ${response.status}); `
      + 'ask the user to keep the CAD workbench tab open',
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`cad_workbench: the viewport state of workbench "${viewport.name}" is not valid JSON`)
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error(`cad_workbench: the viewport state of workbench "${viewport.name}" has an unexpected shape`)
  }
  const raw = body as Record<string, unknown>
  if (typeof raw.connected !== 'boolean') {
    throw new Error(`cad_workbench: the viewport state of workbench "${viewport.name}" has an unexpected shape`)
  }
  let state: CAStudioViewportState | null = null
  if (raw.state !== null) {
    const parsed = parseCAStudioViewportState(raw.state)
    if (parsed === undefined) {
      throw new Error(`cad_workbench: the viewport state of workbench "${viewport.name}" has an unexpected shape`)
    }
    state = parsed
  }
  return {
    connected: raw.connected,
    ageMs: typeof raw.ageMs === 'number' ? raw.ageMs : null,
    state,
  }
}

/** The `snapshot` payload a command response carries and the canonical output repeats. */
interface SnapshotInfo {
  path: string
  absolutePath: string
  width: number
  height: number
  bytes: number
}

/** Canonical output shapes, mirroring `output.schema` for typed render/execute code. */
interface ProjectInfo {
  id: string
  name: string
}

interface ProjectedModel {
  path: string | null
  demo: boolean
  status: string
  error?: string
}

interface ProjectedPart {
  id: string
  name: string
  visible: boolean
}

interface ProjectedSelection {
  meshId: string
  name: string
}

interface ProjectedOptions {
  edges: boolean
  grid: boolean
  ortho: boolean
  section: number
  explode: number
  mode: string
}

interface ProjectedCamera {
  position: number[]
  target: number[]
  projection: string
}

interface ProjectedState {
  workspace: string
  model: ProjectedModel
  parts: ProjectedPart[]
  totalParts: number
  hiddenParts: number
  selection: ProjectedSelection | null
  options: ProjectedOptions
  camera: ProjectedCamera | null
}

/** The CAD part (`default` or a `parts/<slug>/` folder) the viewer shows. */
interface PartInfo {
  slug: string
  name: string
}

interface ToolOutput {
  project: ProjectInfo
  part: PartInfo
  action: string
  state?: ProjectedState
  snapshot?: SnapshotInfo
}

/** Parse and validate the optional snapshot block of a command response. */
function parseSnapshot(body: unknown): SnapshotInfo | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = body as Record<string, unknown>
  if (typeof raw.path !== 'string' || typeof raw.absolutePath !== 'string'
    || typeof raw.width !== 'number' || typeof raw.height !== 'number'
    || typeof raw.bytes !== 'number') return undefined
  return {
    path: raw.path,
    absolutePath: raw.absolutePath,
    width: raw.width,
    height: raw.height,
    bytes: raw.bytes,
  }
}

/** Dispatch one whitelist command and return the service's response body. */
async function postCommand(
  origin: string,
  viewport: CAStudioConnectedViewport,
  command: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ state: CAStudioViewportState | null; snapshot?: SnapshotInfo }> {
  let response: Response
  try {
    response = await caStudioFetch(origin, `/api/projects/${viewport.id}/viewport/command?client=${encodeURIComponent(viewport.client)}`, {
      method: 'POST',
      body: command,
      timeoutMs,
      signal,
    })
  } catch (error) {
    throw transportError(origin, error, signal)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (signal.aborted) throw error
    body = undefined
  }
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null
      && typeof (body as Record<string, unknown>).error === 'string'
      ? ` ${String((body as Record<string, unknown>).error)}`
      : ''
    const mismatch = response.status === 409 && typeof command.part === 'string' && command.action !== 'open'
      ? ` If the viewer shows a different part than "${command.part}", call action "open" with partSlug "${command.part}" to switch to it, or read the part it shows with action "state".`
      : ''
    throw new Error(`cad_workbench: the CAD workbench rejected the command (HTTP ${response.status}).${detail}${mismatch}`)
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('cad_workbench: the CAD workbench command response has an unexpected shape')
  }
  const raw = body as Record<string, unknown>
  let state: CAStudioViewportState | null = null
  if (raw.state !== undefined && raw.state !== null) {
    const parsed = parseCAStudioViewportState(raw.state)
    if (parsed === undefined) {
      throw new Error('cad_workbench: the CAD workbench command response has an unexpected shape')
    }
    state = parsed
  }
  const snapshot = raw.snapshot === undefined ? undefined : parseSnapshot(raw.snapshot)
  if (raw.snapshot !== undefined && snapshot === undefined) {
    throw new Error('cad_workbench: the CAD workbench snapshot payload has an unexpected shape')
  }
  return { state, ...(snapshot === undefined ? {} : { snapshot }) }
}

/** Pick the target workbench: explicit id, the only connected one, or a clear choice error. */
function selectWorkbench(
  viewports: readonly CAStudioConnectedViewport[],
  project: string | undefined,
): CAStudioConnectedViewport {
  if (project !== undefined) {
    const found = viewports.find(viewport => viewport.id === project)
    if (found !== undefined) return found
    const connected = viewports.map(viewport => `"${viewport.name}" (id ${viewport.id})`).join(', ') || 'none'
    throw new Error(
      `cad_workbench: no connected CAD workbench has id "${project}". Connected workbenches: ${connected}. `
      + 'Omit "project" when only one workbench is open.',
    )
  }
  if (viewports.length === 0) {
    throw new Error(
      'cad_workbench: no CAD workbench is open. Ask the user to open the CAD workbench tab in CAStudio, then retry.',
    )
  }
  if (viewports.length > 1) {
    const choices = viewports.map(viewport => `"${viewport.name}" (id ${viewport.id})`).join(', ')
    throw new Error(`cad_workbench: ${viewports.length} CAD workbenches are open; pass "project" to choose one: ${choices}.`)
  }
  return viewports[0] as CAStudioConnectedViewport
}

/** Format one part candidate for error messages. */
function partLabel(mesh: CAStudioViewportMesh): string {
  const name = typeof mesh.name === 'string' && mesh.name.length > 0 ? `"${mesh.name}"` : 'unnamed part'
  return `${name} (id ${typeof mesh.id === 'string' ? mesh.id : '?'})`
}

/** Bounded candidate list for resolution errors. */
function candidateList(meshes: readonly CAStudioViewportMesh[]): string {
  const valid = meshes.filter(mesh => typeof mesh.id === 'string' && mesh.id.length > 0)
  if (valid.length === 0) return 'none'
  const shown = valid.slice(0, MAX_PART_CANDIDATES).map(partLabel).join(', ')
  const rest = valid.length - Math.min(valid.length, MAX_PART_CANDIDATES)
  return rest > 0 ? `${shown}, …and ${rest} more` : shown
}

/**
 * Resolve a `part` argument to a mesh id: an exact id wins, then an exact
 * name; ambiguous or unknown names fail with the candidate list.
 */
function resolvePart(meshes: readonly CAStudioViewportMesh[], part: string): string {
  const byId = meshes.find(mesh => mesh.id === part)
  if (byId !== undefined && typeof byId.id === 'string') return byId.id
  const named = meshes.filter(mesh => mesh.name === part)
  const [firstNamed] = named
  if (named.length === 1 && firstNamed !== undefined && typeof firstNamed.id === 'string') return firstNamed.id
  if (named.length > 1) {
    throw new Error(
      `cad_workbench: part name "${part}" matches ${named.length} parts; pass a part id instead: ${candidateList(named)}.`,
    )
  }
  throw new Error(
    `cad_workbench: no part has id or exact name "${part}". Available parts: ${candidateList(meshes)}.`,
  )
}

/** The part a reported state shows; a page that predates parts shows the project root, part `default`. */
function shownPart(state: CAStudioViewportState): PartInfo {
  return state.part === undefined ? { slug: 'default', name: 'default' } : { slug: state.part.slug, name: state.part.name }
}

/** Project one reported state into the bounded canonical output shape. */
function projectState(state: CAStudioViewportState): ProjectedState {
  const meshes = state.meshes.filter(
    (mesh): mesh is CAStudioViewportMesh & { id: string; name: string } =>
      typeof mesh.id === 'string' && typeof mesh.name === 'string',
  )
  const hidden = meshes.filter(mesh => mesh.visible === false).length
  const selection = state.selection
  const options = state.options
  const camera = state.camera
  const model: ProjectedModel = {
    path: typeof state.model.path === 'string' ? state.model.path : null,
    demo: state.model.demo === true,
    status: state.model.status,
    ...(typeof state.model.error === 'string' ? { error: state.model.error } : {}),
  }
  return {
    workspace: state.workspace,
    model,
    parts: meshes.slice(0, MAX_PART_ROWS).map(mesh => ({
      id: mesh.id,
      name: mesh.name,
      visible: mesh.visible === true,
    })),
    totalParts: state.meshes.length,
    hiddenParts: hidden,
    selection: selection === null || typeof selection !== 'object'
      ? null
      : {
        meshId: typeof selection.meshId === 'string' ? selection.meshId : '',
        name: typeof selection.name === 'string' ? selection.name : '',
      },
    options: {
      edges: options.edges === true,
      grid: options.grid === true,
      ortho: options.ortho === true,
      section: typeof options.section === 'number' ? options.section : 100,
      explode: typeof options.explode === 'number' ? options.explode : 0,
      mode: options.mode === 'face' ? 'face' : 'component',
    },
    camera: camera === null || typeof camera !== 'object'
      ? null
      : {
        position: Array.isArray(camera.position) ? [...camera.position] : [0, 0, 0],
        target: Array.isArray(camera.target) ? [...camera.target] : [0, 0, 0],
        projection: camera.projection === 'orthographic' ? 'orthographic' : 'perspective',
      },
  }
}

/** Render the model-facing text for one canonical result. */
function renderText(
  action: Action,
  project: ProjectInfo,
  part: PartInfo,
  state: ProjectedState | undefined,
  snapshot: SnapshotInfo | undefined,
): string {
  const header = `CAD workbench "${project.name}" (id ${project.id}), part "${part.name}" (${part.slug})`
  if (action === 'snapshot' && snapshot !== undefined) {
    return `${header}: viewport snapshot saved.\n`
      + `File: ${snapshot.absolutePath} (workspace-relative path: ${snapshot.path}; ${snapshot.width}×${snapshot.height}, ${snapshot.bytes} bytes).\n`
      + 'Open it with the read_image tool to actually see the image.'
  }
  if (state === undefined) {
    return `${header}: ${ACTION_TITLES[action]} applied; the workbench did not report a new state.`
  }
  const subject = state.model.demo ? 'demonstration geometry' : state.model.path ?? 'no model file'
  const status = MODEL_STATUS_LABELS[state.model.status as CAStudioViewportState['model']['status']]
    ?? state.model.status
  const selection = state.selection
  const selectionText = selection === null || (selection.name === '' && selection.meshId === '')
    ? 'nothing selected'
    : selection.name === '' ? `part id ${selection.meshId}` : `"${selection.name}" (${selection.meshId})`
  const lines = [
    `Model: ${subject} — ${status}`,
    `Meshes: ${state.totalParts} total, ${state.hiddenParts} hidden (listing up to ${MAX_PART_ROWS})`,
    `Selection: ${selectionText}`,
    `Options: ortho ${state.options.ortho ? 'on' : 'off'}, section ${state.options.section}%, explode ${state.options.explode}, mode ${state.options.mode}`,
  ]
  if (state.camera !== null) {
    lines.push(`Camera: position [${state.camera.position.join(', ')}], target [${state.camera.target.join(', ')}], ${state.camera.projection}`)
  }
  const tab = WORKSPACE_LABELS[state.workspace as CAStudioViewportState['workspace']] ?? state.workspace
  const prefix = action === 'state' ? `${header} — tab: ${tab}\nCurrent state:` : `${header}: ${ACTION_TITLES[action]} applied.`
  return `${prefix}\n${lines.join('\n')}`
}

/** Display-option fields the `options` action accepts. */
interface OptionsInput {
  edges?: boolean
  grid?: boolean
  ortho?: boolean
  section?: number
  explode?: number
  mode?: 'component' | 'face'
}

/** Build the whitelist command body for one validated action. */
function buildCommand(
  action: Action,
  args: {
    view?: 'iso' | 'top' | 'front' | 'right'
    part?: string
    face?: number
    visible?: boolean
    options?: OptionsInput
    workspace?: CAStudioViewportState['workspace']
    path?: string
    panel?: 'viewer' | 'editor' | 'files' | 'properties'
    state?: 'expand' | 'collapse'
  },
  meshId: string | undefined,
): Record<string, unknown> {
  switch (action) {
    case 'open': return { action: 'open', path: args.path }
    case 'panel': return { action: 'panel', panel: args.panel, state: args.state }
    case 'snapshot': return { action: 'snapshot' }
    case 'fit': return args.view === undefined ? { action: 'fit' } : { action: 'fit', view: args.view }
    case 'select': return { action: 'select', meshId: meshId ?? null }
    case 'select_face': return { action: 'select_face', meshId, face: args.face }
    case 'visible': return { action: 'visible', meshId, visible: args.visible }
    case 'options': return { action: 'options', options: args.options }
    case 'workspace': return { action: 'workspace', workspace: args.workspace }
    default: throw new Error(`cad_workbench: action "${action}" does not dispatch a command`)
  }
}

/**
 * Register the `cad_workbench` tool for the lifetime of `ctx`.
 * @param ctx - plugin context; the registration is disposed with it.
 * @param config - service origin and the two request timeout bounds.
 * @returns when the tool is registered.
 * @throws when the service origin or a timeout is invalid.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = resolveCAStudioOrigin(config.url)
  const { stateTimeoutMs, commandTimeoutMs } = validateConfig(config)

  ctx.tools.register(defineTool({
    name: 'cad_workbench',
    description:
      'Inspect and operate the live CAD workbench the user has open in CAStudio. '
      + 'Actions: state (read the viewport state), snapshot (save a PNG of the viewport), '
      + 'fit (frame the model from iso/top/front/right), select and select_face (pick a part by id or exact name, '
      + 'or a CAD face), visible (show or hide a part), options (edges, grid, ortho, section, explode, selection mode), '
      + 'workspace (switch the model/parametric/structural/thermal tab), '
      + 'open (open a model file in the viewer, optionally switching to another part), '
      + 'and panel (expand or collapse the viewer, editor, files, or properties panel). '
      + 'A CAD project holds parts: part "default" is the workspace root and every other part lives in parts/<slug>/. '
      + 'Pass "partSlug" (from the "Project / Part" line of the CAStudio context) so a command only runs while the viewer shows that part; '
      + 'the service refuses it when the viewer shows a different part. Every result names the part the viewer shows. '
      + 'It only inspects and operates the view; geometry, colour and material edits go through the '
      + 'parametric code API described in the castudio skill. '
      + 'When several workbenches are open, pass "project" with the workbench id from the CAStudio context.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'What to do with the workbench.',
      },
      project: {
        type: 'string',
        description: 'Workbench project id. Required when several workbenches are open; defaults to the only connected one.',
      },
      view: {
        type: 'string',
        enum: ['iso', 'top', 'front', 'right'],
        description: 'fit only: camera direction to frame the model from.',
      },
      partSlug: {
        type: 'string',
        description:
          'CAD part slug: "default" or a lowercase hyphenated slug of a folder under parts/. '
          + 'open: the part to switch to. Any other command action: the part you expect the viewer to show; '
          + 'the command is refused when the viewer shows another part. state ignores it and reports the part shown.',
      },
      path: {
        type: 'string',
        description: 'open only: model file path relative to the target part\'s workspace (the workspace root for part "default", parts/<slug>/ otherwise).',
      },
      panel: {
        type: 'string',
        enum: ['viewer', 'editor', 'files', 'properties'],
        description: 'panel action only: the workbench panel to expand or collapse.',
      },
      state: {
        type: 'string',
        enum: ['expand', 'collapse'],
        description: 'panel action only: expand or collapse the panel.',
      },
      part: {
        type: 'string',
        description: 'select, select_face, and visible: a mesh (viewport object) id or an exact mesh name from the reported state. It is not a CAD part; use partSlug for that.',
      },
      face: {
        type: 'integer',
        description: 'select_face only: non-negative CAD face index on the part.',
      },
      visible: {
        type: 'boolean',
        description: 'visible action only: true to show the part, false to hide it.',
      },
      options: {
        type: 'object',
        additionalProperties: false,
        description: 'options action only: any subset of display options to change.',
        properties: {
          edges: { type: 'boolean', description: 'Show mesh edges.' },
          grid: { type: 'boolean', description: 'Show the ground grid.' },
          ortho: { type: 'boolean', description: 'Orthographic instead of perspective projection.' },
          section: { type: 'number', description: 'Section plane percentage, 0-100 (100 = off).' },
          explode: { type: 'number', description: 'Exploded-view amount, 0-180 (0 = off).' },
          mode: { type: 'string', enum: ['component', 'face'], description: 'Selection mode: whole component or single CAD face.' },
        },
      },
      workspace: {
        type: 'string',
        enum: ['model', 'parametric', 'structural', 'thermal'],
        description: 'workspace action only: the workbench tab to switch to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
          part: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              slug: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
          action: { type: 'string', required: true },
          state: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workspace: { type: 'string', required: true },
              model: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  demo: { type: 'boolean', required: true },
                  status: { type: 'string', required: true },
                  error: { type: 'string' },
                },
              },
              parts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    visible: { type: 'boolean', required: true },
                  },
                },
              },
              totalParts: { type: 'integer', required: true },
              hiddenParts: { type: 'integer', required: true },
              selection: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      meshId: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                    },
                  },
                  { type: 'null' },
                ],
                required: true,
              },
              options: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  edges: { type: 'boolean', required: true },
                  grid: { type: 'boolean', required: true },
                  ortho: { type: 'boolean', required: true },
                  section: { type: 'number', required: true },
                  explode: { type: 'number', required: true },
                  mode: { type: 'string', required: true },
                },
              },
              camera: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      position: { type: 'array', required: true, items: { type: 'number' } },
                      target: { type: 'array', required: true, items: { type: 'number' } },
                      projection: { type: 'string', required: true },
                    },
                  },
                  { type: 'null' },
                ],
                required: true,
              },
            },
          },
          snapshot: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              absolutePath: { type: 'string', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              bytes: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: renderText(args.action, value.project, value.part, value.state, value.snapshot),
      }],
      presentationMeta: (_args, value) => ({ project: value.project, part: value.part, action: value.action }),
    },
    execute: async (args, exec) => {
      const action = args.action
      const allowed = ACTION_FIELDS[action]
      for (const key of Object.keys(args)) {
        if (!allowed.has(key)) {
          throw new Error(`cad_workbench: "${key}" does not apply to action "${action}"`)
        }
      }
      for (const required of ACTION_REQUIRED[action]) {
        if (args[required as keyof typeof args] === undefined) {
          throw new Error(`cad_workbench: action "${action}" requires "${required}"`)
        }
      }
      if (action === 'select_face'
        && (typeof args.face !== 'number' || !Number.isInteger(args.face) || args.face < 0)) {
        throw new Error('cad_workbench: "face" must be a non-negative integer')
      }
      if (action === 'options' && args.options !== undefined
        && Object.keys(args.options).length === 0) {
        throw new Error('cad_workbench: "options" must set at least one display option')
      }

      // A project may be open in several sessions at once; this tool only ever
      // drives the CAD instance owned by the session that asked for it.
      const owner = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const listed = await listWorkbenches(origin, stateTimeoutMs, exec.signal)
      const viewports = owner === undefined
        ? listed
        : listed.filter(viewport => viewport.client === owner || viewport.client === 'main')
      if (viewports.length === 0 && args.project === undefined) {
        throw new Error(
          'cad_workbench: no CAD workbench is open. Ask the user to open the CAD workbench tab in CAStudio, then retry.',
        )
      }
      const viewport = selectWorkbench(viewports, args.project)

      if (action === 'state') {
        const report = await readViewportState(origin, viewport, stateTimeoutMs, exec.signal)
        if (!report.connected || report.state === null) {
          throw new Error(
            `cad_workbench: workbench "${viewport.name}" (id ${viewport.id}) is not responding; `
            + 'ask the user to keep the CAD workbench tab open',
          )
        }
        const output: ToolOutput = {
          project: { id: viewport.id, name: viewport.name },
          part: shownPart(report.state),
          action,
          state: projectState(report.state),
        }
        return output
      }

      let meshId: string | undefined
      if (action === 'select' || action === 'select_face' || action === 'visible') {
        const report = await readViewportState(origin, viewport, stateTimeoutMs, exec.signal)
        if (!report.connected || report.state === null) {
          throw new Error(
            `cad_workbench: workbench "${viewport.name}" (id ${viewport.id}) is not responding; `
            + 'ask the user to keep the CAD workbench tab open',
          )
        }
        meshId = resolvePart(report.state.meshes, args.part as string)
      }

      const command = { ...buildCommand(action, args, meshId), ...(args.partSlug === undefined ? {} : { part: args.partSlug }) }
      const result = await postCommand(origin, viewport, command, commandTimeoutMs, exec.signal)
      const output: ToolOutput = {
        project: { id: viewport.id, name: viewport.name },
        part: shownPart(result.state ?? viewport.state),
        action,
        ...(result.state === null ? {} : { state: projectState(result.state) }),
        ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }),
      }
      return output
    },
    presentCall: args => ({
      card: 'generic',
      title: `CAD workbench: ${ACTION_TITLES[args.action]}`,
      kind: 'other',
      rawInput: args,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `CAD workbench: ${ACTION_TITLES[args.action]}`,
      content: result.content,
    }),
  }))
}
