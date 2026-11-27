import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createHash} from 'node:crypto';
import {Store,jsonWrite} from '../server/storage.js';
import {History} from '../server/history.js';
import {parametricRoutes} from '../server/parametric.js';
import {validateBindings} from '../server/semantic-bindings.js';

test('semantic bindings reject stale CAD, missing groups and swapped pressure surfaces',()=>{
 const value={schema_version:1,source_sha256:'abc',equivalence:{approved:true},bindings:{
  'interface.fixed_support':{shell_set:'bottom',face_count:1,area_mm2:1},
  'interface.axial_load':{shell_set:'top',face_count:1,area_mm2:1},
  'interface.external_pressure':{shell_set:'skin',face_count:1,area_mm2:1}}};
 assert.equal(validateBindings(value,'abc'),value);
 assert.throws(()=>validateBindings(value,'changed'),/改变/);
 const swapped=structuredClone(value);swapped.bindings['interface.external_pressure'].shell_set='top';
 assert.throws(()=>validateBindings(swapped,'abc'),/映射/);
 assert.throws(()=>validateBindings({...value,bindings:{}},'abc'),/完整/);
 assert.throws(()=>validateBindings({...value,equivalence:{approved:false}},'abc'),/改变/);
});

test('parametric templates preserve existing source and project boundaries; runtime errors remain actionable',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'castudio-parametric-'));const store=new Store(dir);await store.init();
 const project=await store.createProject('test'),other=await store.createProject('other');
 const app=express();app.use(express.json());const manager=parametricRoutes(app,store,new History(store));
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/projects/${project.id}/parametric`;
 const post=(suffix:string)=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 try{
  assert.equal((await post('/template')).status,201);
  const source=path.join(store.workspace(project.id),'parametric/cylinder.py');const bytes=await fs.readFile(source);
  assert.equal((await post('/template')).status,409);assert.deepEqual(await fs.readFile(source),bytes);
  assert.equal(await fs.access(path.join(store.workspace(other.id),'parametric/cylinder.py')).then(()=>true,()=>false),false);
  assert.equal((await post('/start')).status,422);
  assert.equal((await post('/agent/cells/edit')).status,409);
  assert.equal((await post('/agent/arbitrary')).status,400);
  assert.equal((await post('/publish')).status,422);
  const release=store.acquire(project.id);release(); // failed publication releases project lock
 }finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
});

async function withParametric(run:(c:{store:Store;url:(id:string)=>string;post:(id:string,suffix:string,body?:any)=>Promise<Response>;get:(id:string)=>Promise<any>;dir:string})=>Promise<void>){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'castudio-parametric-'));const store=new Store(dir);await store.init();
 const app=express();app.use(express.json());const manager=parametricRoutes(app,store,new History(store));
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=(id:string)=>`http://127.0.0.1:${(server.address() as any).port}/api/projects/${id}/parametric`;
 const post=(id:string,suffix:string,body:any={})=>fetch(url(id)+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{await run({store,url,post,get:async id=>(await fetch(url(id))).json(),dir});}
 finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
}
const exists=(file:string)=>fs.access(file).then(()=>true,()=>false);

