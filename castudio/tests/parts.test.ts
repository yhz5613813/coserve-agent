import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, scanArtifacts, foreignTopLevel } from '../server/storage.js';
import { createApp } from '../server/app.js';
import { History } from '../server/history.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-parts-'));
  const store = new Store(root); await store.init();
  return { store, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };

test('a part lives under parts/<slug> of its root and is listed after the default part', async () => {
  const { store, cleanup } = await fixture();
  try {
    const root = await store.createProject('减速器');
    const [a, b, c] = await Promise.all([store.createPart(root.id, 'Gear Box'), store.createPart(root.id, 'Gear Box'), store.createPart(root.id, '端盖')]);
    assert.deepEqual([a.slug, b.slug, c.slug], ['gear-box', 'gear-box-2', 'part']);
    assert.equal(a.id, `${root.id}--gear-box`);
    assert.equal(store.workspace(a.id), path.join(store.workspace(root.id), 'parts', 'gear-box'));
    assert.deepEqual((await store.parts(root.id)).map(p => p.slug), ['default', 'gear-box', 'gear-box-2', 'part']);
    assert.deepEqual((await store.projects()).map(p => p.id), [root.id]);
    assert.equal((await store.records()).length, 4);
    await assert.rejects(store.parts(a.id), /零件下不能再列出零件/);
    assert.equal((await store.createPart(root.id, 'default')).slug, 'part-2');
    // Folders the Agent creates directly become parts; invalid names stay plain folders.
    await fs.mkdir(path.join(store.workspace(root.id), 'parts', 'housing'), { recursive: true });
    await fs.mkdir(path.join(store.workspace(root.id), 'parts', 'Bad_Name'), { recursive: true });
    const listed = await store.parts(root.id);
    assert.deepEqual(listed.find(p => p.slug === 'housing'), { id: `${root.id}--housing`, slug: 'housing', name: 'housing' });
    assert.equal(listed.some(p => p.slug === 'Bad_Name'), false);
    assert.equal((await store.createPart(root.id, 'housing')).slug, 'housing-2');
  } finally { await cleanup(); }
});

test('the root lists and records only its own files; restoring default keeps other parts', async () => {
  const { store, cleanup } = await fixture();
  try {
    const root = await store.createProject('装配');
    const part = await store.createPart(root.id, 'shaft');
    const rootWs = store.workspace(root.id), partWs = store.workspace(part.id);
    await write(path.join(rootWs, 'model.step'), 'root v1');
    await write(path.join(partWs, 'shaft.step'), 'shaft v1');
    assert.deepEqual((await scanArtifacts(rootWs, foreignTopLevel(root.id))).map(f => f.path), ['model.step']);
    assert.deepEqual((await scanArtifacts(partWs, foreignTopLevel(part.id))).map(f => f.path), ['shaft.step']);

    const history = new History(store);
    const v1 = await history.snapshot(root.id, 'v1');
    assert.equal(v1.files, 1);
    await write(path.join(rootWs, 'model.step'), 'root v2');
    await write(path.join(partWs, 'shaft.step'), 'shaft v2');
    await write(path.join(partWs, 'extra.step'), 'new');
    const comparison = await history.compare(root.id, v1.id);
    assert.deepEqual(comparison.changes.map(c => c.path), ['model.step']);
    await history.restore(root.id, v1.id, comparison.fingerprint);
    assert.equal(await fs.readFile(path.join(rootWs, 'model.step'), 'utf8'), 'root v1');
    assert.equal(await fs.readFile(path.join(partWs, 'shaft.step'), 'utf8'), 'shaft v2');
    assert.equal(await fs.readFile(path.join(partWs, 'extra.step'), 'utf8'), 'new');
  } finally { await cleanup(); }
});

test('deleting an empty part removes its folder; deleting an empty root removes its part records', async () => {
  const { store, cleanup } = await fixture();
  try {
    const root = await store.createProject('空');
    const a = await store.createPart(root.id, 'a'), b = await store.createPart(root.id, 'b');
    await store.deleteProject(a.id);
    await assert.rejects(fs.access(store.workspace(a.id)));
    assert.deepEqual((await store.parts(root.id)).map(p => p.slug), ['default', 'b']);
    await write(path.join(store.workspace(b.id), 'b.step'), 'x');
    await assert.rejects(store.deleteProject(root.id), /请先清空/);
    await fs.rm(path.join(store.workspace(b.id), 'b.step'));
    await store.deleteProject(root.id);
    assert.deepEqual(await store.records(), []);
  } finally { await cleanup(); }
});

