import type { ViewportCommand, ViewportPanel, ViewportPart, ViewportState } from '../shared/viewport';
import type { MeshInfo, Selection, ViewOptions } from './scene/renderer';
import type { PreviewState } from './scene/review-selection';
import type { ViewportHandle } from './components/Viewport';

export type ViewportReportInput = {
  workspace: ViewportState['workspace'];
  modelPath: string | null;
  demo: boolean;
  preview: PreviewState | null;
  previewCurrent: boolean;
  meshes: readonly MeshInfo[];
  selection: Selection | null;
  options: ViewOptions;
  camera: ViewportState['camera'];
  part?: ViewportPart;
};

export function buildViewportState(input: ViewportReportInput): ViewportState {
  const status: ViewportState['model']['status'] = input.preview && input.previewCurrent ? input.preview.status
    : input.modelPath || input.demo ? 'loading' : 'empty';
  const model: ViewportState['model'] = { path: input.modelPath, demo: input.demo, status };
  if (status === 'error' && input.preview?.error) model.error = input.preview.error;
  const picked = input.selection;
  const selection: ViewportState['selection'] = picked ? {
    meshId: picked.meshId, name: picked.name, bounds: picked.bounds, triangles: picked.triangles,
    ...(picked.triangle !== undefined ? { triangle: picked.triangle } : {}),
    ...(picked.point ? { point: picked.point } : {}),
    ...(picked.cadFace ? { cadFace: picked.cadFace } : {}),
    ...(picked.cylinderObjectId ? { cylinderObjectId: picked.cylinderObjectId } : {}),
  } : null;
  return {
    workspace: input.workspace,
    model,
    meshes: input.meshes.slice(0, 500).map(mesh => {
      const out: ViewportState['meshes'][number] = { id: mesh.id, name: mesh.name, visible: mesh.visible, triangles: mesh.triangles };
      if (mesh.group) out.group = mesh.group;
      if (mesh.cylinderObjectId) out.cylinderObjectId = mesh.cylinderObjectId;
      return out;
    }),
    selection,
    options: { ...input.options },
    camera: input.camera,
    ...(input.part ? { part: { ...input.part } } : {}),
  };
}

export type ViewportCommandResult = { ok: boolean; error?: string; state?: ViewportState; snapshot?: string };
export type ViewportBridgeDeps = {
  handle: ViewportHandle | null;
  meshes: readonly MeshInfo[];
  setOptions: (update: ViewOptions | ((old: ViewOptions) => ViewOptions)) => void;
  setMeshes: (update: MeshInfo[] | ((old: MeshInfo[]) => MeshInfo[])) => void;
  openWorkspace: (mode: ViewportState['workspace']) => void;
  /** Expands a collapsed viewer panel so the canvas has its real size before capture. */
  revealViewer: () => void;
  /** Shows `path` of part `part` (current part when omitted); resolves to an error message when it cannot. */
  openModel: (path: string, part?: string) => Promise<string | null>;
  setPanel: (panel: ViewportPanel, state: 'expand' | 'collapse') => void;
  buildState: () => ViewportState;
  wait?: () => Promise<void>;
};

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 150));

export async function applyViewportCommand(command: ViewportCommand, deps: ViewportBridgeDeps): Promise<ViewportCommandResult> {
  const handle = deps.handle;
  if (!handle) return { ok: false, error: '视口尚未就绪' };
  const known = (id: string) => deps.meshes.some(mesh => mesh.id === id);
  try {
    switch (command.action) {
      case 'fit': handle.fit(command.view); break;
      case 'select':
        if (command.meshId !== null && !known(command.meshId)) return { ok: false, error: `未找到网格 ${command.meshId}` };
        handle.select(command.meshId); break;
      case 'select_face':
        if (!known(command.meshId)) return { ok: false, error: `未找到网格 ${command.meshId}` };
        if (!handle.selectFace(command.meshId, command.face)) return { ok: false, error: '该网格没有可选的 CAD 面' };
        break;
      case 'visible':
        if (!known(command.meshId)) return { ok: false, error: `未找到网格 ${command.meshId}` };
        handle.visible(command.meshId, command.visible);
        deps.setMeshes(old => old.map(mesh => mesh.id === command.meshId ? { ...mesh, visible: command.visible } : mesh));
        break;
      case 'options': deps.setOptions(old => ({ ...old, ...command.options })); break;
      case 'workspace': deps.openWorkspace(command.workspace); break;
      // The model stage stays laid out behind other pages, so a capture never switches the user's page.
      case 'snapshot': deps.revealViewer(); break;
      case 'open': { const error = await deps.openModel(command.path, command.part); if (error) return { ok: false, error }; deps.revealViewer(); break; }
      case 'panel': deps.setPanel(command.panel, command.state); break;
      default: return { ok: false, error: '未知视口指令' };
    }
  } catch (error) { return { ok: false, error: (error as Error).message }; }
  await (deps.wait ?? tick)();
  // A part switch resets the page first; report once the requested model is the one shown (about 3 s at most).
  if (command.action === 'open') {
    const shown = () => { const state = deps.buildState(); return state.model.path === command.path && (command.part === undefined || (state.part?.slug ?? 'default') === command.part); };
    for (let i = 0; i < 20 && !shown(); i++) await (deps.wait ?? tick)();
  }
  if (command.action === 'snapshot') {
    const snapshot = handle.snapshotData();
    if (!snapshot) return { ok: false, error: '视口截图失败' };
    return { ok: true, snapshot, state: deps.buildState() };
  }
  return { ok: true, state: deps.buildState() };
}
