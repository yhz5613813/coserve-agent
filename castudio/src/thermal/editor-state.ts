import type {ThermalConfig,ThermalEditorState,ThermalSelectionResult} from '../../shared/thermal';

export type Row=Record<string,unknown>;
export type Draft={config:ThermalConfig;editor:ThermalEditorState};
export type ConditionKind='heat'|'cooling';
const key=(kind:ConditionKind)=>kind==='heat'?'heat_sources':'cooling';
const ids=(draft:Draft,kind:ConditionKind)=>kind==='heat'?draft.editor.sourceIds:draft.editor.coolingIds;
export function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export function conditionRows(config:ThermalConfig,kind:ConditionKind):Row[]{
  const value=config[key(kind)];return Array.isArray(value)?value as Row[]:[];
}
export function createDraft(config:ThermalConfig,editor?:ThermalEditorState):Draft{
  for(const name of ['heat_sources','cooling'])if(config[name]!==undefined&&(!Array.isArray(config[name])||(config[name] as unknown[]).some(row=>!row||typeof row!=='object'||Array.isArray(row))))throw new Error(name+' 必须为对象数组');
  const copy=structuredClone(config),used=new Set<string>();
  const identity=(old:string[]|undefined,count:number)=>Array.from({length:count},(_,i)=>{
    const id=old?.[i]&&!used.has(old[i])?old[i]:crypto.randomUUID();used.add(id);return id;
  });
  const state:ThermalEditorState={schema_version:1,sourceIds:identity(editor?.sourceIds,conditionRows(copy,'heat').length),
    coolingIds:identity(editor?.coolingIds,conditionRows(copy,'cooling').length),selections:structuredClone(editor?.selections||{}),
    inspectionId:editor?.inspectionId,sourceHash:editor?.sourceHash,surfaceHash:editor?.surfaceHash,requireConfirmation:editor?.requireConfirmation};
  for(const id of Object.keys(state.selections))if(!used.has(id))delete state.selections[id];
  return {config:copy,editor:state};
}
export function editCondition(draft:Draft,kind:ConditionKind,id:string,change:Row):Draft{
  const next=structuredClone(draft),index=ids(next,kind).indexOf(id);
  if(index<0)return draft;
  const rows=conditionRows(next.config,kind);rows[index]={...rows[index],...change};next.config[key(kind)]=rows;
  return next;
}
export function applySelection(draft:Draft,kind:ConditionKind,id:string,selection:ThermalSelectionResult):Draft{
  const next=structuredClone(draft),index=ids(next,kind).indexOf(id);if(index<0)return draft;
  const rows=conditionRows(next.config,kind),row={...rows[index]};
  for(const name of ['selector','faces','surface_box','surface_patch','position_m'])delete row[name];
  row.faces=selection.faces;
  if(selection.surface_patch)row.surface_patch=selection.surface_patch;
  if(kind==='heat'){
    row.source_type=['point','embedded'].includes(selection.kind)?'point':'surface';
    row.placement=selection.kind==='embedded'?'embedded':'surface';
    if(selection.position_m)row.position_m=selection.position_m;
  }
  rows[index]=row;next.config[key(kind)]=rows;next.editor.selections[id]=selection.descriptor;return next;
}
export function addCondition(draft:Draft,kind:ConditionKind,copyId?:string):{draft:Draft;id:string}{
  const next=structuredClone(draft),rows=conditionRows(next.config,kind),oldIndex=copyId?ids(next,kind).indexOf(copyId):-1,id=crypto.randomUUID();
  const row:Row=oldIndex>=0?structuredClone(rows[oldIndex]):kind==='heat'?
    {name:'热源 '+(rows.length+1),source_type:'surface',placement:'surface',start_s:0,end_s:Number(next.config.duration_s)||60}:
    {name:'散热区 '+(rows.length+1),ambient_C:next.config.ambient_C??25,radiation:false,emissivity:next.config.emissivity??.8};
  if(oldIndex>=0)row.name=String(row.name||'条件')+' 副本';
  rows.push(row);next.config[key(kind)]=rows;ids(next,kind).push(id);
  if(copyId&&next.editor.selections[copyId])next.editor.selections[id]=structuredClone(next.editor.selections[copyId]);
  return {draft:next,id};
}
export function removeCondition(draft:Draft,kind:ConditionKind,id:string):Draft{
  const next=structuredClone(draft),index=ids(next,kind).indexOf(id);if(index<0)return draft;
  conditionRows(next.config,kind).splice(index,1);ids(next,kind).splice(index,1);delete next.editor.selections[id];return next;
}
export type DraftHistory={past:Draft[];present:Draft;future:Draft[]};
export function assertRunBinding(draft:Draft,binding:{sourceHash?:string;surfaceHash?:string}):void{
  if(draft.editor.sourceHash!==binding.sourceHash||draft.editor.surfaceHash!==binding.surfaceHash)throw new Error('模型已变化，请重新准备热模型并确认选区');
  if(draft.editor.requireConfirmation&&[...draft.editor.sourceIds,...draft.editor.coolingIds].some(id=>!draft.editor.selections[id]))throw new Error('模型已变化，请重新确认每个热源和散热区');
  for(const heat of conditionRows(draft.config,'heat'))if((heat.source_type==='point'||heat.placement==='embedded')&&!(typeof heat.radius_m==='number'&&Number.isFinite(heat.radius_m)&&heat.radius_m>0))throw new Error('请明确填写点热源的功率分配半径');
}
export function historyStep(history:DraftHistory,action:{type:'undo'|'redo'}|{type:'commit'|'reset'|'bind';value:Draft}):DraftHistory{
  if(action.type==='reset')return {past:[],present:action.value,future:[]};
  if(action.type==='bind'&&(history.present.editor.sourceHash!==action.value.editor.sourceHash||history.present.editor.surfaceHash!==action.value.editor.surfaceHash))return {past:[],present:action.value,future:[]};
  if(action.type==='commit'||action.type==='bind')return canonical(history.present)===canonical(action.value)?history:
    {past:[...history.past,history.present].slice(-60),present:action.value,future:[]};
  if(action.type==='undo'&&history.past.length)return {past:history.past.slice(0,-1),present:history.past.at(-1)!,future:[history.present,...history.future]};
  if(action.type==='redo'&&history.future.length)return {past:[...history.past,history.present],present:history.future[0],future:history.future.slice(1)};
  return history;
}
