import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {Deliveries,selectDelivery} from '../server/delivery.js';
import {Store} from '../server/storage.js';
import type {OptimizationTask} from '../shared/optimization.js';
import type {ThermalRun} from '../shared/thermal.js';
import type {BuildRun} from '../shared/types.js';
import {DEFAULT_OPTIMIZATION_POLICY} from '../shared/optimization.js';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-')),store=new Store(root);await store.init();
  const original=await store.createProject('EV heatsink'),optimized=await store.createProject('Optimization');
  const source='import gmsh\n# baseline\n',candidate='import gmsh\n# improved\n';
  const step=Buffer.from('BASE STEP'),improved=Buffer.from('IMPROVED STEP');
  const baseBuild=randomUUID(),candidateBuild=randomUUID(),baseRun=randomUUID(),candidateRun=randomUUID(),baseFine=randomUUID(),candidateFine=randomUUID();
  const task:OptimizationTask={id:randomUUID(),sourceProjectId:original.id,projectId:optimized.id,workspacePath:store.workspace(optimized.id),revision:12,phase:'completed',policy:{...DEFAULT_OPTIMIZATION_POLICY},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deadlineAt:new Date().toISOString(),stagnation:0,baseline:{maximumC:71,massKg:1,source:'baseline.py',code:source,runId:baseRun,sourceHash:sha(step),buildId:baseBuild,geometry:{bounds:[0,0,0,0.2,0.2,0.04],volumeM3:1/2700,holes:[]},surface:{schema_version:1,source_sha256:sha(step),surface_sha256:'surface',units:'m',kind:'step',points:[],faces:[],face_groups:[],bounds_m:[[0,0,0],[0.2,0.2,0.04]],groups:[]},config:{ambient_C:40,initial_C:40,duration_s:120,mesh_size_m:0.004,base_material:{name:'Al',rho:2700,k:200,cp:900},heat_sources:[{name:'module',power_W:360}]},units:'mm',verificationRunId:baseFine,verifiedMaximumC:71.1},candidates:[{id:randomUUID(),attempt:1,state:'valid',rationale:'<script>alert("x")</script> measured redesign',changes:['fin count 16 → 24'],code:candidate,source:'builds/candidate/model.step',sourceHash:sha(candidate),buildId:candidateBuild,runId:candidateRun,maximumC:64,massKg:1.03,verificationRunId:candidateFine,token:'private-claim'}],verification:{baselineMaximumC:71.1,candidateMaximumC:64.1,meshSizeM:0.003,improvementC:7}};
  task.bestCandidateId=task.candidates[0].id;
  const builds=new Map<string,BuildRun>([[baseBuild,{id:baseBuild,source:'design.py',sourceHash:sha(source),executable:'private',createdAt:'now',state:'succeeded',log:'',truncated:false,engine:'gmsh',revision:'baseline-revision',artifacts:[{path:'model.step',size:step.length,hash:sha(step)}]}],[candidateBuild,{id:candidateBuild,source:'candidate-1.py',sourceHash:sha(candidate),executable:'private',createdAt:'now',state:'succeeded',log:'',truncated:false,engine:'gmsh',revision:'candidate-revision',artifacts:[{path:'model.step',size:improved.length,hash:sha(improved)}]}]]);
  const runs=new Map<string,ThermalRun>(),contents=new Map<string,Buffer>();
  for(const [id,geometry,maximum] of [[baseRun,step,71],[candidateRun,improved,64],[baseFine,step,71.1],[candidateFine,improved,64.1]] as const){
    const files=new Map([['model/source.step',geometry],['job/report.pdf',Buffer.from('%PDF-fixture')],['job/report.md',Buffer.from('real test report')],['job/temperatures.npy',Buffer.from('temperature fixture')],['job/config.json',Buffer.from(JSON.stringify(task.baseline.config))],['job/history.csv',Buffer.from('time_s,maximum_C\n120,'+maximum)]]);
    const run:ThermalRun={id,source:'model.step',sourceHash:sha(geometry),units:'mm',createdAt:'now',state:'succeeded',revision:'run-revision',executable:'private',config:task.baseline.config,log:'',files:[...files].map(([p,b])=>{contents.set(id+'/'+p,b);return {path:p,size:b.length,hash:sha(b)};}),result:{schema_version:1,source_sha256:sha(geometry),engine_version:'test',result:{times_s:[0,120],vertices:1,frames:2,minimum_C:40,maximum_C:maximum,stats:[{time_s:120,minimum_C:40,maximum_C:maximum,average_C:50}],summary:{warnings:[]}}}};
    runs.set(id,run);
  }
  let corrupt=false,mutate=false,reads=0;
  const service=new Deliveries(store,{deliverySnapshot:async()=>structuredClone(task)},
    {file:async(_project,revision)=>Buffer.from(revision==='baseline-revision'?source:candidate)},
    {read:async(_project,id)=>structuredClone(builds.get(id)!),file:async(_project,id)=>id===baseBuild?step:improved},
    {config:async()=>({executable:process.env.TEST_THERMAL_PYTHON||(process.platform==='win32'?'python':'python3'),device:'cuda'}),read:async(_project,id)=>{reads++;return structuredClone(runs.get(id)!);},file:async(_project,id,p)=>{if(mutate){task.revision++;mutate=false;}return corrupt?Buffer.from('corrupt'):Buffer.from(contents.get(id+'/'+p)!);}});
  return {root,task,service,builds,runs,contents,project:original.id,setCorrupt:()=>{corrupt=true;},setMutation:()=>{mutate=true;},reads:()=>reads,dispose:()=>fs.rm(root,{recursive:true,force:true})};
}

