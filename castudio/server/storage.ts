import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, ArtifactCategory, Message, Part, Project, Settings } from '../shared/types.js';
import { partSlugPattern } from '../shared/viewport.js';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const jsonRead = async <T>(file: string, fallback: T): Promise<T> => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
};
export async function jsonWrite(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 8) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
/** Rejects (400) an empty, absolute or dot-segment path before any filesystem access. */
export function checkRelative(relative: string) {
  if (!relative || relative.includes('\0') || /(^|[/\\])\.\.?([/\\]|$)/.test(relative) || path.isAbsolute(relative)) throw new HttpError(400, '无效文件路径');
}
export async function safePath(root: string, relative: string, mustExist = true): Promise<string> {
  checkRelative(relative);
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new HttpError(403, '文件必须位于当前项目中');
  const rootReal = await fs.realpath(root);
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new HttpError(403, '不允许通过符号链接访问项目外文件');
      if (!inside(rootReal, await fs.realpath(current))) throw new HttpError(403, '路径超出项目范围');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) break; throw e; }
  }
  return candidate;
}
export const supportedModels = /\.(glb|gltf|stl|obj|step|stp|scadpkg|zip)$/i;
/** A part's assembly: `assembly.json` at its workspace root (format and routes in assembly.ts); listed as a viewable model. */
export const ASSEMBLY_FILE = 'assembly.json';
const excluded = new Set(['.git', '.pi', '.studio', '.venv', 'venv', 'node_modules', '__pycache__']);
// .CATPart/.CATProduct are deliberately absent from supportedModels (kind 'file': no direct preview) but count as CAD for category purposes.
const cadModels = /\.(step|stp|stl|glb|gltf|obj|scadpkg|CATPart|CATProduct)$/i;
const bookkeeping = /^(AGENTS\.md|studio-[\w.-]+\.json|workflow-[\w.-]+\.json|geometry-check\.json|[\w.-]*manifest\.json|[\w.-]*\.bindings\.json|(job|published|state|run|program)\.json)$/i;
const shortId = (part: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) ? part.slice(0, 8) : part;
/** Role of a workspace file, derived from the layouts written by imports, builds, parametric/cylinder-object publishes, simulations and studio services. */
export function artifactCategory(relative: string): ArtifactCategory {
  if (relative === ASSEMBLY_FILE) return 'cad';
  const parts = relative.split('/'), name = parts[parts.length - 1], top = parts.length > 1 ? parts[0] : '';
  // imports/<id>/converted/ is the STEP/GLB that the CATIA converter derived from the original beside it: the original stays 'import', the derived model is the working 'cad' file.
  if (top === 'imports') return parts[2] === 'converted' && parts.length === 4 && cadModels.test(name) ? 'cad' : 'import';
  if (bookkeeping.test(name) || top === 'studio' || relative.startsWith('artifacts/viewport/')) return 'system';
  // <service>/exports/<rid>/ holds the published CAD plus its frozen source snapshot and binding records.
  const exported = parts.indexOf('exports');
  if (exported > 0 && parts.length > exported + 2) return cadModels.test(name) && parts[exported + 2] !== 'source' ? 'cad' : 'system';
  if (top === 'builds') return cadModels.test(name) ? 'cad' : 'system';
  if (top === 'simulations' || top === 'structural' || name === 'thermal-case.json' || /\.inp$/i.test(name)) return 'simulation';
  if (cadModels.test(name)) return 'cad';
  if (/\.(py|ipynb)$/i.test(name) || relative === 'cylinder-objects/model.json') return 'source';
  if (/\.(pdf|docx|html?|csv|webm|mp4|md)$/i.test(name)) return 'report';
  return 'other';
}
export const artifactDetail = (relative: string) => { const parts = relative.split('/'); return parts[0] === 'imports' && parts.length > 2 ? `导入 ${parts[1].slice(0, 8)}${parts[2] === 'converted' ? ' · 转换' : ''}` : parts.slice(0, -1).map(shortId).join('/'); };
/** Part ids are `<root id>--<slug>`; root ids (UUIDs from earlier releases, name slugs now) never contain `--`. */
export const PART_SEPARATOR = '--';
export const isPartId = (id: string) => id.includes(PART_SEPARATOR);
/** The root project id of a part id; a root id maps to itself. */
export const rootOf = (id: string) => isPartId(id) ? id.slice(0, id.indexOf(PART_SEPARATOR)) : id;
/** Top-level workspace folders owned by someone else: a root project's `parts/` belongs to its parts. */
export const foreignTopLevel = (id: string): ReadonlySet<string> => new Set(isPartId(id) ? [] : ['parts']);
export async function scanArtifacts(root: string, skipTop: ReadonlySet<string> = new Set()): Promise<Artifact[]> {
  const found: Artifact[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 6 || found.length > 1000) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || excluded.has(entry.name) || (depth === 0 && skipTop.has(entry.name))) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const kind = supportedModels.test(entry.name) || relative === ASSEMBLY_FILE ? 'model' : /\.(py|ts|js|json|md|txt|yaml|toml)$/i.test(entry.name) ? 'source' : /\.(png|jpg|jpeg|webp)$/i.test(entry.name) ? 'image' : 'file';
      found.push({ path: relative, name: entry.name, size: stat.size, modified: stat.mtimeMs, kind, category: artifactCategory(relative), detail: artifactDetail(relative) });
    }
  }
  await visit(root, 0);
  return found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}
