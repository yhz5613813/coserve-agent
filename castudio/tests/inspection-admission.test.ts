import test from 'node:test';
import assert from 'node:assert/strict';
import {ownInspection} from '../src/thermal/inspection-admission.js';

test('a late inspection response is cancelled before obsolete admission settles',async()=>{
  let resolve!:(record:{id:string})=>void,finishCancel!:()=>void;
  const start=new Promise<{id:string}>(done=>{resolve=done;});
  const cancellation=new Promise<void>(done=>{finishCancel=done;});
  const events:string[]=[];let current=true,settled=false;
  const pending=ownInspection(start,()=>current,()=>events.push('owned'),async record=>{
    events.push('cancel:'+record.id);await cancellation;
  }).then(value=>{settled=true;return value;});
  current=false;resolve({id:'late'});
  await new Promise(done=>setImmediate(done));
  try{assert.deepEqual(events,['cancel:late']);assert.equal(settled,false);}
  finally{finishCancel();}
  assert.equal(await pending,null);
});

test('current admission publishes ownership before returning the record',async()=>{
  const events:string[]=[];const record={id:'current'};
  const accepted=await ownInspection(Promise.resolve(record),()=>true,()=>events.push('owned'),async()=>{events.push('cancel');});
  assert.equal(accepted,record);assert.deepEqual(events,['owned']);
});
