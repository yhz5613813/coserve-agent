import test from 'node:test';
import assert from 'node:assert/strict';
import { applyViewportCommand, buildViewportState, type ViewportBridgeDeps, type ViewportReportInput } from '../src/viewport-bridge.js';
import type { MeshInfo, Selection, ViewOptions } from '../src/scene/renderer.js';
import type { ViewportHandle } from '../src/components/Viewport.js';
import type { ViewportState } from '../shared/viewport.js';

const options: ViewOptions = { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' };
const camera = { position: [10, -20, 30] as [number, number, number], target: [0, 0, 0] as [number, number, number], projection: 'perspective' as const };
const meshes: MeshInfo[] = [
  { id: 'mesh-a', name: '底座', visible: true, triangles: 100, cylinderObjectId: 'co-1' },
  { id: 'mesh-b', name: '螺栓 01', visible: false, triangles: 50, group: '紧固件' },
];
const input = (overrides: Partial<ViewportReportInput> = {}): ViewportReportInput => ({
  workspace: 'model', modelPath: null, demo: true, preview: null, previewCurrent: false,
  meshes, selection: null, options, camera, ...overrides,
});

test('buildViewportState caps meshes at 500, strips packageMesh and maps model status', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, name: `网格 ${i}`, visible: true, triangles: i }));
  const state = buildViewportState(input({ meshes: many, modelPath: 'models/a.glb', preview: { url: 'blob:x', status: 'ready' }, previewCurrent: true }));
  assert.equal(state.meshes.length, 500);
  assert.equal(state.meshes[0].id, 'm0');
  assert.equal(state.meshes[499].id, 'm499');
  assert.deepEqual(state.model, { path: 'models/a.glb', demo: true, status: 'ready' });
  assert.equal(state.camera, camera);
  const selection: Selection = { meshId: 'mesh-a', name: '底座', bounds: [0, 0, 0, 1, 1, 1], triangles: 100, triangle: 4, point: [1, 2, 3], cadFace: { index: 2 } as Selection['cadFace'], packageMesh: { nodeId: 'n', definitionId: 'd', archiveHash: 'h', selectable: true } };
  const withSelection = buildViewportState(input({ selection }));
  assert.equal(withSelection.selection!.meshId, 'mesh-a');
  assert.equal(withSelection.selection!.triangle, 4);
  assert.deepEqual(withSelection.selection!.point, [1, 2, 3]);
  assert.equal('packageMesh' in withSelection.selection!, false);
  assert.equal(withSelection.selection!.cadFace !== undefined, true);
  assert.equal(buildViewportState(input({ preview: { url: 'blob:x', status: 'error', error: '解析失败' }, previewCurrent: true })).model.error, '解析失败');
  assert.equal(buildViewportState(input({ demo: false, modelPath: null })).model.status, 'empty');
  assert.equal(buildViewportState(input({ demo: false, modelPath: 'a.glb' })).model.status, 'loading');
});

function harness(overrides: { selectFaceResult?: boolean; snapshot?: string | null; meshes?: MeshInfo[] } = {}) {
  const calls: string[] = [];
  let currentOptions = { ...options };
  let currentMeshes = [...(overrides.meshes ?? meshes)];
  const handle: ViewportHandle = {
    fit: view => { calls.push(`fit:${view ?? 'iso'}`); },
    snapshot: () => {},
    exportModel: async () => new Blob(),
    snapshotData: () => overrides.snapshot === undefined ? 'data:image/png;base64,QUJD' : overrides.snapshot,
    state: () => ({ camera }),
    select: id => { calls.push(`select:${id}`); },
    selectFace: (id, face) => { calls.push(`selectFace:${id}:${face}`); return overrides.selectFaceResult ?? true; },
    visible: (id, visible) => { calls.push(`visible:${id}:${visible}`); },
    locateReview: () => ({}),
    measure: () => Promise.reject(new Error('unused')),
  };
  const deps: ViewportBridgeDeps = {
    handle, meshes: currentMeshes,
    setOptions: update => { currentOptions = typeof update === 'function' ? update(currentOptions) : update; },
    setMeshes: update => { currentMeshes = typeof update === 'function' ? update(currentMeshes) : update; },
    openWorkspace: mode => { calls.push(`workspace:${mode}`); },
    revealViewer: () => { calls.push('reveal-viewer'); },
    openModel: async (path, part) => { calls.push(`open:${part ?? '-'}:${path}`); return path === 'missing.step' ? '未找到模型 missing.step' : null; },
    setPanel: (panel, state) => { calls.push(`panel:${panel}:${state}`); },
    buildState: () => buildViewportState(input({ meshes: currentMeshes, options: currentOptions })),
    wait: async () => {},
  };
  return { deps, calls, options: () => currentOptions, meshList: () => currentMeshes };
}

