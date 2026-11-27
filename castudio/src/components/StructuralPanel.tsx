import {useEffect,useMemo,useState,useRef} from 'react';
import {Box,LoaderCircle} from 'lucide-react';
import { chooseStructuralSource } from '../scene/structural-source';
import {Empty,Step,Steps,type StepState} from './Steps';
import {Numeric} from './Numeric';
import {fileLabel} from './FilePanel';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {Artifact} from '../../shared/types';
async function request(url:string,method='GET',body?:unknown){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||r.statusText);return j;}
function FieldView({url,field,factor,section,active}:{url:string;field:string;factor:number;section:boolean;active:boolean}){
 const host=useRef<HTMLDivElement>(null),live=useRef(active);live.current=active;
 useEffect(()=>{let disposed=false,renderer:THREE.WebGLRenderer|undefined,controls:OrbitControls|undefined,ro:ResizeObserver|undefined;let frame=0;const objects:THREE.Object3D[]=[];
  void request(url).then(d=>{if(disposed||!host.current)return;const el=host.current,scene=new THREE.Scene();scene.background=new THREE.Color(getComputedStyle(el).getPropertyValue('--embed-surface').trim()||'#f2f4ee');
   renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));el.appendChild(renderer.domElement);
   const camera=new THREE.PerspectiveCamera(38,1,1,10000);camera.up.set(0,0,1);camera.position.set(1350,-1650,1200);
   controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,250);controls.update();
   const positions:number[]=[],colors:number[]=[];const color=new THREE.Color();
   d.triangles.forEach((tri:number[],i:number)=>{const center=tri.reduce((a,n)=>a+d.points[n][1],0)/3;if(section&&center<0)return;
    tri.forEach(n=>{const p=d.points[n],u=d.displacements[n];positions.push(...p.map((v:number,a:number)=>v+factor*u[a]));
      const value=field==='mises'?d.element_mises[i]/d.maximum_mises:Math.hypot(...u)/d.maximum_displacement;color.setHSL((1-Math.min(1,Math.max(0,value)))*.67,1,.52);colors.push(color.r,color.g,color.b);});});
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();
   const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide});const mesh=new THREE.Mesh(geometry,material);scene.add(mesh);objects.push(mesh);
   const resize=()=>{if(!renderer)return;const w=el.clientWidth,h=el.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};ro=new ResizeObserver(resize);ro.observe(el);resize();
   const draw=()=>{if(disposed||!renderer)return;if(live.current){controls?.update();renderer.render(scene,camera);}frame=requestAnimationFrame(draw);};draw();
  }).catch(console.error);
  return()=>{disposed=true;cancelAnimationFrame(frame);ro?.disconnect();controls?.dispose();objects.forEach(o=>{const m=o as THREE.Mesh;m.geometry?.dispose();(m.material as THREE.Material)?.dispose();});renderer?.dispose();host.current?.replaceChildren();};
 },[url,field,factor,section]);
 return <div ref={host} className="field-view"/>;
}
const stateLabels:Record<string,string>={queued:'排队中',running:'计算中',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
/** `currentModel` is the part's current model resolved to a STEP path when it has one; the page follows it whenever it changes, and says why when it is not a solver input. */
export function StructuralPanel({projectId,partName,files,changed,initialSource,defaultSource,sourceRequest,currentModel,openParametric,active=true}:{projectId:string;partName:string;files:Artifact[];changed:()=>Promise<void>;initialSource?:string;defaultSource?:string;sourceRequest?:number;currentModel?:string;openParametric:()=>void;active?:boolean}){
 const [step,setStep]=useState<1|2|3>(initialSource?2:1),runsSeen=useRef(false);
 const sourceSelected=useRef(!!initialSource),followed=useRef(currentModel);
 const base='api/projects/'+projectId;const [runs,setRuns]=useState<any[]>([]),[chosen,setChosen]=useState(''),[source,setSource]=useState(initialSource||defaultSource||''),[mesh,setMesh]=useState(24),[study,setStudy]=useState(true),[sizes,setSizes]=useState('32,24,18'),[resume,setResume]=useState(''),[reprocess,setReprocess]=useState(false),[fillDiagnostics,setFillDiagnostics]=useState(false),[force,setForce]=useState(2451662.5),[youngs,setYoungs]=useState(70000),[poisson,setPoisson]=useState(.33),[template,setTemplate]=useState(''),[pressure,setPressure]=useState(.2),[error,setError]=useState(''),[working,setWorking]=useState(false),[build,setBuild]=useState(''),[field,setField]=useState('mises'),[resultSize,setResultSize]=useState(''),[resultMode,setResultMode]=useState('nonlinear'),[factor,setFactor]=useState(0),[section,setSection]=useState(false);
 // The solver is a cylinder-shell model: exports of any other parametric template are not candidates.
 const plateExport=(path:string)=>!!template&&template!=='cylinder'&&path.startsWith('parametric/exports/');
 const solverFiles=useMemo(()=>files.filter(f=>!plateExport(f.path)),[files,template]);
 const run=runs.find(r=>r.id===chosen)||runs[0],steps=solverFiles.filter(f=>/\.step$/i.test(f.name)&&!f.path.startsWith('structural/')&&!f.path.startsWith('studio/cad-inspections/'));
 const notShell=plateExport(source),materialError=!(youngs>0&&youngs<=1e6)?'弹性模量 E 应大于 0 且不超过 1000000 MPa':!(poisson>0&&poisson<.5)?'泊松比 ν 应大于 0 且小于 0.5':'';
 const material=run?.material??run?.summary?.material;
 // A newly opened model in 模型 overrides an earlier pick in this page.
 useEffect(()=>{if(followed.current!==currentModel){followed.current=currentModel;sourceSelected.current=false;}setSource(current=>chooseStructuralSource(solverFiles,current,defaultSource,sourceSelected.current,currentModel));},[solverFiles,defaultSource,currentModel]);
 useEffect(()=>{let live=true;void request(base+'/parametric').then(s=>{if(live)setTemplate(s.template||'');}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[base,files]);
 useEffect(()=>{if(!active)return;let live=true;const refresh=()=>request(base+'/structural').then(r=>{if(!live)return;setRuns(r);if(!runsSeen.current){runsSeen.current=true;if(r.length&&!initialSource)setStep(3);}}).catch(e=>{if(live)setError(e.message);});void refresh();const t=setInterval(refresh,2000);return()=>{live=false;clearInterval(t);};},[base,active]);
 useEffect(()=>{if(initialSource){sourceSelected.current=true;setSource(initialSource);setStep(2);}},[initialSource,sourceRequest]);
 useEffect(()=>{setResume('');setReprocess(false);setFillDiagnostics(false);},[source,sourceRequest]);
 const levels=run?.summary?.mesh_study?.levels;const selectedLevel=levels?.find((r:any)=>String(r.size_mm)===resultSize)||levels?.[levels.length-1];
 const result=selectedLevel?.[resultMode]||run?.summary;const resultPath=selectedLevel?`mesh-${selectedLevel.size_mm}/${resultMode}`:'static';
 const file=(p:string,download=false)=>base+'/structural/'+run.id+'/file?path='+encodeURIComponent(p)+(download?'&download=1':'');
 const construct=async()=>{setWorking(true);setError('');setBuild('正在读取 build_model.py…');try{const src=await fetch(base+'/file?path=build_model.py&text=1');if(!src.ok)throw Error('无法读取建模源码');const expectedSource=await src.text();const parameters=await request(base+'/parameters?source=build_model.py');let r=await request(base+'/builds','POST',{source:'build_model.py',expectedSource,expectedParameters:parameters.hash});setBuild('正在通过 CadFlow 构建筒体、翻边、孔与筋条');
   while(['preparing','running'].includes(r.state)){await new Promise(ok=>setTimeout(ok,1500));r=await request(base+'/builds/'+r.id);}
   if(r.state!=='succeeded')throw Error(r.error||r.log||'CAD 构建失败');const pub=await request(base+'/builds/'+r.id+'/publish','POST');sourceSelected.current=true;setSource(pub.path+'/cylinder.step');setBuild('CAD 已构建并保存：'+pub.path);await changed();
  }catch(e){setBuild('');setError((e as Error).message);}finally{setWorking(false);}};
 const solve=async()=>{setWorking(true);setError('');try{const r=await request(base+'/structural','POST',{source,mesh_size_mm:mesh,axial_force_N:force,external_pressure_MPa:pressure,E_MPa:youngs,nu:poisson,buckling:!study,mesh_study:study,reprocess_only:study&&reprocess,diagnostics_fill_missing:study&&reprocess&&fillDiagnostics,resume_run:resume||undefined,mesh_levels_mm:sizes.split(',').map(Number)});setChosen(r.id);setRuns(v=>[r,...v]);setStep(3);}catch(e){setError((e as Error).message);}finally{setWorking(false);}};
 const ready=!!source&&!notShell&&!materialError,computing=runs.some(r=>['queued','running'].includes(r.state));
 const shown=step===3&&runs.length?3:step>=2&&ready?2:1;
 const stepState=(n:1|2|3,enabled:boolean,complete:boolean):StepState=>n===shown?'current':!enabled?'locked':complete?'done':'open';
 const blocked=notShell?`${template==='plate'?'平板':'该模型'}不适用：求解器只支持圆柱壳`:!source?'先选择圆柱壳 STEP':materialError;
 // Shown instead of silently picking another file when the current model cannot feed the solver.
 const currentName=currentModel?.split('/').pop(),unsuitable=!!currentModel&&!source&&!sourceSelected.current&&(/\.(step|stp)$/i.test(currentModel)?`当前模型 ${currentName} 不适用：求解器只支持圆柱壳，请选择其他 STEP。`:`当前模型 ${currentName} 不是 STEP：求解器只支持圆柱壳 STEP，请选择其他 STEP。`);
 const firstLine=(text:string)=>text.split('\n').find(line=>line.trim())||text;
 // Request failures belong to whichever step is on screen, so a retry from the result step reports there too.
 const errorLine=error&&<p role="alert" className="form-error">{error}</p>;
 const buildSource=files.some(f=>f.path==='build_model.py');
 const constructAction=<button className="button" disabled={working||computing} onClick={()=>void construct()}>{working&&build?'正在构建…':'从 build_model.py 构建圆柱壳'}</button>;
 return <div className="structural-panel ui-stack">
 <Steps label="结构仿真步骤">
 <Step n={1} title="模型与材料" state={stepState(1,true,ready)} summary={`零件：${partName} · ${ready?`模型：${source.split('/').pop()} · E ${youngs} MPa · ν ${poisson}`:blocked}`} onOpen={()=>setStep(1)}>
  {steps.length?<label className="ui-field">圆柱壳 STEP<select value={source} onChange={e=>{sourceSelected.current=true;setSource(e.target.value);}}>{!source&&<option value="">选择圆柱壳 STEP</option>}{steps.map(f=><option key={f.path} value={f.path} title={f.path}>{fileLabel(f)}</option>)}</select></label>
  :<Empty icon={<Box size={20}/>} text={`零件「${partName}」${template==='plate'?'用平板模板建模':template&&template!=='cylinder'?'的参数化程序不是圆柱壳':'还没有圆柱壳 STEP'}，结构求解器只支持圆柱壳${buildSource?'；也可以从 build_model.py 构建':''}。`} action={buildSource?constructAction:<button className="button" onClick={openParametric}>去参数</button>}/>}
  {steps.length>0&&unsuitable&&<p className="ui-hint warn" role="status">{unsuitable}</p>}
  {build&&<p className="ui-hint" role="status">{build}</p>}
  {notShell&&<p className="ui-hint warn" role="status">{blocked}，请选择其他 STEP。</p>}
  <div className="ui-grid"><Numeric required label="弹性模量 E（MPa）" min={1} max={1000000} step={1000} value={youngs} onCommit={v=>{if(v!==undefined)setYoungs(v);}}/><Numeric required label="泊松比 ν" min={0.01} max={0.49} step={.01} value={poisson} onCommit={v=>{if(v!==undefined)setPoisson(v);}}/></div>
  {materialError?<p role="alert" className="form-error">{materialError}</p>:<p className="ui-hint">各向同性线弹性；默认铝合金 E 70000 MPa、ν 0.33。</p>}
  {errorLine}
  <div className="ui-actions"><button className="button primary" disabled={!ready} title={ready?undefined:blocked} onClick={()=>setStep(2)}>下一步</button>{!ready&&<span className="ui-hint">{blocked}</span>}</div>
  {steps.length>0&&buildSource&&<details className="ui-disclosure"><summary>高级</summary><div className="ui-actions">{constructAction}<span className="ui-hint">用项目里的 build_model.py 重新生成圆柱壳 STEP</span></div></details>}
 </Step>
 <Step n={2} title="载荷与运行" state={stepState(2,ready,runs.length>0)} summary={ready?`轴向 ${force} N · 外压 ${pressure} MPa`:blocked} onOpen={()=>setStep(2)}>
  <div className="ui-grid"><Numeric required label="轴向总压力（N）" value={force} onCommit={v=>{if(v!==undefined)setForce(v);}}/><Numeric required label="外压（MPa）" step={.01} value={pressure} onCommit={v=>{if(v!==undefined)setPressure(v);}}/></div>
  <p className="ui-hint">固定下端框，上端面均布轴向力，筒体外表面施加外压。</p>
  {errorLine}
  <div className="ui-actions"><button className="button primary" disabled={working||!ready||computing} onClick={()=>void solve()}>{study&&reprocess?(fillDiagnostics?'整理结果并补齐诊断':'重新生成云图与报告'):'运行分析'}</button>{computing&&<span className="ui-hint">已有计算在进行</span>}</div>
  <details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
   <label className="ui-check"><input type="checkbox" checked={study} onChange={e=>setStudy(e.target.checked)}/>几何非线性与网格收敛验证（关闭则做静力与屈曲分析）</label>
   <div className="ui-grid"><Numeric required label="网格目标尺寸（mm）" min={12} max={60} value={mesh} onCommit={v=>{if(v!==undefined)setMesh(v);}}/>{study&&<label className="ui-field">网格序列（mm）<input value={sizes} onChange={e=>setSizes(e.target.value)}/></label>}
   <label className="ui-field wide">复用已完成网格<select value={resume} onChange={e=>setResume(e.target.value)}><option value="">不复用</option>{runs.filter(r=>!['queued','running'].includes(r.state)).map(r=><option key={r.id} value={r.id}>{r.createdAt.slice(5,16).replace('T',' ')} · {stateLabels[r.state]??r.state} · {r.id.slice(0,8)}</option>)}</select></label></div>
   {study&&<label className="ui-check"><input type="checkbox" checked={reprocess} onChange={e=>setReprocess(e.target.checked)}/>仅重新生成云图与报告（保留原收敛状态）</label>}
   {study&&reprocess&&<label className="ui-check"><input type="checkbox" checked={fillDiagnostics} onChange={e=>setFillDiagnostics(e.target.checked)}/>补算缺失的载荷诊断（主分析不重算）</label>}
  </div></details>
 </Step>
 <Step n={3} title="结果" state={stepState(3,runs.length>0,false)} summary={run?`${stateLabels[run.state]??run.state} · ${run.createdAt.slice(5,16).replace('T',' ')}`:'运行后查看应力与位移'} onOpen={()=>setStep(3)}>
  {run&&['queued','running'].includes(run.state)&&<div className="ui-actions" role="status"><LoaderCircle className="spin" size={14}/><span className="ui-hint">{run.state==='queued'?'等待设计助手完成当前编辑后自动计算':run.progress?.detail||'正在计算'}</span><button className="text-button" onClick={()=>void request(base+'/structural/'+run.id+'/cancel','POST').catch(e=>setError((e as Error).message))}>取消</button></div>}
  {run&&['failed','interrupted'].includes(run.state)&&<div className="ui-actions"><p role="alert" className="form-error">计算未完成：{firstLine(run.error||stateLabels[run.state])}</p><button className="button" disabled={working||!ready||computing} title={ready?'用当前模型、材料与载荷重新运行':blocked} onClick={()=>void solve()}>重试</button></div>}
  {errorLine}
  {run&&source&&run.source!==source&&<p className="ui-hint warn" role="status">这条记录对应其他几何版本；重新运行后显示当前几何的结果。</p>}
  {run?.state==='succeeded'&&run.summary&&<>
   <div className="ui-metrics"><div><span>最大 Mises 应力</span><strong>{result.maximum_von_mises_MPa.toFixed(2)} <small>MPa</small></strong></div><div><span>最大总位移</span><strong>{result.maximum_displacement_mm.toFixed(3)} <small>mm</small></strong></div></div>
   <p className="ui-hint">{levels?(resultMode==='nonlinear'?'几何非线性':'线性参考'):'线性参考'}{material&&` · E ${material.E_MPa} MPa · ν ${material.nu}`}{levels&&` · 载荷比例 ${result.load_factor.toFixed(5)}${result.full_load_reached?'（全载荷）':'（最后收敛增量）'}`}</p>
   <div className="ui-actions"><select className="ui-select sm" aria-label="云图变量" value={field} onChange={e=>setField(e.target.value)}><option value="mises">Mises 应力</option><option value="displacement">总位移</option></select><Numeric required label="变形倍率" className="ui-check" inputClassName="ui-input sm" style={{width:56}} min={0} max={30} step={1} value={factor} onCommit={v=>{if(v!==undefined)setFactor(Math.min(30,Math.max(0,v)));}}/><label className="ui-check"><input type="checkbox" checked={section} onChange={e=>setSection(e.target.checked)}/>剖切</label></div>
   <FieldView url={file(resultPath+'/display.json')} field={field} factor={factor} section={section} active={active}/>
   <div className="ui-legend"><span>0</span><i/><span>{field==='mises'?result.maximum_von_mises_MPa.toFixed(2)+' MPa':result.maximum_displacement_mm.toFixed(3)+' mm'}</span></div>
   <p className="ui-hint">{run.summary.assessment||'线弹性参考场；屈曲系数、应力适用性与收敛结果请查看报告。'}</p>
   <div className="ui-actions"><a className="button primary" href={file('report.docx',true)}>下载报告</a></div>
  </>}
  <details className="ui-disclosure"><summary>高级</summary><div className="ui-stack">
   <label className="ui-field">计算记录<select aria-label="计算记录" value={run?.id||''} onChange={e=>setChosen(e.target.value)}>{runs.map(r=><option value={r.id} key={r.id}>{r.createdAt.slice(0,19).replace('T',' ')} · {stateLabels[r.state]??r.state}</option>)}</select></label>
   {run?.state==='succeeded'&&run.summary&&<>
    {levels&&<div className="ui-grid"><label className="ui-field">结果网格（mm）<select value={String(selectedLevel.size_mm)} onChange={e=>setResultSize(e.target.value)}>{levels.map((r:any)=><option key={r.size_mm} value={r.size_mm}>{r.size_mm}</option>)}</select></label><label className="ui-field">分析结果<select value={resultMode} onChange={e=>setResultMode(e.target.value)}><option value="nonlinear">几何非线性</option><option value="linear">线性参考</option></select></label></div>}
    <p className="ui-hint">首阶正屈曲系数 {run.summary.buckling?.first_positive_factor?.toFixed(4)??'未计算'} · {run.summary.mesh_study&&result.assembled_balance_relative==null?'中面近似平衡残差':'力平衡残差'} {result.balance_relative.toExponential(2)}；{field==='mises'?'应力取各单元厚度方向积分点最大值':'位移为节点总位移'}。</p>
    <div className="ui-actions"><a className="button" href={file(resultPath+'/mises.png',true)}>应力云图</a><a className="button" href={file(resultPath+'/displacement.png',true)}>位移云图</a><a className="button" href={file(resultPath+'/analysis.inp',true)}>求解输入文件</a></div>
    {run.summary.diagnosis&&<div><h4>高应力来源分析</h4>{run.summary.diagnosis.paragraphs.map((p:string,i:number)=><p key={i}>{p}</p>)}</div>}
    {run.summary.mesh_study&&<div><h4>几何非线性网格验证</h4><p>当前云图载荷比例：{result.load_factor.toFixed(5)} · {result.full_load_reached?'达到全载荷':'仅最后收敛增量'}；轴压力 {(result.load.axial_force_N*result.load_factor/9806.65).toFixed(3)} 公吨力，外压 {(result.load.external_pressure_MPa*result.load_factor).toFixed(5)} MPa</p><table><thead><tr><th>网格 mm</th><th>载荷比例</th><th>位移 mm</th><th>Mises MPa</th><th>筒皮远场 MPa</th></tr></thead><tbody>{run.summary.mesh_study.levels.map((r:any)=><tr key={r.size_mm}><td>{r.size_mm}</td><td>{r.nonlinear.load_factor.toFixed(5)}</td><td>{r.nonlinear.maximum_displacement_mm.toFixed(3)}</td><td>{r.nonlinear.maximum_von_mises_MPa.toFixed(1)}</td><td>{r.nonlinear.bulk_skin_max_mises_MPa.toFixed(1)}</td></tr>)}</tbody></table><MeshChanges study={run.summary.mesh_study}/><CommonLoad study={run.summary.mesh_study}/><img alt="载荷位移与网格验证曲线" src={file('study.png')} style={{width:'100%'}}/></div>}
   </>}
   {run?.error&&<pre className="ui-log">{run.error}</pre>}
  </div></details>
 </Step>
 </Steps>
 </div>;
}


function MeshChanges({study}:{study:any}) {
 const metrics=['maximum_displacement_mm','maximum_von_mises_MPa','bulk_skin_max_mises_MPa'];
 return <div><h4>相邻网格变化（非线性，同载荷）</h4>
 <p>判据：最后两级的三项变化均小于 {100*study.tolerance}%。载荷不同的结果不作收敛比较。</p>
 <table className="mesh-comparisons"><thead><tr><th>网格 mm</th><th>位移变化</th><th>峰值变化</th><th>远场变化</th></tr></thead>
 <tbody>{study.comparisons.map((c:any)=><tr key={c.to_mm}><td>{c.from_mm} → {c.to_mm}</td>
 {metrics.map(k=>{const v=c.nonlinear[k+'_relative_change'];return <td key={k}>{v==null?'载荷不同':(100*v).toFixed(2)+'%'}</td>;})}</tr>)}</tbody></table></div>;
}

function CommonLoad({study}:{study:any}) {
 if(study.common_load_factor==null||study.common_load_factor>=.99999)return null;
 const rows=study.common_load_levels,a=rows[rows.length-2],b=rows[rows.length-1];
 const change=(k:string)=>(100*Math.abs(a[k]-b[k])/Math.abs(b[k])).toFixed(2);
 return <div><h4>实际共同收敛载荷比较</h4><p>载荷比例 {study.common_load_factor.toFixed(5)}，仅使用实际收敛输出，不作插值。</p>
 <table className="common-load"><thead><tr><th>网格 mm</th><th>位移 mm</th><th>Mises MPa</th></tr></thead><tbody>
 {rows.map((r:any)=><tr key={r.size_mm}><td>{r.size_mm}</td><td>{r.maximum_displacement_mm.toFixed(3)}</td><td>{r.maximum_von_mises_MPa.toFixed(1)}</td></tr>)}</tbody></table>
 <p>最后两级位移变化 {change('maximum_displacement_mm')}%，峰值变化 {change('maximum_von_mises_MPa')}%。这不代表目标全载荷下全部指标已收敛。</p></div>;
}
