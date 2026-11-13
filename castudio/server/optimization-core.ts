import {DEFAULT_OPTIMIZATION_POLICY} from '../shared/optimization.js';
import type {OptimizationPolicy,OptimizationMetrics} from '../shared/optimization.js';
import type {ThermalConfig,ThermalSurface,ThermalSelection,ThermalSelectionResult} from '../shared/thermal.js';
import {HttpError} from './storage.js';
export function resolvePolicy(input:Partial<OptimizationPolicy>={}):OptimizationPolicy{
 const p={...DEFAULT_OPTIMIZATION_POLICY,...input};
 for(const [key,value] of Object.entries(p))if(typeof value!=='number'||!Number.isFinite(value)||value<=(key==='maxRepairsPerCandidate'? -1:0))throw new HttpError(400,`无效优化限制 ${key}`);
 for(const k of ['maxAttempts','maxRepairsPerCandidate','stagnationCandidates'] as const)if(!Number.isInteger(p[k]))throw new HttpError(400,`无效优化限制 ${k}`);
 if(p.verificationMeshFactor>=1)throw new HttpError(400,'复核网格比例必须小于1');return p;
}
export function rankCandidate(value:OptimizationMetrics,best:OptimizationMetrics,baselineMass:number,policy:OptimizationPolicy){return Number.isFinite(value.maximumC)&&Number.isFinite(value.massKg)&&value.massKg>0&&value.massKg<=baselineMass*policy.massRatio&&(value.maximumC<best.maximumC-1e-6||(Math.abs(value.maximumC-best.maximumC)<=1e-6&&value.massKg<best.massKg));}
/** A coarse improvement is only verified when the fine mesh confirms its threshold. */
export function verificationPhase(coarseImprovementC:number,fineImprovementC:number,thresholdC:number):'completed'|'no_improvement'|'unverified'{
 if(fineImprovementC>=thresholdC)return 'completed';
 if(coarseImprovementC>=thresholdC||coarseImprovementC>0&&fineImprovementC<0)return 'unverified';
 return 'no_improvement';
}
function planeMetrics(surface:ThermalSurface,ids:number[],u:number[],v:number[]){const centroid=[0,0,0],low=[Infinity,Infinity],high=[-Infinity,-Infinity];let area=0;for(const id of ids){const points=[0,1,2].map(k=>{const vertex=surface.faces[id*3+k];return surface.points.slice(vertex*3,vertex*3+3);});const a=points[1].map((x,i)=>x-points[0][i]),b=points[2].map((x,i)=>x-points[0][i]),cross=a.map((_,i)=>a[(i+1)%3]*b[(i+2)%3]-a[(i+2)%3]*b[(i+1)%3]),weight=Math.hypot(...cross)/2;area+=weight;for(let i=0;i<3;i++)centroid[i]+=points.reduce((sum,p)=>sum+p[i],0)*weight/3;for(const point of points)for(const [axis,basis] of [u,v].entries()){const projection=point.reduce((sum,x,i)=>sum+x*basis[i],0);low[axis]=Math.min(low[axis],projection);high[axis]=Math.max(high[axis],projection);}}if(area<=0)throw new Error('冷却面面积无效');return [...centroid.map(x=>x/area),...low,...high];}
/** Re-resolves positional descriptors; triangle IDs never survive a geometry change. */
export async function bindConfig(config:ThermalConfig,baseline:ThermalSurface,surface:ThermalSurface,resolve:(selection:ThermalSelection)=>Promise<ThermalSelectionResult>):Promise<ThermalConfig>{
 const cfg=structuredClone(config);
 if(cfg.structural||cfg.surface_evaluation||(cfg.regions as unknown[]|undefined)?.length||(cfg.component_materials as unknown[]|undefined)?.length)throw new Error('首版不支持局部材料、结构或表面评价选区');
 const groups=[...(cfg.heat_sources as Record<string,unknown>[]||[]),...(cfg.cooling as Record<string,unknown>[]||[])];
 for(const condition of groups){
  const patch=condition.surface_patch as {center_m:[number,number,number];u_axis:[number,number,number];v_axis:[number,number,number];width_m:number;height_m:number}|undefined;
  let descriptor:ThermalSelection;
  if(patch)descriptor={kind:'rectangle',...patch};
  else{
   if((cfg.heat_sources as unknown[]||[]).includes(condition))throw new Error('首版热源必须为可定位矩形表面热源');
   const ids=condition.faces as number[]|undefined;
   const group=ids?.length?baseline.groups.find(g=>g.id===baseline.face_groups[ids[0]]):undefined;
   if(!group?.planar||!ids||ids.length!==group.triangles)throw new Error('冷却面必须为可定位完整平面');
   descriptor={kind:'face',center_m:group.center_m,u_axis:group.u_axis,v_axis:group.v_axis};
  }
  if(condition.selector||condition.surface_box||condition.placement==='embedded'||condition.source_type==='point')throw new Error('首版仅支持矩形表面热源和定位平面冷却');
  const center=descriptor.center_m!,normal=descriptor.u_axis!.map((_,i)=>descriptor.u_axis![(i+1)%3]*descriptor.v_axis![(i+2)%3]-descriptor.u_axis![(i+2)%3]*descriptor.v_axis![(i+1)%3]);
  const originalGroups=baseline.groups.filter(g=>g.planar&&Math.abs(g.normal.reduce((s,x,i)=>s+x*normal[i],0))>1-1e-5&&Math.abs(g.center_m.reduce((s,x,i)=>s+(x-center[i])*normal[i],0))<1e-7);if(originalGroups.length!==1)throw new Error('基准边界平面法向不唯一');const outward=originalGroups[0].normal;
  const compatible=surface.groups.filter(g=>g.planar&&g.normal.reduce((s,x,i)=>s+x*outward[i],0)>1-1e-5&&Math.abs(g.center_m.reduce((s,x,i)=>s+(x-center[i])*normal[i],0))<1e-7);
  if(compatible.length!==1)throw new Error('边界平面缺失或定位不唯一');
  descriptor.face=surface.face_groups.indexOf(compatible[0].id);
  const resolved=await resolve(descriptor);
  if(!resolved.faces.length||!Number.isFinite(resolved.area_m2)||resolved.area_m2<=0)throw new Error('边界重绑定面积无效');
  if(patch&&Math.abs(resolved.area_m2-patch.width_m*patch.height_m)>patch.width_m*patch.height_m*.005)throw new Error('矩形接触面积变化');
  if(!patch){const original=baseline.groups.find(g=>g.id===baseline.face_groups[(condition.faces as number[])[0]])!;if(Math.abs(resolved.area_m2-original.area_m2)>original.area_m2*.005)throw new Error('冷却平面面积变化');const before=planeMetrics(baseline,condition.faces as number[],original.u_axis,original.v_axis),after=planeMetrics(surface,resolved.faces,original.u_axis,original.v_axis);if(before.some((value,i)=>Math.abs(value-after[i])>1e-7))throw new Error('冷却平面空间重心或轮廓位置变化');}
  condition.faces=resolved.faces;
 }
 return cfg;
}


