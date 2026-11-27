import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact } from '../shared/types';
import { chooseStructuralSource } from '../src/scene/structural-source';

const file = (path: string): Artifact => ({ path, name: path.split('/').pop()!, kind: 'model', category: 'cad', detail: '', size: 1, modified: 1 });

test('first structural source uses the successful published solver STEP rather than snapshots or failed assemblies', () => {
  const files = [
    file('structural/latest/source.step'),
    file('cylinder-objects/exports/failed/assembly.step'),
    file('cylinder-objects/exports/failed/cylinder.step'),
    file('cylinder-objects/exports/published/assembly.step'),
    file('cylinder-objects/exports/published/cylinder.step'),
  ];
  const published = files[4].path;
  assert.equal(chooseStructuralSource(files, '', published), published);
  assert.equal(chooseStructuralSource(files, files[1].path, published), published, 'a late published default corrects an automatic fallback');
});

test('late publication defaults preserve manual and requested source selections', () => {
  const manual = file('imports/review.step'), published = file('cylinder-objects/exports/published/cylinder.step');
  assert.equal(chooseStructuralSource([manual, published], manual.path, published.path, true), manual.path);
  assert.equal(chooseStructuralSource([manual, published], published.path, manual.path, true), published.path);
});

test('ordinary projects retain their STEP fallback when no valid publication exists', () => {
  const snapshot = file('structural/run/source.step'), model = file('imports/model.step');
  assert.equal(chooseStructuralSource([snapshot, model], ''), model.path);
  assert.equal(chooseStructuralSource([snapshot, model], '', 'missing.step'), model.path);
  assert.equal(chooseStructuralSource([], ''), '');
});

test('the current model decides the automatic structural source', () => {
  const imported = file('imports/a/shell.step'), assembly = file('cylinder-objects/exports/published/assembly.step'), solver = file('cylinder-objects/exports/published/cylinder.step');
  const files = [imported, assembly, solver];
  assert.equal(chooseStructuralSource(files, '', solver.path, false, imported.path), imported.path, 'the current model beats the published default');
  assert.equal(chooseStructuralSource(files, '', solver.path, false, assembly.path), solver.path, 'a cylinder-object preview maps to its solver STEP');
  assert.equal(chooseStructuralSource(files, imported.path, solver.path, false, 'imports/b/part.glb'), '', 'an unsuitable current model is not replaced by another file');
  assert.equal(chooseStructuralSource(files, imported.path, solver.path, true, 'imports/b/part.glb'), imported.path, 'an explicit pick stays');
});

test('CAD inspection outputs cannot become automatic structural inputs', () => {
  const inspection = file('studio/cad-inspections/run/excess_material.step'), model = file('imports/model.step');
  assert.equal(chooseStructuralSource([inspection, model], ''), model.path);
  assert.equal(chooseStructuralSource([inspection], ''), '');
});
