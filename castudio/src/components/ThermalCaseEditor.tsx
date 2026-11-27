import {ownInspection} from '../thermal/inspection-admission';
import {forwardRef,useEffect,useImperativeHandle,useMemo,useReducer,useRef,useState} from 'react';
import type {MutableRefObject} from 'react';
import {request} from '../api';
import type {Artifact} from '../../shared/types';
import type {SurfacePatch,ThermalCatalog,ThermalConfig,ThermalEditorState,ThermalInspection,ThermalRun,ThermalSelection,ThermalSelectionResult,ThermalSurface,Vec3} from '../../shared/thermal';
import {ThermalScene,type ThermalOverlay,type ThermalPose} from './ThermalScene';
import {ThermalPowerCurve,type PowerPoint} from './ThermalPowerCurve';
import {addCondition,applySelection,assertRunBinding,canonical,conditionRows,createDraft,editCondition,historyStep,removeCondition,type ConditionKind,type Draft,type Row} from '../thermal/editor-state';
import {rectangleOverlay,cross} from '../thermal/patch-geometry';
import {Box,Copy,Plus,Redo2,Thermometer,Trash2,Undo2} from 'lucide-react';
import {Empty,Step,type StepState} from './Steps';
import {Numeric} from './Numeric';
import {fileLabel} from './FilePanel';