test('template choice is recorded in program.json; legacy cylinder projects without a record still work; parts stay isolated',async()=>{
 await withParametric(async({store,post,get})=>{
  const plate=await store.createProject('plate'),legacy=await store.createProject('legacy');const part=await store.createPart(plate.id,'bracket');
  assert.equal((await get(plate.id)).exists,false);
  assert.equal((await post(plate.id,'/template',{template:'sphere'})).status,400);
  assert.equal((await post(plate.id,'/template',{template:'constructor'})).status,400);
  const created=await post(plate.id,'/template',{template:'plate'});assert.equal(created.status,201);assert.deepEqual(await created.json(),{template:'plate',source:'parametric/plate.py'});
  const root=path.join(store.workspace(plate.id),'parametric');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'program.json'),'utf8')),{template:'plate',entry:'plate.py'});
  assert.equal(await exists(path.join(root,'cylinder.py')),false);
  const state=await get(plate.id);assert.equal(state.exists,true);assert.equal(state.template,'plate');assert.equal(state.entry,'plate.py');
  assert.equal((await post(plate.id,'/template',{template:'cylinder'})).status,409);
  await fs.writeFile(path.join(root,'plate.py'),'# edited plate');await fs.writeFile(path.join(root,'notes.py'),'# mine');
  const replaced=await post(plate.id,'/template',{template:'cylinder',replace:true});assert.equal(replaced.status,201);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'program.json'),'utf8')),{template:'cylinder',entry:'cylinder.py'});
  assert.equal(await exists(path.join(root,'plate.py')),false,'the old template source leaves the workspace');
  assert.equal(await exists(path.join(root,'cylinder.py')),true);assert.equal(await exists(path.join(root,'notes.py')),true,'other sources stay');
  const revisions=await new History(store).list(plate.id);assert.ok(revisions.some(r=>r.label==='更换参数化模板前'),'the replaced source is kept in history');
  assert.equal((await post(plate.id,'/template',{template:'plate',replace:true})).status,201);
  assert.equal((await get(part.id)).exists,false,'a part has its own program');
  assert.equal((await post(part.id,'/template')).status,201);
  assert.equal(await exists(path.join(store.workspace(part.id),'parametric/cylinder.py')),true);
  assert.equal(await exists(path.join(root,'cylinder.py')),false);
  await fs.mkdir(path.join(store.workspace(legacy.id),'parametric'),{recursive:true});await fs.writeFile(path.join(store.workspace(legacy.id),'parametric/cylinder.py'),'# old');
  const old=await get(legacy.id);assert.equal(old.template,'cylinder');assert.equal(old.entry,'cylinder.py');
  assert.equal((await post(legacy.id,'/template',{template:'plate'})).status,409);
  await fs.writeFile(path.join(store.workspace(legacy.id),'parametric/program.json'),'{"template":"plate","entry":"../x.py"}');
  assert.match((await get(legacy.id)).error,/program\.json/);
 });
});

// A shell shim stands in for the CAD Python: `serve` is a health/settled HTTP stub, `build` writes outputs once a gate file exists.
const fakeBridge=`
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const [,, , , op, ...a]=process.argv;
if(op==='serve'){
  const [workspace,port,,entry]=a;fs.writeFileSync(path.join(workspace,'serve-args.json'),JSON.stringify(a));
  http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(q.url==='/api/health'?'{}':'{"ready":true}');}).listen(+port,'127.0.0.1');
}else{
  const [notebook,output,template,paramsFrom,...rest]=a;
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'args.json'),JSON.stringify({notebook,output,template,paramsFrom,rest,cwd:process.cwd(),code:fs.readFileSync(notebook,'utf8')}));
  while(!fs.existsSync(path.join(output,'../../release')))await new Promise(ok=>setTimeout(ok,50));
  const step=Buffer.from('STEP '+template);fs.writeFileSync(path.join(output,template+'.step'),step);fs.writeFileSync(path.join(output,template+'.scadpkg'),'pkg');
  const record={source_sha256:crypto.createHash('sha256').update(step).digest('hex'),...(template==='cylinder'?{bindings:{},equivalence:{approved:true}}:{template})};
  fs.writeFileSync(path.join(output,template==='cylinder'?'cylinder.bindings.json':template+'.build.json'),JSON.stringify(record));
}
`;

