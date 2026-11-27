import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact } from '../shared/types';
import { currentModel, modelOrigin, simulationInput } from '../src/components/model-origin';

const file = (path: string, kind: Artifact['kind'] = 'model'): Artifact => ({ path, name: path.split('/').pop()!, kind, category: 'cad', detail: '', size: 1, modified: 1 });

test('model origin follows the layouts the services write', () => {
  const paths = ['builds/run-1/studio-build-manifest.json', 'builds/run-1/model.step', 'builds/run-2/model.step'];
  assert.equal(modelOrigin('parametric/exports/rid/blank.step', paths), 'notebook');
  assert.equal(modelOrigin('parametric/exports/rid/cylinder.scadpkg', paths), 'notebook');
  assert.equal(modelOrigin('parametric/exports/rid/source/blank.py', paths), 'other', 'the frozen source copy is not a publish');
  assert.equal(modelOrigin('builds/run-1/model.step', paths), 'script');
  assert.equal(modelOrigin('builds/run-2/model.step', paths), 'other', 'a build folder without its manifest is not a saved build');
  assert.equal(modelOrigin('imports/abc/part.step', paths), 'imported');
  assert.equal(modelOrigin('imports/abc/converted/part.step', paths), 'imported');
  assert.equal(modelOrigin('cylinder-objects/exports/rid/assembly.step', paths), 'other');
  assert.equal(modelOrigin('model.step', paths), 'other');
});

test('the current model is the viewer file, else the preview the viewer would open', () => {
  const step = file('parametric/exports/rid/plate.step'), stl = file('imports/a/part.stl');
  assert.equal(currentModel(stl, [step, stl]), stl);
  assert.equal(currentModel(null, [file('structural/run/source.step'), step])?.path, step.path);
  assert.equal(currentModel(null, [file('notes.py', 'source')]), undefined);
});

test('simulation input is the model itself or its same-stem sibling', () => {
  const files = [file('parametric/exports/rid/cylinder.scadpkg'), file('parametric/exports/rid/cylinder.stl'), file('parametric/exports/rid/cylinder.step'), file('imports/a/part.glb')];
  assert.equal(simulationInput('parametric/exports/rid/cylinder.scadpkg', files, /\.(step|stp)$/i), 'parametric/exports/rid/cylinder.step');
  assert.equal(simulationInput('parametric/exports/rid/cylinder.stl', files, /\.(step|stp|stl)$/i), 'parametric/exports/rid/cylinder.stl');
  assert.equal(simulationInput('imports/a/part.glb', files, /\.(step|stp|stl)$/i), 'imports/a/part.glb', 'no sibling: the caller reports the model as incompatible');
});
