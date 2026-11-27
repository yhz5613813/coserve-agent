import {useEffect,useRef,useState} from 'react';
import {LoaderCircle,X} from 'lucide-react';
import {api,request} from '../api';
import type {OptimizationTask,OptimizationPolicy,OptimizationPhase} from '../../shared/optimization';
import type {DeliveryRecord} from '../../shared/delivery';
import {mergeDeliveries} from '../thermal/delivery-state';
import {DEFAULT_OPTIMIZATION_POLICY as defaults} from '../../shared/optimization';
import {Viewport} from './Viewport';
import {Numeric} from './Numeric';
import '../thermal/optimization.css';

const phaseLabels:Record<OptimizationPhase,string>={preparing:'恢复基准与冻结工况',awaiting_proposal:'等待设计代理',claimed:'DeepSeek 正在生成设计',building:'构建 CAD',inspecting:'检查几何与重绑热边界',solving:'GPU 热仿真',verifying:'加密网格复核',completed:'已完成并复核',no_improvement:'已完成，未获得显著降温',cancelled:'已停止',failed:'任务失败',interrupted:'运行中断，可恢复',unverified:'待验证'};
const terminal=new Set<OptimizationPhase>(['completed','no_improvement','cancelled','failed','interrupted','unverified']);
const send=(body:unknown):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const fixedView={edges:true,grid:true,ortho:false,section:100,explode:0,mode:'component' as const};
const degrees=(value:number|undefined)=>value===undefined?'—':value.toFixed(3)+' °C';

