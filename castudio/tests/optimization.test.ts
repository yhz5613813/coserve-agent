import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {Optimizations} from '../server/optimization.js';import {resolvePolicy} from '../server/optimization-core.js';import {Store,jsonWrite,HttpError} from '../server/storage.js';import {History} from '../server/history.js';import {Builds} from '../server/builds.js';import {Thermal} from '../server/thermal.js';import {ThermalEditor} from '../server/thermal-editor.js';import {Events} from '../server/events.js';import type {OptimizationTask} from '../shared/optimization.js';
import {createHash} from 'node:crypto';
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'opt-'));const store=new Store(root);await store.init();const source=await store.createProject('source'),project=await store.createProject('opt'),events=new Events(),history=new History(store),builds=new Builds(store,history,events),thermal=new Thermal(store,history,events),editor=new ThermalEditor(store,events);const svc=new Optimizations(store,history,builds,thermal,editor,events);const task={id:randomUUID(),sourceProjectId:source.id,projectId:project.id,workspacePath:store.workspace(project.id),revision:1,phase:'awaiting_proposal',policy:resolvePolicy({maxAttempts:2}),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString(),candidates:[],baseline:{code:'import gmsh',source:'base.py',maximumC:80,massKg:1,config:{},runId:randomUUID(),sourceHash:'a'.repeat(64),buildId:randomUUID(),units:'mm',surface:{schema_version:1,source_sha256:'',surface_sha256:'',units:'m',kind:'step',points:[],faces:[],face_groups:[],groups:[],bounds_m:[[0,0,0],[1,1,1]]},geometry:{bounds:[],holes:[],volumeM3:1}},stagnation:0} as OptimizationTask;await jsonWrite(path.join(root,'optimizations',task.id+'.json'),task);return {svc,store,source,project,task,async close(){await svc.dispose();await fs.rm(root,{recursive:true,force:true});}};}
test('claim is exclusive, stale revisions fail, cancellation stops dispatch',async()=>{const f=await fixture();try{assert.equal((await f.svc.pending()).length,1);const c=await f.svc.claim(f.source.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'});assert.equal(c.task.sessionId,'s');await assert.rejects(()=>f.svc.claim(f.source.id,f.task.id,{revision:1,workerId:'other',sessionId:'s'}),/领取|版本/);await f.svc.cancel(f.project.id,f.task.id);assert.equal((await f.svc.pending()).length,0);await assert.rejects(()=>f.svc.proposal(f.project.id,f.task.id,{token:c.proposal.token,attempt:1,code:'x'}),/过期|取消/);}finally{await f.close();}});

test('each claimed design receives the packaged skill and a reproducible content hash',async()=>{
 const f=await fixture();try{
  const local=path.join(f.store.workspace(f.project.id),'.agents/skills/heatsink-optimization');
  await fs.mkdir(local,{recursive:true});await fs.writeFile(path.join(local,'SKILL.md'),'local design notes');
  const claim=await f.svc.claim(f.source.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'});
  const prompt=JSON.parse(claim.proposal.prompt);
  assert.equal(prompt.skill?.name,'heatsink-optimization');
  const content=await fs.readFile(new URL('../resources/heatsink-optimization/SKILL.md',import.meta.url),'utf8');
  assert.equal(prompt.skill.content,content);
  assert.equal(prompt.skill.sha256,createHash('sha256').update(content).digest('hex'));
  assert.equal(prompt.baseline.code,f.task.baseline.code);
  assert.deepEqual(prompt.policy,f.task.policy);
 }finally{await f.close();}
});

for(const missing of [true,false])test((missing?'a missing':'an empty')+' packaged skill fails before claiming or consuming an attempt',async context=>{
 const f=await fixture();const original=fs.readFile;try{
  context.mock.method(fs,'readFile',(...args:Parameters<typeof fs.readFile>)=>{
   if(String(args[0]).replaceAll('\\','/').endsWith('/resources/heatsink-optimization/SKILL.md')){if(missing)throw new Error('ENOENT fixture');return Promise.resolve('');}
   return original(...args);
  });
  await assert.rejects(()=>f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'}),/Skill/);
  const t=await f.svc.read(f.project.id,f.task.id);assert.equal(t.phase,'awaiting_proposal');assert.equal(t.claim,undefined);assert.equal(t.candidates.length,0);assert.equal(t.revision,1);
 }finally{context.mock.restoreAll();await f.close();}
});
test('error proposals count budget and duplicate delivery is idempotent',async()=>{const f=await fixture();try{const claim=await f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'}),input={token:claim.proposal.token,attempt:1,sessionId:'s',error:'model failed'};await f.svc.proposal(f.project.id,f.task.id,input);await f.svc.proposal(f.project.id,f.task.id,input);const t=await f.svc.read(f.source.id,f.task.id);assert.equal(t.candidates.length,1);assert.equal(t.candidates[0].state,'invalid');assert.equal(t.phase,'awaiting_proposal');}finally{await f.close();}});
test('restart interrupts active tasks and resume clears unresolved claim',async()=>{const f=await fixture();try{await f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'});await f.svc.recover();assert.equal((await f.svc.read(f.source.id,f.task.id)).phase,'interrupted');const t=await f.svc.resume(f.project.id,f.task.id);assert.equal(t.phase,'awaiting_proposal');assert.equal(t.claim,undefined);}finally{await f.close();}});


test('driver expiry interrupts a claim without redispatch',async()=>{const f=await fixture();const actualNow=Date.now;try{f.svc.driver('w');await f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'});const later=actualNow()+20000;Date.now=()=>later;await new Promise(r=>setTimeout(r,1200));assert.equal((await f.svc.read(f.project.id,f.task.id)).phase,'interrupted');assert.equal((await f.svc.pending()).length,0);}finally{Date.now=actualNow;await f.close();}});

test('cancelled task resumes only after cancellation with remaining budget',async()=>{const f=await fixture();try{const claim=await f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'});await f.svc.cancel(f.project.id,f.task.id);const t=await f.svc.resume(f.project.id,f.task.id);assert.equal(t.phase,'awaiting_proposal');assert.equal(t.claim,undefined);assert.equal(t.candidates[0].state,'invalid');assert.equal(t.stopReason,undefined);await assert.rejects(()=>f.svc.proposal(f.project.id,f.task.id,{token:claim.proposal.token,attempt:1,sessionId:'s',error:'stale'}),/过期/);}finally{await f.close();}});

test('a replacement worker heartbeat cannot keep an old claim alive',async()=>{const f=await fixture(),now=Date.now;try{f.svc.driver('old');await f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'old',sessionId:'s'});const later=now()+20000;Date.now=()=>later;f.svc.driver('new');await new Promise(r=>setTimeout(r,1200));assert.equal((await f.svc.read(f.project.id,f.task.id)).phase,'interrupted');}finally{Date.now=now;await f.close();}});
test('resume refuses a task whose cancellation is still draining its child',async()=>{const f=await fixture();let release!:()=>void;try{await f.svc.pending();
 // @ts-expect-error Regression fixture controls an in-flight asynchronous stage.
 const cached=f.svc.cache.get(f.task.id)!;
 // @ts-expect-error Regression fixture owns the deferred stage completion.
 f.svc.launch(cached,()=>new Promise<void>(r=>{release=r;}));
 await new Promise(r=>setTimeout(r,0));const cancel=f.svc.cancel(f.project.id,f.task.id);await new Promise(r=>setTimeout(r,10));await assert.rejects(()=>f.svc.resume(f.project.id,f.task.id),/取消|子任务|修改/);release();await cancel;assert.equal((await f.svc.pending()).length,0);
 }finally{release?.();await f.close();}});
test('dispatch setup errors become visible interrupted tasks without consuming attempts',async()=>{const f=await fixture();try{const t=await f.svc.dispatchError(f.project.id,f.task.id,{revision:1,workerId:'w',error:'session permissions missing'});assert.equal(t.phase,'interrupted');assert.equal(t.candidates.length,0);assert.match(t.error!,/permissions/);}finally{await f.close();}});

test('resource contention waits without consuming a candidate and unrelated 409 fails',async()=>{const f=await fixture();try{let calls=0;
 // @ts-expect-error Regression fixture exercises a resource queue without launching a solver.
 const result=await f.svc.resourceStart(f.task,async()=>{if(++calls===1)throw new HttpError(409,'已有热仿真或几何检查正在运行，请等待或取消');return 42;});assert.equal(result,42);assert.equal(calls,2);assert.equal(f.task.candidates.length,0);
 // @ts-expect-error Unrelated conflicts must not be retried.
 await assert.rejects(()=>f.svc.resourceStart(f.task,async()=>{throw new HttpError(409,'配置冲突');}),/配置冲突/);
 }finally{await f.close();}});


test('awaiting proposal is not dispatchable until the previous stage releases ownership',async()=>{const f=await fixture();let release!:()=>void;try{await f.svc.pending();
 // @ts-expect-error Fixture controls a stage paused during its final durable save.
 const cached=f.svc.cache.get(f.task.id)!;
 // @ts-expect-error Fixture owns the prior stage completion.
 f.svc.launch(cached,()=>new Promise<void>(r=>{release=r;}));await new Promise(r=>setTimeout(r,0));assert.equal((await f.svc.pending()).length,0);await assert.rejects(()=>f.svc.claim(f.project.id,f.task.id,{revision:1,workerId:'w',sessionId:'s'}),/阶段|领取/);release();await new Promise(r=>setTimeout(r,10));assert.equal((await f.svc.pending()).length,1);
 }finally{release?.();await f.close();}});


test('claim replay keeps the original attempt, token and revision and rejects another owner',async()=>{
 const f=await fixture();try{
  const input={revision:1,workerId:'w',sessionId:'s'};
  const first=await f.svc.claim(f.project.id,f.task.id,input);
  const replay=await f.svc.claim(f.project.id,f.task.id,input);
  assert.deepEqual(replay,first);assert.equal(replay.task.revision,2);assert.equal(replay.task.candidates.length,0);
  await assert.rejects(()=>f.svc.claim(f.project.id,f.task.id,{...input,workerId:'other'}),/领取|版本/);
  await assert.rejects(()=>f.svc.claim(f.project.id,f.task.id,{...input,sessionId:'other'}),/领取|版本/);
  await f.svc.cancel(f.project.id,f.task.id);
  await assert.rejects(()=>f.svc.claim(f.project.id,f.task.id,input),/领取|版本/);
 }finally{await f.close();}
});
