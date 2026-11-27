import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { acquireLock, lockDecision, type LockRecord } from '../server/instance-lock.js';
import { apiGuard, createApp, healthRoute } from '../server/app.js';

const record = (pid: number, parentPid: number): LockRecord => ({ pid, parentPid, instance: 'i', startedAt: '2026-01-01T00:00:00.000Z' });
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

test('lock decision: dead or unreadable holder is taken over, an orphan is killed, a live owner makes the server exit', () => {
  const live = (...pids: number[]) => (pid: number) => pids.includes(pid);
  assert.equal(lockDecision(null, live(), live()), 'take');
  assert.equal(lockDecision(record(100, 50), live(), live(50)), 'take');
  assert.equal(lockDecision(record(process.pid, 50), live(process.pid), live(50)), 'take');
  assert.equal(lockDecision(JSON.parse('{"pid":"100","parentPid":50}'), live(100), live(50)), 'take');
  assert.equal(lockDecision(record(100, 50), live(100), live()), 'kill');
  assert.equal(lockDecision(record(100, 50), live(100), live(50)), 'exit');
});

test('a lock left by a dead process is taken over and released only by its holder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-lock-'));
  const file = path.join(dir, 'castudio.lock');
  try {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    await fs.writeFile(file, JSON.stringify(record(Number(dead.stdout.trim()), process.pid)));
    const release = await acquireLock(dir, 'test-instance');
    const held = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual([held.pid, held.parentPid, held.instance], [process.pid, process.ppid, 'test-instance']);
    release(); await assert.rejects(fs.access(file));
    await fs.writeFile(file, 'not json');
    const again = await acquireLock(dir, null);
    await fs.writeFile(file, JSON.stringify(record(1, 1)));
    again(); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('health reports readiness, instance and pid behind the loopback check', async () => {
  const previous = process.env.STUDIO_INSTANCE;
  process.env.STUDIO_INSTANCE = 'desktop-1';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-health-'));
  const { app, events } = await createApp(root);
  const front = express(); let ready = false;
  front.use('/api', apiGuard); front.get('/api/health', healthRoute(() => ready));
  const studio = http.createServer(app), early = http.createServer(front);
  const [port, earlyPort] = [await listen(studio), await listen(early)];
  const get = (p: number, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p, path: '/api/health', headers }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) })); }).on('error', reject);
  });
  try {
    assert.deepEqual(await get(port), { status: 200, body: { ok: true, ready: true, instance: 'desktop-1', pid: process.pid } });
    assert.equal((await get(port, { host: 'evil.example' })).status, 403);
    assert.equal((await get(port, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(await get(earlyPort), { status: 503, body: { ok: false, ready: false, instance: 'desktop-1', pid: process.pid } });
    ready = true;
    assert.equal((await get(earlyPort)).body.ok, true);
  } finally {
    if (previous === undefined) delete process.env.STUDIO_INSTANCE; else process.env.STUDIO_INSTANCE = previous;
    events.dispose(); studio.close(); early.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