/** Compact model context retains physical descriptors and measured history, never display meshes. */
export function proposalPrompt(t:Pick<import('../shared/optimization.js').OptimizationTask,'baseline'|'candidates'|'bestCandidateId'|'policy'>,attempt:number){
 const physics=structuredClone(t.baseline.config);
 for(const key of ['heat_sources','cooling'])for(const condition of (physics[key] as Record<string,unknown>[]||[])){
  const ids=condition.faces as number[]|undefined;
  if(!condition.surface_patch&&ids?.length){const g=t.baseline.surface.groups.find(g=>g.id===t.baseline.surface.face_groups[ids[0]]);if(g)condition.frozen_plane={center_m:g.center_m,normal:g.normal,area_m2:g.area_m2};}
  delete condition.faces;
 }
 const best=t.candidates.find(c=>c.id===t.bestCandidateId);
 return JSON.stringify({instruction:'分析真实测量与失败历史，自主改进几何，不采用预设候选序列。只返回JSON {code,rationale,changes}。code必须为完整自包含Gmsh Python源码，固定导出model.step。候选仅支持无别名import gmsh/math/json、普通数值表达式、循环和辅助函数；禁止Path/open/os/文件读写/反射/动态函数调用。基准代码中已有的Path、JSON文件导出应主动移除，候选只导出model.step（可model.stl），不写JSON文件；允许普通_占位变量和安全数值参数解包。仅允许安全Gmsh CAD数值API、固定字面gmsh.write(\'model.step\')（可model.stl），gmsh.initialize仅无参或interruptible=False。不自己构建、求解、读取文件或凭证。保留安装孔、外形上限和全部热接触位置；所有物理工况冻结。Gmsh必须单实体、无零厚度、无干涉碎片；考虑冻结网格对最小间隙和薄壁的分辨能力，说明网格风险及制造假设，不擅改网格或物理字段。不重复已有候选。',attempt,baseline:{code:t.baseline.code,geometry:t.baseline.geometry,maximumC:t.baseline.maximumC,massKg:t.baseline.massKg,units:t.baseline.units},physics,policy:t.policy,best:best?{id:best.id,code:best.code,maximumC:best.maximumC,massKg:best.massKg}:undefined,history:t.candidates.map(c=>({id:c.id,attempt:c.attempt,state:c.state,rationale:c.rationale,changes:c.changes,maximumC:c.maximumC,massKg:c.massKg,error:c.error,warnings:c.warnings,sourceHash:c.sourceHash,repairOf:c.repairOf}))});
}