test('exports editable designs, every completed solve, comparison report and independently hashed ZIP',async()=>{
  const f=await fixture();try{
    const record=await f.service.create(f.project,f.task.id);
    assert.equal(record.selected.kind,'verified_candidate');
    assert.equal(record.selected.candidateId,f.task.bestCandidateId);
    const archive=await f.service.file(f.project,f.task.id,record.id,'archive.zip');
    const bytes=await fs.readFile(archive.path);assert.equal(sha(bytes),record.archive.sha256);
    const zip=unzipSync(bytes),manifest=JSON.parse(strFromU8(zip['manifest.json']));
    assert.match(strFromU8(zip['final/design.py']),/improved/);
    assert.equal(strFromU8(zip['final/model.step']),'IMPROVED STEP');
    assert.ok(zip['reports/overview.html']);assert.ok(zip['reports/comparison.csv']);
    assert.ok(zip['simulations/baseline/job/report.pdf']);
    assert.ok(zip['simulations/candidate-1/job/temperatures.npy']);
    assert.ok(zip['simulations/verification-baseline/job/report.pdf']);
    assert.ok(zip['simulations/verification-candidate-1/job/report.pdf']);
    assert.ok(zip['candidates/attempt-1/design.py']);
    assert.doesNotMatch(strFromU8(zip['reports/overview.html']),/<script>/);
    assert.match(strFromU8(zip['reports/overview.html']),/&lt;script&gt;/);
    assert.doesNotMatch(strFromU8(zip['task.json']),/private-claim|workspacePath/);
    for(const item of manifest.files){assert.equal(sha(Buffer.from(zip[item.path])),item.sha256,item.path);}
    assert.ok(record.files.length>25);assert.equal(manifest.taskRevision,12);
  }finally{await f.dispose();}
});

test('unverified, stopped and no-improvement tasks retain baseline as the final recommendation',async()=>{
  const f=await fixture();try{for(const phase of ['unverified','interrupted','cancelled','no_improvement'] as const){f.task.phase=phase;assert.equal(selectDelivery(f.task).kind,'baseline');}
    f.task.phase='unverified';const record=await f.service.create(f.project,f.task.id);
    const file=await f.service.file(f.project,f.task.id,record.id,'final/design.py');assert.match(await fs.readFile(file.path,'utf8'),/baseline/);
  }finally{await f.dispose();}
});

