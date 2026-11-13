import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraft,applySelection,editCondition,conditionRows,canonical,historyStep,assertRunBinding} from '../src/thermal/editor-state.js';

test('visual edits preserve advanced physics and keep editor identities outside the strict config',()=>{
  const initial={base_material:{name:'custom',k:167,rho:2700,cp:896},structural:{enabled:true},heat_sources:[{name:'CPU',power_W:95,faces:[0],thermostat:{target_C:80}}]};
  let draft=createDraft(initial);
  const id=draft.editor.sourceIds[0];
  draft=applySelection(draft,'heat',id,{kind:'rectangle',faces:[2,3],area_m2:.0004,
    surface_patch:{center_m:[0,0,0],u_axis:[1,0,0],v_axis:[0,1,0],width_m:.02,height_m:.02},descriptor:{kind:'rectangle',face:2}});
  draft=editCondition(draft,'heat',id,{power_W:65});
  const row=conditionRows(draft.config,'heat')[0];
  assert.equal(row.power_W,65);assert.deepEqual(row.thermostat,{target_C:80});
  assert.deepEqual(draft.config.structural,initial.structural);assert.equal(row.id,undefined);
  assert.deepEqual(row.faces,[2,3]);assert.equal(draft.editor.selections[id].kind,'rectangle');
  const same=createDraft(JSON.parse(JSON.stringify(draft.config)),draft.editor);
  assert.equal(same.editor.sourceIds[0],id);assert.equal(canonical(same.config),canonical(draft.config));
});

test('undo/redo restores one complete physical edit and invalidates redo after new edits',()=>{
  const one=createDraft({heat_sources:[{name:'one',power_W:5,faces:[0]}]});
  const two=editCondition(one,'heat',one.editor.sourceIds[0],{power_W:10});
  let history={past:[],present:one,future:[]} as {past:typeof one[];present:typeof one;future:typeof one[]};
  history=historyStep(history,{type:'commit',value:two});history=historyStep(history,{type:'undo'});
  assert.equal(conditionRows(history.present.config,'heat')[0].power_W,5);
  history=historyStep(history,{type:'redo'});assert.equal(conditionRows(history.present.config,'heat')[0].power_W,10);
  history=historyStep(history,{type:'undo'});history=historyStep(history,{type:'commit',value:editCondition(one,'heat',one.editor.sourceIds[0],{power_W:7})});
  assert.equal(history.future.length,0);
});

test('invalid advanced JSON cannot replace the last editable physics object',()=>{
  assert.throws(()=>createDraft({heat_sources:[null]}),/对象数组/);
  assert.throws(()=>createDraft({cooling:'wrong'}),/对象数组/);
});

test('new geometry binding is a history boundary and cannot be undone to old face ids',()=>{
  const one=createDraft({heat_sources:[{faces:[0],power_W:5}]});
  one.editor.sourceHash='A';one.editor.surfaceHash='surfaceA';
  const two=structuredClone(one);two.editor.sourceHash='B';two.editor.surfaceHash='surfaceB';two.editor.requireConfirmation=true;
  let history=historyStep({past:[],present:one,future:[]},{type:'bind',value:two});
  history=historyStep(history,{type:'undo'});
  assert.equal(history.present.editor.sourceHash,'B');
  assert.throws(()=>assertRunBinding(one,{sourceHash:'B',surfaceHash:'surfaceB'}),/变化/);
  assert.throws(()=>assertRunBinding(two,{sourceHash:'B',surfaceHash:'surfaceB'}),/确认/);
  two.editor.selections[two.editor.sourceIds[0]]={kind:'face',face:0};
  assert.doesNotThrow(()=>assertRunBinding(two,{sourceHash:'B',surfaceHash:'surfaceB'}));
});

test('running an edited point source requires an explicit distribution radius',()=>{
  const draft=createDraft({heat_sources:[{source_type:'point',position_m:[0,0,0],power_W:5}]});
  draft.editor.sourceHash='A';draft.editor.surfaceHash='surfaceA';
  assert.throws(()=>assertRunBinding(draft,{sourceHash:'A',surfaceHash:'surfaceA'}),/分配半径/);
  const fixed=editCondition(draft,'heat',draft.editor.sourceIds[0],{radius_m:.001});
  assert.doesNotThrow(()=>assertRunBinding(fixed,{sourceHash:'A',surfaceHash:'surfaceA'}));
});
