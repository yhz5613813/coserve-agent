import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../server/app.js';
import { Store, artifactCategory, artifactDetail, scanArtifacts } from '../server/storage.js';
import { CadConvertError, clearCadProbeCache, exportCad, importCad, isCatiaUpload, probeCadConverter } from '../server/cad-convert.js';

// Fake converter following the CLI contract; behaviour comes from behavior.json beside the script so tests can change license state between calls.
const fakeScript = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
const [cmd, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify([cmd, ...args]) + '\\n');
if (cmd === 'probe') { if (b.probeGarbage) { console.log('not json'); process.exit(0); } console.log(JSON.stringify({ version: '1.2.3', read: b.read, write: b.write, formats: ['CATPart', 'CATProduct'] })); process.exit(0); }
if (b.fail) { console.error('boom: cannot translate ' + path.basename(args[0])); process.exit(3); }
if (cmd === 'import') {
  fs.writeFileSync(path.join(args[1], 'model.step'), 'ISO-10303-21; fake');
  if (b.glb) fs.writeFileSync(path.join(args[1], 'model.glb'), 'glb');
  fs.writeFileSync(path.join(args[1], 'junk.log'), 'discard me');
} else if (cmd === 'export') fs.writeFileSync(args[1], 'CATIA-FAKE ' + (args[2] || '') + ' ' + (args[3] || ''));
`;
async function fixture(behavior: Record<string, unknown> = { read: true, write: true, glb: true }) {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'cad-convert-'));
  const converter = path.join(root, 'fake-converter.cjs'), config = path.join(root, 'behavior.json');
  await fs.writeFile(converter, fakeScript, { mode: 0o755 }); await fs.writeFile(config, JSON.stringify(behavior));
  const previous = process.env.CASTUDIO_CAD_CONVERTER;
  process.env.CASTUDIO_CAD_CONVERTER = converter; clearCadProbeCache();
  const set = async (value: Record<string, unknown>) => { await fs.writeFile(config, JSON.stringify(value)); clearCadProbeCache(); };
  const calls = async () => (await fs.readFile(path.join(root, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  return { root, converter, set, calls, cleanup: async () => { if (previous === undefined) delete process.env.CASTUDIO_CAD_CONVERTER; else process.env.CASTUDIO_CAD_CONVERTER = previous; clearCadProbeCache(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function serve(root: string) {
  const dataRoot = path.join(root, 'data'), { app, store } = await createApp(dataRoot), project = await store.createProject('CATIA');
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, base = `${url}/api/projects/${project.id}`;
  const upload = async (bytes: Uint8Array | string, name: string) => { const form = new FormData(); form.set('file', new Blob([bytes as BlobPart]), name); const r = await fetch(`${base}/upload`, { method: 'POST', body: form }); return { status: r.status, body: await r.json() }; };
  const post = async (route: string, body: unknown) => { const r = await fetch(`${base}/cad-convert/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { url, base, upload, post, workspace: store.workspace(project.id), close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('probe reports license state, is cached briefly, and distinguishes not installed from a broken converter', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await probeCadConverter(), { version: '1.2.3', read: true, write: true, formats: ['CATPart', 'CATProduct'] });
    await probeCadConverter(); assert.equal((await f.calls()).filter(c => c[0] === 'probe').length, 1);
    await f.set({ read: false, write: true });
    assert.equal((await probeCadConverter()).read, false);
    await f.set({ probeGarbage: true });
    await assert.rejects(probeCadConverter(), (e: CadConvertError) => e.code === 'failed' && e.status === 502);
    process.env.CASTUDIO_CAD_CONVERTER = path.join(f.root, 'missing'); clearCadProbeCache();
    await assert.rejects(probeCadConverter(), (e: CadConvertError) => e.code === 'not-installed' && e.status === 501);
    delete process.env.CASTUDIO_CAD_CONVERTER; clearCadProbeCache();
    await assert.rejects(probeCadConverter(), (e: CadConvertError) => e.code === 'not-installed');
  } finally { await f.cleanup(); }
});

test('importCad keeps only model.step and model.glb and reports the stderr tail on failure', async () => {
  const f = await fixture();
  try {
    const input = path.join(f.root, '支架.CATPart'), out = path.join(f.root, 'out'); await fs.writeFile(input, 'x'); await fs.mkdir(out);
    await importCad(input, out);
    assert.deepEqual((await fs.readdir(out)).sort(), ['model.glb', 'model.step']);
    await f.set({ read: true, write: true, fail: true }); await fs.rm(out, { recursive: true }); await fs.mkdir(out);
    await assert.rejects(importCad(input, out), (e: CadConvertError) => e.code === 'failed' && /退出码 3/.test(e.message) && /boom: cannot translate input\.catpart/.test(e.message));
    await f.set({ read: true, write: true, glb: false }); await fs.rm(out, { recursive: true }); await fs.mkdir(out);
    await importCad(input, out); assert.deepEqual(await fs.readdir(out).then(list => list.sort()), ['model.step']);
  } finally { await f.cleanup(); }
});

