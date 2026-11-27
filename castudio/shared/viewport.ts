export type ViewportMesh = { id: string; name: string; visible: boolean; triangles: number; group?: string; cylinderObjectId?: string };
export type ViewportState = {
  workspace: 'model' | 'parametric' | 'structural' | 'thermal';
  model: { path: string | null; demo: boolean; status: 'empty' | 'loading' | 'ready' | 'error'; error?: string };
  meshes: ViewportMesh[];
  selection: { meshId: string; name: string; triangle?: number; point?: number[]; bounds: number[]; triangles: number; cadFace?: unknown; cylinderObjectId?: string } | null;
  options: { edges: boolean; grid: boolean; ortho: boolean; section: number; explode: number; mode: 'component' | 'face' };
  camera: { position: [number, number, number]; target: [number, number, number]; projection: 'perspective' | 'orthographic' } | null;
  /** The part this viewer shows; `model.path` is relative to that part's workspace. Absent from pages that predate parts. */
  part?: ViewportPart;
};
/** `slug` is `default` for the project root, otherwise the folder under `parts/`. */
export type ViewportPart = { slug: string; name: string };
export type ViewportPanel = 'viewer' | 'editor' | 'files' | 'properties';
/**
 * `part` on `open` is the part to switch to; on every other action it is the part the caller expects
 * the viewer to show, and the service refuses the command when the viewer shows another one.
 */
export type ViewportCommand = { part?: string } & (
  | { action: 'fit'; view?: 'iso' | 'top' | 'front' | 'right' }
  | { action: 'select'; meshId: string | null }
  | { action: 'select_face'; meshId: string; face: number }
  | { action: 'visible'; meshId: string; visible: boolean }
  | { action: 'options'; options: Partial<ViewportState['options']> }
  | { action: 'workspace'; workspace: ViewportState['workspace'] }
  | { action: 'snapshot' }
  | { action: 'open'; path: string }
  | { action: 'panel'; panel: ViewportPanel; state: 'expand' | 'collapse' });

export const partSlugPattern = /^(default|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const partSlug = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && partSlugPattern.test(value);
const panels: ViewportPanel[] = ['viewer', 'editor', 'files', 'properties'];
const workspaces = ['model', 'parametric', 'structural', 'thermal'];
const stateKeys = ['workspace', 'model', 'meshes', 'selection', 'options', 'camera', 'part'];
const optionKeys = ['edges', 'grid', 'ortho', 'section', 'explode', 'mode'];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vec3 = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(finite);
const shortText = (value: unknown, max = 400): value is string => typeof value === 'string' && value.length <= max;
const meshId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
// The section slider is bounded 0–100 in the toolbar; explode is normalized by the renderer (/180 = one bounding diagonal of travel, UI toggles 0/30).
const ranged = (value: unknown, max: number): value is number => finite(value) && value >= 0 && value <= max;
const optionRange: Record<string, number> = { section: 100, explode: 180 };

function validateOptions(value: unknown, partial: boolean): ViewportState['options'] {
  if (!isObject(value)) throw new Error('视口显示选项必须是对象');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!optionKeys.includes(key)) throw new Error('视口显示选项含有不支持的字段');
    const field = value[key];
    if (key === 'section' || key === 'explode') { if (!ranged(field, optionRange[key])) throw new Error('视口剖切或拆分数值超出范围'); }
    else if (key === 'mode') { if (field !== 'component' && field !== 'face') throw new Error('视口选择模式无效'); }
    else if (typeof field !== 'boolean') throw new Error('视口显示开关必须是布尔值');
    out[key] = field;
  }
  if (partial) return out as ViewportState['options'];
  for (const key of optionKeys) if (!(key in out)) throw new Error('视口显示选项不完整');
  return out as ViewportState['options'];
}

