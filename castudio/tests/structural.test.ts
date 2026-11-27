import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store,jsonWrite} from '../server/storage.js';
import {structuralRoutes} from '../server/structural.js';

test('a run recorded under another install location is read from the current work root',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-structural-moved-'));
 const store=new Store(root);await store.init();const project=await store.createProject('moved');
 const rid='22222222-2222-4222-8222-222222222222',stale=path.join(root,'old-drive','structural-work',rid),current=path.join(root,'structural-work',rid);
 await jsonWrite(path.join(store.workspace(project.id),'structural',rid,'run.json'),{id:rid,state:'succeeded',createdAt:new Date().toISOString(),source:'case.step',sourceHash:'',log:'',output:stale});
 await fs.mkdir(current,{recursive:true});await fs.writeFile(path.join(current,'report.txt'),'moved report');await jsonWrite(path.join(current,'status.json'),{phase:'done'});
 const app=express();app.use(express.json());structuralRoutes(app,store);
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/projects/${project.id}/structural/${rid}`;
 try{
  const run=await (await fetch(base)).json();assert.equal(run.output,current);assert.deepEqual(run.progress,{phase:'done'});
  const file=await fetch(base+'/file?path=report.txt');assert.equal(file.status,200);assert.equal(await file.text(),'moved report');
  // Only when the current location is missing does the stored path still serve.
  await fs.rm(current,{recursive:true});await fs.mkdir(stale,{recursive:true});await fs.writeFile(path.join(stale,'report.txt'),'old report');
  assert.equal(await (await fetch(base+'/file?path=report.txt')).text(),'old report');
 }finally{await new Promise<void>(ok=>server.close(()=>ok()));await fs.rm(root,{recursive:true,force:true});}
});

test('agent queue waits for editing lock, rejects changed geometry, and cancels safely',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-structural-test-'));
 const store=new Store(root);await store.init();const project=await store.createProject('queue test');
 await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture original');
 await jsonWrite(path.join(root,'structural-runtime.json'),{python:process.execPath,packageRoot:root,solver:'must-not-run',workRoot:path.join(root,'work')});
 const app=express();app.use(express.json());const structural=structuralRoutes(app,store);
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}/api/projects/${project.id}/structural`;
 const post=(suffix:string,body:any={})=>fetch(base+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let release:(()=>void)|undefined;
 try{
  release=store.acquire(project.id);
  assert.equal((await post('',{source:'case.step'})).status,409);
  const queued=await post('/queue',{source:'case.step'});assert.equal(queued.status,202);const run=await queued.json();
  assert.equal((await (await fetch(base+'/'+run.id)).json()).state,'queued');
  await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture changed');release();release=undefined;
  let state:any;
  for(let i=0;i<30;i++){state=await (await fetch(base+'/'+run.id)).json();if(state.state==='failed')break;await new Promise(ok=>setTimeout(ok,100));}
  assert.equal(state.state,'failed');assert.match(state.error,/源模型已改变/);
  assert.equal((await fetch(base+'/'+run.id+'/file?path=report.docx')).status,409);
  release=store.acquire(project.id);
  const run2=await (await post('/queue',{source:'case.step'})).json();
  const cancelled=await (await post('/'+run2.id+'/cancel')).json();assert.equal(cancelled.state,'cancelled');
  assert.throws(()=>store.acquire(project.id),/项目/);release();release=undefined;
  assert.equal((await post('/queue',{source:'../outside.step'})).status,400);
 }finally{
  release?.();await structural.dispose();await new Promise<void>(ok=>server.close(()=>ok()));
  const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});
 }
});


test('slow CAD verification is recorded immediately and remains cancellable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-cad-check-'));
 const store=new Store(root);await store.init();const project=await store.createProject('CAD validation');
 await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture');
 await jsonWrite(path.join(root,'structural-runtime.json'),{python:process.execPath,packageRoot:root,solver:'must-not-run',workRoot:path.join(root,'work')});
 const app=express();app.use(express.json());let entered=false;
 const manager=structuralRoutes(app,store,async(_root,_source,_folder,_hash,signal)=>{
  entered=true;
  return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(new Error('cancelled verification')),{once:true});});
 });
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/projects/${project.id}/structural`;
 try{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'case.step'})});
  assert.equal(response.status,202);const run=await response.json();
  for(let i=0;i<50&&!entered;i++)await new Promise(ok=>setTimeout(ok,20));
  assert.equal(entered,true);
  const listing=await fetch(url);assert.equal(listing.status,200);
  assert.equal((await listing.json())[0].state,'running');
  const cancel=await fetch(url+'/'+run.id+'/cancel',{method:'POST'});
  assert.equal((await cancel.json()).state,'cancelled');
  assert.equal(await fs.readFile(path.join(store.workspace(project.id),'case.step'),'utf8'),'fixture');
 }finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
});

test('material properties are validated, recorded in the run and passed to the solver input; non-shell parametric exports are refused',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-material-'));
 const store=new Store(root);await store.init();const project=await store.createProject('material');const workspace=store.workspace(project.id);
 await fs.writeFile(path.join(workspace,'case.step'),'fixture');
 await fs.mkdir(path.join(workspace,'parametric/exports/run'),{recursive:true});await fs.writeFile(path.join(workspace,'parametric/exports/run/plate.step'),'plate');
 await jsonWrite(path.join(root,'structural-runtime.json'),{python:process.execPath,packageRoot:root,solver:'must-not-run',workRoot:path.join(root,'work')});
 const app=express();app.use(express.json());const manager=structuralRoutes(app,store,async(_root,_source,_folder,_hash,signal)=>new Promise((_ok,reject)=>{if(signal!.aborted)reject(new Error('stop'));signal!.addEventListener('abort',()=>reject(new Error('stop')),{once:true});}));
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/projects/${project.id}/structural`;
 const post=(body:any)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  for(const bad of [{E_MPa:0},{E_MPa:-1},{E_MPa:'70000'},{E_MPa:2e6},{nu:0},{nu:.5},{nu:'0.3'}]){
   const response=await post({source:'case.step',...bad});assert.equal(response.status,400,JSON.stringify(bad));
  }
  const refused=await post({source:'parametric/exports/run/plate.step'});assert.equal(refused.status,422);assert.match((await refused.json()).error,/圆柱壳/);
  const accepted=await post({source:'case.step',E_MPa:69000,nu:.3});assert.equal(accepted.status,202);const run=await accepted.json();
  assert.deepEqual(run.material,{E_MPa:69000,nu:.3});
  const request=JSON.parse(await fs.readFile(path.join(workspace,'structural',run.id,'request.json'),'utf8'));
  assert.equal(request.E_MPa,69000);assert.equal(request.nu,.3);
  assert.deepEqual((await (await fetch(url+'/'+run.id)).json()).material,{E_MPa:69000,nu:.3});
  await fetch(url+'/'+run.id+'/cancel',{method:'POST'});
  const defaults=await (await post({source:'case.step'})).json();assert.deepEqual(defaults.material,{E_MPa:70000,nu:.33});
 }finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
});
