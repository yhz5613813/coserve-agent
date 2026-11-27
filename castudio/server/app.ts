import {Optimizations,optimizationRoutes} from './optimization.js';
import {Deliveries,deliveryRoutes} from './delivery.js';
import { parametricRoutes } from './parametric.js';
import { dshWorkspaceRoutes } from './dsh-workspace.js';
import { viewportRoutes, type ViewportRouteOptions } from './viewport.js';
import { cylinderObjectsRoutes } from './cylinder-objects.js';
import { cadInspectionRoutes } from './cad-inspections.js';
import { cadConvertRoutes, isCatiaUpload } from './cad-convert.js';
import { exportRoutes } from './exports.js';
import { structuralRoutes } from './structural.js';
import express from 'express';
import { Thermal } from './thermal.js';
import {ThermalEditor} from './thermal-editor.js';
import {ThermalResource} from './thermal-resource.js';
import multer from 'multer';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Store, safePath, scanArtifacts, foreignTopLevel, isPartId, rootOf, PART_SEPARATOR, HttpError, jsonRead, jsonWrite } from './storage.js';
import { assemblyRoutes } from './assembly.js';
import type { Part, PartRunStatus } from '../shared/types.js';
import { Plugins } from './plugins.js';
import { Events } from './events.js';
import { watchWorkspace } from './watch.js';
import { PiHarness } from './harness.js';
import type { Settings } from '../shared/types.js';
import { History } from './history.js';
import { validateArchive } from './scene-package.js';
import { Reviews } from './reviews.js';
import { Builds } from './builds.js';
import { Parameters } from './parameters.js';
import { Measurements } from './measurements.js';

/** Loopback Host and same-origin check for every `/api` request; also sets `Cache-Control: no-store`. */
export const apiGuard: express.RequestHandler = (req, res, next) => {
  const host = req.hostname;
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) { res.status(403).json({ error: '仅允许本机访问' }); return; }
  const origin = req.get('origin');
  if (origin) { try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({ error: '跨站请求被拒绝' }); return; } } catch { res.status(403).json({ error: '无效请求来源' }); return; } }
  res.setHeader('Cache-Control', 'no-store'); next();
};
/** `GET /api/health`: 200 `{ok:true, ready:true, instance, pid}` once projects can be served, 503 with `ok:false` before (the desktop waits for its instance with `ok`). */
export const healthRoute = (ready: () => boolean): express.RequestHandler => (_req, res) => {
  const ok = ready();
  if (!ok) res.set('Retry-After', '1');
  res.status(ok ? 200 : 503).json({ ok, ready: ok, instance: process.env.STUDIO_INSTANCE ?? null, pid: process.pid });
};

