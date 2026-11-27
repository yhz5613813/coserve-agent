import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact } from '../shared/types.js';
import { convertedStep, exportOptions, findStepSource, isCatiaOriginal, revisionPattern, uploadNotice, uploadOpenPath } from '../src/components/export-state.js';

const file = (p: string, kind: Artifact['kind'] = 'model', category: Artifact['category'] = 'cad'): Artifact => ({ path: p, name: p.split('/').at(-1)!, size: 10, modified: 1, kind, category, detail: '' });
const ready = { installed: true, version: '1', read: true, write: true, formats: ['CATPart', 'CATProduct'] };
const by = (r: ReturnType<typeof exportOptions>) => Object.fromEntries(r.options.map(o => [o.id, o]));

test('a STEP model offers STEP and CATIA when the converter can write', () => {
  const step = file('builds/ab/part.step'), r = exportOptions({ asset: step, files: [step], converter: ready, visibleMeshes: 3 }), o = by(r);
  assert.equal(r.step, step);
  for (const id of ['original', 'glb', 'stl', 'obj', 'step', 'CATPart', 'CATProduct'] as const) assert.equal(o[id].enabled, true, id);
  assert.equal(o.original.save, false);
});

test('a mesh model without a STEP sibling cannot be exported as STEP or CATIA', () => {
  const glb = file('builds/ab/part.glb'), r = exportOptions({ asset: glb, files: [glb, file('builds/cd/part.step')], converter: ready, visibleMeshes: 1 }), o = by(r);
  assert.equal(r.step, undefined);
  assert.deepEqual([o.step.enabled, o.step.reason], [false, '网格模型不能导出为 STEP']);
  assert.equal(o.CATPart.enabled, false); assert.match(o.CATPart.reason!, /没有 STEP 源文件/);
  assert.equal(o.glb.enabled, true);
});

test('an assembly exports its visible meshes but no STEP or CATIA, even beside a lone STEP', () => {
  const assembly = file('assembly.json'), o = by(exportOptions({ asset: assembly, files: [assembly, file('base.step')], converter: ready, visibleMeshes: 4 }));
  assert.deepEqual([o.step.enabled, o.step.reason, o.CATProduct.enabled, o.CATProduct.reason], [false, '装配暂不支持 STEP 导出', false, '装配暂不支持 STEP 导出']);
  assert.deepEqual([o.glb.enabled, o.stl.enabled, o.obj.enabled], [true, true, true]);
});

test('STEP siblings of published models are found next to them', () => {
  const cases: [string, string[]][] = [
    ['builds/ab/part.glb', ['builds/ab/part.step']],
    ['parametric/exports/r1/plate.scadpkg', ['parametric/exports/r1/plate.step', 'parametric/exports/r1/source/plate.step']],
    ['imports/u1/converted/model.glb', ['imports/u1/converted/model.step']],
  ];
  for (const [model, siblings] of cases) assert.equal(findStepSource(file(model), siblings.map(p => file(p)))?.path, siblings[0], model);
  assert.equal(findStepSource(file('a.glb'), [file('x.step'), file('y.step')]), undefined);
  assert.equal(findStepSource(file('a.glb'), [file('model.step'), file('y.step')])?.path, 'model.step');
  assert.equal(findStepSource(file('a.glb'), [file('other/a.step')]), undefined);
  assert.equal(findStepSource(null, [file('a.step')]), undefined);
});

test('CATIA items are disabled with a distinct reason per converter state', () => {
  const step = file('a.step'), reason = (converter: Parameters<typeof exportOptions>[0]['converter']) => by(exportOptions({ asset: step, files: [step], converter, visibleMeshes: 1 })).CATPart.reason;
  assert.equal(reason(null), '正在检测 CATIA 转换器…');
  assert.equal(reason({ installed: false, code: 'not-installed', message: 'x' }), '未安装 CATIA 转换器');
  assert.equal(reason({ installed: true, code: 'failed', message: '探测失败' }), 'CATIA 转换器不可用：探测失败');
  assert.equal(reason({ ...ready, write: false }), '转换器缺少写入授权');
  assert.equal(reason({ ...ready, formats: ['CATPart'] }), undefined);
  assert.equal(by(exportOptions({ asset: step, files: [step], converter: { ...ready, formats: ['CATPart'] }, visibleMeshes: 1 })).CATProduct.reason, '转换器不支持 CATProduct');
  assert.equal(reason({ ...ready, formats: [] }), undefined);
});

