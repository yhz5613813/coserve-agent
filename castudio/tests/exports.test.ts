import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApp } from '../server/app.js';
import { Events } from '../server/events.js';
import { exportRoutes } from '../server/exports.js';
import { History } from '../server/history.js';
import { Store, scanArtifacts } from '../server/storage.js';

async function tempRoot() { const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); return fs.mkdtemp(path.join(base, 'exports-')); }
async function listen(app: express.Express) {
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const post = async (base: string, format: string, name: string, body: Uint8Array | string) => {
  const r = await fetch(`${base}/exports?format=${format}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: body as BodyInit });
  return { status: r.status, body: await r.json() };
};
const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(20)]);

test('save writes exports/<format>/<timestamp>/<name>, snapshots history, emits artifacts_changed and lists as cad', async () => {
  const root = await tempRoot(), { app, store, events } = await createApp(path.join(root, 'data')), project = await store.createProject('导出'), part = await store.createPart(project.id, '端盖');
  const emitted: string[] = []; const emit = events.emit.bind(events); events.emit = ((id: string, type: string, payload: unknown) => { emitted.push(`${id}:${type}`); return emit(id, type, payload as never); }) as typeof events.emit;
  const server = await listen(app), base = `${server.url}/api/projects/${part.id}`;
  try {
    const saved = await post(base, 'glb', '端盖 v2.glb', glb);
    assert.equal(saved.status, 201); assert.equal(saved.body.name, '端盖 v2.glb'); assert.equal(saved.body.size, glb.length);
    assert.match(saved.body.path, /^exports\/glb\/\d{8}T\d{9}Z\/端盖 v2\.glb$/);
    assert.deepEqual(await fs.readFile(path.join(store.workspace(part.id), saved.body.path)), glb);
    assert.ok(emitted.includes(`${part.id}:artifacts_changed`));
    const labels = (await fetch(`${base}/history`).then(r => r.json())).map((r: { label: string }) => r.label);
    assert.ok(labels.includes('导出后 · 端盖 v2.glb'));
    const [artifact] = await scanArtifacts(store.workspace(part.id));
    assert.deepEqual([artifact.path, artifact.kind, artifact.category], [saved.body.path, 'model', 'cad']);
    const step = await post(base, 'step', 'a.step', 'ISO-10303-21;\nHEADER;');
    assert.equal(step.status, 201); assert.match(step.body.path, /^exports\/step\/[^/]+\/a\.step$/);
    assert.equal((await post(base, 'stl', 'x', Buffer.from([1, 2, 3]))).status, 201);
    assert.equal((await post(base, 'obj', '', 'v 0 0 0\n')).body.name, 'model.obj');
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('save sanitises names and rejects traversal, unknown formats, empty and mismatching content', async () => {
  const root = await tempRoot(), { app, store } = await createApp(path.join(root, 'data')), project = await store.createProject('导出');
  const server = await listen(app), base = `${server.url}/api/projects/${project.id}`;
  try {
    const traversal = await post(base, 'glb', '../../../evil.glb', glb);
    assert.equal(traversal.status, 201); assert.match(traversal.body.path, /^exports\/glb\/[^/]+\/evil\.glb$/);
    const dots = await post(base, 'stl', '..', Buffer.from('x')); assert.equal(dots.status, 201); assert.match(dots.body.path, /^exports\/stl\/[^/]+\/model\.stl$/);
    const slashes = await post(base, 'stl', 'a\\b/c:d?.stl', Buffer.from('x')); assert.match(slashes.body.path, /^exports\/stl\/[^/]+\/c_d_\.stl$/);
    assert.equal((await post(base, 'stl', 'rev1.5', Buffer.from('x'))).body.name, 'rev1.5.stl');
    assert.equal((await fs.readdir(path.join(root, 'data'))).includes('evil.glb'), false);
    assert.equal((await post(base, 'catpart', 'a', glb)).status, 400);
    assert.equal((await post(base, 'zip', 'a', glb)).status, 400);
    assert.equal((await fetch(`${base}/exports?name=a`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: glb })).status, 400);
    assert.equal((await post(base, 'glb', 'a', new Uint8Array())).status, 400);
    assert.equal((await post(base, 'glb', 'a', 'not glb at all')).status, 400);
    assert.equal((await post(base, 'step', 'a', 'solid x')).status, 400);
    assert.equal((await fetch(`${base}/exports?format=glb&name=a`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    const missing = await post(`${server.url}/api/projects/nope`, 'stl', 'a', Buffer.from('x')); assert.ok(missing.status >= 400);
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('save rejects bodies above the size limit with 413', async () => {
  const root = await tempRoot(), store = new Store(path.join(root, 'data')); await store.init();
  const history = new History(store), events = new Events(), project = await store.createProject('导出');
  const app = express(); app.use(express.json());
  exportRoutes(app, store, history, async (_id, action) => action(), events, { maxBytes: 64 });
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status || 500).json({ error: err.message }));
  const server = await listen(app), base = `${server.url}/api/projects/${project.id}`;
  try {
    assert.equal((await post(base, 'stl', 'ok', Buffer.alloc(64))).status, 201);
    const big = await post(base, 'stl', 'big', Buffer.alloc(65));
    assert.equal(big.status, 413); assert.match(big.body.error, /不能超过/);
    assert.deepEqual((await scanArtifacts(store.workspace(project.id))).map(a => a.name), ['ok.stl']);
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
