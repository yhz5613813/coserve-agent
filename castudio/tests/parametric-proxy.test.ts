import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mountParametricProxy } from '../server/parametric-proxy.js';
import { createApp } from '../server/app.js';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

test('parametric proxy forwards same-origin requests and rejects cross-site ones', async () => {
  const worker = http.createServer((req, res) => res.end(`ok ${req.headers.origin}`));
  const workerPort = await listen(worker);
  const app = express();
  const upgrade = mountParametricProxy(app, id => id === 'p1' ? workerPort : null);
  const studio = http.createServer(app);
  studio.on('upgrade', upgrade);
  const port = await listen(studio);
  const get = (headers: Record<string, string>, path = '/pm/p1/') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })); }).on('error', reject);
  });
  try {
    const same = await get({ origin: `http://127.0.0.1:${port}` });
    assert.equal(same.status, 200);
    assert.equal(same.body, `ok http://127.0.0.1:${workerPort}`);
    assert.equal((await get({})).status, 200);
    assert.equal((await get({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await get({ origin: 'not a url' })).status, 403);
    assert.equal((await get({ host: 'evil.example' })).status, 403);
    assert.equal((await get({}, '/pm/missing/')).status, 502);
    const ws = await new Promise<string>(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/pm/p1/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'https://evil.example' } });
      req.on('error', () => resolve('closed')); req.on('upgrade', () => resolve('upgraded')); req.on('response', () => resolve('response'));
      req.end();
    });
    assert.equal(ws, 'closed');
  } finally { studio.close(); worker.close(); }
});

test('in the production order (createApp, then the proxy) JSON bodies reach the worker unread', async () => {
  const worker = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => res.end(`got ${body}`)); });
  const workerPort = await listen(worker);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-proxy-'));
  const { app, events } = await createApp(root);
  mountParametricProxy(app, id => id === 'p1' ? workerPort : null);
  const studio = http.createServer(app), port = await listen(studio);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pm/p1/api/cells/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a', code: 'x = 1' }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'got {"id":"a","code":"x = 1"}');
  } finally { events.dispose(); studio.close(); worker.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a malformed WebSocket path is refused without crashing, and a client abort closes the worker request', async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const worker = http.createServer((req, res) => { res.writeHead(200); res.write('partial'); req.socket.on('close', upstreamClosed); });
  const workerPort = await listen(worker);
  const app = express();
  const upgrade = mountParametricProxy(app, () => workerPort);
  const studio = http.createServer(app); studio.on('upgrade', upgrade);
  const port = await listen(studio);
  try {
    const ws = await new Promise<string>(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/pm/%E0%A4%A/ws', headers: { connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('error', () => resolve('closed')); req.on('upgrade', () => resolve('upgraded')); req.on('response', () => resolve('response'));
      req.end();
    });
    assert.equal(ws, 'closed');
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/pm/p1/stream' }, res => res.once('data', () => { req.destroy(); resolve(); }));
      req.on('error', error => { if (!req.destroyed) reject(error); });
    });
    await closed;
  } finally { studio.close(); worker.close(); }
});
