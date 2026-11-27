import test from 'node:test';
import assert from 'node:assert/strict';
import { expandPanel, layoutPresets, loadLayout, movePanel, placeLayout, saveLayout, shiftWeight, sideBySideWidth, sourceLinkFor, togglePanel } from '../src/workbench-layout.js';

const base = layoutPresets.default.layout;
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };

test('layout round-trips through storage and rejects stale or broken values', () => {
  const store = memory(), changed = movePanel(base, 'files', 1);
  saveLayout(changed, store);
  assert.deepEqual(loadLayout(store), changed);
  store.setItem('castudio:workbench-layout:v1', JSON.stringify({ ...base, order: ['viewer', 'files'] }));
  assert.deepEqual(loadLayout(store), base);
  store.setItem('castudio:workbench-layout:v1', '{broken');
  assert.deepEqual(loadLayout(store), base);
  assert.deepEqual(loadLayout({ getItem: () => { throw new Error('blocked'); } }), base);
});

test('panel operations keep the four roles and the pair weight', () => {
  assert.deepEqual(togglePanel(togglePanel(base, 'viewer'), 'viewer').collapsed, base.collapsed);
  assert.equal(expandPanel(base, 'editor').collapsed.includes('editor'), false);
  assert.equal(expandPanel(base, 'viewer'), base);
  assert.deepEqual(movePanel(base, 'viewer', -1), base);
  assert.deepEqual(movePanel(base, 'viewer', 1).order, ['files', 'viewer', 'editor', 'properties']);
  const shifted = shiftWeight(base, 'viewer', 'files', 0.1);
  assert.ok(Math.abs(shifted.weight.viewer + shifted.weight.files - base.weight.viewer - base.weight.files) < 1e-9);
  assert.equal(shifted.weight.editor, base.weight.editor);
  assert.ok(shiftWeight(base, 'viewer', 'files', 5).weight.files > 0);
});

test('placement stacks narrow panes and gives the lead panel a column on wide ones', () => {
  const narrow = placeLayout(base, 400);
  assert.equal(narrow.sideBySide, false);
  assert.equal(narrow.vertical, null);
  assert.equal(narrow.splitters.length, 3);
  assert.deepEqual(base.order.map(id => narrow.panels[id].gridRow), ['1', '3', '5', '7']);
  assert.equal(narrow.splitters[1].disabled, true); // files | editor(collapsed)
  const wide = placeLayout(base, sideBySideWidth);
  assert.equal(wide.sideBySide, true);
  assert.equal(wide.panels.viewer.gridRow, '1 / -1');
  assert.equal(wide.splitters.length, 2);
  assert.ok(String(wide.grid.gridTemplateColumns).includes('6px'));
  // A collapsed lead panel cannot hold a column, and an all-collapsed column gets a filler row.
  assert.equal(placeLayout(togglePanel(base, 'viewer'), 1200).sideBySide, false);
  const allCollapsed = { ...base, collapsed: [...base.order] };
  assert.match(String(placeLayout(allCollapsed, 400).grid.gridTemplateRows), /1fr\)$/);
});

test('sourceLinkFor reads only server-written provenance', () => {
  const files = ['builds/abc/out.step', 'builds/abc/studio-build-manifest.json', 'parametric/cylinder.py', 'parametric/exports/r1/cylinder.step', 'imports/x/a.step'];
  assert.deepEqual(sourceLinkFor('builds/abc/out.step', files), { kind: 'build', manifest: 'builds/abc/studio-build-manifest.json' });
  assert.deepEqual(sourceLinkFor('parametric/exports/r1/cylinder.step', files), { kind: 'parametric', source: 'parametric/cylinder.py' });
  assert.equal(sourceLinkFor('imports/x/a.step', files), null);
  assert.deepEqual(sourceLinkFor('parametric/exports/r2/plate.step', [...files, 'parametric/plate.py']), { kind: 'parametric', source: 'parametric/plate.py' });
  assert.equal(sourceLinkFor('parametric/exports/r2/plate.step', files), null);
  assert.equal(sourceLinkFor('builds/zzz/out.step', files), null);
  assert.equal(sourceLinkFor(undefined, files), null);
});
