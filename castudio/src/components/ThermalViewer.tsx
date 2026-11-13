import {useEffect,useRef,useState} from 'react';
import type {MutableRefObject} from 'react';
import type {ThermalManifest,ThermalRun} from '../../shared/thermal';
import {ThermalScene,type ThermalPose} from './ThermalScene';

export const thermalFileUrl=(project:string,run:string,file:string)=>'/api/projects/'+project+'/thermal/'+run+'/file?path='+encodeURIComponent(file);
function fieldHistory(run:ThermalRun):ThermalManifest['result']|undefined {
  if(run.result)return run.result.result;
  const preview=run.preview;if(!preview)return;
  return {analysis_mode:preview.analysis_mode,vertices:preview.vertices,frames:preview.frames.length,
    times_s:preview.frames.map(row=>row.time_s),stats:preview.frames,
    minimum_C:Math.min(...preview.frames.map(row=>row.minimum_C)),maximum_C:Math.max(...preview.frames.map(row=>row.maximum_C)),summary:{}};
}

export function ThermalViewer({projectId,run,pose}:{projectId:string;run:ThermalRun;pose?:MutableRefObject<ThermalPose|null>}) {
  const cached=useRef<{url:string;values:Float32Array}|undefined>(undefined);
  const [surface,setSurface]=useState<{points:number[];faces:number[]}|null>(null);
  const [field,setField]=useState<{values:Float32Array;min:number;max:number}>();
  const [frame,setFrame]=useState(0),[follow,setFollow]=useState(true),[error,setError]=useState('');
  const [display,setDisplay]=useState<{frame:number;min:number;max:number}|null>(null);
  const result=fieldHistory(run),live=!run.result,base='/api/projects/'+projectId+'/thermal/'+run.id;
  const count=result?.frames||0,vertices=result?.vertices||0,min=result?.minimum_C||0,max=result?.maximum_C||0;
  const selected=Math.min(frame,Math.max(0,count-1));
  const fieldURL=live?base+'/preview/'+selected:thermalFileUrl(projectId,run.id,'job/surface.bin');
  useEffect(()=>{
    const abort=new AbortController();setSurface(null);setDisplay(null);setError('');cached.current=undefined;
    void fetch(base+'/geometry',{signal:abort.signal}).then(async response=>{
      if(!response.ok)throw new Error('仿真表面读取失败');const value=await response.json();
      if(!abort.signal.aborted)setSurface(value);
    }).catch(reason=>{if(!abort.signal.aborted)setError((reason as Error).message);});
    return()=>abort.abort();
  },[base,vertices]);
  useEffect(()=>{if(follow&&count)setFrame(count-1);},[follow,count]);
  useEffect(()=>{
    if(!surface||!count)return;const abort=new AbortController();
    async function load(){
      let values=cached.current?.url===fieldURL?cached.current.values:undefined;
      if(!values){
        const response=await fetch(fieldURL,{signal:abort.signal});
        if(!response.ok)throw new Error('温度帧读取失败，正在保留上一次可见结果');
        const bytes=await response.arrayBuffer();if(bytes.byteLength%4!==0)throw new Error('温度帧长度无效');
        values=new Float32Array(bytes);
        if(values.length!==vertices*(live?1:count)||!values.every(Number.isFinite))throw new Error('温度场与几何顶点数量不一致');
        if(abort.signal.aborted)return;cached.current={url:fieldURL,values};
      }
      if(abort.signal.aborted)return;
      const start=(live?0:selected)*vertices;setField({values:values.subarray(start,start+vertices),min,max});
      setDisplay({frame:selected,min,max});setError('');
    }
    void load().catch(reason=>{if(!abort.signal.aborted)setError((reason as Error).message);});
    return()=>abort.abort();
  },[fieldURL,selected,surface,live,count,vertices,min,max]);
  if(!result)return null;
  const shown=display?.frame??selected,low=display?.min??min,high=display?.max??max;
  const span=Math.max(1e-6,max-min),time=Math.max(1,result.times_s.at(-1)||1);
  const line=(key:'minimum_C'|'maximum_C'|'average_C')=>result.stats.map((row,i)=>[30+result.times_s[i]/time*560,115-(row[key]-min)/span*95].join(',')).join(' ');
  return <section className="thermal-view">
    {surface?<ThermalScene identity={base+':'+vertices} sourceHash={run.sourceHash} surface={surface} field={field} pose={pose} disabled onError={setError}/>:<p>正在加载真实热表面…</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    {!display&&!error&&<p>正在加载真实温度场…</p>}
    <div className="thermal-legend"><span>{low.toFixed(2)} °C</span><i/><span>{high.toFixed(2)} °C</span></div>
    <label>{result.analysis_mode==='steady'?(shown===0?'初始状态（未求稳态）':'稳态解'):'时刻 '+result.times_s[shown]?.toFixed(1)+' s'}
      <input aria-label="温度场时刻" type="range" min={0} max={count-1} step={1} value={selected} disabled={!surface} onChange={event=>{setFollow(false);setFrame(Number(event.target.value));}}/>
    </label>
    {live&&<label className="thermal-follow"><input type="checkbox" checked={follow} onChange={event=>setFollow(event.target.checked)}/>自动跟随最新温度帧</label>}
    <small>{live?'色标随已保存温度范围更新':'全时段统一色标'} · 拖动旋转，滚轮缩放 · 仿真表面网格，原始 XYZ 坐标</small>
    {result.analysis_mode==='steady'?<p>稳态结果保留初始状态和稳态解两帧，不代表升温过程。</p>:<>
      <svg viewBox="0 0 620 145" role="img" aria-label="温度随时间变化曲线" style={{width:'100%',maxHeight:180}}>
        <path d="M30 15V115H590" fill="none" stroke="#596273"/>
        {(['minimum_C','average_C','maximum_C'] as const).map((key,i)=><polyline key={key} points={line(key)} fill="none" stroke={['#6aaaff','#72d6c2','#ffb56a'][i]} strokeWidth={2}/>)}
        <text x={30} y={137} fill="#aeb7c6" fontSize={11}>0 s</text><text x={555} y={137} fill="#aeb7c6" fontSize={11}>{time} s</text>
      </svg>
      <small>蓝：最低温度 · 绿：体积平均温度 · 橙：最高温度。仅连接实际保存帧。</small>
    </>}
  </section>;
}
