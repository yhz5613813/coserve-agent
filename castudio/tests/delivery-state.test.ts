import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDeliveries} from '../src/thermal/delivery-state.js';
import type {DeliveryRecord} from '../shared/delivery.js';
const record=(id:string,date:string):DeliveryRecord=>({schemaVersion:1,id,taskId:'task',taskRevision:1,phase:'completed',createdAt:date,selected:{kind:'baseline',sourceHash:'hash',runId:'run'},archive:{size:1,sha256:'hash'},files:[]});
test('late export-history responses preserve new download records and do not duplicate them',async()=>{
  let release!:(rows:DeliveryRecord[])=>void;
  const history=new Promise<DeliveryRecord[]>(resolve=>{release=resolve;});
  let visible:DeliveryRecord[]=[];
  const loaded=history.then(rows=>{visible=mergeDeliveries(visible,rows);});
  const created=record('new','2026-11-12T12:00:00Z');
  visible=mergeDeliveries(visible,[created]);
  release([record('old','2026-11-12T11:00:00Z')]);await loaded;
  assert.deepEqual(visible.map(r=>r.id),['new','old']);
  visible=mergeDeliveries(visible,[created]);assert.equal(visible.length,2);
});
