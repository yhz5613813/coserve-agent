import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Express } from 'express';
import type { Assembly, AssemblyComponent, AssemblyView } from '../shared/types.js';
import { partSlugPattern } from '../shared/viewport.js';
import { ASSEMBLY_FILE, HttpError, Store, checkRelative, jsonWrite, rootOf, safePath } from './storage.js';
import type { History } from './history.js';
import type { Events } from './events.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const componentModels = /\.(step|stp|glb|stl)$/i;

/** Absolute path of `relative` inside part `slug` of root project `rootId` (`default` is the root's own workspace); read-only callers only. */
export async function partFile(store: Store, rootId: string, slug: string, relative: string): Promise<string> {
  if (slug.length > 40 || !partSlugPattern.test(slug)) throw new HttpError(400, '无效零件标识');
  checkRelative(relative);
  const part = (await store.parts(rootId)).find(p => p.slug === slug);
  if (!part) throw new HttpError(404, `项目中没有零件 ${slug}`);
  return safePath(store.workspace(part.id), relative);
}

/** Resolves a cross-part reference `part:<slug>/<path relative to that part>` within root project `rootId`. */
export async function resolvePartReference(store: Store, rootId: string, reference: string): Promise<string> {
  const match = /^part:([^/]+)\/(.+)$/.exec(reference);
  if (!match) throw new HttpError(400, '引用格式应为 part:<零件>/<相对路径>');
  return partFile(store, rootId, match[1], match[2]);
}

/** Validates an assembly document (format in shared/types.ts) and returns it without unknown keys; throws 422 naming the first bad field. */
export function validateAssembly(value: unknown): Assembly {
  const bad = (message: string): never => { throw new HttpError(422, `装配文件无效：${message}`); };
  const record = (item: unknown, at: string) => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : bad(`${at} 必须是对象`);
  const doc = record(value, '装配');
  if (doc.version !== 1) bad('version 必须为 1');
  if (!Array.isArray(doc.components) || doc.components.length > 200) bad('components 必须是最多 200 项的数组');
  const ids = new Set<string>();
  const components = (doc.components as unknown[]).map((item, index): AssemblyComponent => {
    const at = `components[${index}]`, c = record(item, at);
    const vector = (key: string) => Array.isArray(c[key]) && c[key].length === 3 && c[key].every(n => typeof n === 'number' && Number.isFinite(n)) ? c[key] as [number, number, number] : bad(`${at}.${key} 必须是 3 个有限数`);
    if (typeof c.id !== 'string' || !/^[\w.-]{1,80}$/.test(c.id) || ids.has(c.id)) bad(`${at}.id 必须是唯一的 1–80 位字母、数字、点、横线或下划线`);
    ids.add(c.id as string);
    if (typeof c.part !== 'string' || c.part.length > 40 || !partSlugPattern.test(c.part)) bad(`${at}.part 必须是零件标识（default 为项目根目录）`);
    if (typeof c.path !== 'string' || c.path.length > 1024 || !componentModels.test(c.path)) bad(`${at}.path 必须是 STEP、GLB 或 STL 文件的相对路径`);
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 80)) bad(`${at}.name 最多 80 个字符`);
    if (c.visible !== undefined && typeof c.visible !== 'boolean') bad(`${at}.visible 必须是布尔值`);
    return { id: c.id as string, part: c.part as string, path: c.path as string, ...(c.name !== undefined && { name: c.name as string }), position: vector('position'), rotation: vector('rotation'), ...(c.visible !== undefined && { visible: c.visible as boolean }) };
  });
  return { version: 1, components };
}

/**
 * GET /api/projects/:id/parts/:slug/file?path= (`:id` the root) reads one file of any part.
 * GET /api/projects/:id/assembly (`:id` the current part) returns the AssemblyView of its assembly.json.
 * PUT /api/projects/:id/assembly `{ etag, assembly }` replaces it: 409 when `etag` is stale or the project lock is held.
 */
export function assemblyRoutes(app: Express, store: Store, history: History, events: Events) {
  const text = async (id: string) => {
    await store.project(id);
    const file = await safePath(store.workspace(id), ASSEMBLY_FILE, false);
    return fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  };
  const read = async (id: string): Promise<AssemblyView> => {
    const raw = await text(id);
    if (raw === null) return { version: 1, exists: false, etag: digest(''), components: [] };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(422, '装配文件不是有效 JSON：assembly.json'); }
    const rootId = rootOf(id), assembly = validateAssembly(parsed);
    const components = await Promise.all(assembly.components.map(async component => {
      const url = `api/projects/${encodeURIComponent(rootId)}/parts/${encodeURIComponent(component.part)}/file?path=${encodeURIComponent(component.path)}`;
      try { await partFile(store, rootId, component.part, component.path); return { ...component, url }; }
      catch (error) {
        if (error instanceof HttpError) return { ...component, url, missing: error.message };
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...component, url, missing: `零件 ${component.part} 中没有文件 ${component.path}` };
        throw error;
      }
    }));
    return { version: 1, exists: true, etag: digest(raw), components };
  };
  app.get('/api/projects/:id/parts/:slug/file', async (req, res) => {
    const id = req.params.id;
    if (rootOf(id) !== id) throw new HttpError(400, '请使用项目编号，不要使用零件编号');
    const file = await partFile(store, id, req.params.slug, String(req.query.path || ''));
    res.set('X-Content-Type-Options', 'nosniff'); res.type('application/octet-stream'); res.sendFile(file, { dotfiles: 'allow' });
  });
  app.get('/api/projects/:id/assembly', async (req, res) => res.json(await read(req.params.id)));
  app.put('/api/projects/:id/assembly', async (req, res) => {
    const id = req.params.id, assembly = validateAssembly(req.body?.assembly);
    const release = store.acquire(id, '编辑装配');
    try {
      await history.recover(id);
      // The etag covers the file text only, so a damaged assembly.json can still be replaced.
      if (digest(await text(id) ?? '') !== req.body.etag) throw new HttpError(409, '装配已被其他操作修改，请刷新后重试');
      await history.snapshot(id, '修改装配前');
      await jsonWrite(await safePath(store.workspace(id), ASSEMBLY_FILE, false), assembly);
      await store.touch(id); await history.snapshot(id, '修改装配');
    } finally { release(); }
    events.emit(id, 'artifacts_changed', {}); events.emit(id, 'history_changed', {});
    res.json(await read(id));
  });
}
