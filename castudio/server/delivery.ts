import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {Express} from 'express';
import {Store,HttpError,safePath,jsonRead,jsonWrite} from './storage.js';
import type {Optimizations} from './optimization.js';
import type {History} from './history.js';
import type {Builds} from './builds.js';
import type {Thermal} from './thermal.js';
import type {OptimizationTask} from '../shared/optimization.js';
import type {DeliveryRecord,DeliverySelection} from '../shared/delivery.js';
import {deliveryReport,type DeliveryRun} from './delivery-report.js';
import {runProcess} from './process.js';

const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const completed=new Set(['completed','no_improvement','unverified','failed','cancelled','interrupted']);
const packager=fileURLToPath(new URL('../resources/delivery/package.py',import.meta.url));
async function fileDigest(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

/** Resolve the recommended final design without promoting unverified improvements.
 * @param task - Durable task facts.
 * @returns The verified candidate, or baseline when no verified improvement exists.
 */
export function selectDelivery(task:OptimizationTask):DeliverySelection{
  if(!completed.has(task.phase))throw new HttpError(409,'请等待优化结束或停止后再导出完整交付包');
  if(task.phase==='completed'){
    const best=task.candidates.find(c=>c.id===task.bestCandidateId);
    if(!best||best.state!=='valid'||!best.buildId||!best.runId||!best.verificationRunId||!task.baseline.verificationRunId||!task.verification||task.verification.improvementC<task.policy.significantImprovementC)throw new HttpError(409,'已完成任务缺少有效成对复核证据，拒绝导出为最终方案');
    return {kind:'verified_candidate',candidateId:best.id,sourceHash:'',runId:best.verificationRunId};
  }
  return {kind:'baseline',sourceHash:task.baseline.sourceHash,runId:task.baseline.verificationRunId||task.baseline.runId};
}

/** Immutable, hash-checked delivery exports; no model workspace directory is copied wholesale. */
export class Deliveries{
  private pending=new Map<string,Promise<DeliveryRecord>>();
  constructor(private store:Store,private optimizations:Pick<Optimizations,'deliverySnapshot'>,private history:Pick<History,'file'>,private builds:Pick<Builds,'read'|'file'>,private thermal:Pick<Thermal,'config'|'read'|'file'>){}
  private root(task:string,id:string){if(!/^[a-f0-9-]{36}$/.test(task)||!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'交付编号无效');return path.join(this.store.root,'deliveries',task,id);}
  /** Prepare a complete export and coalesce simultaneous button presses for one task.
   * @param project - Authorized source or optimization project.
   * @param task - Task identifier.
   * @returns Durable export metadata after the archive and all files are complete.
   */
  async create(project:string,task:string):Promise<DeliveryRecord>{
    await this.store.project(project);
    // Validate project membership even when an export for the same task is already in flight.
    const snapshot=await this.optimizations.deliverySnapshot(project,task);selectDelivery(snapshot);
    const key=task+':'+snapshot.revision,existing=this.pending.get(key);if(existing)return existing;
    const work=this.prepare(project,snapshot).finally(()=>{this.pending.delete(key);});this.pending.set(key,work);return work;
  }
  private async prepare(project:string,task:OptimizationTask):Promise<DeliveryRecord>{
    const id=randomUUID(),target=this.root(task.id,id),staging=target+'.tmp',bundle=path.join(staging,'bundle');
    await fs.mkdir(bundle,{recursive:true});
    const files:DeliveryRecord['files']=[],seen=new Set<string>();let total=0;
    const put=async(relative:string,value:Buffer|string)=>{
      if(seen.has(relative))throw new HttpError(409,'交付文件路径重复：'+relative);
      const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);total+=bytes.length;
      if(total>2*1024**3||files.length>=10000)throw new HttpError(413,'交付包超过 2 GB 或 10000 个文件限制');
      const file=await safePath(bundle,relative,false);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);seen.add(relative);files.push({path:relative,size:bytes.length,sha256:digest(bytes)});
    };
    const json=(relative:string,value:unknown)=>put(relative,JSON.stringify(value,null,2)+'\n');
    try{
      const selected=selectDelivery(task),runs:DeliveryRun[]=[],designs=new Map<string,{code:Buffer;step:Buffer;buildId:string;sourceHash:string}>();
      const design=async(ownerProject:string,buildId:string,code:string,codeHash:string,stepHash:string|undefined,directory:string)=>{
        const build=await this.builds.read(ownerProject,buildId);
        if(build.state!=='succeeded'||!build.revision||build.sourceHash!==codeHash)throw new HttpError(409,'构建源码与优化记录摘要不一致');
        const source=await this.history.file(ownerProject,build.revision,build.source);
        if(digest(source)!==codeHash||digest(code)!==codeHash)throw new HttpError(409,'历史源码摘要不一致');
        const artifact=build.artifacts.find(a=>/\.(step|stp)$/i.test(a.path)&&(!stepHash||a.hash===stepHash));
        if(!artifact)throw new HttpError(409,'构建缺少与仿真对应的 STEP');
        const geometry=await this.builds.file(ownerProject,buildId,artifact.path);
        if(digest(geometry)!==artifact.hash||(stepHash&&digest(geometry)!==stepHash))throw new HttpError(409,'构建模型摘要不一致');
        await put(directory+'/design.py',source);await put(directory+'/model.step',geometry);
        const {executable,log,...record}=build;await json(directory+'/build.json',record);await put(directory+'/build.log',log);
        if(build.parameters)await json(directory+'/parameters.json',build.parameters);
        const result={code:source,step:geometry,buildId,sourceHash:artifact.hash};designs.set(directory,result);return result;
      };
      const baseline=await design(task.sourceProjectId,task.baseline.buildId,task.baseline.code,digest(task.baseline.code),task.baseline.sourceHash,'baseline');
      await json('baseline/thermal-config.json',task.baseline.config);await json('baseline/geometry.json',task.baseline.geometry);await json('baseline/thermal-surface.json',task.baseline.surface);
      const addRun=async(ownerProject:string,runId:string,label:string,directory:string,expectedHash:string,required=true)=>{
        const run=await this.thermal.read(ownerProject,runId);
        if(run.sourceHash!==expectedHash||run.result&&run.result.source_sha256!==expectedHash)throw new HttpError(409,'仿真模型摘要与设计不一致');
        if(required&&run.state!=='succeeded')throw new HttpError(409,'推荐或有效候选仿真尚未完整成功');
        const {executable,...record}=run;await json(directory+'/run.json',record);runs.push({label,directory,run});
        if(run.state==='succeeded'){
          const sources=run.files.filter(file=>/^model\/source\.(step|stp)$/i.test(file.path));
          if(sources.length!==1)throw new HttpError(409,'成功结果缺少唯一的冻结 STEP 模型');
          for(const requiredFile of ['job/temperatures.npy','job/report.pdf','job/report.md','job/history.csv','job/config.json'])if(!run.files.some(f=>f.path===requiredFile))throw new HttpError(409,'成功结果缺少交付文件：'+requiredFile);
          for(const item of run.files){
            const bytes=await this.thermal.file(ownerProject,runId,item.path);
            if(bytes.length!==item.size||digest(bytes)!==item.hash)throw new HttpError(409,'仿真结果文件摘要不一致：'+item.path);
            if(item.path===sources[0].path&&digest(bytes)!==expectedHash)throw new HttpError(409,'仿真输入模型摘要不一致');
            await put(directory+'/'+item.path,bytes);
          }
        }
        return run;
      };
      await addRun(task.sourceProjectId,task.baseline.runId,'基准 · 原网格','simulations/baseline',baseline.sourceHash);
      for(const candidate of task.candidates){
        const directory='candidates/attempt-'+candidate.attempt;
        const {token,...record}=candidate;await json(directory+'/candidate.json',record);
        if(candidate.code)await put(directory+'/proposal.py',candidate.code);
        let model:typeof baseline|undefined;
        if(candidate.buildId){
          const build=await this.builds.read(task.projectId,candidate.buildId);
          if(build.state==='succeeded'&&build.artifacts.some(a=>/\.(step|stp)$/i.test(a.path)))model=await design(task.projectId,candidate.buildId,candidate.code||'',candidate.sourceHash||'',undefined,directory);
          else {const {executable,log,...record}=build;await json(directory+'/build.json',record);await put(directory+'/build.log',log);}
        }
        if(candidate.state==='valid'&&(!model||!candidate.runId))throw new HttpError(409,'有效候选缺少构建或求解证据');
        if(candidate.runId){if(!model)throw new HttpError(409,'候选求解缺少对应设计');await addRun(task.projectId,candidate.runId,`候选 ${candidate.attempt} · 原网格`,'simulations/candidate-'+candidate.attempt,model.sourceHash,candidate.state==='valid');}
      }
      if(task.baseline.verificationRunId){const run=await this.thermal.read(task.projectId,task.baseline.verificationRunId);await addRun(task.projectId,run.id,'基准 · 加密复核','simulations/verification-baseline',baseline.sourceHash,task.phase==='completed');if(selected.kind==='baseline'&&run.state!=='succeeded')selected.runId=task.baseline.runId;}
      for(const c of task.candidates){
        const model=designs.get('candidates/attempt-'+c.attempt);
        if(c.verificationRunId&&model)await addRun(task.projectId,c.verificationRunId,`候选 ${c.attempt} · 加密复核`,'simulations/verification-candidate-'+c.attempt,model.sourceHash,selected.candidateId===c.id);
        for(const [index,runId] of (c.verificationRunIds||[]).entries())if(model&&runId!==c.verificationRunId)await addRun(task.projectId,runId,`候选 ${c.attempt} · 复核历史 ${index+1}`,`simulations/verification-candidate-${c.attempt}-history-${index+1}`,model.sourceHash,false);
      }
      for(const [index,runId] of (task.baseline.verificationRunIds||[]).entries())if(runId!==task.baseline.verificationRunId)await addRun(task.projectId,runId,`基准 · 复核历史 ${index+1}`,`simulations/verification-baseline-history-${index+1}`,baseline.sourceHash,false);
      const chosen=task.candidates.find(c=>c.id===selected.candidateId),final=chosen?designs.get('candidates/attempt-'+chosen.attempt)!:baseline;
      selected.sourceHash=final.sourceHash;
      await put('final/design.py',final.code);await put('final/model.step',final.step);
      const finalRun=runs.find(r=>r.run.id===selected.runId);if(!finalRun||finalRun.run.state!=='succeeded')throw new HttpError(409,'最终推荐方案缺少完整仿真结果');
      await json('final/design.json',{...selected,buildId:final.buildId,units:task.baseline.units,simulationDirectory:finalRun.directory,taskId:task.id,taskRevision:task.revision});
      await json('final/thermal-config.json',finalRun.run.config);
      const {workspacePath,claim,...safeTask}=task;
      await json('task.json',{...safeTask,candidates:task.candidates.map(({token,...c})=>c)});
      const report=deliveryReport(task,selected,runs);await put('reports/overview.html',report.html);await put('reports/overview.md',report.markdown);await put('reports/comparison.csv','\ufeff'+report.csv);
      await put('README.txt',`CoServe 设计-仿真-反馈优化交付包\n\n首先打开 reports/overview.html 查看完整离线报告。\nfinal/ 是本次推荐设计：${selected.kind==='verified_candidate'?'已通过成对加密复核的候选':'基准；没有可作为最终方案交付的已验证改善'}。\n设计文件：final/design.py（可编辑 Gmsh Python 源码）、final/model.step（CAD 实体）。\n仿真文件：${finalRun.directory}/，包括 PDF、温度历程、网格、温度场、输入配置和实际设备记录。\n所有基准、候选、失败原因及复核计算保留在 baseline/、candidates/、simulations/ 和 task.json。\nmanifest.json 记录任务版本和文件 SHA-256；SHA256SUMS.txt 用于独立校验。\n\n继续设计：在新目录用已配置的 Gmsh Python 运行 design.py 重新导出 STEP（输出文件名以源码为准）；源码使用 mm，热模型使用 SI。重新导入并解析热边界后再求解，不能复用旧面编号。\n源码中的参数可以修改；不包含专有 CAD 特征树和生产公差图纸。制造性、网格收敛和真实换热边界仍需工程确认。\n未验证候选不是推荐的最终方案。\n`);
      await json('manifest.json',{schemaVersion:1,taskId:task.id,taskRevision:task.revision,phase:task.phase,selected,files:[...files]});
      await put('SHA256SUMS.txt',files.map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n');
      const runtime=await this.thermal.config();let output='';
      const result=await runProcess(runtime.executable,['-I','-X','utf8',packager,bundle,path.join(staging,'archive.zip')],{cwd:path.dirname(packager),timeout:300000,output:s=>{output=(output+s).slice(-4000);}});
      if(result.code!==0||result.timedOut)throw new HttpError(500,'交付包压缩失败：'+output);
      const latest=await this.optimizations.deliverySnapshot(project,task.id);
      if(latest.revision!==task.revision||latest.phase!==task.phase)throw new HttpError(409,'导出期间任务状态已变化，请等待结束后重试');
      const archiveFile=path.join(staging,'archive.zip'),stat=await fs.stat(archiveFile);
      const record:DeliveryRecord={schemaVersion:1,id,taskId:task.id,taskRevision:task.revision,phase:task.phase,createdAt:new Date().toISOString(),selected,archive:{size:stat.size,sha256:await fileDigest(archiveFile)},files};
      await jsonWrite(path.join(staging,'record.json'),record);await fs.rename(staging,target);return record;
    }catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
  }
  /** Read an immutable export record after checking task membership. */
  async read(project:string,task:string,id:string){await this.optimizations.deliverySnapshot(project,task,false);const record=await jsonRead<DeliveryRecord|null>(path.join(this.root(task,id),'record.json'),null);if(!record)throw new HttpError(404,'交付包不存在或尚未完成');return record;}
  /** List completed, immutable deliveries; staging directories are never downloadable. */
  async list(project:string,task:string){
    await this.optimizations.deliverySnapshot(project,task,false);
    const directory=path.dirname(this.root(task,randomUUID()));
    const ids=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    const records=await Promise.all(ids.filter(id=>/^[a-f0-9-]{36}$/.test(id)).map(id=>this.read(project,task,id)));
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  /** Resolve and rehash one published download; rejects traversal and altered files. */
  async file(project:string,task:string,id:string,relative:string){
    const record=await this.read(project,task,id),entry=relative==='archive.zip'?record.archive:record.files.find(f=>f.path===relative);
    if(!entry)throw new HttpError(404,'交付文件不存在');
    const file=await safePath(this.root(task,id),relative==='archive.zip'?relative:'bundle/'+relative),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size!==entry.size||await fileDigest(file)!==entry.sha256)throw new HttpError(409,'交付文件摘要已变化，请重新导出');
    return {path:file,size:stat.size};
  }
}

