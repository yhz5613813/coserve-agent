import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,jsonWrite} from '../server/storage.js';
import {Events} from '../server/events.js';
import {ThermalEditor} from '../server/thermal-editor.js';
import {ThermalResource} from '../server/thermal-resource.js';

test('inspection shares the thermal budget and rejects paths without leaving the project locked',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'thermal-editor-'));
  const store=new Store(root);await store.init();const project=await store.createProject('editor');
  const budget=new ThermalResource();const editor=new ThermalEditor(store,new Events(),budget);
  try{
    await assert.rejects(()=>editor.start(project.id,{source:'../secret.step',units:'mm'}),/路径/);
    assert.equal(budget.busy,false);
    const release=store.acquire(project.id);release();
    const releaseBudget=budget.acquire();
    await assert.rejects(()=>editor.start(project.id,{source:'model.step',units:'mm'}),/热仿真|几何检查/);
    releaseBudget();
    await assert.rejects(()=>editor.read(project.id,'../escape'),/编号/);
    const id='11111111-1111-4111-8111-111111111111';
    await jsonWrite(path.join(store.projectRoot(project.id),'thermal-inspections',id,'record.json'),
      {id,state:'running',source:'missing.step',sourceHash:'0'.repeat(64),units:'mm'});
    await editor.recover();assert.equal((await editor.read(project.id,id)).state,'interrupted');
    const other=await store.createProject('other');await assert.rejects(()=>editor.read(other.id,id),/不存在/);
  }finally{await editor.dispose();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('real inspection resolves physical area and rejects stale or rewritten evidence',{skip:!process.env.STUDIO_THERMAL_TEST_PYTHON},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'thermal-editor-real-'));
  const store=new Store(root);await store.init();const project=await store.createProject('real editor');
  const editor=new ThermalEditor(store,new Events());
  try{
    await jsonWrite(path.join(root,'thermal-runtime.json'),{executable:process.env.STUDIO_THERMAL_TEST_PYTHON});
    const points=[[0,0,0],[20,0,0],[0,20,0],[0,0,20]],faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]];
    const stl=['solid test',...faces.map(face=>'facet normal 0 0 0\nouter loop\n'+face.map(i=>'vertex '+points[i].join(' ')).join('\n')+'\nendloop\nendfacet'),'endsolid test'].join('\n');
    const source=path.join(store.workspace(project.id),'tetra.stl');await fs.writeFile(source,stl);
    let record=await editor.start(project.id,{source:'tetra.stl',units:'mm'});
    const deadline=Date.now()+60000;
    while(record.state==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));record=await editor.read(project.id,record.id);}
    assert.equal(record.state,'succeeded',record.error+'\n'+record.log);
    const bytes=await editor.surface(project.id,record.id),surface=JSON.parse(bytes.toString());
    assert.equal(surface.units,'m');assert.equal(surface.surface_sha256,record.surfaceHash);
    const whole=await editor.resolve(project.id,record.id,{kind:'face',face:0},record.surfaceHash);
    assert.equal(whole.faces.length,1);
    const rect=await editor.resolve(project.id,record.id,{kind:'rectangle',face:0,center_m:whole.center_m,width_m:.001,height_m:.001},record.surfaceHash);
    assert.ok(Math.abs(rect.area_m2-1e-6)<1e-12);
    await assert.rejects(()=>editor.resolve(project.id,record.id,{kind:'face',face:0},'0'.repeat(64)),/变化/);
    await editor.validate(project.id,record.id,{base_material:{name:'test',k:1,rho:1,cp:1},duration_s:6,dt_s:1,save_s:2,
      heat_sources:[{power_W:5,faces:rect.faces,surface_patch:rect.surface_patch}]});
    await fs.writeFile(source,stl+'\n');
    await assert.rejects(()=>editor.resolve(project.id,record.id,{kind:'face',face:0},record.surfaceHash),/模型已变化/);
    await fs.writeFile(source,stl);
    await fs.writeFile(path.join(root,'thermal-inspection-work',record.id,'output','selection-surface.json'),Buffer.concat([bytes,Buffer.from(' ')]));
    await assert.rejects(()=>editor.surface(project.id,record.id),/摘要已变化/);
  }finally{await editor.dispose();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
