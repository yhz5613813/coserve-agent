import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';

const SECRET = 'sk-test-secret-0123456789';
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

// Fake OpenAI-compatible endpoint; the first path segment selects the behaviour.
const seen: { behaviour: string; image: boolean; effort?: string }[] = [];
const fake = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const behaviour = req.url!.split('/')[1], request = JSON.parse(body || '{}'), hasImage = body.includes('image_url');
  const fail = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); };
  if (!req.url!.endsWith('/chat/completions')) return fail(404, 'not found');
  seen.push({ behaviour, image: hasImage, effort: request.reasoning_effort });
  if (behaviour === 'leaky') return fail(401, `invalid api key ${req.headers.authorization?.replace('Bearer ', '')}`);
  if (behaviour === 'text' && hasImage) return fail(400, 'image input is not supported by this model');
  if (behaviour === 'noreasoning' && 'reasoning_effort' in request) return fail(400, 'unknown parameter: reasoning_effort');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant' });
  if (behaviour === 'vision' && request.reasoning_effort) chunk({ reasoning_content: 'thinking about it' });
  chunk({ content: hasImage ? 'Not sure what this is.' : 'OK' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
});

test('provider connect: real text/image/thinking requests decide capabilities; route validation; key never echoed', { timeout: 120000 }, async () => {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'provider-probe-'));
  const oldAgentDir = process.env.PI_AGENT_DIR; process.env.PI_AGENT_DIR = path.join(root, 'pi');
  const fakeUrl = await listen(fake);
  const { app, store, harness } = await createApp(root); const server = createServer(app); const url = await listen(server);
  const bodies: string[] = [];
  const post = async (route: string, body: unknown) => { const res = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const text = await res.text(); bodies.push(text); return { status: res.status, json: JSON.parse(text) }; };
  const request = (behaviour: string, extra: Record<string, unknown> = {}) => ({ baseUrl: `${fakeUrl}/${behaviour}`, model: `${behaviour}-model`, apiKey: SECRET, ...extra });
  try {
    const runtime = await harness.runtime();

    // Vision + thinking endpoint: all three requests succeed (the image answer is not judged), chosen effort is sent.
    const vision = await post('/api/provider', request('vision', { thinking: 'high' }));
    assert.equal(vision.status, 200);
    assert.deepEqual([vision.json.text.ok, vision.json.image.ok, vision.json.reasoning.ok], [true, true, true]);
    assert.equal(typeof vision.json.text.ms, 'number'); assert.equal(vision.json.reasoning.message, '已返回思考内容');
    assert.deepEqual(vision.json.registered, { input: ['text', 'image'], reasoning: true, thinking: 'high' });
    assert.ok(seen.some(r => r.behaviour === 'vision' && r.image), 'image request was sent');
    assert.ok(seen.some(r => r.behaviour === 'vision' && r.effort === 'high'), 'chosen thinking level was sent');
    const visionModel = runtime.getModel('studio', 'vision-model')!;
    assert.deepEqual([visionModel.input, visionModel.reasoning], [['text', 'image'], true]);
    assert.deepEqual(await store.settings(), { provider: 'studio', model: 'vision-model', thinking: 'high' });

    // Rejects reasoning_effort: thinking unsupported and forced off.
    const plain = await post('/api/provider', request('noreasoning', { thinking: 'high' }));
    assert.deepEqual([plain.json.text.ok, plain.json.image.ok, plain.json.reasoning.ok], [true, true, false]);
    assert.match(plain.json.reasoning.message, /拒绝思考参数.*reasoning_effort/);
    assert.deepEqual(plain.json.registered, { input: ['text', 'image'], reasoning: false, thinking: 'off' });
    assert.equal(runtime.getModel('studio', 'noreasoning-model')!.reasoning, false);
    assert.equal((await store.settings()).thinking, 'off');

    // Rejects image content with 400: image unsupported with an API reason, text only.
    const textOnly = await post('/api/provider', request('text'));
    assert.deepEqual([textOnly.json.text.ok, textOnly.json.image.ok, textOnly.json.reasoning.ok], [true, false, true]);
    assert.match(textOnly.json.image.message, /拒绝图像输入.*not supported/);
    assert.deepEqual(textOnly.json.registered, { input: ['text'], reasoning: true, thinking: 'medium' });
    assert.deepEqual(runtime.getModel('studio', 'text-model')!.input, ['text']);

    // Manual override of failed probes, and thinking 'off' chosen while thinking is supported.
    const overridden = await post('/api/provider', request('text', { input: ['text', 'image'], reasoning: false, thinking: 'low' }));
    assert.deepEqual(overridden.json.registered, { input: ['text', 'image'], reasoning: false, thinking: 'off' });
    const off = await post('/api/provider', request('vision', { thinking: 'off' }));
    assert.deepEqual(off.json.registered, { input: ['text', 'image'], reasoning: true, thinking: 'off' });

    // Failing text request: 502, nothing registered, key redacted.
    const broken = await post('/api/provider', request('leaky'));
    assert.equal(broken.status, 502); assert.match(broken.json.error, /文本测试未通过.*\[redacted\]/);
    assert.equal(runtime.getModel('studio', 'leaky-model'), undefined);

    for (const [body, pattern] of [
      [request('text', { baseUrl: 'not a url' }), /服务地址无效/],
      [request('text', { baseUrl: 'ftp://127.0.0.1/x' }), /HTTP\(S\)/],
      [request('text', { thinking: 'extreme' }), /思考级别/],
      [request('text', { input: ['image'] }), /输入类型/],
      [request('text', { input: ['text', 'audio'] }), /输入类型/],
      [request('text', { reasoning: 'yes' }), /思考能力/],
      [request('text', { apiKey: '' }), /API Key/],
    ] as const) {
      const rejected = await post('/api/provider', body);
      assert.equal(rejected.status, 400, JSON.stringify(body)); assert.match(rejected.json.error, pattern);
    }

    const status = await (await fetch(url + '/api/status')).text(); bodies.push(status);
    const listed = JSON.parse(status).models.find((m: { provider: string; id: string }) => m.provider === 'studio' && m.id === 'vision-model');
    assert.deepEqual([listed.input, listed.reasoning], [['text', 'image'], true]);
    for (const body of bodies) assert.equal(body.includes(SECRET), false, 'API key echoed in a response body');
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldAgentDir;
    await close(server); await close(fake);
  }
});
