import {useEffect,useRef,useState,type MutableRefObject} from 'react';
import {LoaderCircle} from 'lucide-react';
import {request} from '../api';
import type {Artifact} from '../../shared/types';
import type {ThermalRun,ThermalConfig} from '../../shared/thermal';
import {ThermalComparison} from './ThermalComparison';
import {OptimizationPanel} from './OptimizationPanel';
import {ThermalViewer,thermalFileUrl} from './ThermalViewer';
import {ThermalCaseEditor,type ThermalCaseHandle} from './ThermalCaseEditor';
import type {ThermalPose} from './ThermalScene';
import {Empty,Step,Steps} from './Steps';
import {canonical} from '../thermal/editor-state';
import '../thermal/editor.css';
const send=(method:string,body:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const labels:Record<ThermalRun['state'],string>={queued:'等待设计编辑结束',running:'正在仿真',succeeded:'仿真完成',failed:'仿真失败',cancelled:'已取消',interrupted:'服务中断'};
const firstLine=(text:string)=>text.split('\n').find(line=>line.trim())||text;
/** Thermal page: ① 热模型 → ② 热源与散热 → ③ 材料与求解 → ④ 结果 → ⑤ 自动优化 (optional); steps 1–3 live in the case editor. */
export function ThermalPanel({projectId,partName,files,currentModel,busy,changed,feedback,unsaved,active=true}:{projectId:string;partName:string;files:Artifact[];currentModel?:string;busy:boolean;changed:()=>Promise<void>;feedback:(text:string)=>void;unsaved?:MutableRefObject<boolean>;active?:boolean}){
  const [runs,setRuns]=useState<ThermalRun[]>([]),[selected,setSelected]=useState(''),[step,setStep]=useState(1);
  const [error,setError]=useState(''),[working,setWorking]=useState(false),[context,setContext]=useState<{source:string;config:ThermalConfig}|null>(null);
  const seenRunning=useRef(''),initialPoll=useRef(true),editor=useRef<ThermalCaseHandle>(null),pose=useRef<ThermalPose|null>(null);
  const run=runs.find(row=>row.id===selected)||runs[0],computing=runs.some(row=>['queued','running'].includes(row.state)),base=`api/projects/${projectId}/thermal`;
  useEffect(()=>{
    if(!active)return;
    let live=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      let running=false;
      try{
        const rows=await request<ThermalRun[]>(base);if(!live)return;setRuns(rows);
        const activeRun=rows.find(row=>['queued','running'].includes(row.state));running=!!activeRun;
        if(initialPoll.current){initialPoll.current=false;if(rows.length)setStep(4);}
        if(activeRun&&seenRunning.current!==activeRun.id){seenRunning.current=activeRun.id;setSelected(activeRun.id);setStep(4);}
      }catch(reason){if(live)setError((reason as Error).message);}
      finally{if(live)timer=setTimeout(refresh,running?1000:2000);}
    };
    void refresh();return()=>{live=false;clearTimeout(timer);};
  },[projectId,active]);
  const latest=run?.preview?.frames.at(-1),summary=run?.result?run.result.result:latest&&run.preview?{minimum_C:latest.minimum_C,maximum_C:latest.maximum_C,frames:run.preview.frames.length}:undefined;
  const pending=!!run&&['queued','running'].includes(run.state);
  const detail=run?.state==='succeeded'?'报告与完整结果已生成':run?.state==='running'&&latest&&latest.time_s>=Number(run.config.duration_s)?'温度帧已保存，正在处理完整结果':pending?run.progress?.detail:undefined;
  const modified=!!run&&!!context&&(run.source!==context.source||canonical(run.config)!==canonical(context.config));
  const optimizable=run?.state==='succeeded'&&!!run.result;
  const act=async(fn:()=>Promise<void>)=>{setWorking(true);setError('');try{await fn();}catch(reason){setError((reason as Error).message);}finally{setWorking(false);}};
  const reuse=(row:ThermalRun)=>{editor.current?.reuse(row);setStep(1);};
  const shown=step===5&&!optimizable||step===4&&!runs.length?3:step;
  return <div className="thermal-panel ui-stack">
    <Steps label="热仿真步骤">
      <ThermalCaseEditor ref={editor} projectId={projectId} partName={partName} files={files} currentModel={currentModel} visible={active} step={shown} onStep={setStep} busy={busy||computing} pose={pose} unsaved={unsaved} changed={changed}
        onDraft={(source,config)=>setContext({source,config})} onRun={record=>{setSelected(record.id);setRuns(old=>[record,...old]);setStep(4);}}/>
      <Step n={4} title="结果" state={shown===4?'current':!runs.length?'locked':shown>4&&run?.state==='succeeded'?'done':'open'} summary={!run?'运行热仿真后查看温度场':`${labels[run.state]}${summary?` · 最高 ${summary.maximum_C.toFixed(2)} °C`:''}`} onOpen={()=>setStep(4)}>
        {run&&<>
          <div className="ui-actions" role="status">{pending&&<LoaderCircle className="spin" size={14}/>}<span>{labels[run.state]}</span>{detail&&<span className="ui-hint">{detail}</span>}{pending&&<button className="text-button" disabled={working} onClick={()=>void act(async()=>{await request(base+'/'+run.id+'/cancel',send('POST',{}));setRuns(await request(base));})}>取消仿真</button>}</div>
          {pending&&<progress aria-label="热仿真进度" max={100} value={run.progress?.progress||0}/>}
          {run.stale&&<p className="ui-hint warn">当前模型已变化，本结果对应旧模型，请重新仿真。</p>}
          {modified&&<p className="ui-hint warn">工况已修改，本结果对应上次计算。</p>}
          {run.error&&<div className="ui-actions"><p role="alert" className="form-error">仿真未完成：{firstLine(run.error)}</p><button className="button" disabled={working||busy||computing} title="用当前工况重新运行" onClick={()=>void act(()=>editor.current!.rerun())}>重试</button><button className="text-button" disabled={working||computing} title="把这条记录的工况载入编辑器，从第 1 步开始修改" onClick={()=>reuse(run)}>以此工况修改</button></div>}
          {run.previewError&&<p role="alert" className="form-error">{run.previewError}</p>}
          {summary&&<div className="ui-metrics"><div><span>{run.result?'最低':'最新帧最低'}</span><strong>{summary.minimum_C.toFixed(2)} <small>°C</small></strong></div><div><span>{run.result?'最高':'最新帧最高'}</span><strong>{summary.maximum_C.toFixed(2)} <small>°C</small></strong></div><div><span>保存帧</span><strong>{summary.frames}</strong></div></div>}
          {(run.preview||run.result)?<ThermalViewer key={run.id} projectId={projectId} run={run} pose={pose}/>:pending&&<Empty icon={<LoaderCircle className="spin" size={20}/>} text={run.state==='queued'?'等待设计编辑结束后启动求解器。':'首个温度帧保存后显示温度场。'}/>}
          {run.result&&<div className="ui-actions">
            <button className="button primary" disabled={working||busy||computing} onClick={()=>void act(async()=>{
              const saved=await request<{path:string}>(base+'/'+run.id+'/publish',send('POST',{}));await changed();
              feedback(['请根据热仿真结果检查并改进设计。','建模来源：'+run.source,'模型 SHA-256：'+run.sourceHash,'报告：'+saved.path+'/job/report.md','工况：'+saved.path+'/job/config.json','最高温度：'+run.result!.result.maximum_C.toFixed(2)+' °C。'+(run.stale?'注意：当前模型已变化，此结果仅对应旧模型。':''),'先阅读报告、核对热边界和材料，再提出建模修改；修改后导出 STEP/STL 并重新仿真验证。'].join('\n'));
            })}>加入设计对话</button>
            <a className="button" href={thermalFileUrl(projectId,run.id,'job/report.pdf')} download>下载报告</a>
            <button className="text-button" disabled={working||computing} onClick={()=>reuse(run)}>以此工况修改</button>
          </div>}
          {error&&<p className="form-error" role="alert">{error}</p>}
        </>}
        <details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
          <label className="ui-field">计算记录<select aria-label="热仿真记录" value={run?.id||''} onChange={event=>setSelected(event.target.value)}>{runs.map(row=><option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()} · {row.source.split('/').pop()} · {labels[row.state]}</option>)}</select></label>
          {run?.preview&&<p className="ui-hint thermal-live-status">{run.state==='running'?'计算中':'未完成预览'} · 已保存 {run.preview.frames.length} 帧{run.preview.analysis_mode==='transient'&&' · 已求至 '+latest!.time_s.toFixed(1)+' s'}</p>}
          {run?.result&&<>
            <ThermalComparison key={'compare-'+run.id} run={run} runs={runs}/>
            {run.result.result.summary.warnings?.map((warning,i)=><p key={i} className="ui-hint">{warning}</p>)}
            <div className="ui-actions">
              <button className="button" disabled={working||busy||computing||!!run.publishedRevision} onClick={()=>void act(async()=>{await request(base+'/'+run.id+'/publish',send('POST',{}));await changed();setRuns(await request(base));})}>{run.publishedRevision?'已保存到项目':'保存结果到项目'}</button>
              {['job/report.md','job/history.csv','job/result.zip','manifest.json'].map(file=><a key={file} className="button" href={thermalFileUrl(projectId,run.id,file)} download>{file.split('/').pop()}</a>)}
            </div>
          </>}
          {run&&<><p className="ui-hint">来源 <code>{run.source}</code> · SHA-256 <code>{run.sourceHash}</code></p><pre className="ui-log">{run.log||'等待执行…'}</pre></>}
        </div></details>
      </Step>
      <Step n={5} title="自动优化" state={shown===5?'current':optimizable?'open':'locked'} summary={optimizable?'可选：按仿真结果自动改进几何':'热仿真完成后可用'} onOpen={()=>setStep(5)}>
        {run?.result&&<OptimizationPanel key={'optimize-'+projectId} projectId={projectId} baselineRunId={run.id} disabled={working||busy||computing||run.state!=='succeeded'} active={active}/>}
      </Step>
    </Steps>
    {error&&shown!==4&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