/** The backend owns optimization state; unmounting this view only stops its polling. */
export function OptimizationPanel({projectId,baselineRunId,disabled,active=true}:{projectId:string;baselineRunId:string;disabled:boolean;active?:boolean}){
  const [tasks,setTasks]=useState<OptimizationTask[]>([]),[selection,setSelection]=useState('');
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[online,setOnline]=useState(false);
  const [policy,setPolicy]=useState<Partial<OptimizationPolicy>>({}),[preview,setPreview]=useState('');
  const [loaded,setLoaded]=useState(false),generation=useRef(0);
  const [exports,setExports]=useState<DeliveryRecord[]>([]),[exporting,setExporting]=useState(false);
  const base=`api/projects/${projectId}/optimizations`;
  const task=tasks.find(row=>row.id===selection)||tasks.find(row=>row.baseline.runId===baselineRunId)||tasks[0];
  const running=tasks.some(row=>!terminal.has(row.phase));
  useEffect(()=>{
    setExports([]);if(!task)return;let disposed=false;
    void request<DeliveryRecord[]>(`${base}/${task.id}/deliveries`).then(rows=>{if(!disposed)setExports(old=>mergeDeliveries(old,rows));}).catch(reason=>{if(!disposed)setError((reason as Error).message);});
    return()=>{disposed=true;};
  },[base,task?.id]);
  const exportTask=async()=>{
    if(!task)return;const epoch=generation.current;setExporting(true);setError('');
    try{const record=await request<DeliveryRecord>(`${base}/${task.id}/deliveries`,send({}));if(epoch===generation.current)setExports(old=>mergeDeliveries(old,[record]));}
    catch(reason){if(epoch===generation.current)setError((reason as Error).message);}
    finally{if(epoch===generation.current)setExporting(false);}
  };
  useEffect(()=>{
    if(!active)return;
    const epoch=++generation.current;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const [rows,driver]=await Promise.all([request<OptimizationTask[]>(base),request<{available:boolean}>('api/optimizations/driver')]);
        if(epoch!==generation.current)return;
        setTasks([...rows].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)));setOnline(driver.available);setLoaded(true);
      }catch(reason){if(epoch===generation.current)setError((reason as Error).message);}
      finally{if(epoch===generation.current)timer=setTimeout(poll,1500);}
    };
    void poll();return()=>{generation.current++;clearTimeout(timer);};
  },[base,active]);
  const act=async(action:()=>Promise<OptimizationTask>)=>{
    setWorking(true);setError('');const epoch=generation.current;
    try{const updated=await action();if(epoch===generation.current){setTasks(old=>[updated,...old.filter(row=>row.id!==updated.id)]);setSelection(updated.id);}}
    catch(reason){if(epoch===generation.current)setError((reason as Error).message);}
    finally{if(epoch===generation.current)setWorking(false);}
  };
  const best=task?.candidates.find(candidate=>candidate.id===task.bestCandidateId);
  const ranked=task?[...task.candidates].sort((a,b)=>(a.state==='valid'?0:1)-(b.state==='valid'?0:1)||(a.maximumC??Infinity)-(b.maximumC??Infinity)||(a.massKg??Infinity)-(b.massKg??Infinity)||a.attempt-b.attempt):[];
  const selectedPreview=task?.candidates.find(candidate=>candidate.id===preview);
  const policyField=(key:keyof OptimizationPolicy,label:string,min:number,max?:number,factor=1,step:number|'any'=1)=><Numeric required label={label} min={min} max={max} step={step} factor={factor} value={policy[key]??defaults[key]} onCommit={value=>{if(value!==undefined)setPolicy(old=>({...old,[key]:Number(value.toPrecision(10))}));}}/>;
  const candidateStates={proposed:'已提案',building:'构建中',inspecting:'检查中',solving:'求解中',valid:'有效',invalid:'未通过',interrupted:'已中断'};
  return <section className="optimization-panel ui-stack" aria-label="仿真驱动 CAD 自动优化">
    <p className="ui-hint">固定热工况与安装接口，让 DeepSeek 按实际计算结果改进几何；候选只改变几何。</p>
    {loaded&&!online&&<p className="ui-hint warn" role="status">优化宿主未连接，请保持 CoServe 桌面程序运行。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="ui-actions">
      <button className="button primary" disabled={!loaded||!online||disabled||working||running} onClick={()=>void act(()=>request<OptimizationTask>(base,send({baselineRunId,policy})))}>{working?'正在处理…':'开始自动优化'}</button>
      {task&&!terminal.has(task.phase)&&<button className="button" disabled={working} onClick={()=>void act(()=>request(`${base}/${task.id}/cancel`,send({})))}>停止</button>}
      {task&&['interrupted','cancelled'].includes(task.phase)&&<button className="button" disabled={working||!online||running} onClick={()=>void act(()=>request(`${base}/${task.id}/resume`,send({})))}>恢复</button>}
    </div>
    {task&&<>
      <div className="ui-actions" role="status">{!terminal.has(task.phase)&&<LoaderCircle className="spin" size={14}/>}<span>{phaseLabels[task.phase]}</span><span className="ui-hint">尝试 {task.claim?.attempt??task.candidates.length} / {task.policy.maxAttempts}</span></div>
      <div className="ui-metrics"><div><span>基准末帧最高</span><strong>{degrees(task.baseline.maximumC)}</strong></div><div><span>最佳候选</span><strong>{degrees(best?.maximumC)}</strong></div><div><span>降温</span><strong>{best?.maximumC===undefined?'—':(task.baseline.maximumC-best.maximumC).toFixed(3)+' °C'}</strong></div></div>
      {task.verification&&<p className="ui-hint">加密网格复核：基准 {degrees(task.verification.baselineMaximumC)}，候选 {degrees(task.verification.candidateMaximumC)}，降温 {task.verification.improvementC.toFixed(3)} °C</p>}
      {(task.stopReason||task.error)&&<p className={task.error?'form-error':'ui-hint'}>{task.stopReason}{task.error&&' · '+task.error}</p>}
      <div className="optimization-table-wrap"><table className="optimization-table"><thead><tr><th>排名 / 尝试</th><th>状态</th><th>末帧最高</th><th>降温</th><th>质量</th><th/></tr></thead><tbody>
        <tr><td>基准</td><td>冻结</td><td>{degrees(task.baseline.maximumC)}</td><td>—</td><td>{task.baseline.massKg.toFixed(4)} kg</td><td/></tr>
        {ranked.map((row,index)=><tr key={row.id} className={row.id===preview?'active':undefined}><td>{row.state==='valid'?index+1:'—'} / {row.attempt}{row.id===best?.id?' · 最佳':''}</td><td>{candidateStates[row.state]}</td><td>{degrees(row.maximumC)}</td><td>{row.maximumC===undefined?'—':(task.baseline.maximumC-row.maximumC).toFixed(3)+' °C'}</td><td>{row.massKg===undefined?'—':row.massKg.toFixed(4)+' kg'}</td>
          <td><button className="text-button" aria-pressed={row.id===preview} onClick={()=>setPreview(row.id===preview?'':row.id)}>详情</button></td></tr>)}
      </tbody></table></div>
      {selectedPreview&&<div className="ui-section">
        <div className="ui-actions"><strong>候选 {selectedPreview.attempt}</strong><span className="ui-hint">{candidateStates[selectedPreview.state]}</span><span className="ui-spacer"/><button className="icon-button" aria-label="关闭候选详情" title="关闭" onClick={()=>setPreview('')}><X size={14}/></button></div>
        <p className="ui-hint">{selectedPreview.rationale||'未生成设计理由'}</p>
        {selectedPreview.changes.length>0&&<ul className="ui-hint">{selectedPreview.changes.map((change,i)=><li key={i}>{change}</li>)}</ul>}
        {selectedPreview.error&&<p className="form-error">{selectedPreview.error}</p>}{selectedPreview.warnings?.map((warning,i)=><p className="ui-hint" key={i}>{warning}</p>)}
        {selectedPreview.runId&&<div className="ui-actions"><a className="button" href={`api/projects/${task.projectId}/thermal/${selectedPreview.runId}/file?path=job%2Freport.pdf`} target="_blank" rel="noreferrer">仿真报告</a></div>}
        {selectedPreview.source&&selectedPreview.buildId&&<div className="optimization-viewport"><Viewport url={api.buildFileUrl(task.projectId,selectedPreview.buildId,'model.step')} name="model.step" options={fixedView}/></div>}
      </div>}
      <div className="ui-actions">
        <button className="button" disabled={exporting||!terminal.has(task.phase)} onClick={()=>void exportTask()}>{exporting?'正在核对并打包…':'导出交付包'}</button>
        {best?.buildId&&<a className="button" href={api.buildFileUrl(task.projectId,best.buildId,'model.step')} download>最佳候选 STEP</a>}
      </div>
      {exports.filter(row=>row.taskId===task.id).map(row=><div className="ui-actions" key={row.id}>
        <span className="ui-hint">{new Date(row.createdAt).toLocaleString()} · {(row.archive.size/1024/1024).toFixed(1)} MB · {row.selected.kind==='verified_candidate'?'已复核候选':'保留基准'}{row.taskRevision!==task.revision?' · 历史版本':''}</span>
        <a className="text-button" href={`${base}/${task.id}/deliveries/${row.id}/file`} download>下载 ZIP</a>
        <a className="text-button" href={`${base}/${task.id}/deliveries/${row.id}/view/reports/overview.html`} target="_blank" rel="noreferrer">闭环报告</a>
      </div>)}
    </>}
    <details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
      <p className="ui-hint">仅支持带 Gmsh Python 源码的单实体散热器、矩形接触热源、可定位平面冷却区和垂直贯穿安装孔；安装外形上限、孔位孔径、热源位置、材料、功率、环境与时间保持固定。</p>
      <div className="ui-grid">
        {policyField('maxAttempts','候选尝试预算',1,20)}
        {policyField('timeBudgetMs','时间预算（分钟）',1,120,1/60000)}
        {policyField('massRatio','质量上限（基准 %）',1,200,100)}
        {policyField('significantImprovementC','显著降温（°C）',0.001,undefined,1,'any')}
        {policyField('stagnationCandidates','无改善停止轮数',1,10)}
      </div>
      <p className="ui-hint">每个候选最多修复 1 次并计入预算；总时间含加密网格复核。策略用于新任务。</p>
      {tasks.length>0&&<label className="ui-field">任务历史<select aria-label="优化任务历史" value={task?.id||''} onChange={e=>{setSelection(e.target.value);setPreview('');}}>{tasks.map(row=><option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()} · {phaseLabels[row.phase]} · {row.id.slice(0,8)}</option>)}</select></label>}
      {task&&<>
        <div className="ui-actions"><a className="button" href={`${base}/${task.id}/report`} download={`optimization-${task.id}.md`}>对比报告</a><a className="button" href={`${base}/${task.id}`} download={`optimization-${task.id}.json`}>任务记录</a></div>
        <p className="ui-hint">交付包含可编辑源码、STEP、基准与全部候选、原始温度场、各次求解 PDF 和闭环对比报告；未通过复核时保留基准为推荐设计。</p>
        <pre className="ui-log">{JSON.stringify({taskId:task.id,optimizationProject:task.projectId,sessionId:task.sessionId,baselineRun:task.baseline.runId,baselineHash:task.baseline.sourceHash,policy:task.policy},null,2)}</pre>
      </>}
    </div></details>
  </section>;
}
