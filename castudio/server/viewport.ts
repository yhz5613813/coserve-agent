import type { Express } from 'express';
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, HttpError, safePath } from './storage.js';
import type { Events } from './events.js';
import { validateViewportCommand, validateViewportState, viewportCommandMeshId, type ViewportCommand, type ViewportState } from '../shared/viewport.js';

export const VIEWPORT_CONNECTED_MS = 20_000;
export const VIEWPORT_COMMAND_TIMEOUT_MS = 10_000;
export const VIEWPORT_COMMAND_TTL_MS = 15_000;
export const VIEWPORT_SNAPSHOT_LIMIT = 25 * 1024 * 1024;
export const VIEWPORT_SNAPSHOT_KEEP = 10;

export type ViewportRouteOptions = { commandTimeoutMs?: number; maxSnapshotBytes?: number; now?: () => number };
type PageResult = { ok: boolean; error?: string; state?: unknown; snapshot?: string };
type Pending = { project: string; finish: (result: PageResult | 'timeout') => void };

export function isConnected(reportedAt: number | null, now: number): boolean {
  return reportedAt !== null && now - reportedAt < VIEWPORT_CONNECTED_MS;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function decodeSnapshot(dataUrl: string, limit: number) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl.trim());
  if (!match) throw new HttpError(422, '视口截图不是有效的 PNG 数据');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > limit) throw new HttpError(422, '视口截图超过大小限制');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR'
    || !bytes.subarray(bytes.length - 12).equals(PNG_IEND)) throw new HttpError(422, '视口截图不是有效的 PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) throw new HttpError(422, '视口截图尺寸无效');
  return { bytes, width, height };
}

