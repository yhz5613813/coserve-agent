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

const send=(method:string,body:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const initial:ThermalConfig={name:'散热评估（示例）',base_material:{name:'铝（示例）',k:205,rho:2700,cp:900},analysis_mode:'transient',initial_C:25,ambient_C:25,default_h:10,duration_s:60,dt_s:2,save_s:10,mesh_size_m:.004,air_gap_enabled:false,heat_sources:[{name:'顶部热源（示例）',source_type:'surface',placement:'surface',power_W:5,start_s:0,end_s:60,selector:'+z'}]};
const colors=['#ffb56a','#ff6b6b','#ffd166','#d48fff','#f48fb1','#9ccc65'];
export type ThermalCaseHandle={reuse:(run:ThermalRun)=>void};
type Props={projectId:string;files:Artifact[];initialSource?:string;busy:boolean;visible:boolean;pose:MutableRefObject<ThermalPose|null>;
  changed:()=>Promise<void>;onRun:(run:ThermalRun)=>void;onDraft:(source:string,config:ThermalConfig)=>void};

function Numeric({label,value,disabled,onCommit,factor=1,min}:{label:string;value:unknown;disabled?:boolean;onCommit:(value:number|undefined)=>void;factor?:number;min?:number}){
  const format=()=>typeof value==='number'&&Number.isFinite(value)?String(Number((value*factor).toPrecision(10))):'';
  const [text,setText]=useState(format),focused=useRef(false);
  useEffect(()=>{if(!focused.current)setText(format());},[value,factor]);
  return <label>{label}<input aria-label={label} type="number" step="any" min={min} disabled={disabled} value={text}
    onFocus={()=>{focused.current=true;}} onChange={event=>setText(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}
    onBlur={()=>{if(!focused.current)return;focused.current=false;const n=Number(text);if(!text.trim())onCommit(undefined);else if(Number.isFinite(n))onCommit(n/factor);else setText(format());}}/></label>;
}
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

export const ThermalCaseEditor=forwardRef<ThermalCaseHandle,Props>(function ThermalCaseEditor({projectId,files,initialSource,busy,visible,pose,changed,onRun,onDraft},ref){
  const models=files.filter(file=>/\.(step|stp|stl)$/i.test(file.path)&&!file.path.startsWith('simulations/'));
  const [source,setSource]=useState(initialSource||models[0]?.path||''),[units,setUnits]=useState('mm');
  const [history,dispatch]=useReducer(historyStep,{past:[],present:createDraft(initial),future:[]});
  const draft=history.present,config=draft.config,current=useRef(draft);current.current=draft;
  const [loaded,setLoaded]=useState(false),[saved,setSaved]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [inspection,setInspection]=useState<ThermalInspection|null>(null),[surface,setSurface]=useState<ThermalSurface|null>(null);
  const [catalog,setCatalog]=useState<ThermalCatalog|null>(null),[executable,setExecutable]=useState(''),[runtimeMessage,setRuntimeMessage]=useState('');
  const [kind,setKind]=useState<ConditionKind>('heat'),[selected,setSelected]=useState(''),[mode,setMode]=useState<ThermalSelection['kind']>('rectangle'),[tool,setTool]=useState<'orbit'|'place'>('orbit');
  const [resolving,setResolving]=useState(false),[selectionError,setSelectionError]=useState(''),[preview,setPreview]=useState<ThermalSelection|null>(null);
  const [raw,setRaw]=useState(JSON.stringify(initial,null,2)),[rawError,setRawError]=useState(''),rawEditing=useRef(false);
  const epoch=useRef(0),selectionSequence=useRef(0),resolver=useRef<AbortController|null>(null),owned=useRef<{project:string;id:string}|null>(null);
  const rows=conditionRows(config,kind),identities=kind==='heat'?draft.editor.sourceIds:draft.editor.coolingIds;
  const activeId=identities.includes(selected)?selected:identities[0]||'',index=identities.indexOf(activeId),row=rows[index];
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
    void request<{source?:string;units?:string;config?:ThermalConfig;editor?:ThermalEditorState}>(`/api/projects/${projectId}/thermal/case`).then(value=>{
      if(!live||epoch.current!==generation)return;
      const restored=createDraft(value.config||initial,value.editor);dispatch({type:'reset',value:restored});setSource(value.source||initialSource||models[0]?.path||'');setUnits(value.units||'mm');
      setSaved(canonical({source:value.source||initialSource||models[0]?.path||'',units:value.units||'mm',config:restored.config,editor:restored.editor}));setLoaded(true);
    }).catch(reason=>{if(live){setError((reason as Error).message);setLoaded(true);}});
    void request<{executable:string}>('/api/thermal/runtime').then(value=>{if(live)setExecutable(value.executable);});
    return()=>{live=false;epoch.current++;resolver.current?.abort();const task=owned.current;if(task?.project===projectId){owned.current=null;void request(`/api/projects/${task.project}/thermal/inspections/${task.id}/cancel`,send('POST',{})).catch(()=>{});}};
  },[projectId]);
  useEffect(()=>{onDraft(source,config);if(!rawEditing.current)setRaw(JSON.stringify(config,null,2));},[source,config]);
  useEffect(()=>{if(visible&&!catalog)void request<ThermalCatalog>('/api/thermal/schema').then(setCatalog).catch(reason=>setError((reason as Error).message));},[visible]);
  useEffect(()=>{
    const type=row?.source_type==='point'?(row.placement==='embedded'?'embedded':'point'):row?.surface_patch||(!row?.faces&&!row?.selector)?'rectangle':'face';setMode(kind==='cooling'&&['point','embedded'].includes(type)?'face':type);setTool('orbit');
  },[activeId,kind,row?.source_type,row?.placement,!!row?.surface_patch,!!row?.faces,row?.selector]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(!visible||locked||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='z'||(event.target as HTMLElement)?.closest('input,textarea,select'))return;
      event.preventDefault();dispatch({type:event.shiftKey?'redo':'undo'});
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[visible,locked]);
  useImperativeHandle(ref,()=>({reuse:run=>{
    epoch.current++;resolver.current?.abort();const task=owned.current;if(task){owned.current=null;void request(`/api/projects/${task.project}/thermal/inspections/${task.id}/cancel`,send('POST',{})).catch(()=>{});}setWorking(false);setResolving(false);setSource(run.source);setUnits(run.units);setInspection(null);setSurface(null);setTool('orbit');
    const next=createDraft(run.config);next.editor.sourceHash=run.sourceHash;next.editor.surfaceHash=run.surfaceHash;dispatch({type:'reset',value:next});
  }}));

  async function loadSurface(record:ThermalInspection,generation:number){
    const value=await request<ThermalSurface>(`/api/projects/${projectId}/thermal/inspections/${record.id}/surface`);
    if(epoch.current!==generation)return;
    if(record.stale)throw new Error('模型已变化，请重新准备热模型并确认选区');
    setInspection(record);setSurface(value);dispatch({type:'bind',value:{...current.current,editor:editorFor(record,current.current)}});
  }
  useEffect(()=>{
    if(!visible||!loaded||surface||inspection||!draft.editor.inspectionId)return;
    const generation=epoch.current;
    void request<ThermalInspection>(`/api/projects/${projectId}/thermal/inspections/${draft.editor.inspectionId}`).then(record=>{
      if(epoch.current!==generation)return;
      if(record.state==='succeeded'&&record.source===source&&record.units===units)return loadSurface(record,generation);
    }).catch(reason=>{if(epoch.current===generation)setError((reason as Error).message);});
  },[visible,loaded,surface,inspection,draft.editor.inspectionId]);

  async function prepare(){
    setWorking(true);setError('');setSelectionError('');resolver.current?.abort();const generation=epoch.current;
    try{
      const admitted=await ownInspection(
        request<ThermalInspection>(`/api/projects/${projectId}/thermal/inspections`,send('POST',{source,units})),
        ()=>epoch.current===generation,
        record=>{owned.current={project:projectId,id:record.id};setInspection(record);setSurface(null);},
        record=>request(`/api/projects/${projectId}/thermal/inspections/${record.id}/cancel`,send('POST',{})));
      if(!admitted||epoch.current!==generation)return;
      let record=admitted;
      while(record.state==='running'){
        await new Promise(resolve=>setTimeout(resolve,350));if(epoch.current!==generation)return;
        record=await request<ThermalInspection>(`/api/projects/${projectId}/thermal/inspections/${record.id}`);
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
      const result=await request<ThermalSelectionResult>(`/api/projects/${projectId}/thermal/inspections/${inspection.id}/resolve`,{...send('POST',{surfaceHash:surface.surface_sha256,selection:descriptor}),signal:abort.signal});
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
  async function save(run=false){
    setWorking(true);setError('');const generation=epoch.current;
    try{
      if(rawError)throw new Error('请先修正工况 JSON');
      if(run){
        if(!inspection||inspection.state!=='succeeded'||!surface)throw new Error('请先准备可编辑热模型');
        assertRunBinding(current.current,{sourceHash:inspection.sourceHash,surfaceHash:surface.surface_sha256});
        await request(`/api/projects/${projectId}/thermal/inspections/${inspection.id}/validate`,send('POST',{config:current.current.config}));
      }
      const value=caseValue();await request(`/api/projects/${projectId}/thermal/case`,send('PUT',value));setSaved(canonical(value));await changed();
      if(run){const record=await request<ThermalRun>(`/api/projects/${projectId}/thermal`,send('POST',{...value,inspectionId:inspection!.id,surfaceHash:surface!.surface_sha256,expectedHash:inspection!.sourceHash}));if(epoch.current===generation)onRun(record);}
    }catch(reason){if(epoch.current===generation)setError((reason as Error).message);}
    finally{if(epoch.current===generation)setWorking(false);}
  }
  const scalar=(name:string,label:string,factor=1)=><Numeric key={name} label={label} factor={factor} value={config[name]} onCommit={value=>setConfig({[name]:value})}/>;
  const material=(config.base_material||{}) as Row;
  const position=preview?.center_m||patch?.center_m||active?.position;
  const dirty=saved!==canonical({source,units,config,editor:draft.editor});

  return <div className="thermal-case-editor">
    <section><h3>热模型与作用区域</h3>
      <fieldset disabled={locked||!loaded}>
        <label>模型<select aria-label="热仿真模型" value={source} onChange={event=>{setSource(event.target.value);setSurface(null);setInspection(null);setTool('orbit');}}><option value="">选择 STEP/STL</option>{models.map(file=><option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
        <label>STL 长度单位<select value={units} onChange={event=>{setUnits(event.target.value);setSurface(null);setInspection(null);}}><option value="mm">毫米</option><option value="cm">厘米</option><option value="m">米</option></select></label>
        <div className="build-actions"><button className="button" disabled={!source} onClick={()=>void prepare()}>{surface?'重新准备热模型':'准备可编辑热模型'}</button><button className="button" disabled={!history.past.length} onClick={()=>dispatch({type:'undo'})}>撤销</button><button className="button" disabled={!history.future.length} onClick={()=>dispatch({type:'redo'})}>重做</button></div>
      </fieldset>
      <small>STEP 使用文件内单位；界面位置与尺寸为 mm，求解器使用 m。源几何与热表面均绑定摘要</small>
      {inspection?.state==='running'&&<div role="status"><p>{inspection.progress?.detail||'正在准备真实热表面…'}</p><progress max={100} value={inspection.progress?.progress||0}/><button className="button" onClick={()=>void request<ThermalInspection>(`/api/projects/${projectId}/thermal/inspections/${inspection.id}/cancel`,send('POST',{})).then(setInspection)}>取消几何检查</button></div>}
      {inspection?.state==='failed'&&<details><summary>几何检查日志</summary><pre className="build-log">{inspection.log}</pre></details>}
      {surface&&visible?<>
        <fieldset className="thermal-active-strip" disabled={locked}>
          <label>三维当前条件<select aria-label="三维当前条件" value={activeId} onChange={event=>{setKind(draft.editor.sourceIds.includes(event.target.value)?'heat':'cooling');setSelected(event.target.value);}}>{overlays.map(overlay=><option key={overlay.id} value={overlay.id}>{overlay.name}</option>)}</select></label>
          <label>三维作用方式<select aria-label="三维作用方式" value={mode} onChange={event=>{setMode(event.target.value as ThermalSelection['kind']);setTool('place');}}><option value="rectangle">矩形面区域</option><option value="face">整面选择</option>{kind==='heat'&&<><option value="point">表面点热源</option><option value="embedded">嵌入式点热源</option></>}</select></label>
          {row&&<Numeric label={kind==='heat'?'当前功率 W':'当前局部对流 W/(m²·K)'} value={kind==='heat'?row.power_W:row.h} onCommit={value=>edit(kind==='heat'?{power_W:value}:{h:value})}/>}
        </fieldset>
        <div className="thermal-scene-tools"><button className={'button'+(tool==='orbit'?' primary':'')} disabled={locked} onClick={()=>setTool('orbit')}>旋转模型</button><button className={'button'+(tool==='place'?' primary':'')} disabled={locked||!row} onClick={()=>setTool('place')}>点击放置 / 选面</button><button className="button" aria-label="在三维视口新增热源" disabled={locked||draft.editor.sourceIds.length>=16} onClick={()=>{const next=addCondition(current.current,'heat');commit(next.draft);setKind('heat');setSelected(next.id);setMode('rectangle');setTool('place');}}>新增热源</button></div>
        <ThermalScene identity={inspection!.id} sourceHash={inspection!.sourceHash} surface={surface} pose={pose} overlays={overlays} activeId={activeId} tool={tool} disabled={locked}
          onSelect={id=>{const isHeat=draft.editor.sourceIds.includes(id);setKind(isHeat?'heat':'cooling');setSelected(id);}}
          onPlace={(face,center_m)=>{const group=surface.groups[surface.face_groups[face]];const extent=Math.max(...surface.bounds_m[1].map((n,i)=>n-surface.bounds_m[0][i]));void resolveSelection({kind:mode,face,center_m,
            ...(mode==='rectangle'?{width_m:patch?.width_m||extent/4,height_m:patch?.height_m||extent/4,u_axis:group.u_axis,v_axis:group.v_axis}:{})});}}
          onCommit={selection=>void resolveSelection(selection)} onPreview={setPreview} onError={setError}/>
        <p className="thermal-editor-hint">{tool==='place'?'点击模型以指定当前条件的作用位置或表面':'拖动热源中心移动，拖动矩形边角调整尺寸；空白处拖动旋转'} · Escape 取消拖动</p>
        {position&&<small>中心：{position.map(n=>(n*1000).toFixed(3)).join(' / ')} mm</small>}
        <div className="thermal-overlay-legend">{overlays.map(overlay=><button key={overlay.id} style={{borderLeftColor:overlay.color}} onClick={()=>{setKind(draft.editor.sourceIds.includes(overlay.id)?'heat':'cooling');setSelected(overlay.id);}}>{overlay.name}</button>)}</div>
      </>:!surface&&inspection?.state!=='running'&&<div className="thermal-preview-wait">准备热模型后，可在三维视口中指定热源与散热区域</div>}
      {resolving&&<p role="status">正在核对选区与实际面积…</p>}{selectionError&&<p role="alert" className="form-error">{selectionError}</p>}
      {!!unconfirmed&&<p role="alert" className="form-error">模型或热表面已变化，还有 {unconfirmed} 个条件需要重新选区</p>}
    </section>

    <section><h3>热源与局部散热</h3><fieldset disabled={locked}>
      <div className="thermal-segments"><button className={'button'+(kind==='heat'?' primary':'')} onClick={()=>setKind('heat')}>热源</button><button className={'button'+(kind==='cooling'?' primary':'')} onClick={()=>setKind('cooling')}>局部散热</button></div>
      <label>{kind==='heat'?'当前热源':'当前散热区'}<select aria-label="当前物理条件" value={activeId} onChange={event=>setSelected(event.target.value)}><option value="">选择条件</option>{rows.map((item,i)=><option key={identities[i]} value={identities[i]}>{String(item.name||'未命名')}</option>)}</select></label>
      <div className="build-actions"><button className="button" disabled={rows.length>=16} onClick={()=>{const next=addCondition(current.current,kind);commit(next.draft);setSelected(next.id);setMode('rectangle');setTool('place');}}>新增{kind==='heat'?'热源':'散热区'}</button><button className="button" disabled={!row||rows.length>=16} onClick={()=>{const next=addCondition(current.current,kind,activeId);commit(next.draft);setSelected(next.id);}}>复制</button><button className="button" disabled={!row} onClick={()=>commit(removeCondition(current.current,kind,activeId))}>删除</button></div>
      {row&&<>
        <label>名称<input aria-label="物理条件名称" value={String(row.name||'')} onChange={event=>edit({name:event.target.value})}/></label>
        <label>作用方式<select aria-label="热源作用方式" value={mode} onChange={event=>{setMode(event.target.value as ThermalSelection['kind']);setTool('place');}}>
          <option value="rectangle">矩形面区域</option><option value="face">整面选择</option>{kind==='heat'&&<><option value="point">表面点热源</option><option value="embedded">嵌入式点热源</option></>}
        </select></label>
        <small>选择方式后点击三维模型确认；矩形需要平面，曲面可选整面或使用点热源</small>
        {position&&<div className="thermal-editor-grid">{(['X','Y','Z'] as const).map((axis,i)=><Numeric key={axis} label={axis+' 坐标 mm'} factor={1000} value={position[i]} onCommit={value=>{if(value===undefined)return;const center_m=[...position] as Vec3;center_m[i]=value;void resolveSelection({...draft.editor.selections[activeId],kind:patch?'rectangle':active?.embedded?'embedded':'point',...(patch||{}),center_m});}}/>)}</div>}
        {patch&&<div className="thermal-editor-grid"><Numeric label="贴片宽度 mm" factor={1000} value={patch.width_m} onCommit={value=>{if(value!==undefined)void resolveSelection({...draft.editor.selections[activeId],kind:'rectangle',...patch,width_m:value});}}/><Numeric label="贴片高度 mm" factor={1000} value={patch.height_m} onCommit={value=>{if(value!==undefined)void resolveSelection({...draft.editor.selections[activeId],kind:'rectangle',...patch,height_m:value});}}/></div>}
        {kind==='heat'?<>
          <Numeric label="总功率 W" value={row.power_W} onCommit={value=>edit({power_W:value})}/>
          <div className="thermal-editor-grid"><Numeric label="开始时间 s" value={row.start_s??0} onCommit={value=>edit({start_s:value})}/><Numeric label="结束时间 s" value={row.end_s} onCommit={value=>edit({end_s:value})}/></div>
          {(row.source_type==='point'||row.placement==='embedded')&&<><Numeric label="功率分配半径 mm" factor={1000} value={row.radius_m} onCommit={value=>edit({radius_m:value})}/><small>请明确填写分配半径，例如 1 mm（示例，需按实际作用范围核对）。半径用于附近节点的功率分配；热源标记不代表独立 CAD 实体</small></>}
          {!!area&&<p>实际选区 {(area*1e6).toFixed(3)} mm² · 平均热流密度 {Number(row.power_W)>0?(Number(row.power_W)/area).toPrecision(5):'待填写功率'} W/m²</p>}
          <ThermalPowerCurve points={Array.isArray(row.power_profile)?row.power_profile as PowerPoint[]:[]} power={Number(row.power_W)||0} end={Number(row.end_s)||60} duration={Number(config.duration_s)||60} disabled={!!locked} onChange={points=>edit({power_profile:points})}/>
        </>:<>
          <div className="thermal-editor-grid"><Numeric label="局部对流 W/(m²·K)" value={row.h} onCommit={value=>edit({h:value})}/><Numeric label="局部环境 °C" value={row.ambient_C} onCommit={value=>edit({ambient_C:value})}/></div>
          <label className="thermal-follow"><input type="checkbox" checked={!!row.radiation} onChange={event=>edit({radiation:event.target.checked})}/>局部辐射</label>
          <Numeric label="局部发射率" value={row.emissivity??.85} onCommit={value=>edit({emissivity:value})}/><p>实际散热选区 {(area*1e6).toFixed(3)} mm²</p>
        </>}
      </>}
    </fieldset></section>

    <section><h3>材料、环境与求解</h3><fieldset disabled={locked}>
      <label>材料预设<select aria-label="材料预设" defaultValue="" onChange={event=>{if(event.target.value!=='')setConfig({base_material:structuredClone(catalog!.materials[Number(event.target.value)])});}}><option value="">自定义 / 当前材料</option>{catalog?.materials.map((item,i)=><option key={i} value={i}>{String(item.name)}</option>)}</select></label><small>切换预设会替换当前材料物性，可用撤销恢复</small>
      <label>材料名称<input value={String(material.name||'')} onChange={event=>setConfig({base_material:{...material,name:event.target.value}})}/></label>
      <div className="thermal-editor-grid">{[['k','导热系数 W/(m·K)'],['rho','密度 kg/m³'],['cp','比热 J/(kg·K)']].map(([key,label])=><Numeric key={key} label={label} value={material[key]} onCommit={value=>setConfig({base_material:{...material,[key]:value}})}/>)}</div>
      <label>分析类型<select value={String(config.analysis_mode||'transient')} onChange={event=>setConfig({analysis_mode:event.target.value})}><option value="transient">瞬态（查看升温与冷却）</option><option value="steady">稳态（初始与收敛结果）</option></select></label>
      <div className="thermal-editor-grid">{scalar('initial_C','初温 °C')}{scalar('ambient_C','环境 °C')}{scalar('default_h','全局对流 W/(m²·K)')}</div>
      <label className="thermal-follow"><input type="checkbox" checked={!!config.radiation_enabled} onChange={event=>setConfig({radiation_enabled:event.target.checked,...(event.target.checked?{emissivity:config.emissivity??.8,radiation_ambient_C:config.radiation_ambient_C??config.ambient_C??25}:{})})}/>全局辐射</label>
      {config.radiation_enabled===true&&<div className="thermal-editor-grid">{scalar('emissivity','全局发射率')}{scalar('radiation_ambient_C','辐射环境 °C')}</div>}
      <label className="thermal-follow"><input type="checkbox" checked={!!config.heat_convection} onChange={event=>setConfig({heat_convection:event.target.checked})}/>热源作用面同时参与对流</label>
      <div className="thermal-editor-grid">{scalar('duration_s','仿真总时长 s')}{scalar('dt_s','计算步长 s')}{scalar('save_s','保存间隔 s')}{scalar('mesh_size_m','网格尺寸 mm',1000)}</div>
      <small>热源结束时间可早于总时长，以计算断电后的冷却；材料预设为示例值，需按实际材料核对</small>
    </fieldset></section>

    <details><summary>高级工况 JSON</summary><textarea aria-label="热仿真工况 JSON" className="thermal-json" spellCheck={false} disabled={locked} value={raw}
      onFocus={()=>{rawEditing.current=true;}} onBlur={()=>{rawEditing.current=false;if(!rawError)setRaw(JSON.stringify(current.current.config,null,2));}}
      onChange={event=>{setRaw(event.target.value);try{const parsed:unknown=JSON.parse(event.target.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('工况应为 JSON 对象');commit(createDraft(parsed as ThermalConfig,current.current.editor));setRawError('');}catch(reason){setRawError((reason as Error).message);}}}/>
      {rawError&&<p role="alert" className="form-error">{rawError}</p>}<small>高级材料区域、温控和结构参数会完整保留；可视化编辑器不会补造未知物理条件</small>
    </details>
    <details><summary>独立热仿真环境</summary><label>Python 解释器<input aria-label="热仿真 Python 解释器" disabled={locked} value={executable} onChange={event=>setExecutable(event.target.value)}/></label><button className="button" disabled={locked||!executable} onClick={()=>{setWorking(true);void request<{message:string}>('/api/thermal/runtime',send('PUT',{executable})).then(value=>{setRuntimeMessage(value.message);setCatalog(null);}).catch(reason=>setError((reason as Error).message)).finally(()=>setWorking(false));}}>检测并保存环境</button>{runtimeMessage&&<p>{runtimeMessage}</p>}</details>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <div className="thermal-editor-footer"><span>{busy?'计算中，当前工况已冻结':dirty?'工况已修改 · 未保存':'工况已保存'}</span><div className="build-actions"><button className="button" disabled={locked||!loaded||!!rawError} onClick={()=>void save()}>保存工况</button><button className="button primary" disabled={locked||!loaded||!surface||!!rawError||unconfirmed>0} onClick={()=>void save(true)}>{working?'正在处理…':'运行热仿真'}</button></div></div>
  </div>;
});
