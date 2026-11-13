import {useEffect,useRef,useState} from 'react';
import {plotPoint,insertPowerPoint} from '../thermal/curve-geometry';
export type PowerPoint={time_s:number;power_W:number};
export function ThermalPowerCurve({points,power,end,duration,disabled,onChange}:{points:PowerPoint[];power:number;end:number;duration:number;disabled:boolean;onChange:(points:PowerPoint[])=>void}){
  const [preview,setPreview]=useState<PowerPoint[]|null>(null),drag=useRef<{index:number;start:PowerPoint[];time:number;power:number}|null>(null),latestPreview=useRef<PowerPoint[]|null>(null);
  const curve=preview||points,time=Math.max(1,duration,end,...points.map(p=>p.time_s)),maximum=Math.max(1,power,...points.map(p=>p.power_W))*1.2;
  useEffect(()=>{const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'){drag.current=null;setPreview(null);}};window.addEventListener('keydown',cancel);return()=>window.removeEventListener('keydown',cancel);},[]);
  const update=(index:number,key:'time_s'|'power_W',value:string)=>onChange(points.map((point,i)=>i===index?{...point,[key]:Number(value)}:point));
  return <details className="thermal-power-curve"><summary>功率时间曲线</summary>
    {!points.length?<button className="button" disabled={disabled||!(power>0)} onClick={()=>onChange([{time_s:0,power_W:power},{time_s:Math.max(1,end),power_W:power}])}>启用曲线（沿用当前功率）</button>:<>
      <svg viewBox="0 0 420 165" role="img" aria-label="可拖动的热源功率时间曲线" className="thermal-power-plot"
        onPointerMove={event=>{
          const active=drag.current;if(!active)return;const matrix=event.currentTarget.getScreenCTM();if(!matrix)return;
          const {x,y}=plotPoint(event.clientX,event.clientY,matrix);
          const next=structuredClone(active.start),epsilon=Math.max(1e-6,active.time*1e-6);
          const low=active.index?next[active.index-1].time_s+epsilon:0,high=active.index<next.length-1?next[active.index+1].time_s-epsilon:active.time;
          next[active.index]={time_s:Math.max(low,Math.min(high,(x-38)/360*active.time)),power_W:Math.max(0,Math.min(1e8,(125-y)/105*active.power))};latestPreview.current=next;setPreview(next);
        }}
        onPointerUp={event=>{if(drag.current){const value=latestPreview.current;drag.current=null;setPreview(null);if(value)onChange(value);event.currentTarget.releasePointerCapture(event.pointerId);}}}
        onPointerCancel={()=>{drag.current=null;setPreview(null);}}>
        <path d="M38 15V125H398" fill="none" stroke="currentColor" opacity={.5}/>
        <polyline points={curve.map(p=>[38+p.time_s/time*360,125-p.power_W/maximum*105].join(',')).join(' ')} fill="none" stroke="#ffb56a" strokeWidth={2}/>
        {curve.map((p,i)=><circle key={i} cx={38+p.time_s/time*360} cy={125-p.power_W/maximum*105} r={6} fill="#ffb56a" tabIndex={disabled?-1:0} role="button" aria-label={'功率曲线控制点 '+(i+1)}
          onPointerDown={event=>{if(disabled)return;event.stopPropagation();latestPreview.current=null;drag.current={index:i,start:structuredClone(points),time,power:maximum};setPreview(structuredClone(points));event.currentTarget.ownerSVGElement!.setPointerCapture(event.pointerId);}}
          onKeyDown={event=>{if(disabled)return;if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();onChange(points.map((p,j)=>j===i?{...p,power_W:Math.max(0,p.power_W+(event.key==='ArrowUp'?1:-1))}:p));}}}/>)}
        <text x={38} y={151} fill="currentColor" fontSize={10}>0 s</text><text x={350} y={151} fill="currentColor" fontSize={10}>{time.toFixed(1)} s</text>
        <text x={0} y={15} fill="currentColor" fontSize={10}>{maximum.toFixed(1)} W</text>
      </svg>
      <div className="thermal-curve-table">{points.map((point,i)=><div key={i}>
        <label>时刻 s<input aria-label={'曲线时刻 '+(i+1)} type="number" min={0} step="any" value={point.time_s} disabled={disabled} onChange={e=>update(i,'time_s',e.target.value)}/></label>
        <label>功率 W<input aria-label={'曲线功率 '+(i+1)} type="number" min={0} step="any" value={point.power_W} disabled={disabled} onChange={e=>update(i,'power_W',e.target.value)}/></label>
        <button className="button" disabled={disabled||points.length<=2} onClick={()=>onChange(points.filter((_,j)=>j!==i))} aria-label={'删除曲线点 '+(i+1)}>删除</button>
      </div>)}</div>
      <div className="build-actions"><button className="button" disabled={disabled||points.length>=128} onClick={()=>onChange(insertPowerPoint(points,end))}>增加控制点</button><button className="button" disabled={disabled} onClick={()=>onChange([])}>恢复恒定功率</button></div>
      <small>拖动控制点调整时间和功率；启停时间仍由热源的开始与结束时刻控制</small>
    </>}
  </details>;
}
