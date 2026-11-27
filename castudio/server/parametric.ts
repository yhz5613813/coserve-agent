import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { Express } from 'express';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { runProcess } from './process.js';

const resource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/parametric');
const delay = (n:number) => new Promise(ok=>setTimeout(ok,n));
async function pythonSources(root:string,relative=''):Promise<string[]>{
  const result:string[]=[];
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isDirectory()&&!['exports','__marimo__','__pycache__','.sca-editor'].includes(entry.name))result.push(...await pythonSources(root,name));
    else if(entry.isFile()&&entry.name.endsWith('.py'))result.push(name);
  }
  return result.sort();
}
type Worker = { port:number; abort:AbortController; done:Promise<unknown>; log:string; ended:boolean; ready:boolean };
// `record` is the build record the bridge writes next to the STEP; only the cylinder carries shell-model boundaries.
// Every other template is built by bridge.py's generic solid path: the notebook's `body` becomes `<template>.step` with `<template>.build.json`.
const templates:Record<string,{entry:string;files:string[];record:string;created:string;published:string}>={
  cylinder:{entry:'cylinder.py',files:['cylinder.py','parametric_common.py'],record:'cylinder.bindings.json',created:'创建参数化圆柱与语义边界',published:'发布参数化 CAD 与仿真边界'},
  plate:{entry:'plate.py',files:['plate.py'],record:'plate.build.json',created:'创建参数化平板',published:'发布参数化 CAD'},
  blank:{entry:'blank.py',files:['blank.py'],record:'blank.build.json',created:'创建空白参数化程序',published:'发布参数化 CAD'},
};
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** `finished(id, open)` runs after a publish of project `id` has recorded its final job state; `open` is the published preview on success. */
export function parametricRoutes(app:Express, store:Store, history:History, finished:(id:string,open?:string)=>void=()=>{}) {
  const workers=new Map<string,Worker>(), starting=new Map<string,Promise<Worker>>();
  const builds=new Map<string,AbortController>();
  const jobStates=new Map<string,any>();
  const workspace=(id:string)=>path.join(store.workspace(id),'parametric');
  // parametric/program.json records which template created the program; projects without it predate templates and are cylinders.
  async function program(id:string){
    const record=await jsonRead<any>(path.join(workspace(id),'program.json'),null);
    if(record){
      if(!Object.hasOwn(templates,record.template)||!/^[\w-]+\.py$/.test(record.entry))throw new HttpError(422,'参数化程序记录无效：parametric/program.json');
      return {template:String(record.template),entry:String(record.entry)};
    }
    return await fs.access(path.join(workspace(id),'cylinder.py')).then(()=>({template:'cylinder',entry:'cylinder.py'}),()=>null);
  }
  const config=()=>jsonRead<any>(path.join(store.root,'parametric-runtime.json'),null);
  const endpoint=(id:string)=>`/api/projects/${id}/parametric`;
  // Document-relative, served by parametric-proxy.ts on the CAStudio origin under any gateway prefix.
  const editorUrl=(id:string)=>`pm/${encodeURIComponent(id)}/`;
  async function stop(id:string) {
    workers.get(id)?.abort.abort();
    const pending=starting.get(id);if(pending)await pending.catch(()=>{});
    const worker=workers.get(id);if(worker){worker.abort.abort();await worker.done;workers.delete(id);}
  }
  // The editor page serves before its marimo kernel boots: kernel_state is starting | ready | failed (editor/server.py health).
  const health=async(port:number)=>{
    try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)});return r.ok?await r.json() as {kernel_state?:string;kernel_error?:string|null}:null;}
    catch{return null;}
  };
  async function ensure(id:string,parent:string):Promise<Worker> {
    await store.project(id);
    const present=workers.get(id);
    if(present&&!present.ended&&present.ready){
      // A worker whose kernel failed or whose editor stopped answering is replaced, so the next start retries it.
      const state=await health(present.port);if(state&&state.kernel_state!=='failed')return present;
      await stop(id);
    }
    const pending=starting.get(id);if(pending)return pending;
    const task=(async()=>{
      const runtime=await config();if(!runtime)throw new HttpError(422,'未配置参数化建模环境');
      const prog=await program(id);if(!prog)throw new HttpError(422,'请先创建参数化程序');
      const socket=net.createServer();await new Promise<void>(ok=>socket.listen(0,'127.0.0.1',ok));
      const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(ok=>socket.close(()=>ok()));
      const worker:Worker={port,abort:new AbortController(),done:Promise.resolve(),log:'',ended:false,ready:false};
      workers.set(id,worker);
      worker.done=runProcess(runtime.python,['-u',path.join(resource,'bridge.py'),'serve',workspace(id),String(port),parent,prog.entry],
        {cwd:workspace(id),signal:worker.abort.signal,timeout:24*60*60*1000,output:t=>{worker.log=(worker.log+t).slice(-24000);}})
        .catch(e=>{worker.log+='\n'+e.message;}).finally(()=>{worker.ended=true;});
      for(let n=0;n<600;n++){
        if(worker.ended)throw new HttpError(422,worker.log);
        const state=await health(port);
        if(state?.kernel_state==='failed'){worker.abort.abort();await worker.done;throw new HttpError(422,`参数化建模内核启动失败：${state.kernel_error||'未知错误'}\n${worker.log.slice(-4000)}`);}
        if(state){worker.ready=true;return worker;}
        await delay(500);
      }
      worker.abort.abort();await worker.done;throw new HttpError(504,'参数化建模服务启动超时：'+worker.log);
    })();
    starting.set(id,task);try{return await task;}finally{starting.delete(id);}
  }
  const base='/api/projects/:id/parametric';
  app.get('/api/parametric/runtime',async(_q,r)=>r.json({configured:!!await config(),upstream:'cadflow 0.2.0',commit:'0.2.0'}));
  app.get(base,async(q,r)=>{
    await store.project(String(q.params.id));const w=workers.get(String(q.params.id));
    const published=await jsonRead<any>(path.join(workspace(String(q.params.id)),'published.json'),null);
    const job=jobStates.get(String(q.params.id))||await jsonRead<any>(path.join(workspace(String(q.params.id)),'job.json'),null);
    if(job?.state==='running'&&!builds.has(String(q.params.id))){job.state='interrupted';await jsonWrite(path.join(workspace(String(q.params.id)),'job.json'),job);}
    const prog=await program(String(q.params.id));
    // The kernel can fail after the page opened; the panel offers a restart, which /start performs for a failed kernel.
    const kernel=w&&!w.ended&&w.ready?await health(w.port).then(h=>h?{state:h.kernel_state??'ready',error:h.kernel_error??null}:{state:'failed',error:'编辑器无响应'}):null;
    r.json({exists:!!prog,kernel,template:prog?.template??null,entry:prog?.entry??null,
      running:!!w&&!w.ended,url:w&&!w.ended&&w.ready?editorUrl(String(q.params.id)):null,published,job,log:w?.log});
  });
  app.post(base+'/template',async(q,r)=>{
    const id=String(q.params.id);await store.project(id);const release=store.acquire(id);
    try{
      const name=String(q.body?.template??'cylinder');
      if(!Object.hasOwn(templates,name))throw new HttpError(400,'未知的参数化模板');
      const template=templates[name];
      const root=workspace(id);await fs.mkdir(root,{recursive:true});
      // `replace:true` swaps the template of an existing program: the editor stops, the old template files leave the workspace and stay in the history snapshot.
      const existing=await program(id);
      if(existing&&q.body?.replace!==true)throw new HttpError(409,'参数化程序已存在');
      if(existing&&builds.has(id))throw new HttpError(409,'正在发布 CAD，请稍候');
      if(existing)await stop(id);
      await history.snapshot(id,existing?'更换参数化模板前':'创建参数化建模工作区前');
      if(existing)for(const file of templates[existing.template].files)await fs.rm(path.join(root,file),{force:true});
      for(const file of template.files)await fs.copyFile(path.join(resource,'templates',file),path.join(root,file));
      await jsonWrite(path.join(root,'program.json'),{template:name,entry:template.entry});
      await history.snapshot(id,template.created);r.status(201).json({template:name,source:`parametric/${template.entry}`});
    }finally{release();}
  });
  app.post(base+'/start',async(q,r)=>{
    if(builds.has(String(q.params.id)))throw new HttpError(409,'正在发布 CAD，请稍候');
    const id=String(q.params.id);await ensure(id,`http://127.0.0.1:${process.env.STUDIO_PORT||4317}`);r.json({url:editorUrl(id),agentApi:endpoint(id)});
  });
  app.post(base+'/stop',async(q,r)=>{await store.project(String(q.params.id));await stop(String(q.params.id));r.json({ok:true});});
  // A constrained proxy for the built-in agent: no arbitrary upstream URL or path.
  const operations=new Set(['snapshot','cells','sdk','workspace','studio/selected']);
  const commands=new Set(['cells/edit','cells/insert','cells/delete','cells/run','workspace/open','studio/select']);
  app.all(base+'/agent/{*operation}',async(q,r)=>{
    await store.project(String(q.params.id));const operation=Array.isArray(q.params.operation)?q.params.operation.join('/'):String(q.params.operation);
    if(!(q.method==='GET'?operations:commands).has(operation)||!['GET','POST'].includes(q.method))throw new HttpError(400,'不支持的建模操作');
    if(builds.has(String(q.params.id)))throw new HttpError(409,'正在发布 CAD，请稍候');
    const pending=starting.get(String(q.params.id));if(pending)await pending;
    const w=workers.get(String(q.params.id));if(!w||w.ended||!w.ready)throw new HttpError(409,'请先打开参数化建模');
    const response=await fetch(`http://127.0.0.1:${w.port}/api/${operation}`,{method:q.method,headers:{'Content-Type':'application/json'},body:q.method==='POST'?JSON.stringify(q.body):undefined,signal:AbortSignal.timeout(q.method==='POST'?60*60*1000:120000)});
    r.status(response.status).type(response.headers.get('content-type')||'application/json').send(Buffer.from(await response.arrayBuffer()));
  });
  app.post(base+'/publish',async(q,r)=>{
    const id=String(q.params.id);await store.project(id);
    // An editor that is still starting cannot confirm its saved state yet; wait for it before taking the lock.
    const pending=starting.get(id);if(pending)await pending.catch(()=>{});
    if(builds.has(id))throw new HttpError(409,'已有参数化构建正在进行');
    const release=store.acquire(id,'发布参数化模型');const runtime=await config();if(!runtime){release();throw new HttpError(422,'未配置参数化建模环境');}
    const abort=new AbortController();builds.set(id,abort);
    try{
      const w=workers.get(id);
      if(w&&!w.ended){
        if(!w.ready)throw new HttpError(409,'参数化编辑器尚未就绪，请稍后发布');
        if(!q.body?.editor)throw new HttpError(409,'请通过建模面板发布，以确认编辑内容已保存');
        let settled=false;
        for(let n=0;n<240;n++){
          if(abort.signal.aborted)throw new HttpError(409,'已取消发布');
          const response=await fetch(`http://127.0.0.1:${w.port}/api/castudio/settled`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q.body.editor),signal:AbortSignal.timeout(5000)});
          const ready=await response.json() as any;
          if(!response.ok)throw new HttpError(response.status,ready.error||'无法确认编辑状态');
          if(ready.ready){settled=true;break;}await delay(500);
        }
        if(!settled)throw new HttpError(409,'编辑保存或建模尚未完成，请等待后重新发布');
      }
      const prog=await program(id);if(!prog)throw new HttpError(422,'请先创建参数化程序');
      const template=templates[prog.template];
      await history.snapshot(id,'参数化 CAD 发布前');
      const rid=randomUUID(),root=workspace(id),output=path.join(root,'exports',rid);
      await safePath(root,prog.entry);
      const snapshot=path.join(output,'source');await fs.mkdir(snapshot,{recursive:true});
      // Freeze all local Python modules and their hashes. The editor keeps running; the build reads only this copy, so the exports describe exactly the frozen source.
      const frozen:Record<string,string>={};
      for(const name of await pythonSources(root)){
        await fs.mkdir(path.dirname(path.join(snapshot,name)),{recursive:true});await fs.copyFile(await safePath(root,name),path.join(snapshot,name));
        frozen[name]=sha256(await fs.readFile(path.join(snapshot,name)));
      }
      const unchanged=async(directory:string)=>{
        const names=await pythonSources(directory);
        return JSON.stringify(names)===JSON.stringify(Object.keys(frozen).sort())&&(await Promise.all(names.map(async name=>sha256(await fs.readFile(path.join(directory,name)))===frozen[name]))).every(Boolean);
      };
      const job:any={id:rid,state:'running',createdAt:new Date().toISOString(),log:'',sourceHash:frozen[prog.entry]};
      jobStates.set(id,job);
      await jsonWrite(path.join(root,'job.json'),job);
      const task=async()=>{
        try{
          // Per-cell caching is disabled in the runtime (bridge.py, stage 1), so building from a copy costs nothing extra. Saved slider values stay keyed to the live notebook path, hence params_from.
          const reference=prog.template==='cylinder'?['--reference',path.join(resource,'reference-cylinder.step')]:[];
          const result=await runProcess(runtime.python,['-u',path.join(resource,'bridge.py'),'build',path.join(snapshot,prog.entry),output,prog.template,path.join(root,prog.entry),...reference],
            {cwd:snapshot,signal:abort.signal,timeout:60*60*1000,output:t=>{job.log=(job.log+t).slice(-32000);}});
          job.exitCode=result.code;job.timedOut=result.timedOut;
          if(result.code!==0||result.timedOut||abort.signal.aborted)throw Error('CAD 进程退出码 '+result.code+(result.timedOut?'（超时）':'')+'\n'+job.log.slice(-5000));
          if(!await unchanged(snapshot))throw Error('构建期间冻结的源码被修改，产物未发布');
          const manifest=await jsonRead<any>(path.join(output,template.record),null);
          const step=`${prog.template}.step`;
          if(!manifest||manifest.source_sha256!==sha256(await fs.readFile(path.join(output,step))))throw Error('CAD 与构建记录不匹配');
          // The editor may have saved newer edits while the build ran; the exports still describe the frozen source.
          const published={template:prog.template,source:`parametric/exports/${rid}/${step}`,preview:`parametric/exports/${rid}/${prog.template}.scadpkg`,manifest,createdAt:new Date().toISOString(),sourceChangedDuringBuild:!await unchanged(root).catch(()=>false)};
          await jsonWrite(path.join(root,'published.json'),published);job.state='succeeded';job.published=published;
          await history.snapshot(id,template.published);
        }catch(e){job.state=abort.signal.aborted?'cancelled':'failed';job.error=(e as Error).message;}
        finally{await jsonWrite(path.join(root,'job.json'),job);builds.delete(id);release();finished(id,job.state==='succeeded'?job.published?.preview:undefined);}
      };
      void task();r.status(202).json(job);
    }catch(e){builds.delete(id);release();throw e;}
  });
  app.post(base+'/cancel',async(q,r)=>{await store.project(String(q.params.id));builds.get(String(q.params.id))?.abort();r.json({ok:true});});
  const workerPort=(id:string)=>{const w=workers.get(id);return w&&!w.ended&&w.ready?w.port:null;};
  return {workerPort,dispose:async()=>{for(const abort of builds.values())abort.abort();await Promise.allSettled([...workers.keys()].map(stop));}};
}
