import {useEffect,useState,useRef} from 'react';
import {LoaderCircle,SlidersHorizontal} from 'lucide-react';
import {request} from '../api';
import {Empty,StepIndicator} from './Steps';
import type {ModelOrigin} from './model-origin';

// `caps` are the simulations a template's export qualifies for: structural needs the cylinder's shell-boundary record, thermal takes any STEP.
// The server also offers `blank` (a box notebook the Agent rewrites); it has no card here, the conversation card covers new geometry.
const templates=[
 {id:'cylinder',name:'圆柱壳',text:'加筋圆柱壳：外径、总高、蒙皮厚、翻边孔、纵环筋。',caps:['可结构仿真','可热仿真']},
 {id:'plate',name:'平板',text:'长、宽、厚与可选孔阵列。',caps:['可热仿真']},
];
const noParameters:Record<Exclude<ModelOrigin,'notebook'>,string>={script:'此模型由脚本生成，暂无可调参数。',imported:'导入的模型没有参数。',other:'此模型暂无可调参数。'};
/**
 * Parametric page: ① 从哪里开始 (conversation, a template, or an import) → ② 编辑参数 (the editor opens by itself) → ③ 发布. The editor frame stays mounted while another step is shown so publishing can confirm its saved state.
 * `model` is the part's current model; when it does not come from the parametric program the page offers 让 Agent 转为参数化 (`convert`) or 从模板新建 instead of the steps.
 * `describe` and `convert` start a conversation draft for the Agent and return the hint to show; `importModel` opens the import file picker.
 */
