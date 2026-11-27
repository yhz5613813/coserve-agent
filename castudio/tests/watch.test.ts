import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { watchWorkspace } from '../server/watch.js';
import { Events } from '../server/events.js';
import { Store, foreignTopLevel } from '../server/storage.js';

/** A recording stand-in for the parts of an Express response that `Events.connect` uses. */
const asResponse = (value: EventEmitter) => value as Response & EventEmitter;
const sleep =(ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fast = { debounceMs: 60, scanMs: 60 };

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-watch-'));
  await fs.mkdir(path.join(root, 'parts', 'a'), { recursive: true });
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', '__pycache__'), { recursive: true });
  await sleep(400); // FSEvents delivers setup events late; let them drain before a watcher starts
  return root;
}
const collect = (root: string, skipTop: ReadonlySet<string>, mode: 'native' | 'scan') => {
  const batches: (string[] | undefined)[] = [];
  const stop = watchWorkspace(root, skipTop, paths => batches.push(paths), { mode, ...fast });
  return { batches, stop };
};
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await sleep(50); assert.ok(check(), 'timed out'); };

for (const mode of ['native', 'scan'] as const) {
  test(`${mode}: debounces writes into one batch and ignores dot-dirs, node_modules, __pycache__ and foreign top-level folders`, async () => {
    const root = await workspace();
    const { batches, stop } = collect(root, foreignTopLevel('root'), mode);
    await sleep(200);
    await fs.writeFile(path.join(root, 'a.step'), '1');
    await fs.writeFile(path.join(root, 'src', 'b.py'), '1');
    await fs.writeFile(path.join(root, '.studio', 'x.json'), '1');
    await fs.writeFile(path.join(root, 'node_modules', 'x', 'y.js'), '1');
    await fs.writeFile(path.join(root, 'src', '__pycache__', 'b.pyc'), '1');
    await fs.writeFile(path.join(root, 'parts', 'a', 'p.step'), '1');
    await until(() => batches.length > 0);
    await sleep(300);
    const paths = batches.flatMap(batch => batch ?? []);
    assert.ok(paths.includes('a.step') && paths.includes('src/b.py'));
    assert.deepEqual(paths.filter(file => /^(\.studio|node_modules|parts)|__pycache__/.test(file)), []);
    stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  test(`${mode}: reports modification and deletion, and stop silences the watcher`, async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'm.stl'), 'a');
    await fs.writeFile(path.join(root, 'd.stl'), 'a');
    const { batches, stop } = collect(root, new Set(), mode);
    await sleep(300);
    await fs.writeFile(path.join(root, 'm.stl'), 'longer');
    await fs.rm(path.join(root, 'd.stl'));
    await until(() => batches.flatMap(batch => batch ?? []).includes('d.stl'));
    assert.ok(batches.flatMap(batch => batch ?? []).includes('m.stl'));
    stop();
    const seen = batches.length;
    await fs.writeFile(path.join(root, 'late.stl'), 'x');
    await sleep(400);
    assert.equal(batches.length, seen);
    await fs.rm(root, { recursive: true, force: true });
  });
}

test('a part workspace notices its own files and the root does not see them', async () => {
  const root = await workspace();
  const part = collect(path.join(root, 'parts', 'a'), foreignTopLevel('root--a'), 'native');
  const parent = collect(root, foreignTopLevel('root'), 'native');
  await sleep(200);
  await fs.writeFile(path.join(root, 'parts', 'a', 'p.step'), '1');
  await until(() => part.batches.length > 0);
  await sleep(200);
  assert.deepEqual(part.batches.flatMap(batch => batch ?? []), ['p.step']);
  assert.deepEqual(parent.batches, []);
  part.stop(); parent.stop();
  await fs.rm(root, { recursive: true, force: true });
});

test('scan mode skips symlinks, bounds depth and survives a vanished root', async () => {
  const root = await workspace();
  await fs.symlink(root, path.join(root, 'loop'));
  let deep = root;
  for (let i = 0; i < 9; i++) deep = path.join(deep, `d${i}`);
  await fs.mkdir(deep, { recursive: true });
  const { batches, stop } = collect(root, new Set(), 'scan');
  await sleep(200);
  await fs.writeFile(path.join(deep, 'too-deep.step'), '1');
  await fs.writeFile(path.join(root, 'ok.step'), '1');
  await until(() => batches.length > 0);
  assert.deepEqual(batches.flat(), ['ok.step']);
  await fs.rm(root, { recursive: true, force: true });
  await sleep(200);
  stop();
});

test('paths are omitted when the OS names no file or too many files change', async () => {
  const root = await workspace();
  const { batches, stop } = collect(root, new Set(), 'scan');
  await sleep(200);
  await Promise.all(Array.from({ length: 210 }, (_, i) => fs.writeFile(path.join(root, `f${i}.txt`), '1')));
  await until(() => batches.length > 0);
  assert.equal(batches[0], undefined);
  stop();
  await fs.rm(root, { recursive: true, force: true });
});

test('events: the watcher starts with the first SSE client, stops with the last, and dispose stops the rest', async () => {
  const log: string[] = [];
  const events = new Events(project => { log.push(`start ${project}`); return () => log.push(`stop ${project}`); });
  const response = () => asResponse(Object.assign(new EventEmitter(), { set() {}, flushHeaders() {}, write() { return true; } }));
  const [a, b, c] = [response(), response(), response()];
  events.connect('p', a, 0); events.connect('p', b, 0); events.connect('q', c, 0);
  assert.deepEqual(log, ['start p', 'start q']);
  a.emit('close');
  assert.deepEqual(log, ['start p', 'start q']);
  b.emit('close');
  assert.deepEqual(log, ['start p', 'start q', 'stop p']);
  const again = response();
  events.connect('p', again, 0);
  events.dispose();
  assert.deepEqual(log.slice(3), ['start p', 'stop q', 'stop p']);
  const plain = response();
  new Events().connect('r', plain, 0);
  for (const stream of [again, c, plain]) stream.emit('close');
});

test('events: a watcher emission reaches the SSE stream as artifacts_changed with paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-watch-events-'));
  const store = new Store(root); await store.init();
  const project = await store.createProject('w');
  await sleep(400);
  const writes: string[] = [];
  const events: Events = new Events(id => watchWorkspace(store.workspace(id), foreignTopLevel(id), paths => events.emit(id, 'artifacts_changed', paths ? { paths } : {}), { mode: 'native', ...fast }));
  const res = asResponse(Object.assign(new EventEmitter(), { set() {}, flushHeaders() {}, write(chunk: string) { writes.push(chunk); return true; } }));
  events.connect(project.id, res, 0);
  await sleep(200);
  await fs.writeFile(path.join(store.workspace(project.id), 'agent.step'), '1');
  await until(() => writes.some(chunk => chunk.includes('artifacts_changed')));
  const payload = JSON.parse(writes.find(chunk => chunk.includes('artifacts_changed'))!.split('data: ')[1]);
  assert.equal(payload.type, 'artifacts_changed');
  assert.deepEqual(payload.data.paths, ['agent.step']);
  res.emit('close');
  events.dispose();
  await fs.rm(root, { recursive: true, force: true });
});