async function appFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-parts-app-'));
  const { app, store, events, harness } = await createApp(root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  const emitted: string[] = [], emit = events.emit.bind(events);
  events.emit = (project, type, data) => { emitted.push(`${project}:${type}`); emit(project, type, data); };
  const send = (url: string, method: string, body?: unknown) => fetch(`${base}/${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { store, harness, send, emitted, cleanup: async () => { events.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); } };
}

test('the part list reports updatedAt, published and the latest structural and thermal run of each part', async () => {
  const f = await appFixture();
  try {
    const root = await f.store.createProject('装配'), a = await f.store.createPart(root.id, 'shaft'), b = await f.store.createPart(root.id, 'gear');
    const run = (dir: string, id: string, state: string, createdAt: string) => write(path.join(dir, id, 'run.json'), JSON.stringify({ id, state, createdAt }));
    await write(path.join(f.store.workspace(root.id), 'parametric', 'published.json'), '{}');
    await write(path.join(f.store.workspace(a.id), 'shaft.step'), 'step');
    // A STEP that only exists as a solver snapshot does not count as published.
    await run(path.join(f.store.workspace(b.id), 'structural'), '00000000-0000-4000-8000-000000000001', 'succeeded', '2026-01-01T00:00:00.000Z');
    await write(path.join(f.store.workspace(b.id), 'structural', '00000000-0000-4000-8000-000000000001', 'source.step'), 'step');
    // The latest record wins; a running record without a live worker was interrupted.
    await run(path.join(f.store.workspace(b.id), 'structural'), '00000000-0000-4000-8000-000000000002', 'running', '2026-02-01T00:00:00.000Z');
    await run(path.join(f.store.projectRoot(a.id), 'thermal'), '00000000-0000-4000-8000-000000000003', 'failed', '2026-01-01T00:00:00.000Z');
    await run(path.join(f.store.projectRoot(a.id), 'thermal'), '00000000-0000-4000-8000-000000000004', 'succeeded', '2026-02-01T00:00:00.000Z');
    await new History(f.store).snapshot(b.id, 'v1');
    const response = await f.send(`${root.id}/parts`, 'GET');
    assert.equal(response.status, 200);
    const parts = await response.json() as { slug: string; updatedAt: string; published: boolean; structural?: string; thermal?: string }[];
    assert.deepEqual(parts.map(p => [p.slug, p.published, p.structural, p.thermal]), [['default', true, undefined, undefined], ['shaft', true, undefined, 'succeeded'], ['gear', false, 'failed', undefined]]);
    const record = await f.store.project(b.id), gear = parts.find(p => p.slug === 'gear')!;
    assert.ok(Number.isFinite(Date.parse(gear.updatedAt)) && gear.updatedAt >= record.updatedAt);
    assert.equal((await f.send(`${a.id}/parts`, 'GET')).status, 400);
  } finally { await f.cleanup(); }
});

test('renaming a part changes only its display name and keeps names unique', async () => {
  const f = await appFixture();
  try {
    const root = await f.store.createProject('装配'), a = await f.store.createPart(root.id, 'shaft'), b = await f.store.createPart(root.id, 'gear');
    const ok = await f.send(`${root.id}/parts/shaft`, 'PATCH', { name: '  主轴  ' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: a.id, slug: 'shaft', name: '主轴' });
    assert.ok(f.emitted.includes(`${root.id}:parts_changed`));
    assert.deepEqual((await f.store.parts(root.id)).map(p => [p.slug, p.name]), [['default', '默认零件'], ['shaft', '主轴'], ['gear', 'gear']]);
    assert.equal((await f.send(`${root.id}/parts/shaft`, 'PATCH', { name: '主轴' })).status, 200);
    assert.equal((await f.send(`${root.id}/parts/gear`, 'PATCH', { name: '主轴' })).status, 409);
    assert.equal((await f.send(`${root.id}/parts/gear`, 'PATCH', { name: '默认零件' })).status, 409);
    assert.equal((await f.send(`${root.id}/parts/gear`, 'PATCH', { name: '   ' })).status, 400);
    assert.equal((await f.send(`${root.id}/parts/gear`, 'PATCH', { name: 'x'.repeat(61) })).status, 400);
    assert.equal((await f.send(`${root.id}/parts/gear`, 'PATCH', {})).status, 400);
    assert.equal((await f.send(`${root.id}/parts/nope`, 'PATCH', { name: 'n' })).status, 404);
    const defaultRename = await f.send(`${root.id}/parts/default`, 'PATCH', { name: '总装' });
    assert.equal(defaultRename.status, 400);
    assert.match((await defaultRename.json()).error, /默认零件不能重命名/);
    assert.equal((await f.send(`${a.id}/parts/gear`, 'PATCH', { name: 'n' })).status, 400);
    assert.equal(b.slug, 'gear');
  } finally { await f.cleanup(); }
});

test('deleting a part moves only its folder and record to trash, where it can be restored', async () => {
  const f = await appFixture();
  try {
    const root = await f.store.createProject('装配'), a = await f.store.createPart(root.id, 'shaft'), b = await f.store.createPart(root.id, 'gear');
    const rootWs = f.store.workspace(root.id), aWs = f.store.workspace(a.id), bWs = f.store.workspace(b.id);
    await write(path.join(rootWs, 'model.step'), 'root'); await write(path.join(aWs, 'shaft.step'), 'shaft'); await write(path.join(bWs, 'gear.step'), 'gear');
    await new History(f.store).snapshot(a.id, 'v1');
    await f.send(`${root.id}/parts/shaft`, 'PATCH', { name: '主轴' });
    f.emitted.length = 0;

    const refusedDefault = await f.send(`${root.id}/parts/default`, 'DELETE');
    assert.equal(refusedDefault.status, 400);
    assert.equal((await f.send(`${a.id}/parts/gear`, 'DELETE')).status, 400);
    assert.equal((await f.send(`${root.id}/parts/nope`, 'DELETE')).status, 404);
    // Busy agent on the part or on the root blocks deletion.
    const busy = f.harness.isBusy.bind(f.harness);
    f.harness.isBusy = id => id === a.id;
    assert.equal((await f.send(`${root.id}/parts/shaft`, 'DELETE')).status, 409);
    f.harness.isBusy = id => id === root.id;
    assert.equal((await f.send(`${root.id}/parts/shaft`, 'DELETE')).status, 409);
    f.harness.isBusy = busy;
    const release = f.store.acquire(a.id);
    assert.equal((await f.send(`${root.id}/parts/shaft`, 'DELETE')).status, 409);
    release();
    assert.deepEqual(f.emitted, []);

    const response = await f.send(`${root.id}/parts/shaft`, 'DELETE');
    assert.equal(response.status, 200);
    const { trash } = await response.json();
    assert.deepEqual(f.emitted, [`${root.id}:parts_changed`]);
    assert.deepEqual((await f.store.parts(root.id)).map(p => p.slug), ['default', 'gear']);
    await assert.rejects(fs.access(aWs));
    await assert.rejects(f.store.project(a.id));
    assert.equal(await fs.readFile(path.join(rootWs, 'model.step'), 'utf8'), 'root');
    assert.equal(await fs.readFile(path.join(bWs, 'gear.step'), 'utf8'), 'gear');
    assert.equal((await f.store.project(b.id)).slug, 'gear');

    // Recovery: the folder and the record (name, history) wait in the trash and move straight back.
    const dir = trash;
    assert.equal(path.dirname(path.dirname(dir)), f.store.projectsDir);
    assert.equal(await fs.readFile(path.join(dir, 'workspace', 'shaft.step'), 'utf8'), 'shaft');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'record', 'project.json'), 'utf8')).name, '主轴');
    assert.equal((await fs.readdir(path.join(dir, 'record', 'history'))).includes('index.json'), true);
    await fs.rename(path.join(dir, 'workspace'), aWs); await fs.rename(path.join(dir, 'record'), f.store.projectRoot(a.id));
    assert.deepEqual((await f.store.parts(root.id)).map(p => [p.slug, p.name]), [['default', '默认零件'], ['shaft', '主轴'], ['gear', 'gear']]);
    assert.equal(await fs.readFile(path.join(aWs, 'shaft.step'), 'utf8'), 'shaft');
    assert.equal((await new History(f.store).list(a.id)).length, 1);
  } finally { await f.cleanup(); }
});