/** Local-only export preparation, offline report viewing, and attachment downloads. */
export function deliveryRoutes(app:Express,service:Deliveries){
  const base='/api/projects/:project/optimizations/:task/deliveries';
  app.post(base,async(req,res)=>res.status(201).json(await service.create(String(req.params.project),String(req.params.task))));
  app.get(base,async(req,res)=>res.json(await service.list(String(req.params.project),String(req.params.task))));
  app.get(base+'/:delivery',async(req,res)=>res.json(await service.read(String(req.params.project),String(req.params.task),String(req.params.delivery))));
  app.get(base+'/:delivery/view/{*file}',async(req,res)=>{
    const relative=Array.isArray(req.params.file)?req.params.file.join('/'):String(req.params.file||'reports/overview.html');
    const file=await service.file(String(req.params.project),String(req.params.task),String(req.params.delivery),relative);
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
    res.setHeader('X-Content-Type-Options','nosniff');res.sendFile(file.path);
  });
  app.get(base+'/:delivery/file',async(req,res)=>{
    const relative=typeof req.query.path==='string'?req.query.path:'archive.zip';
    const file=await service.file(String(req.params.project),String(req.params.task),String(req.params.delivery),relative);
    if(relative.endsWith('.html')){res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");res.type('html');}
    res.download(file.path,relative==='archive.zip'?`CoServe-design-simulation-${req.params.task}.zip`:path.basename(relative));
  });
}
