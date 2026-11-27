/**
 * Optional CATIA (.CATPart / .CATProduct) bridge.
 *
 * Open-source OCCT cannot read or write CATIA, so a commercial SDK (Datakit CrossCad/Ware, Spatial 3D InterOp as backup) is installed separately
 * and wrapped in a converter executable. Studio only ever talks to that executable through the CLI contract below, in a separate child
 * process (no shell, argument array, timeout, output caps); the SDK is never loaded in-process. The internal format stays STEP (AP242) + GLB preview.
 *
 * Configuration: CASTUDIO_CAD_CONVERTER = absolute path of the executable (read on every call). Unset = not installed.
 *
 * CLI contract (all paths absolute; exit code 0 = success, anything else = failure with a human-readable message on stderr):
 *   <exe> probe
 *       stdout: one JSON object { "version": string, "read": boolean, "write": boolean, "formats": string[] }
 *       read / write reflect the current license state; formats lists supported CATIA kinds, e.g. ["CATPart", "CATProduct"].
 *   <exe> import <input> <outDir>
 *       <input> is a .CATPart, a .CATProduct, or a .zip (or directory) holding a .CATProduct plus the parts it references.
 *       <outDir> exists and is empty. The converter writes <outDir>/model.step (STEP AP242, required) and <outDir>/model.glb (preview, optional).
 *       Anything else it leaves in <outDir> is discarded; model.step / model.glb larger than 128 MB are rejected (the project history limit).
 *   <exe> export <input.step> <output.CATPart|output.CATProduct> [--version V5-6R20xx]
 *       Writes <output>; its parent directory exists. The target kind follows the output extension; --version selects the CATIA release.
 *
 * Distinct failures (CadConvertError.code -> HTTP status): not-installed 501, no-read-license 409, no-write-license 409, failed 502 (stderr tail).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { unzipSync } from 'fflate';
import type { Events } from './events.js';
import type { History } from './history.js';
import { HttpError, safePath, type Store } from './storage.js';

export type CadConverterProbe = { version: string; read: boolean; write: boolean; formats: string[] };
export type CadConversion = { state: 'unavailable' | 'no-read-license' | 'failed' | 'done'; message: string; step?: string; glb?: string };
type ErrorCode = 'not-installed' | 'no-read-license' | 'no-write-license' | 'failed';
const statusOf: Record<ErrorCode, number> = { 'not-installed': 501, 'no-read-license': 409, 'no-write-license': 409, failed: 502 };
export class CadConvertError extends HttpError {
  constructor(readonly code: ErrorCode, message: string) { super(statusOf[code], message); }
}

const maxFile = 128 * 1024 * 1024, probeTtl = 10_000, probeTimeout = 15_000, convertTimeout = 10 * 60_000, tail = 4000;
const catiaName = /\.(CATPart|CATProduct)$/i;
const executable = () => process.env.CASTUDIO_CAD_CONVERTER || '';

/** A CATIA upload is a .CATPart/.CATProduct, or a .zip assembly package that contains one. */
export function isCatiaUpload(name: string, bytes: Uint8Array) {
  if (catiaName.test(name)) return true;
  if (!/\.zip$/i.test(name)) return false;
  const names: string[] = [];
  try { unzipSync(bytes, { filter: file => { names.push(file.name); return false; } }); } catch { return false; }
  return names.some(entry => catiaName.test(entry));
}

