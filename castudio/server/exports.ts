/**
 * Saves client-generated exports (mesh files from the viewer, copies of STEP files) into the current part.
 *
 * POST /api/projects/:id/exports?format=glb|stl|obj|step&name=<base name>   body: application/octet-stream
 *   -> 201 { path: 'exports/<format>/<timestamp>/<name>.<format>', name, size }
 * CATIA exports (exports/catia/...) are written by the converter route in cad-convert.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import type { Events } from './events.js';
import type { History } from './history.js';
import { HttpError, safePath, type Store } from './storage.js';

export const exportFormats = ['glb', 'stl', 'obj', 'step'] as const;
export const maxExportBytes = 128 * 1024 * 1024;
const signatures: Record<string, (bytes: Buffer) => boolean> = {
  glb: bytes => bytes.subarray(0, 4).toString('latin1') === 'glTF',
  step: bytes => bytes.subarray(0, 512).includes('ISO-10303-21'),
};

type Modify = <T>(id: string, action: () => Promise<T>) => Promise<T>;
export function exportRoutes(app: Express, store: Store, history: History, modify: Modify, events: Events, options: { maxBytes?: number } = {}) {
  const limit = options.maxBytes ?? maxExportBytes;
  const body = express.raw({ type: 'application/octet-stream', limit });
  const tooLarge = (error: Error & { type?: string }, _req: Request, _res: Response, next: NextFunction) => next(error.type === 'entity.too.large' ? new HttpError(413, `导出文件不能超过 ${Math.round(limit / 1024 / 1024)} MB`) : error);
  app.post('/api/projects/:id/exports', body, tooLarge, async (req: Request, res: Response) => {
    const id = String(req.params.id), format = String(req.query.format);
    if (!(exportFormats as readonly string[]).includes(format)) throw new HttpError(400, '不支持这个导出格式');
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, '需要导出文件内容（application/octet-stream）');
    if (signatures[format] && !signatures[format](bytes)) throw new HttpError(400, `文件内容不是有效的 ${format.toUpperCase()}`);
    const stem = path.basename(String(req.query.name || '')).replace(new RegExp(`\\.${format}$`, 'i'), '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[. ]+/, '').slice(0, 100) || 'model';
    const name = `${stem}.${format}`, relative = `exports/${format}/${new Date().toISOString().replace(/[-:.]/g, '')}/${name}`;
    await store.project(id);
    await modify(id, async () => {
      const target = await safePath(store.workspace(id), relative, false);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
      await history.snapshot(id, `导出后 · ${name}`, 'after-save');
      await store.touch(id);
    });
    events.emit(id, 'artifacts_changed', {}); events.emit(id, 'history_changed', {});
    res.status(201).json({ path: relative, name, size: bytes.length });
  });
}
