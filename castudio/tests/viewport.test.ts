import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { isConnected, type ViewportRouteOptions } from '../server/viewport.js';
import { validateViewportCommand, validateViewportState, type ViewportState } from '../shared/viewport.js';

const state = (overrides: Record<string, unknown> = {}): ViewportState => ({
  workspace: 'model',
  model: { path: null, demo: true, status: 'ready' },
  meshes: [
    { id: 'mesh-a', name: '底座', visible: true, triangles: 120 },
    { id: 'mesh-b', name: '螺栓 01', visible: false, triangles: 36, group: '紧固件' },
  ],
  selection: null,
  options: { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' },
  camera: { position: [10, -20, 30], target: [0, 0, 0], projection: 'perspective' },
  ...overrides,
}) as ViewportState;

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sse(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const pending: any[] = [];
  const waiters: { pred: (event: any) => boolean; resolve: (event: any) => void; reject: (error: Error) => void }[] = [];
  const push = (event: any) => {
    const index = waiters.findIndex(waiter => waiter.pred(event));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(event); else pending.push(event);
  };
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (data) { try { push(JSON.parse(data)); } catch { /* heartbeat blocks carry no JSON */ } }
      }
    }
  })().catch(() => {});
  return {
    waitFor: (pred: (event: any) => boolean, timeoutMs = 8000) => new Promise<any>((resolve, reject) => {
      const found = pending.findIndex(pred);
      if (found >= 0) { resolve(pending.splice(found, 1)[0]); return; }
      const waiter = { pred, resolve: (event: any) => { clearTimeout(timer); resolve(event); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('等待 SSE 事件超时')); }, timeoutMs);
      timer.unref?.();
      waiters.push(waiter);
    }),
    close: () => { for (const waiter of waiters.splice(0)) waiter.reject(new Error('SSE 已关闭')); void reader.cancel().catch(() => {}); },
  };
}