async function saveSnapshot(store: Store, id: string, dataUrl: string, limit: number, keep: number, now: () => number) {
  const { bytes, width, height } = decodeSnapshot(dataUrl, limit);
  const iso = new Date(now()).toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}-${iso.slice(20, 23)}`;
  const relative = `artifacts/viewport/viewport-${stamp}.png`;
  const file = await safePath(store.workspace(id), relative, false);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  const names = (await fs.readdir(path.dirname(file))).filter(name => /^viewport-\d{8}-\d{6}-\d{3}\.png$/.test(name)).sort().reverse();
  for (const name of names.slice(keep)) await fs.unlink(path.join(path.dirname(file), name)).catch(() => {});
  return { path: relative, absolutePath: file, bytes: bytes.length, width, height };
}

function stateOrNull(value: unknown): ViewportState | null {
  try { return validateViewportState(value); } catch { return null; }
}

/** In-memory viewport bridge keyed by project *and* CAD instance; the page reports state and answers commands over the existing SSE channel. */
export function viewportRoutes(app: Express, store: Store, events: Events, options: ViewportRouteOptions = {}) {
  const timeoutMs = options.commandTimeoutMs ?? VIEWPORT_COMMAND_TIMEOUT_MS;
  const snapshotLimit = options.maxSnapshotBytes ?? VIEWPORT_SNAPSHOT_LIMIT;
  const now = options.now ?? Date.now;
  // One live viewport per CAD instance: two sessions may open the same project
  // at once, and each must keep its own camera, selection and command target.
  const states = new Map<string, { state: ViewportState; reportedAt: number }>();
  const pending = new Map<string, Pending>();
  const INSTANCE_SEPARATOR = '\u0000';
  const CLIENT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

  /** The reporting CAD instance: the `client` query value, or the shared default for a plain browser page. */
  const clientOf = (value: unknown): string => {
    const text = typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
    return CLIENT_PATTERN.test(text) ? text : 'main';
  };
  const instanceKey = (project: string, client: string) => `${project}${INSTANCE_SEPARATOR}${client}`;
  const splitKey = (key: string): [string, string] => {
    const at = key.indexOf(INSTANCE_SEPARATOR);
    return at < 0 ? [key, 'main'] : [key.slice(0, at), key.slice(at + 1)];
  };

  app.put('/api/projects/:id/viewport/state', express.json({ limit: '1mb' }), async (req, res) => {
    const id = String(req.params.id);
    await store.project(id);
    let state: ViewportState;
    try { state = validateViewportState(req.body); } catch (error) { throw new HttpError(422, (error as Error).message); }
    states.set(instanceKey(id, clientOf(req.query.client)), { state, reportedAt: now() });
    res.status(204).end();
  });

  app.get('/api/projects/:id/viewport/state', async (req, res) => {
    const id = String(req.params.id);
    await store.project(id);
    const entry = states.get(instanceKey(id, clientOf(req.query.client)));
    res.json({ connected: isConnected(entry?.reportedAt ?? null, now()), ageMs: entry ? Math.max(0, now() - entry.reportedAt) : null, state: entry?.state ?? null });
  });

  app.post('/api/projects/:id/viewport/command', express.json({ limit: '64kb' }), async (req, res) => {
    const id = String(req.params.id);
    await store.project(id);
    let command: ViewportCommand;
    try { command = validateViewportCommand(req.body); } catch (error) { throw new HttpError(422, (error as Error).message); }
    const client = clientOf(req.query.client);
    const entry = states.get(instanceKey(id, client));
    if (!isConnected(entry?.reportedAt ?? null, now())) throw new HttpError(409, 'CAD 工作台未打开或视口无响应');
    // A command that names a part only runs against a viewer showing that part; `open` is how the viewer changes part.
    const shown = entry!.state.part?.slug ?? 'default';
    if (command.part !== undefined && command.action !== 'open' && command.part !== shown)
      throw new HttpError(409, `视口当前显示零件 ${shown}，不是 ${command.part}；请先用 open 切换零件`);
    const mesh = viewportCommandMeshId(command);
    if (mesh !== null && !entry!.state.meshes.some(item => item.id === mesh)) throw new HttpError(422, `未找到网格 ${mesh}`);
    const commandId = randomUUID(), expiresAt = now() + VIEWPORT_COMMAND_TTL_MS;
    const result = await new Promise<PageResult | 'timeout'>(resolve => {
      const pendingEntry: Pending = { project: id, finish: value => { clearTimeout(timer); if (pending.get(commandId) === pendingEntry) pending.delete(commandId); resolve(value); } };
      const timer = setTimeout(() => pendingEntry.finish('timeout'), timeoutMs);
      timer.unref?.();
      pending.set(commandId, pendingEntry);
      // Every page of the project hears the broadcast; only the named instance must act on it.
      events.emit(id, 'viewport_command', { id: commandId, expiresAt, client, command });
    });
    if (result === 'timeout') throw new HttpError(504, '视口未在 10 秒内响应');
    if (!result.ok) throw new HttpError(422, result.error || '视口执行失败');
    let snapshot: Awaited<ReturnType<typeof saveSnapshot>> | undefined;
    if (command.action === 'snapshot') {
      if (typeof result.snapshot !== 'string') throw new HttpError(422, '视口未返回截图');
      snapshot = await saveSnapshot(store, id, result.snapshot, snapshotLimit, VIEWPORT_SNAPSHOT_KEEP, now);
      events.emit(id, 'artifacts_changed', {});
    }
    res.json({ ok: true, state: stateOrNull(result.state) ?? states.get(instanceKey(id, client))?.state ?? null, ...(snapshot ? { snapshot } : {}) });
  });

  app.get('/api/dsh/viewports', async (_req, res) => {
    const nowMs = now();
    const connected = [...states.entries()]
      .filter(([, entry]) => isConnected(entry.reportedAt, nowMs))
      .sort((a, b) => b[1].reportedAt - a[1].reportedAt);
    if (!connected.length) { res.json([]); return; }
    const projects = new Map((await store.projects()).map(project => [project.id, project]));
    res.json(connected.flatMap(([key, entry]) => {
      const [id, client] = splitKey(key);
      const project = projects.get(id);
      if (!project) return [];
      return [{ id, client, name: project.name, workspacePath: store.workspace(id), ageMs: Math.max(0, nowMs - entry.reportedAt), state: entry.state }];
    }));
  });

  app.post('/api/projects/:id/viewport/results/:commandId', express.json({ limit: '30mb' }), async (req, res) => {
    const id = String(req.params.id), commandId = String(req.params.commandId);
    await store.project(id);
    const entry = pending.get(commandId);
    if (!entry || entry.project !== id) throw new HttpError(404, '视口指令不存在或已过期');
    const body = isRecord(req.body) ? req.body : {};
    entry.finish({
      ok: body.ok === true,
      error: typeof body.error === 'string' ? body.error.slice(0, 500) : undefined,
      state: body.state,
      snapshot: typeof body.snapshot === 'string' ? body.snapshot : undefined,
    });
    res.json({ ok: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
