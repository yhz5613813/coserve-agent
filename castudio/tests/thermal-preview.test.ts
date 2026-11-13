import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Store,jsonWrite} from '../server/storage.js';
import {Thermal} from '../server/thermal.js';
import {History} from '../server/history.js';
import {Events} from '../server/events.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('unfinished fields are readable, checked, and never publishable',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'thermal-live-'));
  const store=new Store(root);await store.init();const project=await store.createProject('preview');
  const thermal=new Thermal(store,new History(store),new Events());
  try{
    const id=randomUUID(),folder=path.join(root,'thermal-work',id,'output','preview');
    await fs.mkdir(path.join(folder,'frames'),{recursive:true});
    const geometry=Buffer.from(JSON.stringify({points:[0,0,0,1,0,0,0,1,0],faces:[0,1,2]}));
    const field=Buffer.alloc(12);[25,26,27].forEach((v,i)=>field.writeFloatLE(v,i*4));
    const source=Buffer.from('test source');await fs.writeFile(path.join(store.workspace(project.id),'test.step'),source);
    const record={id,source:'test.step',sourceHash:hash(source),state:'cancelled',files:[],config:{},units:'mm',createdAt:new Date().toISOString()};
    const recordFile=path.join(store.projectRoot(project.id),'thermal',id,'run.json');
    await jsonWrite(recordFile,record);
    await fs.writeFile(path.join(folder,'surface.json'),geometry);
    await fs.writeFile(path.join(folder,'frames','000000.bin'),field);
    const index={schema_version:1,source_sha256:hash(source),vertices:3,analysis_mode:'transient',geometry_sha256:hash(geometry),
      frames:[{time_s:0,minimum_C:25,maximum_C:27,average_C:26,sha256:hash(field)}]};
    await jsonWrite(path.join(folder,'index.json'),index);
    const run=await thermal.read(project.id,id);
    assert.equal(run.preview?.frames.length,1);
    assert.deepEqual(await thermal.previewFrame(project.id,id,0),field);
    assert.deepEqual(await thermal.geometry(project.id,id),geometry);
    await assert.rejects(()=>thermal.publish(project.id,id),/已完成/);
    await assert.rejects(()=>thermal.previewFrame(project.id,id,1),/帧/);
    const other=await store.createProject('other');
    await assert.rejects(()=>thermal.previewFrame(other.id,id,0),/不存在/);
    field.writeFloatLE(100,0);await fs.writeFile(path.join(folder,'frames','000000.bin'),field);
    await assert.rejects(()=>thermal.previewFrame(project.id,id,0),/变化/);
    index.source_sha256='0'.repeat(64);await jsonWrite(path.join(folder,'index.json'),index);
    const refused=await thermal.read(project.id,id);
    assert.equal(refused.preview,undefined);assert.match(refused.previewError||'',/模型/);
    index.source_sha256=hash(source);index.frames[0].minimum_C=99;
    await jsonWrite(path.join(folder,'index.json'),index);
    assert.equal((await thermal.read(project.id,id)).preview,undefined);
    assert.equal((await thermal.read(project.id,id)).result,undefined);
  }finally{await thermal.dispose();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('a design turn can queue a thermal run and cancel without releasing another owner',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'thermal-queue-'));
  const store=new Store(root);await store.init();const project=await store.createProject('queued');
  const thermal=new Thermal(store,new History(store),new Events());
  let release:(()=>void)|undefined;
  try{
    const file=path.join(store.workspace(project.id),'test.step');await fs.writeFile(file,'frozen test input');
    release=store.acquire(project.id);
    const run=await thermal.start(project.id,{source:'test.step',units:'mm',config:{}},true);
    assert.equal(run.state,'queued');
    assert.equal((await thermal.cancel(project.id,run.id)).state,'cancelled');
    assert.throws(()=>store.acquire(project.id),/修改/);
    release();release=store.acquire(project.id);
    let next=await thermal.start(project.id,{source:'test.step',units:'mm',config:{}},true);
    await fs.writeFile(file,'changed during design');release();release=undefined;
    const deadline=Date.now()+3000;
    while(['queued','running'].includes(next.state)&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,20));next=await thermal.read(project.id,next.id);
    }
    assert.equal(next.state,'failed');assert.match(next.error||'',/模型已变化/);
    assert.equal(next.result,undefined);
  }finally{release?.();await thermal.dispose();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