async function fixture(viewport?: ViewportRouteOptions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-viewport-'));
  const { app, store, builds, thermal, structural, parametric, cylinderObjects, cadInspections } = await createApp(root, { viewport });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = await store.createProject('Viewport');
  const streams: ReturnType<typeof sse>[] = [];
  const connect = async () => {
    const stream = sse(await fetch(`${base}/api/projects/${project.id}/events`));
    streams.push(stream);
    return stream;
  };
  const putState = (value: unknown) => fetch(`${base}/api/projects/${project.id}/viewport/state`, json(value, 'PUT'));
  const getState = () => fetch(`${base}/api/projects/${project.id}/viewport/state`).then(r => r.json());
  const command = (value: unknown) => fetch(`${base}/api/projects/${project.id}/viewport/command`, json(value));
  const result = (commandId: string, value: unknown, id = project.id) => fetch(`${base}/api/projects/${id}/viewport/results/${commandId}`, json(value));
  const cleanup = async () => {
    for (const stream of streams) stream.close();
    await Promise.allSettled([builds.dispose(), thermal.dispose(), structural.dispose(), parametric.dispose(), cylinderObjects.dispose(), cadInspections.dispose()]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { base, id: project.id, store, connect, putState, getState, command, result, cleanup };
}

/** Answer every viewport_command on the stream; received events are appended to log. */
function autoPage(stream: ReturnType<typeof sse>, answer: (command: any) => unknown | Promise<unknown>, post: (commandId: string, body: unknown) => Promise<Response>, log: any[] = []) {
  void (async () => {
    for (;;) {
      const event = await stream.waitFor(e => e.type === 'viewport_command', 60000).catch(() => null);
      if (!event) return;
      log.push(event);
      const commandId = String(event.data.id);
      try { await post(commandId, await answer(event.data.command)); }
      catch (error) { await post(commandId, { ok: false, error: (error as Error).message }).catch(() => {}); }
    }
  })();
}

test('state endpoint reports connection lifecycle and rejects malformed bodies', async () => {
  const f = await fixture();
  try {
    const empty = await f.getState();
    assert.deepEqual(empty, { connected: false, ageMs: null, state: null });
    const denied = await f.command({ action: 'fit' });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, 'CAD 工作台未打开或视口无响应');
    // body-parser strict mode rejects JSON primitives with 400 before validation.
    for (const bad of [null, 'x']) assert.equal((await f.putState(bad)).status, 400);
    for (const bad of [[], { workspace: 'model' }, { ...state(), meshes: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, name: 'x', visible: true, triangles: 1 })) }, { ...state(), workspace: 'other' }])
      assert.equal((await f.putState(bad)).status, 422, JSON.stringify(bad)?.slice(0, 80));
    assert.equal((await f.putState(state())).status, 204);
    const reported = await f.getState();
    assert.equal(reported.connected, true);
    assert.equal(typeof reported.ageMs, 'number');
    assert.equal(reported.state.model.demo, true);
    assert.equal(reported.state.meshes.length, 2);
    assert.equal((await fetch(`${f.base}/api/projects/missing/viewport/state`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/projects/missing/viewport/state`, json(state(), 'PUT'))).status, 404);
  } finally { await f.cleanup(); }
});

test('dsh viewports lists only connected workbenches, newest report first', async () => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now });
  try {
    const other = await f.store.createProject('Second');
    const listUrl = `${f.base}/api/dsh/viewports`;
    assert.deepEqual(await (await fetch(listUrl)).json(), []);
    await f.putState(state());
    now += 1000;
    await fetch(`${f.base}/api/projects/${other.id}/viewport/state`, json(state({ workspace: 'thermal' }), 'PUT'));
    now += 1000;
    await f.putState(state({ options: { edges: false, grid: true, ortho: true, section: 40, explode: 30, mode: 'face' } }));
    const list = await (await fetch(listUrl)).json();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, f.id);
    assert.equal(list[0].name, 'Viewport');
    assert.equal(list[0].workspacePath, f.store.workspace(f.id));
    assert.equal(list[0].ageMs, 0);
    assert.equal(list[0].state.options.ortho, true);
    assert.equal(list[0].state.meshes.length, 2);
    assert.equal(list[1].id, other.id);
    assert.equal(list[1].name, 'Second');
    assert.equal(list[1].ageMs, 1000);
    assert.equal(list[1].state.workspace, 'thermal');
    now += 21_000;
    assert.deepEqual(await (await fetch(listUrl)).json(), []);
  } finally { await f.cleanup(); }
});

test('connected window uses the injected clock for the 20 second rule', async () => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now });
  try {
    await f.putState(state());
    assert.equal((await f.getState()).connected, true);
    now += 19_999;
    assert.equal((await f.getState()).connected, true);
    now += 2;
    const stale = await f.getState();
    assert.equal(stale.connected, false);
    assert.equal(stale.ageMs, 20_001);
    assert.equal((await f.command({ action: 'fit' })).status, 409);
    assert.equal(isConnected(now - 20_000, now), false);
    assert.equal(isConnected(now - 19_999, now), true);
    assert.equal(isConnected(null, now), false);
  } finally { await f.cleanup(); }
});

test('commands round-trip through the SSE channel for every action', async () => {
  const f = await fixture({ commandTimeoutMs: 5000 });
  try {
    const stream = await f.connect();
    await f.putState(state({ selection: { meshId: 'mesh-a', name: '底座', bounds: [1, 2, 3], triangles: 120 } }));
    const seen: string[] = [];
    autoPage(stream, command => {
      seen.push(command.action);
      if (command.action === 'snapshot') return { ok: true, snapshot: PNG_1PX, state: state({ workspace: 'structural' }) };
      return { ok: true, state: state() };
    }, (commandId, body) => f.result(commandId, body));
    const cases: unknown[] = [
      { action: 'fit' },
      { action: 'fit', view: 'top' },
      { action: 'select', meshId: 'mesh-a' },
      { action: 'select', meshId: null },
      { action: 'select_face', meshId: 'mesh-a', face: 3 },
      { action: 'visible', meshId: 'mesh-b', visible: true },
      { action: 'options', options: { grid: false, section: 40 } },
      { action: 'workspace', workspace: 'thermal' },
    ];
    for (const command of cases) {
      const response = await f.command(command);
      assert.equal(response.status, 200, JSON.stringify(command));
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.state.workspace, 'model');
    }
    assert.deepEqual(seen, cases.map(command => (command as { action: string }).action));
    const snap = await (await f.command({ action: 'snapshot' })).json();
    assert.equal(snap.ok, true);
    assert.equal(snap.state.workspace, 'structural');
    assert.match(snap.snapshot.path, /^artifacts\/viewport\/viewport-\d{8}-\d{6}-\d{3}\.png$/);
    assert.equal(snap.snapshot.width, 1);
    assert.equal(snap.snapshot.height, 1);
    assert.ok(snap.snapshot.bytes > 0);
    assert.ok(await fs.stat(snap.snapshot.absolutePath));
    const served = await fetch(`${f.base}/api/projects/${f.id}/file?path=${encodeURIComponent(snap.snapshot.path)}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  } finally { await f.cleanup(); }
});

test('mesh-targeting commands validate against the last reported meshes before dispatch', async () => {
  const f = await fixture();
  try {
    const stream = await f.connect();
    await f.putState(state());
    let dispatched = 0;
    autoPage(stream, () => { dispatched++; return { ok: true, state: state() }; }, (commandId, body) => f.result(commandId, body));
    for (const command of [
      { action: 'select', meshId: 'ghost' },
      { action: 'select_face', meshId: 'ghost', face: 0 },
      { action: 'visible', meshId: 'ghost', visible: true },
    ]) {
      const response = await f.command(command);
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /未找到网格 ghost/);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(dispatched, 0);
    assert.equal(await stream.waitFor(e => e.type === 'viewport_command', 300).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('page failures become 422 and timeouts become 504 with late results ignored', async () => {
  const f = await fixture({ commandTimeoutMs: 120 });
  try {
    const stream = await f.connect();
    await f.putState(state());
    let silent = false;
    const log: any[] = [];
    autoPage(stream, () => {
      if (silent) return new Promise(() => {});
      return { ok: false, error: '视口截图失败' };
    }, (commandId, body) => f.result(commandId, body), log);
    const failed = await f.command({ action: 'options', options: { grid: false } });
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).error, '视口截图失败');
    silent = true;
    const timedOut = await f.command({ action: 'fit' });
    assert.equal(timedOut.status, 504);
    assert.equal((await timedOut.json()).error, '视口未在 10 秒内响应');
    const fit = log.find(event => event.data?.command?.action === 'fit');
    assert.ok(fit);
    assert.equal((await f.result(String(fit.data.id), { ok: true, state: state() })).status, 404);
    assert.equal((await f.result('not-a-command', { ok: true })).status, 404);
    const other = await f.store.createProject('Other');
    assert.equal((await f.result(String(fit.data.id), { ok: true }, other.id)).status, 404);
  } finally { await f.cleanup(); }
});

test('first result wins and snapshot payloads are validated before writing', async () => {
  const f = await fixture({ maxSnapshotBytes: 2048 });
  try {
    const stream = await f.connect();
    await f.putState(state());
    const snapPromise = f.command({ action: 'snapshot' });
    const event = await stream.waitFor(e => e.type === 'viewport_command');
    const commandId = String(event.data.id);
    assert.equal((await f.result(commandId, { ok: true, snapshot: PNG_1PX, state: state() })).status, 200);
    const good = await (await snapPromise).json();
    assert.equal(good.ok, true);
    assert.equal((await f.result(commandId, { ok: true })).status, 404);
    let body: unknown = 'data:image/png;base64,AAAA';
    autoPage(stream, () => ({ ok: true, snapshot: body, state: state() }), (commandId, reply) => f.result(commandId, reply));
    const bad = await f.command({ action: 'snapshot' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /PNG/);
    body = 'data:image/png;base64,' + Buffer.alloc(3000, 1).toString('base64');
    const oversize = await f.command({ action: 'snapshot' });
    assert.equal(oversize.status, 422);
    assert.match((await oversize.json()).error, /大小限制/);
  } finally { await f.cleanup(); }
});

test('snapshots prune the viewport directory to the newest files', async () => {
  let now = 2_000_000;
  const f = await fixture({ now: () => now, commandTimeoutMs: 5000 });
  try {
    const stream = await f.connect();
    await f.putState(state());
    autoPage(stream, () => ({ ok: true, snapshot: PNG_1PX, state: state() }), (commandId, body) => f.result(commandId, body));
    const dir = path.join(f.store.workspace(f.id), 'artifacts', 'viewport');
    for (let i = 0; i < 12; i++) {
      now += 1000;
      assert.equal((await f.command({ action: 'snapshot' })).status, 200);
    }
    const names = (await fs.readdir(dir)).filter(name => /^viewport-\d{8}-\d{6}-\d{3}\.png$/.test(name));
    assert.equal(names.length, 10);
    assert.equal(names.sort()[0], 'viewport-19700101-003323-000.png');
  } finally { await f.cleanup(); }
});

test('validators reject unknown actions, extra fields and out-of-range values', () => {  for (const bad of [null, {}, [], { action: 'fly' }, { action: 'fit', view: 'back' }, { action: 'fit', extra: 1 }, { action: 'select' }, { action: 'select', meshId: 7 }, { action: 'select_face', meshId: 'm', face: -1 }, { action: 'select_face', meshId: 'm', face: 1.5 }, { action: 'visible', meshId: 'm' }, { action: 'options' }, { action: 'options', options: { section: 101 } }, { action: 'options', options: { explode: -1 } }, { action: 'options', options: { explode: 181 } }, { action: 'options', options: { mode: 'vertex' } }, { action: 'options', options: { hack: true } }, { action: 'workspace', workspace: 'cad' }, { action: 'snapshot', view: 'top' }])
    assert.throws(() => validateViewportCommand(bad), JSON.stringify(bad)?.slice(0, 90));
  assert.deepEqual(validateViewportCommand({ action: 'fit' }), { action: 'fit' });
  assert.deepEqual(validateViewportCommand({ action: 'options', options: { section: 55, grid: false } }), { action: 'options', options: { section: 55, grid: false } });
  assert.deepEqual(validateViewportCommand({ action: 'options', options: { explode: 180 } }), { action: 'options', options: { explode: 180 } });
  assert.equal(validateViewportCommand({ action: 'select', meshId: null }).action, 'select');
  for (const bad of [null, {}, { ...state(), extra: 1 }, { ...state(), options: { ...state().options, section: 101 } }, { ...state(), meshes: [{ id: 'm', name: 'x', visible: 'yes', triangles: 1 }] }, { ...state(), camera: { position: [0, 0], target: [0, 0, 0], projection: 'perspective' } }])
    assert.throws(() => validateViewportState(bad), JSON.stringify(bad)?.slice(0, 90));
  const clean = validateViewportState(state({ selection: { meshId: 'mesh-a', name: '底座', triangle: 4, point: [1, 2, 3], bounds: [1, 2, 3], triangles: 120, cadFace: { index: 2 }, packageMesh: { secret: true } } }));
  assert.equal(clean.selection!.cadFace !== undefined, true);
  assert.equal('packageMesh' in clean.selection!, false);
});

test('one project keeps a separate viewport per CAD instance', async () => {
  const f = await fixture();
  try {
    const alpha = state({ camera: { position: [10, -20, 30], target: [0, 0, 0], projection: 'perspective' } });
    const beta = state({ camera: { position: [1, 2, 3], target: [4, 5, 6], projection: 'orthographic' } });
    assert.equal((await fetch(`${f.base}/api/projects/${f.id}/viewport/state?client=session-a`, json(alpha, 'PUT'))).status, 204);
    assert.equal((await fetch(`${f.base}/api/projects/${f.id}/viewport/state?client=session-b`, json(beta, 'PUT'))).status, 204);
    const readA = await (await fetch(`${f.base}/api/projects/${f.id}/viewport/state?client=session-a`)).json();
    const readB = await (await fetch(`${f.base}/api/projects/${f.id}/viewport/state?client=session-b`)).json();
    assert.deepEqual(readA.state.camera.position, [10, -20, 30]);
    assert.deepEqual(readB.state.camera.position, [1, 2, 3]);
    const listed = await (await fetch(`${f.base}/api/dsh/viewports`)).json() as any[];
    assert.deepEqual(listed.map(row => row.client).sort(), ['session-a', 'session-b']);
    // A command names one instance: every page of the project hears the broadcast, one acts on it.
    const stream = await f.connect();
    const pending = fetch(`${f.base}/api/projects/${f.id}/viewport/command?client=session-b`, json({ action: 'fit', view: 'top' }));
    const event = await stream.waitFor(e => e.type === 'viewport_command');
    assert.equal(event.data.client, 'session-b');
    assert.equal(event.data.command.action, 'fit');
    void fetch(`${f.base}/api/projects/${f.id}/viewport/results/${event.data.id}`, json({ ok: true, state: beta }));
    assert.equal((await pending).status, 200);
  } finally { await f.cleanup(); }
});

test('a command naming a part runs only while the viewer shows it; open may name any part', async () => {
  const f = await fixture();
  try {
    const stream = await f.connect();
    autoPage(stream, command => ({ ok: true, state: state({ part: { slug: command.part ?? 'shaft', name: '轴' } }) }), (id, body) => f.result(id, body));
    assert.equal((await f.putState(state({ part: { slug: 'shaft', name: '轴' } }))).status, 204);
    const mismatch = await f.command({ action: 'fit', part: 'housing' });
    assert.equal(mismatch.status, 409);
    assert.match((await mismatch.json()).error, /当前显示零件 shaft，不是 housing/);
    assert.equal((await f.command({ action: 'fit', part: 'shaft' })).status, 200);
    const opened = await f.command({ action: 'open', path: 'housing.step', part: 'housing' });
    assert.equal(opened.status, 200);
    assert.deepEqual((await opened.json()).state.part, { slug: 'housing', name: '轴' });
    for (const bad of [{ action: 'open', path: '../x.step' }, { action: 'open', path: '/abs.step' }, { action: 'fit', part: 'Bad' }, { action: 'panel', panel: 'chat', state: 'expand' }])
      assert.equal((await f.command(bad)).status, 422, JSON.stringify(bad));
    assert.equal((await f.putState(state({ part: { slug: 'x', name: 'n', extra: 1 } }))).status, 422);
  } finally { await f.cleanup(); }
});