/** Project and part ids: also the record folder names under `<projects dir>/.coserve`. Root ids also name the visible project folder. */
export const projectIdPattern = /^[a-z0-9-]{1,80}$/;
/** Record folder (project.json, history, sessions, runs) inside the projects directory; hidden on Windows. */
const RECORDS = '.coserve';
const windowsReserved = /^(con|prn|aux|nul|com\d|lpt\d)$/;
export class Store {
  /**
   * `projectsDir` holds one readable folder per root project (`<projects dir>/<id>/`, the workspace with the user's files)
   * plus the records under `.coserve/<id>/`; it defaults inside the data root and may live on another drive.
   */
  constructor(readonly root: string, readonly projectsDir = path.join(root, 'projects')) {}
  private mutations = new Map<string, string>();
  /** Takes the project's single mutation lock; `holder` names the operation in the 409 that other writers receive. */
  acquire(id: string, holder = '修改'): () => void {
    this.projectRoot(id);
    const current = this.mutations.get(id);
    if (current) throw new HttpError(409, current === 'Agent' ? '项目正在由 Agent 修改，请等待完成或停止 Agent' : `项目正在${current}，请等待完成后重试`);
    this.mutations.set(id, holder);
    return () => { this.mutations.delete(id); };
  }
  async init() {
    const records = path.join(this.projectsDir, RECORDS);
    await fs.mkdir(records, { recursive: true });
    // The record folder is bookkeeping, not user files; hiding it is cosmetic, so a failed attrib is ignored.
    if (process.platform === 'win32') execFile('attrib', ['+h', records], () => {});
    await this.migrateLegacyLayout();
  }
  /**
   * Earlier releases kept `<projects dir>/<id>/{project.json,…,workspace/}` and part records as `<projects dir>/<root>--<slug>/`.
   * Move each record to `.coserve/<id>` and lift a root's `workspace/` to `<projects dir>/<id>`. Runs before any service touches a project.
   */
  private async migrateLegacyLayout() {
    for (const entry of await fs.readdir(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !projectIdPattern.test(entry.name)) continue;
      const legacy = path.join(this.projectsDir, entry.name), record = await jsonRead<Project | null>(path.join(legacy, 'project.json'), null);
      if (record?.id !== entry.name) continue;
      const hasWorkspace = await fs.stat(path.join(legacy, 'workspace')).then(s => s.isDirectory(), () => false);
      if (!isPartId(entry.name) && !hasWorkspace) continue;
      const target = this.projectRoot(entry.name);
      await fs.rename(legacy, target);
      if (hasWorkspace) await fs.rename(path.join(target, 'workspace'), legacy);
    }
  }
  projectRoot(id: string) {
    if (!projectIdPattern.test(id)) throw new HttpError(400, '无效项目编号');
    return path.join(this.projectsDir, RECORDS, id);
  }
  /** A root's workspace is its visible `<projects dir>/<id>` folder; a part's is the `parts/<slug>` folder of its root's workspace. */
  workspace(id: string): string {
    this.projectRoot(id);
    if (!isPartId(id)) return path.join(this.projectsDir, id);
    const at = id.indexOf(PART_SEPARATOR);
    return path.join(this.workspace(id.slice(0, at)), 'parts', id.slice(at + PART_SEPARATOR.length));
  }
  async project(id: string): Promise<Project> {
    const project = await jsonRead<Project | null>(path.join(this.projectRoot(id), 'project.json'), null);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }
  /** Every record, parts included; for services that recover per-id state. Entries that are not project-id folders (desktop.ini) are skipped. */
  async records(): Promise<Project[]> {
    const ids = (await fs.readdir(path.join(this.projectsDir, RECORDS), { withFileTypes: true })).filter(entry => entry.isDirectory() && projectIdPattern.test(entry.name)).map(entry => entry.name);
    const projects = await Promise.all(ids.map(id => jsonRead<Project | null>(path.join(this.projectRoot(id), 'project.json'), null)));
    return projects.filter((p): p is Project => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** Root projects only; parts are listed through `parts()`. */
  async projects(): Promise<Project[]> { return (await this.records()).filter(p => !p.parentId); }
  /**
   * The root's parts, the implicit `default` part (the root itself) first. A folder under `parts/` with a valid
   * slug and no record (for example one the Agent created) is registered as a part named after its slug.
   */
  parts(rootId: string): Promise<Part[]> { return this.serialParts(rootId, () => this.listParts(rootId)); }
  /** Serialized per root so concurrent requests with the same name get distinct slugs. */
  createPart(rootId: string, name: string): Promise<Part> { return this.serialParts(rootId, () => this.writePart(rootId, name)); }
  /** Changes the display name only; slug, folder, history and agent references stay valid. The default part is the root itself and has no stored name. */
  renamePart(rootId: string, slug: string, name: string): Promise<Part> {
    return this.serialParts(rootId, async () => {
      const list = await this.listParts(rootId), part = list.find(p => p.slug === slug);
      if (slug === 'default') throw new HttpError(400, '默认零件不能重命名');
      if (!part) throw new HttpError(404, '零件不存在');
      const label = name.trim();
      if (label.length < 1 || label.length > 60) throw new HttpError(400, '零件名称需为 1–60 个字符');
      if (list.some(p => p.slug !== slug && p.name.toLowerCase() === label.toLowerCase())) throw new HttpError(409, '已有同名零件');
      const record = await this.project(part.id);
      record.name = label; record.updatedAt = new Date().toISOString();
      await jsonWrite(path.join(this.projectRoot(part.id), 'project.json'), record);
      return { id: part.id, slug, name: label };
    });
  }
  /**
   * Moves the part's folder and its record directory (project.json, history, messages) to `<projects dir>/.trash/<timestamp>-<part id>/{workspace,record}`,
   * outside every workspace and on the projects volume, so the moves are renames. Restoring is moving `workspace` back to `parts/<slug>` and `record` to `<projects dir>/.coserve/<part id>`.
   * Returns the absolute trash folder. The caller checks that no agent run is active on the part.
   */
  deletePart(rootId: string, slug: string): Promise<{ deleted: true; id: string; trash: string }> {
    return this.serialParts(rootId, async () => {
      const part = (await this.listParts(rootId)).find(p => p.slug === slug);
      if (slug === 'default') throw new HttpError(400, '默认零件不能删除');
      if (!part) throw new HttpError(404, '零件不存在');
      const release = this.acquire(part.id);
      try {
        const trash = path.join(this.projectsDir, '.trash', `${Date.now()}-${part.id}`);
        await fs.mkdir(trash, { recursive: true });
        await fs.rename(this.workspace(part.id), path.join(trash, 'workspace')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rename(this.projectRoot(part.id), path.join(trash, 'record'));
        return { deleted: true, id: part.id, trash };
      } finally { release(); }
    });
  }
  private partWork = new Map<string, Promise<unknown>>();
  private serialParts<T>(rootId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.partWork.get(rootId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.partWork.set(rootId, next);
    return next;
  }
  private async listParts(rootId: string): Promise<Part[]> {
    const root = await this.project(rootId);
    if (root.parentId) throw new HttpError(400, '零件下不能再列出零件');
    const own = (await this.records()).filter(p => p.parentId === rootId);
    const folders = await fs.readdir(path.join(this.workspace(rootId), 'parts'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of folders) {
      if (!entry.isDirectory() || entry.name === 'default' || entry.name.length > 40 || !partSlugPattern.test(entry.name) || own.some(p => p.slug === entry.name)) continue;
      own.push(await this.recordPart(rootId, entry.name, entry.name));
    }
    own.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug!.localeCompare(b.slug!));
    return [{ id: rootId, slug: 'default', name: '默认零件' }, ...own.map(p => ({ id: p.id, slug: p.slug!, name: p.name }))];
  }
  private async recordPart(rootId: string, slug: string, name: string): Promise<Project> {
    const now = new Date().toISOString();
    const part: Project = { id: `${rootId}${PART_SEPARATOR}${slug}`, name, createdAt: now, updatedAt: now, parentId: rootId, slug };
    await fs.mkdir(this.workspace(part.id), { recursive: true });
    await jsonWrite(path.join(this.projectRoot(part.id), 'project.json'), part);
    return part;
  }
  private async writePart(rootId: string, name: string): Promise<Part> {
    const existing = await this.listParts(rootId);
    const label = name.trim().slice(0, 80) || '新零件';
    const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'part';
    const taken = new Set(existing.map(p => p.slug));
    let slug = base === 'default' ? 'part' : base;
    for (let n = 2; taken.has(slug); n++) slug = `${base === 'default' ? 'part' : base}-${n}`;
    if (!partSlugPattern.test(slug) || slug.length > 40) throw new HttpError(400, '无法生成零件标识');
    const part = await this.recordPart(rootId, slug, label);
    return { id: part.id, slug, name: label };
  }
  /**
   * The id is an ASCII slug of the name (the Python/gmsh toolchain needs ASCII paths), unique among the folders in the projects directory,
   * so the project's folder is `<projects dir>/<slug>`; names without ASCII letters or digits become `project`, `project-2`, …
   */
  createProject(name: string): Promise<Project> {
    return this.serialParts(RECORDS, async () => {
      const label = name.trim().slice(0, 80) || '未命名设计';
      let base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'project';
      if (windowsReserved.test(base)) base = `${base}-project`;
      const taken = new Set((await fs.readdir(this.projectsDir)).map(n => n.toLowerCase()));
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const now = new Date().toISOString(), project = { id, name: label, createdAt: now, updatedAt: now };
      await fs.mkdir(path.join(this.workspace(id), 'artifacts'), { recursive: true });
      await jsonWrite(path.join(this.projectRoot(id), 'project.json'), project);
      return project;
    });
  }
  async renameProject(id: string, name: string): Promise<Project> {
    const project = await this.project(id);
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) throw new HttpError(400, '项目名称不能为空');
    project.name = trimmed;
    project.updatedAt = new Date().toISOString();
    await jsonWrite(path.join(this.projectRoot(id), 'project.json'), project);
    return project;
  }
  /** Files that make a project more than the prepared skeleton; only a skeleton-only project may be deleted. */
  async userFiles(id: string): Promise<string[]> {
    const root = this.workspace(id);
    const found: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(dir, entry.name);
        const relative = path.relative(root, target).split(path.sep).join('/');
        if (entry.isDirectory()) { if (relative !== '.agents' && !excluded.has(entry.name)) await visit(target); continue; }
        if (entry.isFile() && relative !== 'AGENTS.md') found.push(relative);
      }
    };
    try { await visit(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return found.sort();
  }
  async deleteProject(id: string): Promise<{ deleted: true; id: string }> {
    const project = await this.project(id);
    const release = this.acquire(id);
    try {
      const files = await this.userFiles(id);
      if (files.length > 0) throw new HttpError(409, `项目里还有 ${files.length} 个文件（例如 ${files[0]}），请先清空模型和产物再删除`);
      // An empty root may still hold empty part records; they go with it.
      await fs.rm(this.workspace(id), { recursive: true, force: true });
      if (!project.parentId) for (const part of (await this.records()).filter(p => p.parentId === id)) await fs.rm(this.projectRoot(part.id), { recursive: true, force: true });
      await fs.rm(this.projectRoot(id), { recursive: true, force: true });
      return { deleted: true, id: project.id };
    } finally { release(); }
  }
  async touch(id: string) { const p = await this.project(id); p.updatedAt = new Date().toISOString(); await jsonWrite(path.join(this.projectRoot(id), 'project.json'), p); }
  async messages(id: string): Promise<Message[]> { await this.project(id); return jsonRead(path.join(this.projectRoot(id), 'messages.json'), []); }
  private messageWrites = new Map<string, Promise<unknown>>();
  async addMessage(id: string, message: Message) {
    const previous = this.messageWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const messages = await this.messages(id);
      const index = messages.findIndex(m => m.id === message.id);
      if (index >= 0) messages[index] = message; else messages.push(message);
      await jsonWrite(path.join(this.projectRoot(id), 'messages.json'), messages.slice(-500));
    });
    this.messageWrites.set(id, next); await next;
  }
  async settings(): Promise<Settings> {
    const settings = await jsonRead<Settings>(path.join(this.root, 'settings.json'), { provider: process.env.PI_PROVIDER || '', model: process.env.PI_MODEL || '', thinking: 'off' });
    if (settings.model === 'gpt-6-astra' && ['off', 'minimal'].includes(settings.thinking)) settings.thinking = 'medium';
    return settings;
  }
  async saveSettings(settings: Settings) { await jsonWrite(path.join(this.root, 'settings.json'), settings); }
}