test('mesh items need visible meshes and everything is disabled without a model', () => {
  const glb = file('a.glb'), o = by(exportOptions({ asset: glb, files: [glb], converter: ready, visibleMeshes: 0 }));
  assert.deepEqual([o.glb.enabled, o.stl.enabled, o.obj.enabled, o.original.enabled], [false, false, false, true]);
  assert.equal(o.glb.reason, '没有可见的网格');
  const none = exportOptions({ asset: null, files: [], converter: ready, visibleMeshes: 0 });
  assert.equal(none.options.some(x => x.enabled), false); assert.ok(none.options.every(x => x.reason === '没有打开的模型'));
});

test('revision pattern matches V5-6R20xx only', () => {
  assert.ok(revisionPattern.test('V5-6R2024')); assert.ok(!revisionPattern.test('V5-6R24')); assert.ok(!revisionPattern.test('V5-6R2024x'));
});

test('CATIA originals are recognised and matched to their converted STEP', () => {
  const original = file('imports/u1/bracket.CATPart', 'file', 'import'), step = file('imports/u1/converted/model.step');
  assert.equal(isCatiaOriginal(original), true);
  assert.equal(isCatiaOriginal(file('exports/catia/t/bracket.CATPart', 'file', 'cad')), false);
  assert.equal(isCatiaOriginal(file('imports/u1/a.stl', 'model', 'import')), false);
  assert.equal(convertedStep(original, [original]), undefined);
  assert.equal(convertedStep(original, [original, step, file('imports/u2/converted/model.step')]), step);
});

test('uploadNotice and uploadOpenPath cover plain uploads and every conversion state', () => {
  const base = { path: 'imports/u1/a.CATPart', name: 'a.CATPart' };
  assert.equal(uploadNotice({ path: 'imports/u1/a.stl', name: 'a.stl' }), '已导入 a.stl');
  assert.equal(uploadNotice({ path: 'imports/u1/a.stl', name: 'a.stl', duplicate: true }), 'a.stl 之前已导入过，已打开已有副本');
  assert.equal(uploadNotice({ ...base, conversion: { state: 'done', message: '', step: 'imports/u1/converted/model.step' } }), '已导入 a.CATPart，已转换为 STEP');
  assert.equal(uploadNotice({ ...base, conversion: { state: 'unavailable', message: 'x' } }), '已导入 a.CATPart，但未安装 CATIA 转换器，暂不能预览');
  assert.equal(uploadNotice({ ...base, conversion: { state: 'no-read-license', message: 'x' } }), '已导入 a.CATPart，但转换器缺少读取授权，暂不能预览');
  assert.equal(uploadNotice({ ...base, duplicate: true, conversion: { state: 'failed', message: `CATIA 转换失败（退出码 3）：${'x'.repeat(200)}\nsecond line` } }).length < 140, true);
  assert.match(uploadNotice({ ...base, conversion: { state: 'failed', message: 'boom\nmore' } }), /^已导入 a\.CATPart，但转换失败：boom$/);
  assert.equal(uploadOpenPath({ ...base, conversion: { state: 'done', message: '', step: 'imports/u1/converted/model.step', glb: 'imports/u1/converted/model.glb' } }), 'imports/u1/converted/model.step');
  assert.equal(uploadOpenPath({ ...base, conversion: { state: 'failed', message: 'x' } }), base.path);
  assert.equal(uploadOpenPath({ path: 'imports/u1/a.stl', name: 'a.stl' }), 'imports/u1/a.stl');
});
