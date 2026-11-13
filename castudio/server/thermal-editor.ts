import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Store,HttpError,jsonRead,jsonWrite,safePath} from './storage.js';
import {Events} from './events.js';
import {runProcess} from './process.js';
import {thermalPreviewBytes} from './thermal-preview.js';
import {ThermalResource} from './thermal-resource.js';
import type {ThermalCatalog,ThermalInspection,ThermalSelectionResult,ThermalSurface} from '../shared/thermal.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
type StartInput={source?:unknown;units?:unknown;expectedHash?:unknown};
type RunInput=StartInput&{config?:unknown;inspectionId?:unknown;surfaceHash?:unknown};

/** Owns read-only geometry preparation and physics validation, never CAD mutation. */
export class ThermalEditor {
  private active=new Map<string,{record:ThermalInspection;abort:AbortController;done:Promise<void>}>();
  private helpers=new Map<string,AbortController>();
  private catalog?:{executable:string;value:Promise<ThermalCatalog>};
  constructor(private store:Store,private events:Events,private resource=new ThermalResource()){}
  private directory(project:string,id:string){
    if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'无效几何检查编号');
    return path.join(this.store.projectRoot(project),'thermal-inspections',id);
  }
  private work(id:string){return path.join(this.store.root,'thermal-inspection-work',id);}
  private async executable(){return (await jsonRead(path.join(this.store.root,'thermal-runtime.json'),{executable:process.env.STUDIO_THERMAL_PYTHON||'python'})).executable;}
  private async persist(project:string,record:ThermalInspection){
    await jsonWrite(path.join(this.directory(project,record.id),'record.json'),record);
    this.events.emit(project,'thermal_inspection_changed',{id:record.id});
  }
  async read(project:string,id:string):Promise<ThermalInspection>{
    await this.store.project(project);const directory=this.directory(project,id),active=this.active.get(project);
    if(active?.record.id===id&&active.record.state!=='running')await active.done;
    const record=active?.record.id===id?structuredClone(active.record):await jsonRead<ThermalInspection|null>(path.join(directory,'record.json'),null);
    if(!record)throw new HttpError(404,'几何检查不存在');
    if(record.state==='running')record.progress=await jsonRead(path.join(this.work(id),'output/job/status.json'),record.progress);
    try{record.stale=hash(await fs.readFile(await safePath(this.store.workspace(project),record.source)))!==record.sourceHash;}catch{record.stale=true;}
    return record;
  }
  async recover(){
    for(const project of await this.store.projects()){
      const folder=path.join(this.store.projectRoot(project.id),'thermal-inspections');
      const ids=await fs.readdir(folder).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
      for(const id of ids.filter(value=>/^[a-f0-9-]{36}$/.test(value))){
        const record=await this.read(project.id,id);
        if(record.state==='running'){record.state='interrupted';record.error='几何检查服务中断，请重新准备';record.finishedAt=new Date().toISOString();await this.persist(project.id,record);}
      }
    }
  }
  async start(project:string,input:StartInput){
    const releaseCPU=this.resource.acquire();let releaseProject:(()=>void)|undefined,dispatched=false;
    try{
      releaseProject=this.store.acquire(project);await this.store.project(project);
      if(typeof input.source!=='string'||!/\.(step|stp|stl)$/i.test(input.source))throw new HttpError(400,'请选择 STEP/STL 模型');
      if(!['mm','cm','m'].includes(String(input.units)))throw new HttpError(400,'模型单位无效');
      const source=await safePath(this.store.workspace(project),input.source),stat=await fs.stat(source);
      if(!stat.isFile()||!stat.size||stat.size>100*1024*1024)throw new HttpError(413,'模型必须为 100 MB 以内的非空文件');
      const bytes=await fs.readFile(source),sourceHash=hash(bytes);
      if(input.expectedHash&&input.expectedHash!==sourceHash)throw new HttpError(409,'模型已变化，请重新选择');
      const record:ThermalInspection={id:randomUUID(),source:input.source,sourceHash,units:input.units as ThermalInspection['units'],state:'running',createdAt:new Date().toISOString(),log:''};
      const work=this.work(record.id);await fs.mkdir(work,{recursive:true});
      const frozen=path.join(work,'source'+path.extname(source));await fs.writeFile(frozen,bytes);await this.persist(project,record);
      const abort=new AbortController(),executable=await this.executable();
      const done=Promise.resolve().then(async()=>{
        try{
          const output=path.join(work,'output');
          const result=await runProcess(executable,['-I','-X','utf8','-u','-m','thermal_sim','inspect',frozen,'--units',record.units,'--output',output],
            {cwd:work,signal:abort.signal,timeout:5*60*1000,output:text=>{record.log=(record.log+text).slice(-64000);}});
          if(abort.signal.aborted)throw new Error('几何检查已取消');
          if(result.timedOut||result.code!==0)throw new Error('热模型准备失败，请查看几何检查日志');
          const surfacePath=await safePath(output,'selection-surface.json'),stat=await fs.stat(surfacePath);
          if(!stat.isFile()||stat.size>128*1024*1024)throw new Error('热表面超过显示上限');
          const data=await fs.readFile(surfacePath),surface=JSON.parse(data.toString('utf8')) as ThermalSurface;
          if(surface.source_sha256!==record.sourceHash||!/^[a-f0-9]{64}$/.test(surface.surface_sha256)||!surface.faces.length||surface.faces.length%3||surface.points.length%3)throw new Error('热表面协议或模型摘要不一致');
          record.fileHash=hash(data);record.surfaceHash=surface.surface_sha256;record.state='succeeded';
        }catch(error){record.state=abort.signal.aborted?'cancelled':'failed';record.error=(error as Error).message;}
        finally{record.finishedAt=new Date().toISOString();try{await this.persist(project,record);}finally{releaseProject?.();releaseCPU();}}
      }).finally(()=>{this.active.delete(project);});
      this.active.set(project,{record,abort,done});dispatched=true;void done.catch(error=>console.error('保存几何检查失败',error));
      return structuredClone(record);
    }finally{if(!dispatched){releaseProject?.();releaseCPU();}}
  }
  async cancel(project:string,id:string){
    await this.read(project,id);const active=this.active.get(project);
    if(active?.record.id===id){active.abort.abort();await active.done;}
    return this.read(project,id);
  }
  async surface(project:string,id:string){
    const record=await this.read(project,id);
    if(record.state!=='succeeded'||!record.fileHash)throw new HttpError(409,'热模型尚未准备完成');
    return thermalPreviewBytes(path.join(this.work(id),'output'),'selection-surface.json',record.fileHash);
  }
  private async call(executable:string,args:string[],cwd:string,signal?:AbortSignal){
    let log='';let tooLarge=false;
    const result=await runProcess(executable,['-I','-X','utf8','-u','-m','thermal_sim.editor',...args],
      {cwd,signal,timeout:60000,output:text=>{log+=text;if(log.length>32*1024*1024){tooLarge=true;log=log.slice(-10000);}}});
    if(signal?.aborted)throw new HttpError(409,'热工况操作已取消');
    if(result.timedOut)throw new HttpError(422,'热工况操作超时，请重试');
    const line=log.split(/\r?\n/).find(row=>row.startsWith('THERMAL_RESULT='));
    if(result.code!==0||!line||tooLarge){
      const detail=log.split(/\r?\n/).filter(row=>/^ValueError:/.test(row)).at(-1);
      throw new HttpError(422,detail?.replace(/^ValueError:\s*/,'')||log.slice(-1800)||'热工况校验失败');
    }
    return JSON.parse(line.slice(15)) as unknown;
  }
  async schema():Promise<ThermalCatalog>{
    const executable=await this.executable();
    if(this.catalog?.executable!==executable){
      const value=this.call(executable,['schema'],os.tmpdir()).then(value=>value as ThermalCatalog);
      this.catalog={executable,value};void value.catch(()=>{if(this.catalog?.value===value)this.catalog=undefined;});
    }
    return this.catalog!.value;
  }
  private async action(project:string,id:string,action:'resolve'|'validate',input:unknown,signal?:AbortSignal){
    const record=await this.read(project,id);
    if(record.stale)throw new HttpError(409,'模型已变化，请重新准备热模型并确认选区');
    await this.surface(project,id);
    const previous=this.helpers.get(project);previous?.abort();
    const abort=new AbortController();this.helpers.set(project,abort);
    const stop=()=>abort.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const work=this.work(id),request=path.join(work,`editor-${randomUUID()}.json`);
    try{
      if(JSON.stringify(input).length>400000)throw new HttpError(413,'热工况过大');
      await jsonWrite(request,input);
      return await this.call(await this.executable(),[action,'--surface',path.join(work,'output/selection-surface.json'),'--request',request],work,abort.signal);
    }finally{
      signal?.removeEventListener('abort',stop);if(this.helpers.get(project)===abort)this.helpers.delete(project);
      await fs.unlink(request).catch(()=>{});
    }
  }
  async resolve(project:string,id:string,input:unknown,surfaceHash:unknown,signal?:AbortSignal):Promise<ThermalSelectionResult>{
    const record=await this.read(project,id);
    if(surfaceHash!==record.surfaceHash)throw new HttpError(409,'热表面已变化，请重新确认选区');
    return this.action(project,id,'resolve',input,signal) as Promise<ThermalSelectionResult>;
  }
  async validate(project:string,id:string,input:unknown,signal?:AbortSignal){return this.action(project,id,'validate',input,signal);}
  async prepareRun(project:string,input:RunInput){
    if(input.inspectionId===undefined)return input;
    if(typeof input.inspectionId!=='string')throw new HttpError(400,'几何检查编号无效');
    const record=await this.read(project,input.inspectionId);
    if(record.source!==input.source||record.units!==input.units||record.surfaceHash!==input.surfaceHash)throw new HttpError(409,'模型或单位已变化，请重新确认选区');
    await this.validate(project,record.id,input.config);
    return {...input,expectedHash:record.sourceHash,surfaceHash:record.surfaceHash};
  }
  async dispose(){
    for(const value of this.active.values())value.abort.abort();for(const abort of this.helpers.values())abort.abort();
    await Promise.allSettled([...this.active.values()].map(value=>value.done));
  }
}