test('the blank template installs a notebook whose `body` the generic bridge path publishes',async()=>{
 await withParametric(async({store,post,get})=>{
  const project=await store.createProject('blank');const root=path.join(store.workspace(project.id),'parametric');
  const created=await post(project.id,'/template',{template:'blank'});assert.equal(created.status,201);assert.deepEqual(await created.json(),{template:'blank',source:'parametric/blank.py'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'program.json'),'utf8')),{template:'blank',entry:'blank.py'});
  const state=await get(project.id);assert.equal(state.template,'blank');assert.equal(state.entry,'blank.py');
  const code=await fs.readFile(path.join(root,'blank.py'),'utf8');
  assert.match(code,/^\s+body = cad\.make_box_rsolid\(LENGTH, WIDTH, HEIGHT/m,'bridge.py exports the notebook variable `body`');
  assert.match(code,/part_id="castudio-part"/);assert.match(code,/# ui: slider\(/);
  assert.equal(await exists(path.join(root,'parametric_common.py')),false);
  const bridge=await fs.readFile(path.join(import.meta.dirname,'../resources/parametric/bridge.py'),'utf8');
  assert.match(bridge,/choices=\['cylinder','plate','blank'\]/,'the bridge CLI accepts the template name');
 });
});

for(const template of ['cylinder','plate','blank']){
 test(`${template} publish builds from a frozen copy while the editor keeps running`,{skip:process.platform==='win32'},async()=>{
  await withParametric(async({store,post,get,dir})=>{
   const project=await store.createProject(template);const root=path.join(store.workspace(project.id),'parametric');
   await fs.writeFile(path.join(dir,'fake-bridge.mjs'),fakeBridge);
   const shim=path.join(dir,'fake-python');await fs.writeFile(shim,`#!/bin/sh\nexec "${process.execPath}" "${path.join(dir,'fake-bridge.mjs')}" "$@"\n`,{mode:0o755});
   await jsonWrite(path.join(dir,'parametric-runtime.json'),{python:shim});
   assert.equal((await post(project.id,'/template',{template})).status,201);
   const entry=`${template}.py`,original=await fs.readFile(path.join(root,entry),'utf8');
   assert.equal((await post(project.id,'/start')).status,200);
   assert.equal((await post(project.id,'/publish')).status,409,'a running editor must confirm its saved state');
   const accepted=await post(project.id,'/publish',{editor:{notebook:entry,cells:[],parameters:{},modules:[]}});assert.equal(accepted.status,202);
   const job=await accepted.json();
   let state:any;for(let i=0;i<100;i++){state=await get(project.id);if(state.job?.state==='running'&&await exists(path.join(root,'exports',job.id,'args.json')))break;await new Promise(ok=>setTimeout(ok,50));}
   assert.equal(state.running,true,'editor is not stopped by publishing');assert.ok(state.url);
   await fs.appendFile(path.join(root,entry),'\n# edited during build\n');
   await fs.writeFile(path.join(root,'release'),'');
   for(let i=0;i<100;i++){state=await get(project.id);if(state.job?.state!=='running')break;await new Promise(ok=>setTimeout(ok,50));}
   assert.equal(state.job.state,'succeeded',state.job.error);assert.equal(state.running,true,'editor still running after publish');
   const args=JSON.parse(await fs.readFile(path.join(root,'exports',job.id,'args.json'),'utf8'));
   assert.equal(args.notebook,path.join(root,'exports',job.id,'source',entry));assert.equal(args.paramsFrom,path.join(root,entry));assert.equal(args.template,template);
   assert.equal(args.code,original,'the build reads the frozen copy, not later edits');
   assert.equal(args.rest.length,template==='cylinder'?2:0);if(template==='cylinder')assert.equal(args.rest[0],'--reference');
   assert.equal(state.job.sourceHash,createHash('sha256').update(original).digest('hex'));
   const published=state.published;assert.equal(published.template,template);assert.equal(published.source,`parametric/exports/${job.id}/${template}.step`);
   assert.equal(published.preview,`parametric/exports/${job.id}/${template}.scadpkg`);assert.equal(published.sourceChangedDuringBuild,true);
   assert.equal('bindings' in published.manifest,template==='cylinder');
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'serve-args.json'),'utf8')).slice(-1),[entry],'the editor is started on the recorded entry');
  });
 });
}