function run(exe: string, args: string[], timeout: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      else try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', text => { if (stdout.length < 64 * 1024) stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-32 * 1024); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}
const failure = (what: string, result: { code: number | null; stderr: string; timedOut: boolean }) =>
  new CadConvertError('failed', result.timedOut ? `${what}超时，已终止` : `${what}失败（退出码 ${result.code}）：${result.stderr.trim().slice(-tail) || '转换器没有输出错误信息'}`);

let cached: { exe: string; at: number; probe: CadConverterProbe } | undefined;
export const clearCadProbeCache = () => { cached = undefined; };
/** Probe result, cached for a few seconds. Throws not-installed (unset or missing executable) or failed (probe broken). */
export async function probeCadConverter(): Promise<CadConverterProbe> {
  const exe = executable();
  if (!exe) throw new CadConvertError('not-installed', '未安装 CATIA 转换器（请设置 CASTUDIO_CAD_CONVERTER 指向转换器可执行文件）');
  if (cached && cached.exe === exe && Date.now() - cached.at < probeTtl) return cached.probe;
  let result;
  try { result = await run(exe, ['probe'], probeTimeout); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CadConvertError('not-installed', `未找到 CATIA 转换器：${exe}`);
    throw new CadConvertError('failed', `无法启动 CATIA 转换器：${(error as Error).message}`);
  }
  if (result.code !== 0 || result.timedOut) throw failure('转换器检测', result);
  let probe: CadConverterProbe;
  try {
    probe = JSON.parse(result.stdout);
    if (typeof probe.version !== 'string' || typeof probe.read !== 'boolean' || typeof probe.write !== 'boolean' || !Array.isArray(probe.formats)) throw new Error();
  } catch { throw new CadConvertError('failed', '转换器 probe 没有返回有效的 JSON（需要 version/read/write/formats）'); }
  cached = { exe, at: Date.now(), probe };
  return probe;
}
async function require(mode: 'read' | 'write', kind?: string) {
  const probe = await probeCadConverter();
  if (!probe[mode]) throw new CadConvertError(mode === 'read' ? 'no-read-license' : 'no-write-license', mode === 'read' ? 'CATIA 转换器没有读取授权，无法导入 CATIA 文件' : 'CATIA 转换器没有写入授权，无法导出 CATIA 文件');
  if (kind && probe.formats.length && !probe.formats.some(f => f.toLowerCase() === kind.toLowerCase())) throw new CadConvertError('failed', `转换器不支持 ${kind} 格式`);
}
/** Removes everything but the named files from the converter's output directory and checks the kept files are regular and within the history size limit. */
async function keepOnly(dir: string, wanted: string[], optional: string[] = []) {
  for (const entry of await fs.readdir(dir)) if (![...wanted, ...optional].includes(entry)) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  for (const name of [...wanted, ...optional]) {
    const stat = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile() && stat.size > 0 && stat.size <= maxFile) continue;
    if (optional.includes(name)) { await fs.rm(path.join(dir, name), { force: true }); continue; }
    throw new CadConvertError('failed', stat?.isFile() && stat.size > maxFile ? `转换结果 ${name} 超过 128 MB 上限` : `转换器没有生成有效的 ${name}`);
  }
}
/** `<exe> import <input> <outDir>`; leaves only model.step (+ model.glb) in outDir. */
export async function importCad(input: string, outDir: string) {
  // The converter gets ASCII file names only: user files are often named in Chinese and native CAD tools may read paths in the ANSI code page.
  const copy = path.join(outDir, `input${path.extname(input).toLowerCase()}`);
  await fs.copyFile(input, copy);
  const result = await run(executable(), ['import', copy, outDir], convertTimeout);
  if (result.code !== 0 || result.timedOut) throw failure('CATIA 转换', result);
  await keepOnly(outDir, ['model.step'], ['model.glb']);
}
/** `<exe> export <input.step> <output> [--version V]`; the converter reads and writes ASCII names in the output folder, then the result takes `output`'s name. */
export async function exportCad(input: string, output: string, version?: string) {
  const dir = path.dirname(output), copy = path.join(dir, 'input.step'), written = path.join(dir, `output${path.extname(output).toLowerCase()}`);
  await fs.copyFile(input, copy);
  const result = await run(executable(), ['export', copy, written, ...(version ? ['--version', version] : [])], convertTimeout);
  if (result.code !== 0 || result.timedOut) throw failure('CATIA 导出', result);
  await keepOnly(dir, [path.basename(written)]);
  if (written !== output) await fs.rename(written, output);
}