export async function createApp(dataRoot: string, options: { viewport?: ViewportRouteOptions; projects?: string } = {}) {
  const store = new Store(dataRoot, options.projects); await store.init();
  const history = new History(store);
  const reviews = new Reviews(store, history);
  const parameters = new Parameters(store, history);
  const measurements = new Measurements(store, history);
  for (const project of await store.records()) await history.recover(project.id);
  const plugins = new Plugins(dataRoot), events: Events = new Events(id => watchWorkspace(store.workspace(id), foreignTopLevel(id), paths => events.emit(id, 'artifacts_changed', paths ? { paths } : {}))), harness = new PiHarness(store, plugins, events, history);
  const builds = new Builds(store, history, events); await builds.recover();
  const thermalResource=new ThermalResource();
  const thermal = new Thermal(store, history, events,thermalResource); await thermal.recover();
  const thermalEditor=new ThermalEditor(store,events,thermalResource);await thermalEditor.recover();
  const optimizations=new Optimizations(store,history,builds,thermal,thermalEditor,events);await optimizations.recover();
  const modify = async <T>(id: string, action: () => Promise<T>) => {
    const release = store.acquire(id);
    try { await history.recover(id); return await action(); } finally { release(); }
  };
  const app = express(); app.disable('x-powered-by');
  app.use('/api', apiGuard);
  app.get('/api/health', healthRoute(() => true));
  // Viewport routes carry their own body parsers: the results route accepts 30mb snapshots while the shared parser stays at 8mb.
  viewportRoutes(app, store, events, options.viewport);
  // Scoped to /api: the parametric proxy (/pm/:id) must forward request bodies unread.
  app.use('/api', express.json({ limit: '8mb' }));
  dshWorkspaceRoutes(app, store);
  optimizationRoutes(app,optimizations);
  deliveryRoutes(app,new Deliveries(store,optimizations,history,builds,thermal));
  // Part statuses (GET parts) derive from publishes and runs, so their completion refreshes the root's part list.
  const partsChanged=(id:string)=>events.emit(rootOf(id),'parts_changed',{});
  const parametric=parametricRoutes(app,store,history,(id,open)=>{partsChanged(id);if(open)events.emit(id,'artifacts_changed',{open});});
  const cylinderObjects=cylinderObjectsRoutes(app,store,history,{changed:id=>{events.emit(id,'artifacts_changed',{});events.emit(id,'history_changed',{});}});
  const cadInspections=cadInspectionRoutes(app,store,history,{changed:id=>events.emit(id,'artifacts_changed',{})});
  const structural=structuralRoutes(app,store,undefined,partsChanged);
  assemblyRoutes(app,store,history,events);
  /** The latest run record under `dir/<run id>/run.json`, as the services write them. */
  const latestRun = async (dir: string) => {
    const names = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    const runs = await Promise.all(names.filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => jsonRead<{ id: string; state: string; createdAt: string } | null>(path.join(dir, name, 'run.json'), null)));
    return runs.filter(run => !!run).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))[0];
  };
  const runStatus = (state?: string): PartRunStatus | undefined => state === 'succeeded' ? 'succeeded' : state === 'failed' || state === 'interrupted' ? 'failed' : state === 'queued' || state === 'running' ? 'running' : undefined;
  const partStatus = async (part: Part): Promise<Part> => {
    const record = await store.project(part.id), workspace = store.workspace(part.id);
    const index = await fs.stat(path.join(store.projectRoot(part.id), 'history', 'index.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const updatedAt = index && index.mtime.toISOString() > record.updatedAt ? index.mtime.toISOString() : record.updatedAt;
    const published = !!await jsonRead(path.join(workspace, 'parametric', 'published.json'), null) || (await scanArtifacts(workspace, foreignTopLevel(part.id))).some(f => f.category === 'cad' && /\.(step|stp)$/i.test(f.name));
    const structuralRun = await latestRun(path.join(workspace, 'structural')), thermalRun = await latestRun(path.join(store.projectRoot(part.id), 'thermal'));
    const structuralState = structuralRun && ['queued', 'running'].includes(structuralRun.state) && !structural.running(structuralRun.id) ? 'interrupted' : structuralRun?.state;
    return { ...part, updatedAt, published, structural: runStatus(structuralState), thermal: runStatus(thermalRun?.state) };
  };
  app.get('/api/projects/:id/measurements', async (req, res) => res.json(await measurements.read(req.params.id)));
  app.post('/api/projects/:id/measurements', async (req, res) => {
    const value = await measurements.change(req.params.id, req.body.etag, { add: req.body.measurement });
    events.emit(req.params.id, 'artifacts_changed', {}); res.status(201).json(value);
  });
  app.delete('/api/projects/:id/measurements/:measurement', async (req, res) => {
    const value = await measurements.change(req.params.id, req.body.etag, { remove: req.params.measurement });
    events.emit(req.params.id, 'artifacts_changed', {}); res.json(value);
  });
  app.get('/api/runtime', async (_req, res) => res.json(await builds.runtime.config()));
  app.post('/api/runtime/probe', async (req, res) => res.json(await builds.runtime.probe(req.body.executable)));
  app.put('/api/runtime', async (req, res) => res.json(await builds.runtime.save(req.body.executable)));
  app.get('/api/projects/:id/builds', async (req, res) => res.json(await builds.list(req.params.id)));
  app.post('/api/projects/:id/builds', async (req, res) => res.status(202).json(await builds.start(req.params.id, req.body.source, req.body.expectedSource, req.body.expectedParameters, req.body.engine)));
  app.get('/api/projects/:id/parameters', async (req, res) => res.json(await parameters.read(req.params.id, req.query.source)));
  app.put('/api/projects/:id/parameters', async (req, res) => {
    const value = await parameters.save(req.params.id, req.body.source, req.body.hash, req.body.values);
    events.emit(req.params.id, 'artifacts_changed', {}); events.emit(req.params.id, 'history_changed', {}); res.json(value);
  });
  app.post('/api/projects/:id/templates/plate', async (req, res) => {
    const value = await parameters.template(req.params.id);
    events.emit(req.params.id, 'artifacts_changed', {}); events.emit(req.params.id, 'history_changed', {}); res.status(201).json(value);
  });
  app.get('/api/projects/:id/builds/:run', async (req, res) => res.json(await builds.read(req.params.id, req.params.run)));
  app.post('/api/projects/:id/builds/:run/cancel', async (req, res) => res.json(await builds.cancel(req.params.id, req.params.run)));
  app.post('/api/projects/:id/builds/:run/publish', async (req, res) => res.json(await builds.publish(req.params.id, req.params.run)));
  app.get('/api/projects/:id/builds/:run/file', async (req, res) => {
    const file = String(req.query.path || '');
    res.set('X-Content-Type-Options', 'nosniff').attachment(path.basename(file)).send(await builds.file(req.params.id, req.params.run, file));
  });
  app.post('/api/scene-package/validate', express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '需要场景包二进制文件');
    try { res.json(await validateArchive(req.body)); }
    catch (error) { throw new HttpError(422, (error as Error).message); }
  });
  app.get('/api/thermal/runtime', async (_req,res) => res.json(await thermal.status()));
  app.get('/api/thermal/schema',async(_req,res)=>res.json(await thermalEditor.schema()));
  app.post('/api/projects/:id/thermal/inspections',async(req,res)=>res.status(202).json(await thermalEditor.start(req.params.id,req.body)));
  app.get('/api/projects/:id/thermal/inspections/:inspection',async(req,res)=>res.json(await thermalEditor.read(req.params.id,req.params.inspection)));
  app.get('/api/projects/:id/thermal/inspections/:inspection/surface',async(req,res)=>res.type('json').send(await thermalEditor.surface(req.params.id,req.params.inspection)));
  app.post('/api/projects/:id/thermal/inspections/:inspection/cancel',async(req,res)=>res.json(await thermalEditor.cancel(req.params.id,req.params.inspection)));
  app.post('/api/projects/:id/thermal/inspections/:inspection/resolve',async(req,res)=>{
    const abort=new AbortController(),stop=()=>{if(!res.writableEnded)abort.abort();};res.once('close',stop);
    try{res.json(await thermalEditor.resolve(req.params.id,req.params.inspection,req.body.selection,req.body.surfaceHash,abort.signal));}
    finally{res.off('close',stop);}
  });
  app.post('/api/projects/:id/thermal/inspections/:inspection/validate',async(req,res)=>res.json(await thermalEditor.validate(req.params.id,req.params.inspection,req.body.config)));
  app.post('/api/thermal/runtime/probe', async (req,res) => res.json(await thermal.probe(req.body.executable)));
  app.put('/api/thermal/runtime', async (req,res) => res.json(await thermal.saveRuntime(req.body.executable)));
  app.get('/api/projects/:id/thermal/case', async (req,res) => {
    await store.project(req.params.id);
    const file=await safePath(store.workspace(req.params.id),'thermal-case.json',false);
    res.json(await jsonRead(file,{}));
  });
  app.put('/api/projects/:id/thermal/case', async (req,res) => {
    const {source,units,config,editor}=req.body;
    if(typeof source!=='string'||!['mm','cm','m'].includes(units)||!config||typeof config!=='object'||Array.isArray(config))throw new HttpError(400,'无效工况');
    if(editor!==undefined&&(!editor||typeof editor!=='object'||Array.isArray(editor)||editor.schema_version!==1||JSON.stringify(editor).length>200000||
      !['sourceIds','coolingIds'].every(key=>Array.isArray(editor[key])&&editor[key].length<=16&&editor[key].every((id:unknown)=>typeof id==='string'&&id.length<=80))))throw new HttpError(400,'工况编辑信息无效');
    await modify(req.params.id,async()=>{
      await store.project(req.params.id);
      await safePath(store.workspace(req.params.id),source);
      const file=await safePath(store.workspace(req.params.id),'thermal-case.json',false);
      await history.snapshot(req.params.id,'保存热仿真工况前');
      await jsonWrite(file,{source,units,config,...(editor?{editor}:{})});await store.touch(req.params.id);
      await history.snapshot(req.params.id,'保存热仿真工况');
    });
    events.emit(req.params.id,'artifacts_changed',{});res.json({ok:true});
  });
  app.get('/api/projects/:id/thermal',async(req,res)=>res.json(await thermal.list(req.params.id)));
  app.post('/api/projects/:id/thermal',async(req,res)=>res.status(202).json(await thermal.start(req.params.id,await thermalEditor.prepareRun(req.params.id,req.body))));
  app.post('/api/projects/:id/thermal/queue',async(req,res)=>res.status(202).json(await thermal.start(req.params.id,await thermalEditor.prepareRun(req.params.id,req.body),true)));
  app.get('/api/projects/:id/thermal/:run',async(req,res)=>res.json(await thermal.read(req.params.id,req.params.run)));
  app.get('/api/projects/:id/thermal/:run/geometry',async(req,res)=>{
    res.type('json').send(await thermal.geometry(req.params.id,req.params.run));
  });
  app.get('/api/projects/:id/thermal/:run/preview/:frame',async(req,res)=>{
    if(!/^\d{1,3}$/.test(req.params.frame))throw new HttpError(400,'无效实时帧编号');
    res.type('application/octet-stream').send(await thermal.previewFrame(req.params.id,req.params.run,Number(req.params.frame)));
  });
  app.post('/api/projects/:id/thermal/:run/cancel',async(req,res)=>res.json(await thermal.cancel(req.params.id,req.params.run)));
  app.post('/api/projects/:id/thermal/:run/publish',async(req,res)=>res.json(await thermal.publish(req.params.id,req.params.run)));
  app.get('/api/projects/:id/thermal/:run/file',async(req,res)=>{
    const file=String(req.query.path||'');res.set('X-Content-Type-Options','nosniff').attachment(path.basename(file)).send(await thermal.file(req.params.id,req.params.run,file));
  });
  app.get('/api/status', async (_req, res) => res.json(await harness.status()));
  app.get('/api/auth/chatgpt', (_req, res) => res.json(harness.chatGPT.status()));
  app.post('/api/auth/chatgpt', async (_req, res) => {
    if (!harness.chatGPT.active) await harness.invalidate();
    res.json(harness.chatGPT.start());
  });
  app.delete('/api/auth/chatgpt/:id', async (req, res) => res.json(await harness.chatGPT.cancel(String(req.params.id))));
  app.post('/api/auth/chatgpt/:id/callback', (req, res) => {
    if (typeof req.body.callbackUrl !== 'string' || req.body.callbackUrl.length > 10000) throw new HttpError(400, '无效回跳地址');
    res.json(harness.chatGPT.submitCallback(String(req.params.id), req.body.callbackUrl.trim()));
  });
  app.post('/api/provider/openai', async (req, res) => {
    if (typeof req.body.apiKey !== 'string' || !req.body.apiKey.trim()) throw new HttpError(400, '请填写 OpenAI API Key');
    await harness.connectOpenAI(req.body.apiKey.trim()); res.json({ ok: true, model: 'gpt-6-astra' });
  });
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const providerFields = (body: Record<string, unknown>) => {
    const { baseUrl, model, apiKey, thinking, input, reasoning } = body;
    if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' || !apiKey.trim()) throw new HttpError(400, '请填写服务地址、模型名称和 API Key');
    let url: URL; try { url = new URL(baseUrl); } catch { throw new HttpError(400, '服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, '服务地址必须是 HTTP(S) URL');
    if (thinking !== undefined && !thinkingLevels.includes(thinking as string)) throw new HttpError(400, '无效思考级别');
    if (input !== undefined && (!Array.isArray(input) || !input.includes('text') || input.some(item => item !== 'text' && item !== 'image'))) throw new HttpError(400, '输入类型必须包含 text，且只能是 text 或 image');
    if (reasoning !== undefined && typeof reasoning !== 'boolean') throw new HttpError(400, '无效思考能力设置');
    return { baseUrl: url.toString().replace(/\/$/, ''), model: model.trim(), apiKey: apiKey.trim(), thinking: thinking as Settings['thinking'] | undefined, input: input as ('text' | 'image')[] | undefined, reasoning: reasoning as boolean | undefined };
  };
  app.post('/api/provider', async (req, res) => {
    const { baseUrl, model, apiKey, ...options } = providerFields(req.body);
    res.json({ ok: true, ...await harness.connectProvider(baseUrl, model, apiKey, options) });
  });
  app.put('/api/settings', async (req, res) => {
    const { provider, model, thinking } = req.body;
    if (typeof provider !== 'string' || typeof model !== 'string' || !thinkingLevels.includes(thinking)) throw new HttpError(400, '无效模型设置');
    if (model === 'gpt-6-astra' && ['off', 'minimal'].includes(thinking)) throw new HttpError(400, 'GPT-6 的思考级别请选择 low 或更高');
    await harness.invalidate(); await store.saveSettings({ provider, model, thinking }); res.json({ ok: true });
  });
  app.get('/api/projects', async (_req, res) => res.json(await store.projects()));
  app.post('/api/projects', async (req, res) => res.status(201).json(await store.createProject(String(req.body.name || '新设计'))));
  app.get('/api/projects/:id', async (req, res) => res.json(await store.project(req.params.id)));
  app.patch('/api/projects/:id', async (req, res) => res.json(await store.renameProject(req.params.id, String(req.body?.name ?? ''))));
  app.delete('/api/projects/:id', async (req, res) => res.json(await store.deleteProject(req.params.id)));
  app.get('/api/projects/:id/messages', async (req, res) => res.json(await harness.messages(req.params.id)));
  app.get('/api/projects/:id/events', async (req, res) => { await store.project(req.params.id); events.connect(req.params.id, res, Number(req.get('last-event-id') || 0)); });
  app.post('/api/projects/:id/prompt', async (req, res) => {
    if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 40000) throw new HttpError(400, '请输入 1–40000 字符的消息');
    res.status(202).json(await harness.prompt(req.params.id, req.body.text, req.body.selection));
  });
  app.post('/api/projects/:id/stop', async (req, res) => { await store.project(req.params.id); await harness.stop(req.params.id); res.json({ ok: true }); });
  app.get('/api/projects/:id/files', async (req, res) => { await store.project(req.params.id); res.json(await scanArtifacts(store.workspace(req.params.id), foreignTopLevel(req.params.id))); });
  app.get('/api/projects/:id/parts', async (req, res) => res.json(await Promise.all((await store.parts(req.params.id)).map(partStatus))));
  app.post('/api/projects/:id/parts', async (req, res) => {
    const part = await store.createPart(req.params.id, String(req.body?.name ?? ''));
    events.emit(req.params.id, 'parts_changed', {}); res.status(201).json(part);
  });
  const rootOnly = (id: string) => { if (isPartId(id)) throw new HttpError(400, '请使用项目编号，不要使用零件编号'); return id; };
  app.patch('/api/projects/:id/parts/:slug', async (req, res) => {
    const part = await store.renamePart(rootOnly(req.params.id), req.params.slug, String(req.body?.name ?? ''));
    events.emit(req.params.id, 'parts_changed', {}); res.json(part);
  });
  app.delete('/api/projects/:id/parts/:slug', async (req, res) => {
    const rootId = rootOnly(req.params.id), slug = req.params.slug;
    if (slug !== 'default' && (harness.isBusy(rootId) || harness.isBusy(`${rootId}${PART_SEPARATOR}${slug}`))) throw new HttpError(409, 'Agent 正在修改项目，请先停止任务');
    const result = await store.deletePart(rootId, slug);
    events.emit(rootId, 'parts_changed', {}); res.json(result);
  });
  app.get('/api/projects/:id/annotations', async (req, res) => res.json(await reviews.read(req.params.id)));
  app.post('/api/projects/:id/annotations', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { create: req.body.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.status(201).json(doc);
  });
  app.patch('/api/projects/:id/annotations/:note', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { update: req.params.note, value: req.body.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.json(doc);
  });
  app.delete('/api/projects/:id/annotations/:note', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { remove: req.params.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.json(doc);
  });
  app.get('/api/projects/:id/history', async (req, res) => res.json(await history.list(req.params.id)));
  app.post('/api/projects/:id/history', async (req, res) => {
    const id = req.params.id;
    res.status(201).json(await modify(id, () => history.snapshot(id, String(req.body.label || '手动保存版本'))));
    events.emit(id, 'history_changed', {});
  });
  app.get('/api/projects/:id/history/:revision/compare', async (req, res) => res.json(await history.compare(req.params.id, req.params.revision)));
  app.get('/api/projects/:id/history/:revision/diff', async (req, res) => res.json(await history.diff(req.params.id, req.params.revision, String(req.query.path || ''))));
  app.get('/api/projects/:id/history/:revision/file', async (req, res) => {
    const bytes = await history.file(req.params.id, req.params.revision, String(req.query.path || ''));
    res.set('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(bytes);
  });
  app.post('/api/projects/:id/history/:revision/restore', async (req, res) => {
    const id = req.params.id;
    if (typeof req.body.fingerprint !== 'string') throw new HttpError(400, '请先查看版本差异');
    const result = await modify(id, async () => {
      const value = await history.restore(id, req.params.revision, req.body.fingerprint);
      await store.touch(id);
      await store.addMessage(id, { id: randomUUID(), role: 'system', text: `项目文件已恢复到「${value.restored.label}」。恢复前版本「${value.backup.label}」已保留。对话记录不回退。`, timestamp: Date.now() });
      return value;
    });
    events.emit(id, 'artifacts_changed', {}); events.emit(id, 'history_changed', {});
    res.json(result);
  });
  app.get('/api/projects/:id/file', async (req, res) => {
    await store.project(req.params.id);
    const file = await safePath(store.workspace(req.params.id), String(req.query.path || ''));
    if (String(req.query.text) === '1') {
      if (!/\.(py|ts|js|json|md|txt|yaml|toml)$/i.test(file)) throw new HttpError(400, '这个文件不是可编辑文本');
      if ((await fs.stat(file)).size > 2_000_000) throw new HttpError(413, '源文件超过 2 MB');
      res.type('text/plain').send(await fs.readFile(file, 'utf8'));
    } else { res.set('X-Content-Type-Options', 'nosniff'); res.type('application/octet-stream'); res.sendFile(file, { dotfiles: 'allow' }); }
  });
  app.put('/api/projects/:id/file', async (req, res) => {
    await store.project(req.params.id);
    if (harness.isBusy(req.params.id)) throw new HttpError(409, 'Agent 正在修改项目，请先停止任务');
    const relative = String(req.body.path || '');
    if (!/\.(py|json|md|txt|yaml|toml)$/i.test(relative) || typeof req.body.text !== 'string') throw new HttpError(400, '只支持保存 Python 和文本文件');
    // Part folders belong to their own records (lock and history); the root must not write into them.
    if (foreignTopLevel(req.params.id).has(relative.split(/[\\/]/)[0])) throw new HttpError(400, '零件文件请在对应零件中保存');
    await modify(req.params.id, async () => {
      const file = await safePath(store.workspace(req.params.id), relative, false);
      if ('baseText' in req.body) {
        const actual = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (actual !== req.body.baseText) throw new HttpError(409, '源码已被其他操作修改。请重新打开文件并合并修改后保存。');
      }
      await history.snapshot(req.params.id, `保存前 · ${relative}`, 'before-save');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(path.dirname(file), `.studio-save-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, req.body.text, 'utf8');
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
      await history.snapshot(req.params.id, `保存后 · ${relative}`, 'after-save');
      await store.touch(req.params.id);
    });
    events.emit(req.params.id, 'artifacts_changed', {}); res.json({ ok: true });
  });
  app.post('/api/projects/:id/motor-recordings', express.raw({ type: 'video/webm', limit: '128mb' }), async (req,res) => {
    const bytes=req.body;
    if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.readUInt32BE(0)!==0x1a45dfa3||!bytes.subarray(0,256).includes(Buffer.from('webm')))throw new HttpError(400,'需要有效的 WebM 视口录制');
    const id=String(req.params.id), name='induction-motor-studio.webm', relative=`recordings/${randomUUID()}/${name}`;
    await modify(id,async()=>{
      await store.project(id);
      const target=await safePath(store.workspace(id),relative,false);
      await history.snapshot(id,'保存电机视口录制前','before-import');
      await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
      await history.snapshot(id,'电机装配与启动 · Studio 视口录制','after-import');await store.touch(id);
    });
    events.emit(id,'artifacts_changed',{});events.emit(id,'history_changed',{});res.status(201).json({path:relative,name});
  });
  const cadConvert = cadConvertRoutes(app, store, history, modify, events); exportRoutes(app, store, history, modify, events);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 128 * 1024 * 1024, files: 1 } });
  app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
    const id = String(req.params.id);
    await store.project(id);
    if (!req.file) throw new HttpError(400, '请选择一个文件');
    const name = path.basename(Buffer.from(req.file.originalname, 'latin1').toString('utf8')).replace(/[^\p{L}\p{N}._ -]/gu, '_');
    if (!/\.(glb|gltf|stl|obj|step|stp|scadpkg|zip|CATPart|CATProduct|py|json|png|jpg|jpeg|webp)$/i.test(name)) throw new HttpError(400, '不支持这个文件类型');
    const relative = `imports/${randomUUID()}/${name}`;
    const bytes = req.file.buffer, hash = createHash('sha256').update(bytes).digest('hex');
    let duplicate: string | undefined;
    await modify(id, async () => {
      // Same name and identical bytes under imports/*/ reuse the earlier import instead of adding a copy and two revisions.
      const imports = path.join(store.workspace(id), 'imports');
      for (const dir of await fs.readdir(imports, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
        if (!dir.isDirectory()) continue;
        const existing = path.join(imports, dir.name, name), stat = await fs.lstat(existing).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (stat?.isFile() && stat.size === bytes.length && createHash('sha256').update(await fs.readFile(existing)).digest('hex') === hash) { duplicate = `imports/${dir.name}/${name}`; return; }
      }
      const target = await safePath(store.workspace(id), relative, false);
      await history.snapshot(id, `导入前 · ${name}`, 'before-import');
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      await history.snapshot(id, `导入后 · ${name}`, 'after-import');
      await store.touch(id);
    });
    const catia = isCatiaUpload(name, bytes);
    if (duplicate) return res.json({ path: duplicate, name, duplicate: true, ...(catia && { conversion: await cadConvert.importUploaded(id, duplicate) }) });
    events.emit(id, 'artifacts_changed', {}); res.json({ path: relative, name, ...(catia && { conversion: await cadConvert.importUploaded(id, relative) }) });
  });
  app.get('/api/plugins', async (_req, res) => res.json(await plugins.list()));
  app.post('/api/plugins', async (req, res) => { await harness.invalidate(); res.status(201).json(await plugins.install(String(req.body.source || ''))); });
  app.patch('/api/plugins/:id', async (req, res) => { if (typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值'); await harness.invalidate(); res.json(await plugins.enable(req.params.id, req.body.enabled)); });
  app.delete('/api/plugins/:id', async (req, res) => { await harness.invalidate(); await plugins.remove(req.params.id); res.json({ ok: true }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as Error & { status?: number; code?: string };
    const status = error.code === 'ENOENT' ? 404 : error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 500;
    res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 128 MB' : error.message || '请求失败' });
  });
  return { optimizations, parametric, cylinderObjects, cadInspections, structural, app, store, plugins, harness, events, history, builds, thermal,thermalEditor };
}
