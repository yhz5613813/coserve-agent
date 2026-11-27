import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { resolvePartReference, validateAssembly } from '../server/assembly.js';
import { scanArtifacts } from '../server/storage.js';
import type { AssemblyView } from '../shared/types.js';

const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-assembly-'));
  const { app, store, events } = await createApp(dir);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const emitted: string[] = [], emit = events.emit.bind(events);
  events.emit = (project, type, data) => { emitted.push(`${project}:${type}`); emit(project, type, data); };
  const root = await store.createProject('装配'), shaft = await store.createPart(root.id, 'shaft');
  await write(path.join(store.workspace(root.id), 'base.step'), 'root step');
  await write(path.join(store.workspace(shaft.id), 'cad', 'shaft.stl'), 'shaft stl');
  const put = (id: string, body: unknown) => fetch(`${base}api/projects/${id}/assembly`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const view = async (id: string) => await (await fetch(`${base}api/projects/${id}/assembly`)).json() as AssemblyView;
  return { base, store, root, shaft, emitted, put, view, cleanup: async () => { events.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); } };
}
const component = (over: Record<string, unknown> = {}) => ({ id: 'c1', part: 'shaft', path: 'cad/shaft.stl', position: [0, 0, 10], rotation: [0, 90, 0], ...over });

test('assembly validation names the first bad field and drops unknown keys', () => {
  assert.deepEqual(validateAssembly({ version: 1, components: [{ ...component(), extra: 1 }] }), { version: 1, components: [component()] });
  for (const [value, pattern] of [
    [{ version: 2, components: [] }, /version/],
    [{ version: 1 }, /components/],
    [{ version: 1, components: [component(), component()] }, /components\[1\]\.id/],
    [{ version: 1, components: [component({ part: 'Bad_Slug' })] }, /part/],
    [{ version: 1, components: [component({ path: 'notes.md' })] }, /path/],
    [{ version: 1, components: [component({ position: [0, 0] })] }, /position/],
    [{ version: 1, components: [component({ rotation: [0, 0, Infinity] })] }, /rotation/],
    [{ version: 1, components: [component({ visible: 'yes' })] }, /visible/],
  ] as const) assert.throws(() => validateAssembly(value), (error: Error & { status?: number }) => error.status === 422 && pattern.test(error.message));
});

test('cross-part references resolve inside the target part only', async () => {
  const f = await fixture();
  try {
    assert.equal(await resolvePartReference(f.store, f.root.id, 'part:shaft/cad/shaft.stl'), path.join(f.store.workspace(f.shaft.id), 'cad', 'shaft.stl'));
    assert.equal(await resolvePartReference(f.store, f.root.id, 'part:default/base.step'), path.join(f.store.workspace(f.root.id), 'base.step'));
    await assert.rejects(resolvePartReference(f.store, f.root.id, 'part:shaft/../../base.step'), (e: Error & { status?: number }) => e.status === 400);
    await assert.rejects(resolvePartReference(f.store, f.root.id, 'part:x/../../base.step'), (e: Error & { status?: number }) => e.status === 400);
    await assert.rejects(resolvePartReference(f.store, f.root.id, 'part:nope/a.step'), (e: Error & { status?: number }) => e.status === 404);
    await assert.rejects(resolvePartReference(f.store, f.root.id, 'shaft/cad/shaft.stl'), (e: Error & { status?: number }) => e.status === 400);
    const read = await fetch(`${f.base}api/projects/${f.root.id}/parts/shaft/file?path=${encodeURIComponent('cad/shaft.stl')}`);
    assert.equal(read.status, 200); assert.equal(await read.text(), 'shaft stl');
    assert.equal((await fetch(`${f.base}api/projects/${f.root.id}/parts/shaft/file?path=${encodeURIComponent('../base.step')}`)).status, 400);
    assert.equal((await fetch(`${f.base}api/projects/${f.shaft.id}/parts/default/file?path=base.step`)).status, 400);
  } finally { await f.cleanup(); }
});

test('an assembly is created and replaced with etag concurrency, resolves component URLs and flags missing files', async () => {
  const f = await fixture();
  try {
    const empty = await f.view(f.root.id);
    assert.deepEqual([empty.exists, empty.components], [false, []]);
    const assembly = { version: 1, components: [component(), component({ id: 'c2', part: 'default', path: 'base.step', name: '底座' }), component({ id: 'c3', path: 'gone.step' })] };
    const created = await f.put(f.root.id, { etag: empty.etag, assembly });
    assert.equal(created.status, 200);
    const value = await created.json() as AssemblyView;
    assert.equal(value.exists, true);
    assert.deepEqual(value.components.map(c => [c.id, c.missing === undefined]), [['c1', true], ['c2', true], ['c3', false]]);
    assert.match(value.components[2].missing!, /gone\.step/);
    assert.equal(await (await fetch(f.base + value.components[0].url)).text(), 'shaft stl');
    assert.ok(f.emitted.includes(`${f.root.id}:artifacts_changed`));
    // assembly.json is listed as a viewable CAD model of its part.
    assert.deepEqual((await scanArtifacts(f.store.workspace(f.root.id))).find(a => a.path === 'assembly.json')?.kind, 'model');
    // A stale etag is a conflict; the stored assembly stays.
    const stale = await f.put(f.root.id, { etag: empty.etag, assembly: { version: 1, components: [] } });
    assert.equal(stale.status, 409);
    assert.equal((await f.view(f.root.id)).components.length, 3);
    // So is a held project lock.
    const release = f.store.acquire(f.root.id, '运行热仿真');
    const locked = await f.put(f.root.id, { etag: value.etag, assembly: { version: 1, components: [] } });
    release();
    assert.equal(locked.status, 409);
    assert.match((await locked.json()).error, /运行热仿真/);
    assert.equal((await f.put(f.root.id, { etag: value.etag, assembly: { version: 1, components: [component({ position: [1] })] } })).status, 422);
    // A part has its own assembly.json; components may reference any part.
    const partView = await f.view(f.shaft.id);
    assert.equal(partView.exists, false);
    assert.equal((await f.put(f.shaft.id, { etag: partView.etag, assembly: { version: 1, components: [component({ part: 'default', path: 'base.step' })] } })).status, 200);
    assert.equal((await f.view(f.shaft.id)).components[0].missing, undefined);
    // A damaged file is reported on read and can still be replaced by its text etag.
    await write(path.join(f.store.workspace(f.shaft.id), 'assembly.json'), '{');
    assert.equal((await fetch(`${f.base}api/projects/${f.shaft.id}/assembly`)).status, 422);
    const { createHash } = await import('node:crypto');
    assert.equal((await f.put(f.shaft.id, { etag: createHash('sha256').update('{').digest('hex'), assembly: { version: 1, components: [] } })).status, 200);
  } finally { await f.cleanup(); }
});