type Modify = <T>(id: string, action: () => Promise<T>) => Promise<T>;
/** Registers the converter routes and returns `importUploaded`, which the upload route calls for CATIA files. */
export function cadConvertRoutes(app: Express, store: Store, history: History, modify: Modify, events: Events) {
  const changed = (id: string) => { events.emit(id, 'artifacts_changed', {}); events.emit(id, 'history_changed', {}); };
  const exists = (file: string) => fs.lstat(file).then(stat => stat.isFile(), () => false);
  const done = async (dir: string, root: string): Promise<CadConversion> => {
    const rel = (name: string) => path.relative(root, path.join(dir, name)).split(path.sep).join('/');
    return { state: 'done', message: '已转换为 STEP', step: rel('model.step'), ...(await exists(path.join(dir, 'model.glb')) ? { glb: rel('model.glb') } : {}) };
  };
  /** Converts imports/<uuid>/<file> into imports/<uuid>/converted/. Throws CadConvertError; an existing result is reused unless `force`. */
  const convert = async (id: string, relative: string, force: boolean): Promise<CadConversion> => {
    await store.project(id);
    const root = store.workspace(id), source = await safePath(root, relative);
    const parts = relative.split('/');
    if (parts.length !== 3 || parts[0] !== 'imports' || !(catiaName.test(relative) || /\.zip$/i.test(relative))) throw new HttpError(400, '需要 imports/ 下已上传的 CATIA 文件');
    const target = path.join(path.dirname(source), 'converted');
    if (!force && await exists(path.join(target, 'model.step'))) return done(target, root);
    await require('read', relative.match(catiaName)?.[1]);
    const temporary = path.join(path.dirname(source), `.converting-${randomUUID()}`);
    await fs.mkdir(temporary);
    try {
      await importCad(source, temporary);
      await modify(id, async () => {
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(temporary, target);
        await history.snapshot(id, `CATIA 转换后 · ${parts[2]}`, 'after-import');
        await store.touch(id);
      });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    changed(id);
    return done(target, root);
  };
  /** Upload hook: never throws, reports the outcome as `conversion` so the original stays usable whatever happens. */
  const importUploaded = async (id: string, relative: string): Promise<CadConversion> => {
    try { return await convert(id, relative, false); }
    catch (error) {
      const message = (error as Error).message;
      if (error instanceof CadConvertError) return { state: error.code === 'not-installed' ? 'unavailable' : error.code === 'no-read-license' ? 'no-read-license' : 'failed', message };
      return { state: 'failed', message };
    }
  };
  const guard = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await handler(req, res); }
    catch (error) { if (error instanceof CadConvertError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } throw error; }
  };
  app.get('/api/cad-convert/status', async (_req, res) => {
    try { res.json({ installed: true, ...await probeCadConverter() }); }
    catch (error) {
      if (!(error instanceof CadConvertError)) throw error;
      res.json({ installed: error.code !== 'not-installed', code: error.code, message: error.message });
    }
  });
  app.post('/api/projects/:id/cad-convert/import', guard(async (req, res) => {
    const id = String(req.params.id), relative = req.body?.path;
    if (typeof relative !== 'string') throw new HttpError(400, '需要 path');
    res.json(await convert(id, relative, true));
  }));
  app.post('/api/projects/:id/cad-convert/export', guard(async (req, res) => {
    const id = String(req.params.id), { path: relative, format, revision } = req.body ?? {};
    if (typeof relative !== 'string' || !/\.(step|stp)$/i.test(relative)) throw new HttpError(400, 'path 需要是项目内的 STEP 文件');
    if (format !== 'CATPart' && format !== 'CATProduct') throw new HttpError(400, "format 需要是 'CATPart' 或 'CATProduct'");
    if (revision !== undefined && !(typeof revision === 'string' && /^V5-6R20\d\d$/.test(revision))) throw new HttpError(400, 'revision 格式应为 V5-6R20xx');
    await store.project(id);
    await require('write', format);
    const root = store.workspace(id), input = await safePath(root, relative);
    const name = `${path.basename(relative).replace(/\.(step|stp)$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'model'}.${format}`;
    const base = path.join(root, 'exports', 'catia'), temporary = path.join(base, `.converting-${randomUUID()}`);
    const stamp = new Date().toISOString().replace(/[-:.]/g, ''), target = path.join(base, stamp);
    await fs.mkdir(temporary, { recursive: true });
    try {
      await exportCad(input, path.join(temporary, name), revision);
      await modify(id, async () => {
        await fs.rename(temporary, target);
        await history.snapshot(id, `CATIA 导出 · ${name}`, 'after-save');
        await store.touch(id);
      });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    changed(id);
    res.status(201).json({ path: `exports/catia/${stamp}/${name}`, name, format, ...(revision ? { revision } : {}) });
  }));
  return { importUploaded };
}