test('exportCad passes the revision flag and returns the written file', async () => {
  const f = await fixture();
  try {
    const step = path.join(f.root, '支架.step'), output = path.join(f.root, 'out', '支架.CATPart'); await fs.writeFile(step, 'step'); await fs.mkdir(path.dirname(output));
    await exportCad(step, output, 'V5-6R2024');
    assert.equal(await fs.readFile(output, 'utf8'), 'CATIA-FAKE --version V5-6R2024');
    assert.deepEqual(await fs.readdir(path.dirname(output)), ['支架.CATPart']);
    assert.deepEqual((await f.calls()).at(-1), ['export', path.join(f.root, 'out', 'input.step'), path.join(f.root, 'out', 'output.catpart'), '--version', 'V5-6R2024']);
  } finally { await f.cleanup(); }
});

test('isCatiaUpload recognises CATIA files and zips that contain them', () => {
  assert.equal(isCatiaUpload('a.CATPart', new Uint8Array()), true);
  assert.equal(isCatiaUpload('a.catproduct', new Uint8Array()), true);
  assert.equal(isCatiaUpload('pkg.zip', zipSync({ 'asm/top.CATProduct': strToU8('x'), 'asm/p.CATPart': strToU8('y') })), true);
  assert.equal(isCatiaUpload('scene.zip', zipSync({ 'scene.json': strToU8('{}') })), false);
  assert.equal(isCatiaUpload('broken.zip', strToU8('not a zip')), false);
  assert.equal(isCatiaUpload('a.step', new Uint8Array()), false);
});

test('artifact categories: original stays import, converted model is cad, exported CATIA is cad', () => {
  const id = '0123456789ab-cdef-0123-456789abcdef';
  assert.equal(artifactCategory(`imports/${id}/a.CATPart`), 'import');
  assert.equal(artifactCategory(`imports/${id}/converted/model.step`), 'cad');
  assert.equal(artifactCategory(`imports/${id}/converted/model.glb`), 'cad');
  assert.equal(artifactCategory(`imports/${id}/part.step`), 'import');
  assert.equal(artifactCategory('exports/catia/20261126T101500000Z/a.CATPart'), 'cad');
  assert.equal(artifactCategory('a.CATProduct'), 'cad');
  assert.equal(artifactDetail(`imports/${id}/converted/model.step`), `导入 ${id.slice(0, 8)} · 转换`);
});

test('upload converts CATIA files when the converter can read and explains why not otherwise', async () => {
  const f = await fixture({ read: false, write: false });
  const s = await serve(f.root);
  try {
    const status = await fetch(`${s.url}/api/cad-convert/status`).then(r => r.json());
    assert.deepEqual(status, { installed: true, version: '1.2.3', read: false, write: false, formats: ['CATPart', 'CATProduct'] });

    const noLicense = await s.upload('catia bytes', 'bracket.CATPart');
    assert.equal(noLicense.status, 200); assert.equal(noLicense.body.conversion.state, 'no-read-license');
    assert.equal(await fs.readFile(path.join(s.workspace, noLicense.body.path), 'utf8'), 'catia bytes');
    assert.equal((await f.calls()).some(c => c[0] === 'import'), false);

    await f.set({ read: true, write: true, glb: true });
    const retried = await s.post('import', { path: noLicense.body.path });
    const dir = path.dirname(noLicense.body.path);
    assert.deepEqual(retried, { status: 200, body: { state: 'done', message: '已转换为 STEP', step: `${dir}/converted/model.step`, glb: `${dir}/converted/model.glb` } });
    assert.equal(await fs.readFile(path.join(s.workspace, dir, 'converted', 'model.step'), 'utf8'), 'ISO-10303-21; fake');
    assert.deepEqual((await fs.readdir(path.join(s.workspace, dir))).sort(), ['bracket.CATPart', 'converted']);
    const artifacts = await scanArtifacts(s.workspace);
    assert.deepEqual(artifacts.map(a => [a.name, a.kind, a.category]).sort(), [['bracket.CATPart', 'file', 'import'], ['model.glb', 'model', 'cad'], ['model.step', 'model', 'cad']]);

    // Same name and identical bytes: dedup keeps the original and reuses the converted result without running the converter again.
    const importsBefore = (await f.calls()).filter(c => c[0] === 'import').length;
    const again = await s.upload('catia bytes', 'bracket.CATPart');
    assert.equal(again.body.duplicate, true); assert.equal(again.body.path, noLicense.body.path); assert.equal(again.body.conversion.state, 'done');
    assert.equal((await f.calls()).filter(c => c[0] === 'import').length, importsBefore);

    // A fresh upload converts immediately and records history.
    const fresh = await s.upload('other bytes', 'cover.CATPart');
    assert.equal(fresh.body.conversion.state, 'done');
    assert.match(fresh.body.conversion.step, /^imports\/[^/]+\/converted\/model\.step$/);
    const labels = (await fetch(`${s.base}/history`).then(r => r.json())).map((r: { label: string }) => r.label);
    assert.ok(labels.includes('CATIA 转换后 · cover.CATPart'));

    await f.set({ read: true, write: true, fail: true });
    const failed = await s.upload('third', 'broken.CATPart');
    assert.equal(failed.status, 200); assert.equal(failed.body.conversion.state, 'failed'); assert.match(failed.body.conversion.message, /boom: cannot translate input\.catpart/);
    assert.equal(await fs.readFile(path.join(s.workspace, failed.body.path), 'utf8'), 'third');
    assert.deepEqual(await fs.readdir(path.join(s.workspace, path.dirname(failed.body.path))), ['broken.CATPart']);
    const retriedFailure = await s.post('import', { path: failed.body.path });
    assert.equal(retriedFailure.status, 502); assert.equal(retriedFailure.body.code, 'failed');

    // A zip assembly package reaches the converter as an ASCII-named copy; zips without CATIA content get no conversion field.
    await f.set({ read: true, write: true });
    const zip = await s.upload(zipSync({ 'top.CATProduct': strToU8('p'), 'part.CATPart': strToU8('q') }), 'asm.zip');
    assert.equal(zip.body.conversion.state, 'done');
    assert.equal(path.basename((await f.calls()).at(-1)![1]), 'input.zip');
    assert.equal((await s.upload(zipSync({ 'scene.json': strToU8('{}') }), 'scene.zip')).body.conversion, undefined);
    assert.equal((await s.upload('solid a', 'plain.stl')).body.conversion, undefined);
  } finally { await s.close(); await f.cleanup(); }
});