test('applyViewportCommand executes every action against the handle', async () => {
  const h = harness();
  const reported = buildViewportState(input());
  h.deps.buildState = () => reported;
  assert.deepEqual(await applyViewportCommand({ action: 'fit' }, h.deps), { ok: true, state: reported });
  assert.deepEqual(await applyViewportCommand({ action: 'fit', view: 'top' }, h.deps), { ok: true, state: reported });
  assert.deepEqual(await applyViewportCommand({ action: 'select', meshId: 'mesh-a' }, h.deps), { ok: true, state: reported });
  assert.deepEqual(await applyViewportCommand({ action: 'select', meshId: null }, h.deps), { ok: true, state: reported });
  assert.deepEqual(await applyViewportCommand({ action: 'select_face', meshId: 'mesh-b', face: 2 }, h.deps), { ok: true, state: reported });
  const visible = await applyViewportCommand({ action: 'visible', meshId: 'mesh-b', visible: true }, h.deps);
  assert.equal(visible.ok, true);
  assert.equal(h.meshList().find(m => m.id === 'mesh-b')!.visible, true);
  const merged = await applyViewportCommand({ action: 'options', options: { grid: false, section: 40 } }, h.deps);
  assert.equal(merged.ok, true);
  assert.equal(h.options().grid, false);
  assert.equal(h.options().section, 40);
  assert.equal(h.options().edges, true);
  assert.deepEqual(await applyViewportCommand({ action: 'workspace', workspace: 'parametric' }, h.deps), { ok: true, state: reported });
  assert.deepEqual(h.calls, ['fit:iso', 'fit:top', 'select:mesh-a', 'select:null', 'selectFace:mesh-b:2', 'visible:mesh-b:true', 'workspace:parametric']);
});

test('open switches part and model through the page, reveals the viewer, and reports a missing file; panel toggles a panel', async () => {
  const h = harness();
  h.deps.buildState = () => buildViewportState(input({ part: { slug: 'shaft', name: '轴' } }));
  const opened = await applyViewportCommand({ action: 'open', path: 'shaft.step', part: 'shaft' }, h.deps);
  assert.deepEqual(opened.state?.part, { slug: 'shaft', name: '轴' });
  assert.deepEqual(await applyViewportCommand({ action: 'open', path: 'missing.step' }, h.deps), { ok: false, error: '未找到模型 missing.step' });
  assert.equal((await applyViewportCommand({ action: 'panel', panel: 'editor', state: 'collapse' }, h.deps)).ok, true);
  assert.deepEqual(h.calls, ['open:shaft:shaft.step', 'reveal-viewer', 'open:-:missing.step', 'panel:editor:collapse']);
  assert.equal('part' in buildViewportState(input()), false);
});

test('applyViewportCommand reports failures for unknown meshes, missing faces and missing handle', async () => {
  const h = harness({ selectFaceResult: false });
  h.deps.buildState = () => buildViewportState(input());
  assert.deepEqual(await applyViewportCommand({ action: 'select', meshId: 'ghost' }, h.deps), { ok: false, error: '未找到网格 ghost' });
  assert.deepEqual(await applyViewportCommand({ action: 'select_face', meshId: 'ghost', face: 0 }, h.deps), { ok: false, error: '未找到网格 ghost' });
  assert.deepEqual(await applyViewportCommand({ action: 'visible', meshId: 'ghost', visible: true }, h.deps), { ok: false, error: '未找到网格 ghost' });
  assert.deepEqual(await applyViewportCommand({ action: 'select_face', meshId: 'mesh-a', face: 9 }, h.deps), { ok: false, error: '该网格没有可选的 CAD 面' });
  assert.deepEqual(await applyViewportCommand({ action: 'snapshot' }, { ...h.deps, handle: null }), { ok: false, error: '视口尚未就绪' });
  assert.equal(h.calls.filter(call => call.startsWith('selectFace')).length, 1);
});

test('applyViewportCommand snapshot returns the data URL without switching the workspace', async () => {
  const h = harness({ snapshot: 'data:image/png;base64,iVBORw0KGgo=' });
  h.deps.buildState = () => buildViewportState(input());
  const result = await applyViewportCommand({ action: 'snapshot' }, h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot, 'data:image/png;base64,iVBORw0KGgo=');
  assert.deepEqual(h.calls, ['reveal-viewer']);
  const empty = harness({ snapshot: null });
  empty.deps.buildState = () => buildViewportState(input());
  assert.deepEqual(await applyViewportCommand({ action: 'snapshot' }, empty.deps), { ok: false, error: '视口截图失败' });
});
