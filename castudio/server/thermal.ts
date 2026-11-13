import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { Events } from './events.js';
import { runProcess } from './process.js';
import {readThermalPreview,thermalPreviewBytes} from './thermal-preview.js';
import {ThermalResource} from './thermal-resource.js';
import type { ThermalConfig, ThermalRun, ThermalManifest, ThermalProbe } from '../shared/thermal.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Host adapter only. All geometry, meshing, material validation and FEM live in
// the separately installed thermal-sim distribution and its versioned CLI.
export class Thermal {
  private active = new Map<string, { run: ThermalRun; abort: AbortController; done: Promise<void> }>();
  private pending = 0;
  constructor(private store: Store, private history: History, private events: Events,private resource=new ThermalResource()) {}
  async config() {
    const config = await jsonRead<{executable:string; device?:string}>(path.join(this.store.root, 'thermal-runtime.json'), { executable: process.env.STUDIO_THERMAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') });
    const device = config.device ?? 'cpu';
    if (device !== 'cpu' && device !== 'cuda') throw new HttpError(400, '热仿真设备必须为 cpu 或 cuda');
    return {...config, device};
  }
  async probe(value?: unknown): Promise<ThermalProbe> {
    const config = await this.config();
    const executable = value ?? config.executable;
    if (typeof executable !== 'string' || executable.length > 2048 || /[\0\r\n]/.test(executable) || (!path.isAbsolute(executable) && !['python','python3'].includes(executable))) throw new HttpError(400, '请填写 Python 解释器绝对路径');
    let log = '';
    try {
      const result = await runProcess(executable, ['-I','-X','utf8','-m','thermal_sim','doctor','--device',config.device], { cwd: os.tmpdir(), timeout: 60000, output: s => { log = (log + s).slice(-16000); } });
      const line = log.split(/\r?\n/).find(l => l.startsWith('THERMAL_RESULT='));
      const body = line ? JSON.parse(line.slice(15)) : null;
      if (result.code !== 0 || result.timedOut || body?.schema_version !== 1 || body?.ok !== true) throw new Error(log || '检测超时或缺少 thermal-sim');
      if (body.compute?.device !== config.device) throw new Error('热仿真实际设备与配置不一致');
      return { ok: true, executable, version: body.version, message: body.compute.device === 'cuda' ? `热仿真 GPU 可用：${body.compute.name}` : '热仿真包与 CPU 依赖可用' };
    } catch (e) { return { ok: false, executable, message: (e as Error).message.slice(-3000) }; }
  }
  async saveRuntime(value: unknown) { const probe = await this.probe(value); if (!probe.ok) throw new HttpError(422, probe.message); await jsonWrite(path.join(this.store.root, 'thermal-runtime.json'), { ...await this.config(), executable: probe.executable }); return probe; }
  private directory(project: string, run?: string) {
    if (run !== undefined && !/^[a-f0-9-]{36}$/.test(run)) throw new HttpError(400, '无效仿真编号');
    return path.join(this.store.projectRoot(project), 'thermal', run || '');
  }
  private work(project: string, run: string) { this.directory(project,run); return path.join(this.store.root, 'thermal-work',run); }
  private async persist(project: string, run: ThermalRun) { await jsonWrite(path.join(this.directory(project,run.id),'run.json'), run); this.events.emit(project,'thermal_changed',{ id: run.id }); }
  async list(project: string) {
    await this.store.project(project);
    const ids = await fs.readdir(this.directory(project)).catch(e => { if(e.code==='ENOENT') return []; throw e; });
    return (await Promise.all(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.read(project,id)))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async read(project: string, id: string): Promise<ThermalRun> {
    await this.store.project(project); this.directory(project,id);
    const active = this.active.get(project);
    if (active?.run.id === id && !['running','queued'].includes(active.run.state)) await active.done;
    const run = active?.run.id === id ? structuredClone(active.run) : await jsonRead<ThermalRun | null>(path.join(this.directory(project,id),'run.json'),null);
    if (!run) throw new HttpError(404,'仿真不存在');
    if (run.state === 'running') run.progress = await jsonRead(path.join(this.work(project,id),'output/job/status.json'), run.progress);
    if(run.state!=='succeeded'){
      try{run.preview=await readThermalPreview(path.join(this.work(project,id),'output/preview'),run.sourceHash);}
      catch(error){run.previewError=(error as Error).message;}
    }
    try { const file=await safePath(this.store.workspace(project),run.source); run.stale=hash(await fs.readFile(file))!==run.sourceHash; } catch { run.stale=true; }
    return run;
  }
  async recover() { for(const project of await this.store.projects()) for(const run of await this.list(project.id)) if(['running','queued'].includes(run.state)) { run.state='interrupted';run.error='服务中断，请重新运行';run.finishedAt=new Date().toISOString(); await this.persist(project.id,run); } }
  /** Queue waits for an editing owner; direct submission acquires the project immediately. */
  async start(project: string, input: { source?: unknown; units?: unknown; config?: unknown; expectedHash?: unknown; surfaceHash?:unknown }, queue=false) {
    if(this.active.size + this.pending >= 1) throw new HttpError(409,'已有热仿真正在运行，请等待或取消');
    const releaseCPU=this.resource.acquire();let release:(()=>void)|undefined;let dispatched=false;this.pending++;
    try {
      release=queue?undefined:this.store.acquire(project);
      await this.store.project(project);
      if(typeof input.source!=='string' || !/\.(step|stp|stl)$/i.test(input.source)) throw new HttpError(400,'请选择项目中的 STEP/STL 实体');
      if(!['mm','cm','m'].includes(String(input.units))) throw new HttpError(400,'请选择模型单位');
      if(!input.config || typeof input.config!=='object' || Array.isArray(input.config) || JSON.stringify(input.config).length>400000) throw new HttpError(400,'无效仿真工况');
      const file=await safePath(this.store.workspace(project),input.source), stat=await fs.stat(file);
      if(!stat.isFile() || stat.size>100*1024*1024 || !stat.size) throw new HttpError(413,'模型必须为 100 MB 以内的非空文件');
      const bytes=await fs.readFile(file), sourceHash=hash(bytes);
      if(input.expectedHash && input.expectedHash!==sourceHash) throw new HttpError(409,'模型已变化，请重新选择');
      if(input.surfaceHash!==undefined&&(typeof input.surfaceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.surfaceHash)))throw new HttpError(400,'热表面摘要无效');
      const {executable,device}=await this.config();
      const run: ThermalRun={id:randomUUID(),source:input.source,sourceHash,units:input.units as ThermalRun['units'],config:structuredClone(input.config) as ThermalConfig,executable,createdAt:new Date().toISOString(),state:queue?'queued':'running',log:'',files:[],
        progress:queue?{phase:'queued',progress:0,detail:'等待设计编辑结束后开始计算'}:undefined,surfaceHash:input.surfaceHash as string|undefined};
      const work=this.work(project,run.id);await fs.mkdir(work,{recursive:true});
      const source=path.join(work,'source'+path.extname(input.source));await fs.writeFile(source,bytes);
      await jsonWrite(path.join(work,'request.json'),{schema_version:1,geometry:{path:source,units:run.units,sha256:sourceHash,...(run.surfaceHash?{surface_sha256:run.surfaceHash}:{})},simulation:run.config,device});
      await this.persist(project,run);
      const abort=new AbortController();
      const done=Promise.resolve().then(()=>this.execute(project,run,abort.signal,release)).finally(()=>{this.active.delete(project);releaseCPU();});
      this.active.set(project,{run,abort,done});dispatched=true;
      void done.catch(e=>console.error('保存仿真记录失败',e));return structuredClone(run);
    } finally { this.pending--; if(!dispatched){release?.();releaseCPU();} }
  }
  private async execute(project: string, run: ThermalRun, signal: AbortSignal,initialRelease:(()=>void)|undefined) {
    let release=initialRelease;
    try {
      while(!release){
        signal.throwIfAborted();
        try{release=this.store.acquire(project);}
        catch(error){
          if(!(error instanceof HttpError)||error.status!==409)throw error;
          await delay(200,undefined,{signal});
        }
      }
      await this.history.recover(project);
      const source=await safePath(this.store.workspace(project),run.source);
      if(hash(await fs.readFile(source))!==run.sourceHash)throw new Error('排队后模型已变化，请重新选择模型并运行');
      signal.throwIfAborted();
      run.revision=(await this.history.snapshot(project,`热仿真 ${run.source} 前`)).id;
      run.state='running';run.progress={phase:'running',progress:0,detail:'正在启动热求解器'};await this.persist(project,run);
      const work=this.work(project,run.id), output=path.join(work,'output');
      const result=await runProcess(run.executable,['-I','-X','utf8','-u','-m','thermal_sim','run',path.join(work,'request.json'),'--output',output],{cwd:work,signal,timeout:30*60*1000,output:text=>{run.log=(run.log+text).slice(-128000);}});
      if(signal.aborted) throw new Error('仿真已取消');
      if(result.timedOut) throw new Error('仿真超过 30 分钟，已停止');
      if(result.code!==0) throw new Error(`热仿真退出码 ${result.code}，请查看日志`);
      const manifest=await jsonRead<ThermalManifest|null>(path.join(output,'manifest.json'),null);
      if(manifest?.schema_version!==1 || manifest.source_sha256!==run.sourceHash || !Number.isFinite(manifest.result?.maximum_C)) throw new Error('仿真结果协议或模型摘要不匹配');
      let total=0;
      const scan=async(dir:string,depth=0)=>{if(depth>10)throw new Error('结果目录过深');for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(depth===0&&entry.name==='preview')continue;
        const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('结果含符号链接');if(entry.isDirectory()){await scan(file,depth+1);continue;}if(!entry.isFile())throw new Error('结果不是普通文件');
        const stat=await fs.stat(file);total+=stat.size;if(stat.size>128*1024*1024||total>512*1024*1024||run.files.length>=2000)throw new Error('结果超过保存上限，请降低网格或帧数');
        run.files.push({path:path.relative(output,file).split(path.sep).join('/'),size:stat.size,hash:hash(await fs.readFile(file))});
      }};await scan(output);run.result=manifest;run.state='succeeded';
    } catch(e){run.state=signal.aborted?'cancelled':'failed';run.error=(e as Error).message;run.files=[];delete run.result;}
    finally{run.finishedAt=new Date().toISOString();try{await this.persist(project,run);}finally{release?.();}}
  }
  async cancel(project:string,id:string){await this.read(project,id);const active=this.active.get(project);if(active?.run.id===id){active.abort.abort();await active.done;}return this.read(project,id);}
  async file(project:string,id:string,relative:string){
    const run=await this.read(project,id),item=run.files.find(f=>f.path===relative);
    if(run.state!=='succeeded'||!item)throw new HttpError(404,'没有可用结果文件');
    const file=await safePath(path.join(this.work(project,id),'output'),relative),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size!==item.size)throw new HttpError(409,'结果文件已变化');
    const bytes=await fs.readFile(file);if(hash(bytes)!==item.hash)throw new HttpError(409,'结果文件摘要已变化');return bytes;
  }
  /** Geometry keeps the same URL while a task transitions from preview to final results. */
  async geometry(project:string,id:string){
    const run=await this.read(project,id);
    if(run.state==='succeeded')return this.file(project,id,'model/display.json');
    if(!run.preview)throw new HttpError(404,'尚未生成实时温度场');
    return thermalPreviewBytes(path.join(this.work(project,id),'output/preview'),'surface.json',run.preview.geometry_sha256);
  }
  /** Read exactly one committed unfinished frame; no incomplete data is exposed as a final result. */
  async previewFrame(project:string,id:string,index:number){
    const run=await this.read(project,id);
    const frame=run.preview?.frames[index];
    if(!Number.isSafeInteger(index)||index<0||!frame)throw new HttpError(404,'实时温度帧不存在');
    return thermalPreviewBytes(path.join(this.work(project,id),'output/preview'),`frames/${String(index).padStart(6,'0')}.bin`,frame.sha256,run.preview!.vertices*4);
  }
  async publish(project:string,id:string){
    const release=this.store.acquire(project);
    try{
      await this.history.recover(project);const run=await this.read(project,id);
      if(run.state!=='succeeded')throw new HttpError(409,'只能保存已完成仿真');
      if(run.publishedRevision)return {path:run.published!};
      const prefix=`simulations/${id}`,target=await safePath(this.store.workspace(project),prefix,false);
      if(!run.published){
        try{await fs.access(target);throw new HttpError(409,'保存目录已存在');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        const staging=path.join(this.directory(project,id),'publish');await fs.mkdir(staging,{recursive:true});
        for(const item of run.files){const bytes=await this.file(project,id,item.path),file=await safePath(staging,item.path,false);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
        await jsonWrite(path.join(staging,'studio-simulation.json'),{id,source:run.source,sourceHash:run.sourceHash,revision:run.revision,config:run.config,engine:run.result?.engine_version});
        await this.history.snapshot(project,'保存仿真结果前');await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(staging,target);run.published=prefix;await this.persist(project,run);
      }
      await this.store.touch(project);run.publishedRevision=(await this.history.snapshot(project,'热仿真结果与建模来源')).id;await this.persist(project,run);this.events.emit(project,'artifacts_changed',{});return {path:prefix};
    }finally{release();}
  }
  async dispose(){for(const item of this.active.values())item.abort.abort();await Promise.allSettled([...this.active.values()].map(a=>a.done));}
}