test('upload keeps the original and reports unavailable when no converter is installed', async () => {
  const f = await fixture();
  const s = await serve(f.root);
  try {
    delete process.env.CASTUDIO_CAD_CONVERTER; clearCadProbeCache();
    const result = await s.upload('catia', 'asm.CATProduct');
    assert.equal(result.status, 200); assert.equal(result.body.conversion.state, 'unavailable'); assert.match(result.body.conversion.message, /未安装/);
    assert.equal(await fs.readFile(path.join(s.workspace, result.body.path), 'utf8'), 'catia');
    const status = await fetch(`${s.url}/api/cad-convert/status`).then(r => r.json());
    assert.equal(status.installed, false); assert.equal(status.code, 'not-installed');
    const retry = await s.post('import', { path: result.body.path });
    assert.equal(retry.status, 501); assert.equal(retry.body.code, 'not-installed');
    const exported = await s.post('export', { path: 'x.step', format: 'CATPart' });
    assert.equal(exported.status, 501);
  } finally { await s.close(); await f.cleanup(); }
});

test('export writes the CATIA file under exports/catia/<timestamp>/ and reports license and input errors distinctly', async () => {
  const f = await fixture({ read: true, write: false });
  const s = await serve(f.root);
  try {
    const step = await s.upload('ISO-10303-21;', 'bracket.step');
    const noWrite = await s.post('export', { path: step.body.path, format: 'CATPart' });
    assert.equal(noWrite.status, 409); assert.equal(noWrite.body.code, 'no-write-license');

    await f.set({ read: true, write: true });
    const ok = await s.post('export', { path: step.body.path, format: 'CATPart', revision: 'V5-6R2024' });
    assert.equal(ok.status, 201);
    assert.match(ok.body.path, /^exports\/catia\/\d{8}T\d{9}Z\/bracket\.CATPart$/);
    assert.equal(await fs.readFile(path.join(s.workspace, ok.body.path), 'utf8'), 'CATIA-FAKE --version V5-6R2024');
    assert.deepEqual(await fs.readdir(path.join(s.workspace, 'exports', 'catia')), [path.basename(path.dirname(ok.body.path))]);
    const labels = (await fetch(`${s.base}/history`).then(r => r.json())).map((r: { label: string }) => r.label);
    assert.ok(labels.includes('CATIA 导出 · bracket.CATPart'));

    assert.equal((await s.post('export', { path: step.body.path, format: 'IGES' })).status, 400);
    assert.equal((await s.post('export', { path: step.body.path, format: 'CATPart', revision: '--evil' })).status, 400);
    assert.equal((await s.post('export', { path: 'notes.txt', format: 'CATPart' })).status, 400);
    assert.equal((await s.post('export', { path: '../escape.step', format: 'CATPart' })).status, 400);

    await f.set({ read: true, write: true, fail: true });
    const failed = await s.post('export', { path: step.body.path, format: 'CATProduct' });
    assert.equal(failed.status, 502); assert.match(failed.body.error, /boom/);
    assert.equal((await fs.readdir(path.join(s.workspace, 'exports', 'catia'))).length, 1);
  } finally { await s.close(); await f.cleanup(); }
});