export function validateViewportState(body: unknown): ViewportState {
  if (!isObject(body)) throw new Error('视口状态必须是对象');
  for (const key of Object.keys(body)) if (!stateKeys.includes(key)) throw new Error('视口状态含有不支持的字段');
  if (!workspaces.includes(String(body.workspace))) throw new Error('视口工作区无效');
  const model = body.model;
  if (!isObject(model) || !(model.path === null || shortText(model.path, 1000)) || typeof model.demo !== 'boolean'
    || !['empty', 'loading', 'ready', 'error'].includes(String(model.status))
    || (model.error !== undefined && !shortText(model.error, 1000))) throw new Error('视口模型状态无效');
  if (!Array.isArray(body.meshes) || body.meshes.length > 500) throw new Error('视口网格列表无效');
  const meshes = body.meshes.map(raw => {
    if (!isObject(raw) || !meshId(raw.id) || !shortText(raw.name, 300) || typeof raw.visible !== 'boolean' || !finite(raw.triangles) || raw.triangles < 0
      || (raw.group !== undefined && !shortText(raw.group, 300)) || (raw.cylinderObjectId !== undefined && !shortText(raw.cylinderObjectId, 128))) throw new Error('视口网格信息无效');
    const mesh: ViewportMesh = { id: raw.id, name: raw.name, visible: raw.visible, triangles: raw.triangles };
    if (raw.group !== undefined) mesh.group = raw.group;
    if (raw.cylinderObjectId !== undefined) mesh.cylinderObjectId = raw.cylinderObjectId;
    return mesh;
  });
  let selection: ViewportState['selection'] = null;
  if (body.selection !== null && body.selection !== undefined) {
    const raw = body.selection;
    if (!isObject(raw) || !meshId(raw.meshId) || !shortText(raw.name, 300) || !finite(raw.triangles) || raw.triangles < 0
      || !Array.isArray(raw.bounds) || raw.bounds.length < 3 || raw.bounds.length > 6 || !raw.bounds.every(finite)
      || (raw.triangle !== undefined && (!Number.isSafeInteger(raw.triangle) || (raw.triangle as number) < 0))
      || (raw.point !== undefined && !vec3(raw.point))
      || (raw.cylinderObjectId !== undefined && !shortText(raw.cylinderObjectId, 128))) throw new Error('视口选择状态无效');
    selection = { meshId: raw.meshId, name: raw.name, bounds: raw.bounds as number[], triangles: raw.triangles };
    if (raw.triangle !== undefined) selection.triangle = raw.triangle as number;
    if (raw.point !== undefined) selection.point = raw.point;
    if ('cadFace' in raw) selection.cadFace = raw.cadFace;
    if (raw.cylinderObjectId !== undefined) selection.cylinderObjectId = raw.cylinderObjectId;
  }
  const camera = body.camera;
  let view: ViewportState['camera'] = null;
  if (camera !== null && camera !== undefined) {
    if (!isObject(camera) || !vec3(camera.position) || !vec3(camera.target) || !['perspective', 'orthographic'].includes(String(camera.projection))) throw new Error('视口相机状态无效');
    view = { position: camera.position, target: camera.target, projection: camera.projection as 'perspective' | 'orthographic' };
  }
  const options = validateOptions(body.options, false);
  const state: ViewportState = {
    workspace: body.workspace as ViewportState['workspace'],
    model: { path: model.path as string | null, demo: model.demo, status: model.status as ViewportState['model']['status'] },
    meshes, selection, options, camera: view,
  };
  if (model.error !== undefined) state.model.error = model.error;
  if (body.part !== undefined) {
    const part = body.part;
    if (!isObject(part) || !partSlug(part.slug) || !shortText(part.name, 120) || Object.keys(part).some(key => key !== 'slug' && key !== 'name')) throw new Error('视口零件信息无效');
    state.part = { slug: part.slug, name: part.name };
  }
  return state;
}

const commandKeys: Record<string, string[]> = {
  fit: ['action', 'view'],
  select: ['action', 'meshId'],
  select_face: ['action', 'meshId', 'face'],
  visible: ['action', 'meshId', 'visible'],
  options: ['action', 'options'],
  workspace: ['action', 'workspace'],
  snapshot: ['action'],
  open: ['action', 'path'],
  panel: ['action', 'panel', 'state'],
};

export function validateViewportCommand(body: unknown): ViewportCommand {
  if (!isObject(body) || typeof body.action !== 'string') throw new Error('未知视口指令');
  const allowed = commandKeys[body.action];
  if (!allowed) throw new Error('未知视口指令');
  for (const key of Object.keys(body)) if (key !== 'part' && !allowed.includes(key)) throw new Error('视口指令含有不支持的字段');
  if (body.part !== undefined && !partSlug(body.part)) throw new Error('视口零件标识无效');
  const { part, ...rest } = body as Record<string, unknown>;
  const command = parseCommand(rest);
  return part === undefined ? command : { ...command, part: part as string };
}

function parseCommand(raw: Record<string, unknown>): ViewportCommand {
  switch (raw.action) {
    case 'fit':
      if (raw.view !== undefined && !['iso', 'top', 'front', 'right'].includes(String(raw.view))) throw new Error('视口视角无效');
      return raw.view === undefined ? { action: 'fit' } : { action: 'fit', view: raw.view as 'iso' | 'top' | 'front' | 'right' };
    case 'select':
      if (raw.meshId !== null && !meshId(raw.meshId)) throw new Error('视口网格编号无效');
      return { action: 'select', meshId: raw.meshId as string | null };
    case 'select_face':
      if (!meshId(raw.meshId) || !Number.isSafeInteger(raw.face) || (raw.face as number) < 0) throw new Error('视口面选择参数无效');
      return { action: 'select_face', meshId: raw.meshId, face: raw.face as number };
    case 'visible':
      if (!meshId(raw.meshId) || typeof raw.visible !== 'boolean') throw new Error('视口显隐参数无效');
      return { action: 'visible', meshId: raw.meshId, visible: raw.visible };
    case 'options':
      return { action: 'options', options: validateOptions(raw.options, true) };
    case 'workspace':
      if (!workspaces.includes(String(raw.workspace))) throw new Error('视口工作区无效');
      return { action: 'workspace', workspace: raw.workspace as ViewportState['workspace'] };
    case 'snapshot':
      return { action: 'snapshot' };
    case 'open':
      if (!shortText(raw.path, 1000) || !raw.path || raw.path.startsWith('/') || raw.path.split(/[\\/]/).includes('..')) throw new Error('打开的模型路径无效');
      return { action: 'open', path: raw.path };
    case 'panel':
      if (!panels.includes(raw.panel as ViewportPanel) || (raw.state !== 'expand' && raw.state !== 'collapse')) throw new Error('面板指令参数无效');
      return { action: 'panel', panel: raw.panel as ViewportPanel, state: raw.state };
    default:
      throw new Error('未知视口指令');
  }
}

/** The mesh a command addresses, or null when it does not target one (select-null, fit, options, workspace, snapshot). */
export function viewportCommandMeshId(command: ViewportCommand): string | null {
  switch (command.action) {
    case 'select': return command.meshId;
    case 'select_face':
    case 'visible': return command.meshId;
    default: return null;
  }
}
