import type { CSSProperties } from 'react';

/** The model page has four role-fixed panels; users resize, collapse and reorder them, never create or delete them. */
export type PanelId = 'viewer' | 'editor' | 'files' | 'properties';
export type WorkbenchLayout = { order: PanelId[]; collapsed: PanelId[]; weight: Record<PanelId, number>; split: number };
export type PresetId = 'default' | 'review' | 'code';

export const panelIds: PanelId[] = ['viewer', 'editor', 'files', 'properties'];
export const minPanelPx = 72;
/** Container width from which the first panel gets its own column. */
export const sideBySideWidth = 860;

export const layoutPresets: Record<PresetId, { label: string; layout: WorkbenchLayout }> = {
  default: { label: '默认', layout: { order: ['viewer', 'files', 'editor', 'properties'], collapsed: ['editor', 'properties'], weight: { viewer: 3, editor: 2, files: 1.4, properties: 1.2 }, split: 0.62 } },
  review: { label: '查看', layout: { order: ['viewer', 'properties', 'files', 'editor'], collapsed: ['editor'], weight: { viewer: 4, editor: 2, files: 1.2, properties: 1.4 }, split: 0.7 } },
  code: { label: '编码', layout: { order: ['editor', 'viewer', 'files', 'properties'], collapsed: ['properties'], weight: { viewer: 2, editor: 3, files: 1.2, properties: 1 }, split: 0.5 } },
};

const storageKey = 'castudio:workbench-layout:v1';

function isLayout(value: unknown): value is WorkbenchLayout {
  const v = value as WorkbenchLayout;
  return !!v && Array.isArray(v.order) && v.order.length === panelIds.length && panelIds.every(id => v.order.includes(id))
    && Array.isArray(v.collapsed) && v.collapsed.every(id => panelIds.includes(id))
    && !!v.weight && panelIds.every(id => Number.isFinite(v.weight[id]) && v.weight[id] > 0)
    && Number.isFinite(v.split) && v.split > 0 && v.split < 1;
}

/** localStorage may be blocked inside the iframe or hold a layout from an older build; both fall back to the default preset. */
export function loadLayout(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): WorkbenchLayout {
  try { const stored = JSON.parse(storage?.getItem(storageKey) || 'null'); if (isLayout(stored)) return stored; } catch { /* optional preference */ }
  return layoutPresets.default.layout;
}
export function saveLayout(layout: WorkbenchLayout, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try { storage?.setItem(storageKey, JSON.stringify(layout)); } catch { /* optional preference */ }
}

export const expandPanel = (layout: WorkbenchLayout, id: PanelId): WorkbenchLayout => layout.collapsed.includes(id) ? { ...layout, collapsed: layout.collapsed.filter(x => x !== id) } : layout;
export const togglePanel = (layout: WorkbenchLayout, id: PanelId): WorkbenchLayout => layout.collapsed.includes(id) ? expandPanel(layout, id) : { ...layout, collapsed: [...layout.collapsed, id] };
export function movePanel(layout: WorkbenchLayout, id: PanelId, delta: -1 | 1): WorkbenchLayout {
  const from = layout.order.indexOf(id), to = from + delta;
  if (to < 0 || to >= layout.order.length) return layout;
  const order = [...layout.order]; [order[from], order[to]] = [order[to], order[from]];
  return { ...layout, order };
}
/** Moves `share` (0..1 of the pair's combined weight) from panel b to panel a, keeping every other panel's size. */
export function shiftWeight(layout: WorkbenchLayout, a: PanelId, b: PanelId, share: number): WorkbenchLayout {
  const sum = layout.weight[a] + layout.weight[b], first = Math.min(0.92, Math.max(0.08, layout.weight[a] / sum + share));
  return { ...layout, weight: { ...layout.weight, [a]: sum * first, [b]: sum * (1 - first) } };
}
export const setSplit = (layout: WorkbenchLayout, split: number): WorkbenchLayout => ({ ...layout, split: Math.min(0.75, Math.max(0.25, split)) });

export type Splitter = { a: PanelId; b: PanelId; style: CSSProperties; disabled: boolean };
export type Placement = { grid: CSSProperties; panels: Record<PanelId, CSSProperties>; splitters: Splitter[]; vertical: CSSProperties | null; sideBySide: boolean };

const row = (layout: WorkbenchLayout, id: PanelId) => layout.collapsed.includes(id) ? 'auto' : `minmax(${minPanelPx}px, ${layout.weight[id].toFixed(3)}fr)`;
function column(layout: WorkbenchLayout, ids: PanelId[], gridColumn: string, panels: Record<PanelId, CSSProperties>, splitters: Splitter[]) {
  ids.forEach((id, i) => {
    panels[id] = { gridColumn, gridRow: String(2 * i + 1) };
    if (i > 0) splitters.push({ a: ids[i - 1], b: id, style: { gridColumn, gridRow: String(2 * i) }, disabled: layout.collapsed.includes(ids[i - 1]) || layout.collapsed.includes(id) });
  });
  const rows = ids.flatMap((id, i) => i ? ['6px', row(layout, id)] : [row(layout, id)]);
  // With every panel collapsed the headers stack at the top and a filler row takes the rest.
  if (ids.every(id => layout.collapsed.includes(id))) rows.push('minmax(0, 1fr)');
  return rows.join(' ');
}

/** Grid placement for the panels; DOM order never changes, so the 3D canvas and editors are never remounted. */
export function placeLayout(layout: WorkbenchLayout, width: number): Placement {
  const panels = {} as Record<PanelId, CSSProperties>, splitters: Splitter[] = [];
  const sideBySide = width >= sideBySideWidth && !layout.collapsed.includes(layout.order[0]);
  if (!sideBySide) {
    const rows = column(layout, layout.order, '1', panels, splitters);
    return { grid: { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: rows }, panels, splitters, vertical: null, sideBySide };
  }
  const [lead, ...rest] = layout.order;
  const rows = column(layout, rest, '3', panels, splitters);
  panels[lead] = { gridColumn: '1', gridRow: '1 / -1' };
  return {
    grid: { gridTemplateColumns: `minmax(240px, ${layout.split.toFixed(3)}fr) 6px minmax(220px, ${(1 - layout.split).toFixed(3)}fr)`, gridTemplateRows: rows },
    panels, splitters, vertical: { gridColumn: '2', gridRow: '1 / -1' }, sideBySide,
  };
}

/**
 * Where the source of a model file lives, judged only from paths the server writes:
 * a saved build keeps `studio-build-manifest.json` at its root, a parametric publish comes from the parametric program.
 */
export type SourceLink = { kind: 'build'; manifest: string } | { kind: 'parametric'; source: string } | null;
export function sourceLinkFor(modelPath: string | undefined, filePaths: string[]): SourceLink {
  if (!modelPath) return null;
  const build = /^builds\/[^/]+\//.exec(modelPath);
  if (build && filePaths.includes(`${build[0]}studio-build-manifest.json`)) return { kind: 'build', manifest: `${build[0]}studio-build-manifest.json` };
  // Each template publishes `<entry stem>.*` (cylinder.step, plate.step, …) from `parametric/<entry stem>.py`.
  const published = /^parametric\/exports\/[^/]+\/([a-z0-9_-]+)\.[^/]+$/i.exec(modelPath);
  const source = published && `parametric/${published[1]}.py`;
  if (source && filePaths.includes(source)) return { kind: 'parametric', source };
  return null;
}
