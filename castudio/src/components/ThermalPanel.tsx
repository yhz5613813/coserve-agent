import {useEffect,useRef,useState} from 'react';
import {request} from '../api';
import type {Artifact} from '../../shared/types';
import type {ThermalRun,ThermalConfig} from '../../shared/thermal';
import {ThermalComparison} from './ThermalComparison';
import {OptimizationPanel} from './OptimizationPanel';
import {ThermalViewer,thermalFileUrl} from './ThermalViewer';
import {ThermalCaseEditor,type ThermalCaseHandle} from './ThermalCaseEditor';
import type {ThermalPose} from './ThermalScene';
import {canonical} from '../thermal/editor-state';
import '../thermal/editor.css';
const send=(method:string,body:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const labels:Record<ThermalRun['state'],string>={queued:'等待设计编辑结束',running:'正在仿真',succeeded:'仿真完成',failed:'仿真失败',cancelled:'已取消',interrupted:'服务中断'};
export function ThermalPanel({projectId,files,initialSource,busy,changed,feedback}:{projectId:string;files:Artifact[];initialSource?:string;busy:boolean;changed:()=>Promise<void>;feedback:(text:string)=>void}){
  const [runs,setRuns]=useState<ThermalRun[]>([]),[selected,setSelected]=useState(''),[view,setView]=useState<'edit'|'results'>('edit');
  const [error,setError]=useState(''),[working,setWorking]=useState(false),[context,setContext]=useState<{source:string;config:ThermalConfig}|null>(null);
  const resultsRef=useRef<HTMLElement>(null),seenRunning=useRef(''),initialPoll=useRef(true),editor=useRef<ThermalCaseHandle>(null),pose=useRef<ThermalPose|null>(null);
  const run=runs.find(row=>row.id===selected)||runs[0],active=runs.some(row=>['queued','running'].includes(row.state)),base=`/api/projects/${projectId}/thermal`;
  useEffect(()=>{
    let live=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      let running=false;
      try{
        const rows=await request<ThermalRun[]>(base);if(!live)return;setRuns(rows);
        const activeRun=rows.find(row=>['queued','running'].includes(row.state));running=!!activeRun;
        if(initialPoll.current){initialPoll.current=false;if(rows.length)setView('results');}
        if(activeRun&&seenRunning.current!==activeRun.id){seenRunning.current=activeRun.id;setSelected(activeRun.id);setView('results');}
      }catch(reason){if(live)setError((reason as Error).message);}
      finally{if(live)timer=setTimeout(refresh,running?1000:2000);}
    };
    void refresh();return()=>{live=false;clearTimeout(timer);};
  },[projectId]);
  useEffect(()=>{if(view==='results'&&run&&['queued','running'].includes(run.state))resultsRef.current?.scrollIntoView({block:'start',behavior:'smooth'});},[run?.id,view]);
  const latest=run?.preview?.frames.at(-1),summary=run?.result?run.result.result:latest&&run.preview?{minimum_C:latest.minimum_C,maximum_C:latest.maximum_C,frames:run.preview.frames.length}:undefined;
  const detail=run?.state==='succeeded'?'报告与完整结果已生成':run?.state==='running'&&latest&&latest.time_s>=Number(run.config.duration_s)?'温度帧已保存，正在处理完整结果':run&&['queued','running'].includes(run.state)?run.progress?.detail:undefined;
  const modified=!!run&&!!context&&(run.source!==context.source||canonical(run.config)!==canonical(context.config));
  const act=async(fn:()=>Promise<void>)=>{setWorking(true);setError('');try{await fn();}catch(reason){setError((reason as Error).message);}finally{setWorking(false);}};
  return <div className="thermal-panel thermal-editor-panel">
    <div className="thermal-workspace-tabs" role="tablist" aria-label="热分析视图">
      <button className={'button'+(view==='edit'?' primary':'')} role="tab" aria-selected={view==='edit'} onClick={()=>setView('edit')}>编辑工况</button>
      <button className={'button'+(view==='results'?' primary':'')} role="tab" aria-selected={view==='results'} onClick={()=>setView('results')}>仿真结果{active?' · 计算中':''}</button>
    </div>
    <div hidden={view!=='edit'}><ThermalCaseEditor ref={editor} projectId={projectId} files={files} initialSource={initialSource} visible={view==='edit'} busy={busy||active} pose={pose} changed={changed}
      onDraft={(source,config)=>setContext({source,config})} onRun={record=>{setSelected(record.id);setRuns(old=>[record,...old]);setView('results');}}/></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {view==='results'&&<section className="thermal-results" ref={resultsRef}>
      <h3>{run&&['queued','running'].includes(run.state)?'实时热仿真':'结果与设计反馈'}</h3>
      <select aria-label="热仿真记录" value={run?.id||''} onChange={event=>setSelected(event.target.value)}><option value="">暂无计算记录</option>{runs.map(row=><option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()} · {row.source} · {labels[row.state]}</option>)}</select>
      {!run&&<p>先在「编辑工况」中放置热源、确认材料和散热条件，然后运行</p>}
      {run&&<>
        <div className="thermal-run-status" role="status"><span>{labels[run.state]}</span><span>{detail}</span></div>
        {['queued','running'].includes(run.state)&&<><progress aria-label="热仿真进度" max={100} value={run.progress?.progress||0}/><button className="button" disabled={working} onClick={()=>void act(async()=>{await request(base+'/'+run.id+'/cancel',send('POST',{}));setRuns(await request(base));})}>取消仿真</button></>}
        {run.stale&&<p className="form-error">当前模型已变化，本结果对应旧模型，请重新仿真</p>}
        {modified&&<p className="thermal-draft-notice">工况已修改，此结果对应上次计算；点击「编辑工况」核对后重新运行</p>}
        {run.error&&<p className="form-error">{run.error}</p>}{run.previewError&&<p role="alert" className="form-error">{run.previewError}</p>}
        {run.preview&&<p className="thermal-live-status">{run.state==='running'?'计算中':'未完成预览'} · 已保存 {run.preview.frames.length} 帧{run.preview.analysis_mode==='transient'&&' · 已求至 '+latest!.time_s.toFixed(1)+' s'}</p>}
        {summary&&<div className="thermal-summary"><span>{run.result?'最低':'最新帧最低'} <b>{summary.minimum_C.toFixed(2)} °C</b></span><span>{run.result?'最高':'最新帧最高'} <b>{summary.maximum_C.toFixed(2)} °C</b></span><span>保存 <b>{summary.frames} 帧</b></span></div>}
        {run.result&&<OptimizationPanel key={'optimize-'+projectId} projectId={projectId} baselineRunId={run.id} disabled={working||busy||active||run.state!=='succeeded'}/>}
        {(run.preview||run.result)?<ThermalViewer key={run.id} projectId={projectId} run={run} pose={pose}/>:['queued','running'].includes(run.state)&&<div className="thermal-preview-wait">{run.state==='queued'?'等待设计编辑结束后启动求解器':'温度场将在首个保存帧完成后显示'}</div>}
        {run.result&&<>
          <ThermalComparison key={'compare-'+run.id} run={run} runs={runs}/>
          {run.result.result.summary.warnings?.map((warning,i)=><p key={i} className="hint">{warning}</p>)}
          <div className="build-artifacts">{['job/report.pdf','job/report.md','job/history.csv','job/result.zip','manifest.json'].map(file=><a key={file} href={thermalFileUrl(projectId,run.id,file)} download>{file.split('/').pop()}</a>)}</div>
          <div className="build-actions">
            <button className="button" disabled={working||busy||active||!!run.publishedRevision} onClick={()=>void act(async()=>{await request(base+'/'+run.id+'/publish',send('POST',{}));await changed();setRuns(await request(base));})}>{run.publishedRevision?'已保存到项目':'保存结果到项目'}</button>
            <button className="button primary" disabled={working||busy||active} onClick={()=>void act(async()=>{
              const saved=await request<{path:string}>(base+'/'+run.id+'/publish',send('POST',{}));await changed();
              feedback(['请根据热仿真结果检查并改进设计。','建模来源：'+run.source,'模型 SHA-256：'+run.sourceHash,'报告：'+saved.path+'/job/report.md','工况：'+saved.path+'/job/config.json','最高温度：'+run.result!.result.maximum_C.toFixed(2)+' °C。'+(run.stale?'注意：当前模型已变化，此结果仅对应旧模型。':''),'先阅读报告、核对热边界和材料，再提出建模修改；修改后导出 STEP/STL 并重新仿真验证。'].join('\n'));
            })}>将结果加入设计对话</button>
            <button className="button" disabled={working||active} onClick={()=>{editor.current?.reuse(run);setView('edit');}}>复用本次工况</button>
          </div>
        </>}
        <details><summary>日志与来源</summary><code>{run.source}</code><code>SHA-256: {run.sourceHash}</code><pre className="build-log">{run.log||'等待执行…'}</pre></details>
      </>}
    </section>}
  </div>;
}