const send=(method:string,body:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const initial:ThermalConfig={name:'散热评估（示例）',base_material:{name:'铝（示例）',k:205,rho:2700,cp:900},analysis_mode:'transient',initial_C:25,ambient_C:25,default_h:10,duration_s:60,dt_s:2,save_s:10,mesh_size_m:.004,air_gap_enabled:false,heat_sources:[{name:'顶部热源（示例）',source_type:'surface',placement:'surface',power_W:5,start_s:0,end_s:60,selector:'+z'}]};
const colors=['#ffb56a','#ff6b6b','#ffd166','#d48fff','#f48fb1','#9ccc65'];
/** `reuse` loads a run's case into the editor; `rerun` saves and runs the case now in the editor and rejects with the reason when it cannot. */
export type ThermalCaseHandle={reuse:(run:ThermalRun)=>void;rerun:()=>Promise<void>};
/**
 * Renders steps 1–3 of the thermal page; `visible` is whether the page is shown, `step` the page's current step. `unsaved` is kept true while the case differs from what is saved.
 * `currentModel` is the part's current model resolved to a STEP/STL path when it has one (undefined when the part has no model): it is the case's model, also over a saved case, and a later change is followed; when it is not a thermal input the model stays unselected with a one-line reason.
 */
type Props={projectId:string;partName:string;files:Artifact[];currentModel?:string;busy:boolean;visible:boolean;step:number;onStep:(step:number)=>void;pose:MutableRefObject<ThermalPose|null>;unsaved?:MutableRefObject<boolean>;
  changed:()=>Promise<void>;onRun:(run:ThermalRun)=>void;onDraft:(source:string,config:ThermalConfig)=>void};

/** One readable line for a failed runtime check; the raw interpreter output stays behind a disclosure. */
const runtimeReason=(raw:string)=>/No module named|ModuleNotFoundError/.test(raw)?'所选 Python 解释器里没有安装 thermal-sim 包':/ENOENT|not found|No such file/i.test(raw)?'找不到所填的 Python 解释器':/绝对路径|设备/.test(raw)?raw:'环境检测未通过';
function thermalFaces(surface:ThermalSurface,row:Row):number[]{
  if(Array.isArray(row.faces))return row.faces.filter((v):v is number=>Number.isInteger(v)&&v>=0&&v<surface.faces.length/3);
  if(typeof row.selector!=='string')return [];
  if(row.selector==='all')return Array.from({length:surface.faces.length/3},(_,i)=>i);
  const match=/^([+-])([xyz])$/.exec(row.selector);if(!match)return [];
  const axis='xyz'.indexOf(match[2]),sign=match[1]==='+'?1:-1,ids:number[]=[];
  for(let i=0;i<surface.faces.length/3;i++){
    const p=[0,1,2].map(j=>surface.points.slice(surface.faces[i*3+j]*3,surface.faces[i*3+j]*3+3));
    const a=p[1].map((v,j)=>v-p[0][j]) as Vec3,b=p[2].map((v,j)=>v-p[0][j]) as Vec3,n=cross(a,b);
    if(n[axis]*sign/Math.max(1e-30,Math.hypot(...n))>=.9)ids.push(i);
  }
  return ids;
}

function legacyPatch(surface:ThermalSurface,faces:number[],row:Row):SurfacePatch|undefined{
  const box=row.surface_box as {min_m?:number[];max_m?:number[]}|undefined;
  if(!box||!Array.isArray(box.min_m)||!Array.isArray(box.max_m)||!faces.length)return;
  const group=surface.groups[surface.face_groups[faces[0]]];
  if(!group?.planar||faces.some(face=>surface.face_groups[face]!==group.id))return;
  const normalAxis=group.normal.findIndex(value=>Math.abs(value)>1-1e-6);if(normalAxis<0)return;
  const center=box.min_m.map((value,i)=>(value+box.max_m![i])/2) as Vec3;center[normalAxis]=group.center_m[normalAxis];
  const dimensions=box.min_m.map((value,i)=>box.max_m![i]-value);
  return {center_m:center,u_axis:group.u_axis,v_axis:group.v_axis,
    width_m:dimensions.reduce((sum,value,i)=>sum+Math.abs(group.u_axis[i])*value,0),height_m:dimensions.reduce((sum,value,i)=>sum+Math.abs(group.v_axis[i])*value,0)};
}

export const ThermalCaseEditor=forwardRef<ThermalCaseHandle,Props>(function ThermalCaseEditor({projectId,partName,files,currentModel,busy,visible,step,onStep,pose,unsaved,changed,onRun,onDraft},ref){
  const models=files.filter(file=>/\.(step|stp|stl)$/i.test(file.path)&&!file.path.startsWith('simulations/'));
  const latest=useRef({currentModel,models}),followed=useRef(currentModel);latest.current={currentModel,models};
  const pick=(saved?:string)=>{const {currentModel,models}=latest.current;return currentModel===undefined?saved||models[0]?.path||'':models.some(file=>file.path===currentModel)?currentModel:'';};
  const [source,setSource]=useState(()=>pick()),[units,setUnits]=useState('mm');
  const [history,dispatch]=useReducer(historyStep,{past:[],present:createDraft(initial),future:[]});
  const draft=history.present,config=draft.config,current=useRef(draft);current.current=draft;
  const [loaded,setLoaded]=useState(false),[saved,setSaved]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [inspection,setInspection]=useState<ThermalInspection|null>(null),[surface,setSurface]=useState<ThermalSurface|null>(null);
  const [catalog,setCatalog]=useState<ThermalCatalog|null>(null),[executable,setExecutable]=useState(''),[runtimeMessage,setRuntimeMessage]=useState(''),[runtimeError,setRuntimeError]=useState('');
  const [selected,setSelected]=useState(''),[mode,setMode]=useState<ThermalSelection['kind']>('rectangle'),[tool,setTool]=useState<'orbit'|'place'>('orbit');
  const [resolving,setResolving]=useState(false),[selectionError,setSelectionError]=useState(''),[preview,setPreview]=useState<ThermalSelection|null>(null);
  const [raw,setRaw]=useState(JSON.stringify(initial,null,2)),[rawError,setRawError]=useState(''),rawEditing=useRef(false);
  const epoch=useRef(0),selectionSequence=useRef(0),resolver=useRef<AbortController|null>(null),owned=useRef<{project:string;id:string}|null>(null);
  // The selected condition decides whether the form edits a heat source or a cooling region.
  const allIds=[...draft.editor.sourceIds,...draft.editor.coolingIds],activeId=allIds.includes(selected)?selected:allIds[0]||'';
  const kind:ConditionKind=draft.editor.coolingIds.includes(activeId)?'cooling':'heat';
  const rows=conditionRows(config,kind),identities=kind==='heat'?draft.editor.sourceIds:draft.editor.coolingIds;
  const index=identities.indexOf(activeId),row=rows[index];
  const locked=busy||working||resolving||inspection?.state==='running';
  const commit=(value:Draft)=>dispatch({type:'commit',value});
  const setConfig=(change:Row)=>commit({...current.current,config:{...current.current.config,...change}});
  const edit=(change:Row)=>{if(activeId)commit(editCondition(current.current,kind,activeId,change));};
  const editorFor=(record:ThermalInspection,base:Draft)=>{
    const changed=!!base.editor.sourceHash&&(base.editor.sourceHash!==record.sourceHash||base.editor.surfaceHash!==record.surfaceHash);
    return {...base.editor,inspectionId:record.id,sourceHash:record.sourceHash,surfaceHash:record.surfaceHash,
      requireConfirmation:changed||base.editor.requireConfirmation,selections:changed?{}:base.editor.selections};
  };
  useEffect(()=>{
    const generation=++epoch.current;let live=true;setLoaded(false);setSurface(null);setInspection(null);setError('');
    resolver.current?.abort();
    void request<{source?:string;units?:string;config?:ThermalConfig;editor?:ThermalEditorState}>(`api/projects/${projectId}/thermal/case`).then(value=>{
      if(!live||epoch.current!==generation)return;
      const restored=createDraft(value.config||initial,value.editor),chosen=pick(value.source);followed.current=latest.current.currentModel;dispatch({type:'reset',value:restored});setSource(chosen);setUnits(value.units||'mm');
      setSaved(canonical({source:chosen,units:value.units||'mm',config:restored.config,editor:restored.editor}));setLoaded(true);
    }).catch(reason=>{if(live){setError((reason as Error).message);setLoaded(true);}});
    void request<{executable:string}>('api/thermal/runtime').then(value=>{if(live)setExecutable(value.executable);}).catch(reason=>{if(live)setRuntimeError((reason as Error).message);});
    return()=>{live=false;epoch.current++;resolver.current?.abort();const task=owned.current;if(task?.project===projectId){owned.current=null;void request(`api/projects/${task.project}/thermal/inspections/${task.id}/cancel`,send('POST',{})).catch(()=>{});}};
  },[projectId]);
  useEffect(()=>{onDraft(source,config);if(!rawEditing.current)setRaw(JSON.stringify(config,null,2));},[source,config]);
  // A model opened in 模型 after the case loaded becomes the case's model, as a pick in the selector would; a locked page applies it once unlocked.
  useEffect(()=>{if(!loaded||locked||currentModel===undefined||followed.current===currentModel)return;followed.current=currentModel;setSource(pick());setSurface(null);setInspection(null);setTool('orbit');},[currentModel,loaded,locked]);
  // Reading the schema runs the configured interpreter, so its failure is the runtime check of this page.
  const loadCatalog=()=>request<ThermalCatalog>('api/thermal/schema').then(value=>{setCatalog(value);setRuntimeError('');}).catch(reason=>setRuntimeError((reason as Error).message));
  useEffect(()=>{if(visible&&!catalog)void loadCatalog();},[visible]);
  const [probing,setProbing]=useState(false);
  const saveRuntime=()=>{setProbing(true);setRuntimeMessage('');void request<{message:string}>('api/thermal/runtime',send('PUT',{executable:executable.trim()})).then(value=>{setRuntimeMessage(value.message);return loadCatalog();}).catch(reason=>setRuntimeError((reason as Error).message)).finally(()=>setProbing(false));};
  useEffect(()=>{
    const type=row?.source_type==='point'?(row.placement==='embedded'?'embedded':'point'):row?.surface_patch||(!row?.faces&&!row?.selector)?'rectangle':'face';setMode(kind==='cooling'&&['point','embedded'].includes(type)?'face':type);setTool('orbit');
  },[activeId,kind,row?.source_type,row?.placement,!!row?.surface_patch,!!row?.faces,row?.selector]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(!visible||locked||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='z'||(event.target as HTMLElement)?.closest('input,textarea,select'))return;
      event.preventDefault();dispatch({type:event.shiftKey?'redo':'undo'});
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[visible,locked]);
  // A freshly prepared (or restored) thermal surface moves a page still on step 1 to placing heat sources.
  useEffect(()=>{if(surface&&step===1)onStep(2);},[surface]);
  useImperativeHandle(ref,()=>({reuse:run=>{
    epoch.current++;resolver.current?.abort();const task=owned.current;if(task){owned.current=null;void request(`api/projects/${task.project}/thermal/inspections/${task.id}/cancel`,send('POST',{})).catch(()=>{});}setWorking(false);setResolving(false);setSource(run.source);setUnits(run.units);setInspection(null);setSurface(null);setTool('orbit');
    const next=createDraft(run.config);next.editor.sourceHash=run.sourceHash;next.editor.surfaceHash=run.surfaceHash;dispatch({type:'reset',value:next});
  },rerun:async()=>{
    if(!surface||inspection?.state!=='succeeded'){onStep(1);throw new Error('热模型需要重新准备：点击「准备热模型」，确认热源后再运行');}
    const failure=await save(true);if(failure)throw new Error(failure);
  }}));

  async function loadSurface(record:ThermalInspection,generation:number){
    const value=await request<ThermalSurface>(`api/projects/${projectId}/thermal/inspections/${record.id}/surface`);
    if(epoch.current!==generation)return;
    if(record.stale)throw new Error('模型已变化，请重新准备热模型并确认选区');
    setInspection(record);setSurface(value);dispatch({type:'bind',value:{...current.current,editor:editorFor(record,current.current)}});
  }
  useEffect(()=>{
    if(!visible||!loaded||surface||inspection||!draft.editor.inspectionId)return;
    const generation=epoch.current;
    void request<ThermalInspection>(`api/projects/${projectId}/thermal/inspections/${draft.editor.inspectionId}`).then(record=>{
      if(epoch.current!==generation)return;
      if(record.state==='succeeded'&&record.source===source&&record.units===units)return loadSurface(record,generation);
    }).catch(reason=>{if(epoch.current===generation)setError((reason as Error).message);});
  },[visible,loaded,surface,inspection,draft.editor.inspectionId]);

  async function prepare(){
    setWorking(true);setError('');setSelectionError('');resolver.current?.abort();const generation=epoch.current;
    try{
      const admitted=await ownInspection(
        request<ThermalInspection>(`api/projects/${projectId}/thermal/inspections`,send('POST',{source,units})),
        ()=>epoch.current===generation,
        record=>{owned.current={project:projectId,id:record.id};setInspection(record);setSurface(null);},
        record=>request(`api/projects/${projectId}/thermal/inspections/${record.id}/cancel`,send('POST',{})));
      if(!admitted||epoch.current!==generation)return;
      let record=admitted;
      while(record.state==='running'){
        await new Promise(resolve=>setTimeout(resolve,350));if(epoch.current!==generation)return;
        record=await request<ThermalInspection>(`api/projects/${projectId}/thermal/inspections/${record.id}`);
        if(epoch.current!==generation)return;
        setInspection(record);
      }
      owned.current=null;if(record.state!=='succeeded')throw new Error(record.error||'热模型准备未完成');
      await loadSurface(record,generation);
    }catch(reason){if(epoch.current===generation)setError((reason as Error).message);}
    finally{if(epoch.current===generation)setWorking(false);}
  }
  async function resolveSelection(selection:ThermalSelection){
    if(!inspection||!surface||!activeId)return;
    resolver.current?.abort();const abort=new AbortController();resolver.current=abort;
    const sequence=++selectionSequence.current,generation=epoch.current,targetId=activeId,targetKind=kind;
    setResolving(true);setSelectionError('');
    const previous=current.current.editor.selections[targetId];
    const descriptor={...selection,face:selection.face??previous?.face??(Array.isArray(row?.faces)?row.faces[0] as number:undefined)};
    try{
      const result=await request<ThermalSelectionResult>(`api/projects/${projectId}/thermal/inspections/${inspection.id}/resolve`,{...send('POST',{surfaceHash:surface.surface_sha256,selection:descriptor}),signal:abort.signal});
      if(sequence!==selectionSequence.current||epoch.current!==generation)return;
      commit(applySelection(current.current,targetKind,targetId,result));setTool('orbit');
    }catch(reason){if(!abort.signal.aborted&&epoch.current===generation)setSelectionError((reason as Error).message);}
    finally{if(sequence===selectionSequence.current&&epoch.current===generation){setResolving(false);setPreview(null);}}
  }
  const overlays=useMemo(()=>{
    if(!surface)return [];
    const values:ThermalOverlay[]=[];
    for(const type of ['heat','cooling'] as const){
      const ids=type==='heat'?draft.editor.sourceIds:draft.editor.coolingIds;
      conditionRows(config,type).forEach((condition,i)=>{
        const faces=thermalFaces(surface,condition);
        values.push({id:ids[i],name:String(condition.name||'未命名'),color:type==='heat'?colors[i%colors.length]:'#72d6c2',faces,
          position:Array.isArray(condition.position_m)?condition.position_m as Vec3:undefined,patch:condition.surface_patch as SurfacePatch|undefined||legacyPatch(surface,faces,condition),
          embedded:condition.placement==='embedded',radius:condition.source_type==='point'?Number(condition.radius_m)||.001:undefined});
      });
    }
    return values;
  },[surface,config,draft.editor.sourceIds,draft.editor.coolingIds]);
  const active=overlays.find(overlay=>overlay.id===activeId),patch=active?.patch;
  const area=surface&&active&&row?.source_type!=='point'&&row?.placement!=='embedded'?(patch?rectangleOverlay(surface,active.faces,patch).area_m2:active.faces.reduce((sum,face)=>{
    const p=[0,1,2].map(i=>surface.points.slice(surface.faces[face*3+i]*3,surface.faces[face*3+i]*3+3)),a=p[1].map((v,i)=>v-p[0][i]) as Vec3,b=p[2].map((v,i)=>v-p[0][i]) as Vec3;
    return sum+Math.hypot(...cross(a,b))/2;
  },0)):0;
  const unconfirmed=draft.editor.requireConfirmation?[...draft.editor.sourceIds,...draft.editor.coolingIds].filter(id=>!draft.editor.selections[id]).length:0;
  const caseValue=()=>({source,units,config:current.current.config,editor:current.current.editor});
  /** Saves the case and optionally starts a run; resolves to the failure message, empty when it worked. */
  async function save(run=false):Promise<string>{
    setWorking(true);setError('');const generation=epoch.current;
    try{
      if(rawError)throw new Error('请先修正工况 JSON');
      if(run){
        if(!inspection||inspection.state!=='succeeded'||!surface)throw new Error('请先准备可编辑热模型');
        assertRunBinding(current.current,{sourceHash:inspection.sourceHash,surfaceHash:surface.surface_sha256});
        await request(`api/projects/${projectId}/thermal/inspections/${inspection.id}/validate`,send('POST',{config:current.current.config}));
      }
      const value=caseValue();await request(`api/projects/${projectId}/thermal/case`,send('PUT',value));setSaved(canonical(value));await changed();
      if(run){const record=await request<ThermalRun>(`api/projects/${projectId}/thermal`,send('POST',{...value,inspectionId:inspection!.id,surfaceHash:surface!.surface_sha256,expectedHash:inspection!.sourceHash}));if(epoch.current===generation)onRun(record);}
      return '';
    }catch(reason){if(epoch.current===generation)setError((reason as Error).message);return (reason as Error).message;}
    finally{if(epoch.current===generation)setWorking(false);}
  }
  const scalar=(name:string,label:string,factor=1)=><Numeric key={name} label={label} factor={factor} value={config[name]} onCommit={value=>setConfig({[name]:value})}/>;
  const material=(config.base_material||{}) as Row;
  const position=preview?.center_m||patch?.center_m||active?.position;
  const dirty=saved!==canonical({source,units,config,editor:draft.editor});
  // Read by the app before it switches part; a case that never loaded has nothing to lose.
  if(unsaved)unsaved.current=!!saved&&dirty;
  useEffect(()=>()=>{if(unsaved)unsaved.current=false;},[]);

  const shown=step>=2&&step<=3&&!surface?1:step;
  const stepState=(n:number,valid:boolean):StepState=>n===shown?'current':!surface&&n>1?'locked':n<shown&&valid?'done':'open';
  const heatCount=draft.editor.sourceIds.length,coolCount=draft.editor.coolingIds.length,name=source.split('/').pop();
  const errorLine=error&&<p role="alert" className="form-error">{error}</p>;
  const kindLabel=kind==='heat'?'热源':'散热区';
  const conditions=(['heat','cooling'] as const).flatMap(type=>conditionRows(config,type).map((item,i)=>({id:(type==='heat'?draft.editor.sourceIds:draft.editor.coolingIds)[i],name:String(item.name||'未命名'),type,color:type==='heat'?colors[i%colors.length]:'#72d6c2'})));
  const add=(type:ConditionKind)=>{const next=addCondition(current.current,type);commit(next.draft);setSelected(next.id);setMode('rectangle');setTool('place');};
  const modeSelect=<label className="ui-field">作用方式<select aria-label={`${kindLabel}作用方式`} value={mode} onChange={event=>{setMode(event.target.value as ThermalSelection['kind']);setTool('place');}}>
    <option value="rectangle">矩形面区域</option><option value="face">整面选择</option>{kind==='heat'&&<><option value="point">表面点热源</option><option value="embedded">嵌入式点热源</option></>}
  </select></label>;
  const runtimeField=<>
    <label className="ui-field">热仿真 Python 解释器<input aria-label="热仿真 Python 解释器" placeholder="/path/to/python（已安装 thermal-sim）" spellCheck={false} value={executable} onChange={event=>setExecutable(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&executable.trim()&&!probing&&!locked)saveRuntime();}}/></label>
    <div className="ui-actions"><button className="button" disabled={!executable.trim()||probing||locked} onClick={saveRuntime}>{probing?'正在检测…':'检测并保存'}</button>{runtimeMessage&&!runtimeError&&<span className="ui-hint" role="status">{runtimeMessage}</span>}</div>
  </>;

  return <>
    <Step n={1} title="热模型" state={stepState(1,!!surface)} summary={`零件：${partName} · ${runtimeError?'热仿真环境不可用':surface?`模型：${name} · 已准备`:inspection?.state==='running'?`模型：${name} · 正在准备…`:name?`模型：${name}`:'选择 STEP 或 STL 模型'}`} onOpen={()=>onStep(1)}>
      {runtimeError&&<div className="ui-stack">
        <p role="alert" className="form-error">热仿真环境不可用：{runtimeReason(runtimeError)}。</p>
        <p className="ui-hint">填写已安装 thermal-sim 的 Python 解释器绝对路径，检测通过后即可继续。</p>
        {runtimeField}
        <details className="ui-disclosure"><summary>错误详情</summary><pre className="ui-log">{runtimeError}</pre></details>
      </div>}
      <fieldset className="ui-stack" disabled={locked||!loaded}>
        {models.length?<label className="ui-field">模型<select aria-label="热仿真模型" value={source} onChange={event=>{setSource(event.target.value);setSurface(null);setInspection(null);setTool('orbit');}}><option value="">选择 STEP/STL</option>{models.map(file=><option key={file.path} value={file.path} title={file.path}>{fileLabel(file)}</option>)}</select></label>
        :<Empty icon={<Box size={20}/>} text="项目里还没有 STEP 或 STL 模型。在「模型」页导入，或在「参数」页发布。"/>}
        {models.length>0&&!source&&currentModel!==undefined&&!models.some(file=>file.path===currentModel)&&<p className="ui-hint warn" role="status">当前模型 {currentModel.split('/').pop()} 不是 STEP 或 STL，热仿真需要其中一种，请选择其他模型。</p>}
        {/\.stl$/i.test(source)&&<label className="ui-field">STL 长度单位<select value={units} onChange={event=>{setUnits(event.target.value);setSurface(null);setInspection(null);}}><option value="mm">毫米</option><option value="cm">厘米</option><option value="m">米</option></select></label>}
      </fieldset>
      {inspection?.state==='running'?<div className="ui-actions" role="status"><progress max={100} value={inspection.progress?.progress||0}/><span className="ui-hint">{inspection.progress?.detail||'正在准备热表面…'}</span><button className="text-button" onClick={()=>void request<ThermalInspection>(`api/projects/${projectId}/thermal/inspections/${inspection.id}/cancel`,send('POST',{})).then(setInspection).catch(reason=>setError((reason as Error).message))}>取消</button></div>
        :models.length>0&&<p className="ui-hint">把模型转换成可选面的热表面，之后在三维视图里放置热源。</p>}
      {errorLine}
      <div className="ui-actions">{surface?<><button className="button primary" onClick={()=>onStep(2)}>下一步</button><button className="button" disabled={locked||!loaded||!source||!!runtimeError} onClick={()=>void prepare()}>重新准备</button></>
        :<><button className="button primary" disabled={locked||!loaded||!source||!!runtimeError} onClick={()=>void prepare()}>准备热模型</button>{(runtimeError||!source)&&<span className="ui-hint">{runtimeError?'先配置热仿真环境':models.length?'先选择模型':'先导入模型'}</span>}</>}</div>
      {(!runtimeError||inspection?.state==='failed')&&<details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
        {!runtimeError&&runtimeField}
        {inspection?.state==='failed'&&<pre className="ui-log">{inspection.log}</pre>}
      </div></details>}
    </Step>

    <Step n={2} title="热源与散热" state={stepState(2,heatCount>0&&!unconfirmed)} summary={!surface?'先准备热模型':`${heatCount} 个热源 · ${coolCount} 个散热区${unconfirmed?` · ${unconfirmed} 个需重新选区`:''}`} onOpen={()=>onStep(2)}>
      <fieldset className="ui-stack" disabled={locked}>
        <div className="ui-actions" role="group" aria-label="热源与散热区">
          {conditions.map(item=><button key={item.id} className={'ui-chip thermal-legend-chip'+(item.id===activeId?' active':'')} aria-pressed={item.id===activeId} title={`${item.type==='heat'?'热源':'散热区'}：${item.name}`} style={{borderLeftColor:item.color}} onClick={()=>setSelected(item.id)}>{item.name}</button>)}
          <button className="text-button" disabled={heatCount>=16} title={heatCount>=16?'最多 16 个热源':undefined} onClick={()=>add('heat')}><Plus size={13}/>热源</button>
          <button className="text-button" disabled={coolCount>=16} title={coolCount>=16?'最多 16 个散热区':undefined} onClick={()=>add('cooling')}><Plus size={13}/>散热区</button>
        </div>
        {surface&&visible&&shown===2&&<>
          <div className="ui-actions"><div className="ui-segmented" role="group" aria-label="视图工具"><button className={'button'+(tool==='orbit'?' active':'')} aria-pressed={tool==='orbit'} onClick={()=>setTool('orbit')}>旋转</button><button className={'button'+(tool==='place'?' active':'')} aria-pressed={tool==='place'} disabled={!row} title={row?undefined:'先新增热源或散热区'} onClick={()=>setTool('place')}>放置 / 选面</button></div><span className="ui-hint">{!row?'先新增热源或散热区':tool==='place'?`点击模型放置「${String(row.name||'未命名')}」`:'拖动中心移动，拖动边角调整尺寸'}</span></div>
          <ThermalScene identity={inspection!.id} sourceHash={inspection!.sourceHash} surface={surface} pose={pose} overlays={overlays} activeId={activeId} tool={tool} disabled={locked}
            onSelect={setSelected}
            onPlace={(face,center_m)=>{const group=surface.groups[surface.face_groups[face]];const extent=Math.max(...surface.bounds_m[1].map((n,i)=>n-surface.bounds_m[0][i]));void resolveSelection({kind:mode,face,center_m,
              ...(mode==='rectangle'?{width_m:patch?.width_m||extent/4,height_m:patch?.height_m||extent/4,u_axis:group.u_axis,v_axis:group.v_axis}:{})});}}
            onCommit={selection=>void resolveSelection(selection)} onPreview={setPreview} onError={setError}/>
        </>}
        {row?<>
          <div className="ui-actions"><strong className="thermal-condition-title">{kindLabel} · {String(row.name||'未命名')}</strong><span className="ui-spacer"/>
            <button className="icon-button" aria-label={`复制${kindLabel}`} title={rows.length>=16?`最多 16 个${kindLabel}`:`复制这个${kindLabel}`} disabled={rows.length>=16} onClick={()=>{const next=addCondition(current.current,kind,activeId);commit(next.draft);setSelected(next.id);}}><Copy size={14}/></button>
            <button className="icon-button" aria-label={`删除${kindLabel}`} title={`删除这个${kindLabel}（可撤销）`} onClick={()=>commit(removeCondition(current.current,kind,activeId))}><Trash2 size={14}/></button>
          </div>
          <div className="ui-grid"><label className="ui-field">名称<input aria-label={`${kindLabel}名称`} value={String(row.name||'')} onChange={event=>edit({name:event.target.value})}/></label>{modeSelect}</div>
          {kind==='heat'?<div className="ui-grid"><Numeric label="总功率 W" value={row.power_W} onCommit={value=>edit({power_W:value})}/>{(row.source_type==='point'||row.placement==='embedded')&&<Numeric label="功率分配半径 mm" factor={1000} value={row.radius_m} onCommit={value=>edit({radius_m:value})}/>}</div>
            :<div className="ui-grid"><Numeric label="局部对流 W/(m²·K)" value={row.h} onCommit={value=>edit({h:value})}/><Numeric label="局部环境 °C" value={row.ambient_C} onCommit={value=>edit({ambient_C:value})}/></div>}
          {!!area&&<p className="ui-hint">选区 {(area*1e6).toFixed(3)} mm²{kind==='heat'&&` · 平均热流密度 ${Number(row.power_W)>0?(Number(row.power_W)/area).toPrecision(5):'待填写功率'} W/m²`}</p>}
        </>:<Empty icon={<Thermometer size={20}/>} text="还没有热源或散热区。点击「＋ 热源」新增，再在模型上点击放置。"/>}
      </fieldset>
      {resolving&&<p className="ui-hint" role="status">正在核对选区与实际面积…</p>}{selectionError&&<p role="alert" className="form-error">{selectionError}</p>}
      {!!unconfirmed&&<p role="alert" className="form-error">模型或热表面已变化，还有 {unconfirmed} 个条件需要重新选区</p>}
      {errorLine}
      <div className="ui-actions"><button className="button primary" disabled={unconfirmed>0} title={unconfirmed?'还有条件需要重新选区':undefined} onClick={()=>onStep(3)}>下一步</button><span className="ui-spacer"/>
        <button className="icon-button" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={locked||!history.past.length} onClick={()=>dispatch({type:'undo'})}><Undo2 size={14}/></button>
        <button className="icon-button" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled={locked||!history.future.length} onClick={()=>dispatch({type:'redo'})}><Redo2 size={14}/></button>
      </div>
      {row&&<details className="ui-disclosure"><summary>高级</summary><fieldset className="ui-stack" disabled={locked}>
        {position&&<div className="ui-grid">{(['X','Y','Z'] as const).map((axis,i)=><Numeric key={axis} label={axis+' 坐标 mm'} factor={1000} value={position[i]} onCommit={value=>{if(value===undefined)return;const center_m=[...position] as Vec3;center_m[i]=value;void resolveSelection({...draft.editor.selections[activeId],kind:patch?'rectangle':active?.embedded?'embedded':'point',...(patch||{}),center_m});}}/>)}</div>}
        {patch&&<div className="ui-grid"><Numeric label="贴片宽度 mm" factor={1000} value={patch.width_m} onCommit={value=>{if(value!==undefined)void resolveSelection({...draft.editor.selections[activeId],kind:'rectangle',...patch,width_m:value});}}/><Numeric label="贴片高度 mm" factor={1000} value={patch.height_m} onCommit={value=>{if(value!==undefined)void resolveSelection({...draft.editor.selections[activeId],kind:'rectangle',...patch,height_m:value});}}/></div>}
        {kind==='heat'?<>
          <div className="ui-grid"><Numeric label="开始时间 s" value={row.start_s??0} onCommit={value=>edit({start_s:value})}/><Numeric label="结束时间 s" value={row.end_s} onCommit={value=>edit({end_s:value})}/></div>
          {(row.source_type==='point'||row.placement==='embedded')&&<p className="ui-hint">分配半径决定功率分到附近哪些节点，请按实际作用范围填写；热源标记不是独立 CAD 实体。</p>}
          <ThermalPowerCurve points={Array.isArray(row.power_profile)?row.power_profile as PowerPoint[]:[]} power={Number(row.power_W)||0} end={Number(row.end_s)||60} duration={Number(config.duration_s)||60} disabled={!!locked} onChange={points=>edit({power_profile:points})}/>
        </>:<div className="ui-grid"><label className="ui-check"><input type="checkbox" checked={!!row.radiation} onChange={event=>edit({radiation:event.target.checked})}/>局部辐射</label><Numeric label="局部发射率" value={row.emissivity??.85} onCommit={value=>edit({emissivity:value})}/></div>}
      </fieldset></details>}
    </Step>

    <Step n={3} title="材料与求解" state={stepState(3,!!loaded)} summary={!surface?'先准备热模型':`${String(material.name||'自定义材料')} · ${config.analysis_mode==='steady'?'稳态':`瞬态 ${config.duration_s??60} s`}`} onOpen={()=>onStep(3)}>
      <fieldset className="ui-stack" disabled={locked}>
        <label className="ui-field">材料<select aria-label="材料预设" defaultValue="" onChange={event=>{if(event.target.value!=='')setConfig({base_material:structuredClone(catalog!.materials[Number(event.target.value)])});}}><option value="">{String(material.name||'自定义')}（当前）</option>{catalog?.materials.map((item,i)=><option key={i} value={i}>{String(item.name)}</option>)}</select></label>
        <div className="ui-grid">{[['k','导热系数 W/(m·K)'],['rho','密度 kg/m³'],['cp','比热 J/(kg·K)']].map(([key,label])=><Numeric key={key} label={label} value={material[key]} onCommit={value=>setConfig({base_material:{...material,[key]:value}})}/>)}</div>
        <div className="ui-grid"><label className="ui-field">分析类型<select value={String(config.analysis_mode||'transient')} onChange={event=>setConfig({analysis_mode:event.target.value})}><option value="transient">瞬态（升温与冷却）</option><option value="steady">稳态</option></select></label>{scalar('duration_s','仿真总时长 s')}</div>
        <div className="ui-grid">{scalar('initial_C','初温 °C')}{scalar('ambient_C','环境 °C')}{scalar('default_h','对流 W/(m²·K)')}</div>
        <p className="ui-hint">材料预设为示例值，请按实际材料核对；切换预设可用撤销恢复。</p>
      </fieldset>
      {errorLine}
      <div className="ui-actions"><button className="button primary" disabled={locked||!loaded||!surface||!!rawError||unconfirmed>0} onClick={()=>void save(true)}>{working?'正在处理…':'运行热仿真'}</button><button className="text-button" disabled={locked||!loaded||!!rawError} onClick={()=>void save()}>保存工况</button><span className="ui-hint">{busy?'计算中，工况已冻结':dirty?'有未保存修改':'已保存'}</span></div>
      <details className="ui-disclosure"><summary>高级</summary><fieldset className="ui-stack" disabled={locked}>
        <label className="ui-field">材料名称<input value={String(material.name||'')} onChange={event=>setConfig({base_material:{...material,name:event.target.value}})}/></label>
        <div className="ui-grid">{scalar('dt_s','计算步长 s')}{scalar('save_s','保存间隔 s')}{scalar('mesh_size_m','网格尺寸 mm',1000)}</div>
        <label className="ui-check"><input type="checkbox" checked={!!config.radiation_enabled} onChange={event=>setConfig({radiation_enabled:event.target.checked,...(event.target.checked?{emissivity:config.emissivity??.8,radiation_ambient_C:config.radiation_ambient_C??config.ambient_C??25}:{})})}/>全局辐射</label>
        {config.radiation_enabled===true&&<div className="ui-grid">{scalar('emissivity','全局发射率')}{scalar('radiation_ambient_C','辐射环境 °C')}</div>}
        <label className="ui-check"><input type="checkbox" checked={!!config.heat_convection} onChange={event=>setConfig({heat_convection:event.target.checked})}/>热源作用面同时参与对流</label>
        <label className="ui-field">工况 JSON<textarea aria-label="热仿真工况 JSON" className="thermal-json" spellCheck={false} value={raw}
          onFocus={()=>{rawEditing.current=true;}} onBlur={()=>{rawEditing.current=false;if(!rawError)setRaw(JSON.stringify(current.current.config,null,2));}}
          onChange={event=>{setRaw(event.target.value);try{const parsed:unknown=JSON.parse(event.target.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('工况应为 JSON 对象');commit(createDraft(parsed as ThermalConfig,current.current.editor));setRawError('');}catch(reason){setRawError((reason as Error).message);}}}/></label>
        {rawError?<p role="alert" className="form-error">{rawError}</p>:<p className="ui-hint">JSON 中的高级材料区域、温控等参数会完整保留。Python 解释器在第 1 步「热模型」的高级里设置。</p>}
      </fieldset></details>
    </Step>
  </>;
});