export function ParametricPanel({projectId,model,changed,simulate,open,describe,convert,importModel,active=true}:{projectId:string;model?:{path:string;origin:ModelOrigin};changed:()=>Promise<void>;simulate:(source:string)=>void;open:(path:string)=>void;describe:()=>string;convert:()=>string;importModel:()=>void;active?:boolean}){
 const [described,setDescribed]=useState(''),[fromTemplate,setFromTemplate]=useState(false);
 useEffect(()=>{setFromTemplate(false);setDescribed('');},[model?.path]);
 const foreign=model&&model.origin!=='notebook'&&!fromTemplate?model.origin:null;
 const base=`api/projects/${projectId}/parametric`;
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[url,setUrl]=useState('');
 const [picked,setPicked]=useState<1|2|3|null>(null),[starting,setStarting]=useState(false),[startError,setStartError]=useState(''),[stopped,setStopped]=useState(false),[replacing,setReplacing]=useState('');
 const frame=useRef<HTMLIFrameElement>(null);
 const prepareEditor=()=>new Promise<any>((resolve,reject)=>{
  if(!url){resolve(undefined);return;}
  // randomUUID exists only in secure contexts; plain-HTTP intranet pages need the fallback.
  const requestId=globalThis.crypto?.randomUUID?.()??(Math.random().toString(36).slice(2)+Date.now().toString(36));
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  const receive=(e:MessageEvent)=>{if(e.source===frame.current?.contentWindow&&e.origin===new URL(url,window.location.href).origin&&e.data?.type==='castudio.prepared'&&e.data.requestId===requestId){cleanup();resolve(e.data.editor);}};
  const timer=setTimeout(()=>{cleanup();reject(Error('编辑器尚未就绪，无法确认保存状态'));},5000);
  window.addEventListener('message',receive);frame.current?.contentWindow?.postMessage({type:'castudio.prepare',requestId},new URL(url,window.location.href).origin);
 });
 const post=(action:string,body:any={})=>request<any>(base+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const refresh=async()=>{const next=await request<any>(base);setState(next);setUrl(next.url||'');return next;};
 useEffect(()=>{if(!active)return;let live=true;const update=()=>request<any>(base).then(s=>{if(live){setState(s);setUrl(s.url||'');}}).catch(e=>live&&setError(e.message));void update();const t=setInterval(update,2000);return()=>{live=false;clearInterval(t);};},[base,active]);
 useEffect(()=>{if(state?.job?.state==='succeeded')void changed();},[state?.job?.id,state?.job?.state]);
 const act=async(action:string,body:any={})=>{setBusy(true);setError('');try{const editor=action==='publish'?await prepareEditor():undefined;await post(action,action==='publish'?{editor}:body);await refresh();await changed();return true;}catch(e){setError((e as Error).message);return false;}finally{setBusy(false);}};
 // `plain` templates (plate, blank) publish STEP and preview only; the cylinder also checks its shell-model boundaries.
 const exists=!!state?.exists,step=!exists?1:picked??2,running=state?.job?.state==='running',plain=state?.template!=='cylinder',entry=`parametric/${state?.entry}`;
 // A publication made with another template (before 更换模板) does not describe the current program.
 const published=state?.published&&(state.published.template??'cylinder')===state.template?state.published:null,manifest=published?.manifest,approved=!!manifest?.equivalence?.approved;
 const start=async()=>{setStarting(true);setStartError('');setStopped(false);try{await post('start');await refresh();}catch(e){setStartError((e as Error).message);}finally{setStarting(false);}};
 useEffect(()=>{if(active&&!foreign&&exists&&step===2&&!url&&!starting&&!startError&&!stopped&&!running&&!busy)void start();},[active,foreign,exists,step,url,starting,startError,stopped,running,busy]);
 const choose=async(template:string,replace=false)=>{setReplacing('');if(await act('template',{template,replace})){setStartError('');setStopped(false);setPicked(2);}};
 const publish=async()=>{if(await act('publish'))setPicked(3);};
 const firstLine=(text:string)=>text.split('\n').find(line=>line.trim())||text,noRuntime=/未配置参数化建模环境/.test(startError);
 const status=running?'正在发布，可返回「编辑参数」继续编辑':published?`最近发布 ${new Date(published.createdAt).toLocaleString()}`:'尚未发布';
 const cells=manifest&&`构建步骤：${manifest.cells.filter((c:any)=>c.status==='cached').length} 个缓存命中，${manifest.cells.filter((c:any)=>c.status==='ran').length} 个实际运行。${manifest.timings?` 总耗时 ${manifest.timings.total_seconds.toFixed(1)} 秒。`:''}`;
 return <div className="parametric-panel">
  {!foreign&&<StepIndicator label="参数步骤" onOpen={i=>setPicked((i+1) as 1|2|3)} steps={[
   {title:'从哪里开始',state:step===1?'current':'done'},
   {title:'编辑参数',state:step===2?'current':exists?'open':'locked',reason:'先选择模板'},
   {title:'发布',state:step===3?'current':!exists?'locked':published&&!running?'done':'open',reason:'先选择模板'}]}/>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  {foreign?<>
    {/* The part may already hold a parametric program while the viewer shows another file: offer that program first. */}
    <Empty icon={<SlidersHorizontal size={20}/>} text={exists?`${noParameters[foreign]}本零件已有参数化程序，可直接编辑并发布新模型。`:noParameters[foreign]} action={<div className="ui-actions">{exists&&<button className="button primary" onClick={()=>{setFromTemplate(true);setDescribed('');setPicked(2);}}>编辑参数化程序</button>}<button className={exists?'button':'button primary'} onClick={()=>setDescribed(convert())}>让 Agent 转为参数化</button>{!exists&&<button className="button" onClick={()=>{setFromTemplate(true);setDescribed('');setPicked(1);}}>从模板新建</button>}</div>}/>
    {described&&<p className="ui-hint" role="status">{described}</p>}
   </>
  :!state?<Empty icon={<LoaderCircle className="spin" size={20}/>} text="正在读取参数化状态…"/>
  :step===1?<div className="parametric-templates" role="group" aria-label="从哪里开始">
    <p className="ui-hint">{exists?'更换模板会用新模板替换 parametric/ 下的模板源码并关闭编辑器；原源码保留在项目历史里，可以恢复。':'选择一种方式开始；项目里已有的源码和分析记录不受影响。'}</p>
    <button className="parametric-template" onClick={()=>setDescribed(describe())}><strong>用对话描述</strong><span>在对话中描述零件的形状、尺寸与用途，Agent 编写参数化程序并发布 STEP。</span></button>
    {described&&<p className="ui-hint" role="status">{described}</p>}
    {templates.map(t=><button key={t.id} className="parametric-template" aria-pressed={exists?state.template===t.id:undefined} disabled={busy||running||state.template===t.id} title={running?'正在发布，完成后才能更换模板':undefined} onClick={()=>exists?setReplacing(t.id):void choose(t.id)}><strong>{t.name}{state.template===t.id&&' · 当前模板'}</strong><span>{t.text}</span><span className="parametric-caps">{t.caps.map(c=><span key={c} className="ui-chip">{c}</span>)}</span></button>)}
    <button className="parametric-template" onClick={importModel}><strong>导入已有模型</strong><span>导入 STEP、STL、GLB 或 CATIA 文件到当前零件；导入的模型没有模板参数。</span></button>
    {replacing&&<div className="ui-actions" role="alertdialog" aria-label="确认更换模板"><p className="ui-hint warn">更换为「{templates.find(t=>t.id===replacing)?.name}」会替换 {entry}，确定吗？</p><button className="button" autoFocus onClick={()=>setReplacing('')}>取消</button><button className="button danger" disabled={busy} onClick={()=>void choose(replacing,true)}>更换模板</button></div>}
    {exists&&!replacing&&<div className="ui-actions"><button className="button primary" onClick={()=>setPicked(2)}>继续编辑</button></div>}
   </div>
  :step===2?<>
    <div className="ui-actions"><button className="button primary" title={!url?'编辑器打开后才能发布':plain?'生成 STEP 与预览':'生成 STEP 并校验圆柱壳仿真边界'} disabled={busy||running||!url} onClick={()=>void publish()}>{running?'正在发布…':'发布'}</button><span className="ui-hint parametric-status">{status}</span></div>
    {url&&state?.kernel?.state==='failed'&&<p className="ui-hint" role="alert">参数化建模内核已停止：{firstLine(state.kernel.error||'未知错误')} <button className="text-button" disabled={starting} onClick={()=>void start()}>重启编辑器</button></p>}
    {!url&&(startError?<Empty icon={<SlidersHorizontal size={20}/>} text={noRuntime?<>参数化建模环境尚未安装。在 CAStudio 目录运行一次 <code>node scripts/setup-cad-env.mjs</code>（说明见 docs/runtime.md），然后重试。</>:`编辑器未能打开：${firstLine(startError)}`} action={<button className="button" onClick={()=>void start()}>重试</button>}/>
     :stopped?<Empty icon={<SlidersHorizontal size={20}/>} text={`编辑器已关闭。打开后修改 ${entry} 的参数与建模步骤。`} action={<button className="button primary" onClick={()=>void start()}>打开编辑器</button>}/>
     :running?<Empty icon={<LoaderCircle className="spin" size={20}/>} text="正在发布，完成后自动打开编辑器。"/>
     :<Empty icon={<LoaderCircle className="spin" size={20}/>} text="正在打开编辑器，首次启动可能需要一分钟…"/>)}
   </>
  :<>
    <div className="ui-actions">
     <button className="button primary" title={noRuntime?'参数化建模环境尚未安装，见「编辑参数」里的说明':plain?'生成 STEP 与预览':'生成 STEP 并校验圆柱壳仿真边界'} disabled={busy||running||starting||noRuntime||(!!state.running&&!url)} onClick={()=>void publish()}>{running?'正在发布…':published?'重新发布':'发布'}</button>
     {running&&<button className="text-button" onClick={()=>void act('cancel')}>取消</button>}
     <span className="ui-hint parametric-status">{status}</span>
    </div>
    {state.job?.error&&<p role="alert" className="form-error">发布未完成：{firstLine(state.job.error)}（详情见高级）</p>}
    {published?.sourceChangedDuringBuild&&<p className="ui-hint warn" role="status">发布期间源码又有修改，再次发布才会包含新修改。</p>}
    {published?<div className="ui-section">
      <strong>{plain?'已发布 STEP':approved?'已发布，圆柱壳检查通过':'已发布，圆柱壳检查未通过'}</strong>
      <p className="ui-hint">{plain?'只发布 STEP 与预览，可做热仿真，不能做结构仿真。':approved?'几何与圆柱壳模型一致，可以送入结构仿真。':'几何已变化，暂不能套用圆柱壳模型做结构仿真；详情见高级。'}</p>
      <div className="ui-actions"><button className="button" onClick={()=>open(published.source)}>在查看器中打开</button>{!plain&&<button className="button" title={approved?'用最近发布的几何做结构仿真':'最近发布未通过圆柱壳检查'} disabled={busy||running||!approved} onClick={()=>simulate(published.source)}>送入结构仿真</button>}</div>
     </div>
    :!running&&<p className="ui-hint">发布会保存 {entry}，生成 STEP 与预览{plain?'':'，并检查圆柱壳仿真边界'}；发布后可在查看器中打开{plain?'':'或送入结构仿真'}。</p>}
    <details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
     <p className="ui-hint">在编辑器里点击面、边或顶点会把选择表达式写入模型。发布保存源码、STEP、场景包与构建记录；发布不关闭编辑器，使用点击发布时的源码。</p>
     {url&&<div className="ui-actions"><button className="button" disabled={busy||running} onClick={()=>void act('stop').then(ok=>{if(ok)setStopped(true);})}>关闭编辑器</button><span className="ui-hint">释放编辑器占用的后台进程</span></div>}
     {manifest&&plain&&<><h4>最近发布 · STEP</h4><p className="ui-hint">实体体积 {manifest.volume_mm3.toFixed(3)} mm³；参数 {Object.entries(manifest.parameters).map(([k,v])=>`${k}=${v}`).join('，')}。{cells}</p></>}
     {manifest&&!plain&&<><h4>最近发布 · {approved?'已通过圆柱壳模型适配检查':'几何已变化，暂不可套用现有圆柱壳模型'}</h4>
      <p className="ui-hint">实体体积 {manifest.equivalence.volume_mm3.toFixed(3)} mm³；双向实体差体积 {manifest.equivalence.difference_volumes_mm3.join(' / ')||'体积不匹配'} mm³。筒体外表面映射到筒皮中面，两端面映射到端框中面。{cells}</p>
      <table><thead><tr><th>仿真边界</th><th>CAD 面数</th><th>面积 mm²</th><th>壳模型区域</th></tr></thead><tbody>{Object.entries(manifest.bindings).map(([key,b]:[string,any])=><tr key={key}><td>{key}</td><td>{b.face_count}</td><td>{b.area_mm2.toFixed(3)}</td><td>{b.shell_set}</td></tr>)}</tbody></table>
     </>}
     {state.job?.error&&<pre className="ui-log">{state.job.error}</pre>}
     {state.job?.log&&<pre className="ui-log">{state.job.log}</pre>}
    </div></details>
   </>}
  {url&&<iframe ref={frame} title="CAStudio 参数化建模编辑器" src={url} className="parametric-frame" hidden={step!==2||!!foreign}/>}
 </div>;
}