test('exports a frozen .stp source and rejects a mismatched .stp payload',async()=>{
  for(const tampered of [false,true]){
    const f=await fixture();try{
      for(const run of f.runs.values()){
        const item=run.files.find(file=>file.path==='model/source.step')!;
        const bytes=f.contents.get(run.id+'/'+item.path)!;
        f.contents.delete(run.id+'/'+item.path);
        item.path='model/source.stp';run.source='model.stp';
        const payload=tampered?Buffer.from('wrong geometry'):bytes;
        item.hash=sha(payload);item.size=payload.length;
        f.contents.set(run.id+'/'+item.path,payload);
      }
      if(tampered)await assert.rejects(f.service.create(f.project,f.task.id),/模型摘要/);
      else {
        const record=await f.service.create(f.project,f.task.id);
        const file=await f.service.file(f.project,f.task.id,record.id,'simulations/baseline/model/source.stp');
        assert.equal(await fs.readFile(file.path,'utf8'),'BASE STEP');
      }
    }finally{await f.dispose();}
  }
});

test('refuses running exports and incomplete verified claims',async()=>{
  const f=await fixture();try{f.task.phase='solving';await assert.rejects(f.service.create(f.project,f.task.id),/结束|停止/);
    f.task.phase='completed';delete f.task.candidates[0].verificationRunId;await assert.rejects(f.service.create(f.project,f.task.id),/复核/);
  }finally{await f.dispose();}
});

test('rejects corrupted results and source/build/result mismatches instead of delivering partial success',async()=>{
  const f=await fixture();try{f.setCorrupt();await assert.rejects(f.service.create(f.project,f.task.id),/摘要|哈希/);}finally{await f.dispose();}
  const g=await fixture();try{g.builds.get(g.task.candidates[0].buildId!)!.sourceHash=sha('different');await assert.rejects(g.service.create(g.project,g.task.id),/源码|摘要/);}finally{await g.dispose();}
  const h=await fixture();try{h.runs.get(h.task.candidates[0].runId!)!.sourceHash=sha('other-model');await assert.rejects(h.service.create(h.project,h.task.id),/模型|摘要/);}finally{await h.dispose();}
});

test('coalesces simultaneous export clicks and rejects a resumed task while packaging',async()=>{
  const f=await fixture();try{const [a,b]=await Promise.all([f.service.create(f.project,f.task.id),f.service.create(f.project,f.task.id)]);assert.equal(a.id,b.id);}finally{await f.dispose();}
  const g=await fixture();try{g.setMutation();await assert.rejects(g.service.create(g.project,g.task.id),/任务.*变化/);}finally{await g.dispose();}
});

test('rejects unsafe archive paths and detects modified published downloads',async()=>{
  const f=await fixture();try{
    const record=await f.service.create(f.project,f.task.id);
    await assert.rejects(f.service.file(f.project,f.task.id,record.id,'../task.json'),/路径|文件/);
    const file=await f.service.file(f.project,f.task.id,record.id,'final/model.step');await fs.writeFile(file.path,'tamper');
    await assert.rejects(f.service.file(f.project,f.task.id,record.id,'final/model.step'),/摘要|变化/);
  }finally{await f.dispose();}
});

test('includes diagnostics for failed CAD builds without calling their output a valid design',async()=>{
  const f=await fixture();try{
    const id=randomUUID();f.task.candidates.push({id:randomUUID(),attempt:2,state:'invalid',rationale:'repair attempt',changes:[],code:'import gmsh\nraise RuntimeError("disconnected fins")',buildId:id,error:'脚本退出码 1；请查看日志'});
    f.builds.set(id,{id,source:'candidate-2.py',sourceHash:sha('failed source'),executable:'private',createdAt:'now',state:'failed',log:'RuntimeError: disconnected fins\n',truncated:false,artifacts:[],error:'脚本退出码 1；请查看日志'});
    const record=await f.service.create(f.project,f.task.id);
    const file=await f.service.file(f.project,f.task.id,record.id,'candidates/attempt-2/build.log');
    assert.match(await fs.readFile(file.path,'utf8'),/disconnected fins/);
    assert.ok(record.files.some(f=>f.path==='candidates/attempt-2/build.json'));
    assert.ok(!record.files.some(f=>f.path==='candidates/attempt-2/model.step'));
  }finally{await f.dispose();}
});
