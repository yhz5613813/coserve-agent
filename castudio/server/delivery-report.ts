import type {OptimizationTask} from '../shared/optimization.js';
import type {DeliverySelection} from '../shared/delivery.js';
import type {ThermalRun} from '../shared/thermal.js';

/** Validated run metadata and its portable directory inside the delivery. */
export type DeliveryRun={label:string;directory:string;run:ThermalRun};
const escape=(value:unknown)=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const num=(n:number|undefined,digits=3)=>n===undefined?'—':n.toFixed(digits);
const phases:Record<string,string>={completed:'完成并通过成对加密复核',no_improvement:'完成，未获得显著改善',unverified:'待验证',failed:'任务失败',interrupted:'任务中断',cancelled:'用户停止'};
const states:Record<string,string>={valid:'有效',invalid:'未通过',interrupted:'已中断',proposed:'提案',building:'构建',inspecting:'检查',solving:'求解'};
const cell=(value:unknown)=>String(value??'—').replace(/[|\r\n]/g,' ');
const compact=(_key:string,value:unknown)=>Array.isArray(value)&&value.length>60?{count:value.length,note:'完整内容见冻结工况与原始结果文件'}:value;

/** Produce offline reports from measured task facts; no model-generated result claims or remote assets.
 * @param task - Stable task revision used by the export.
 * @param selected - Recommended design after verification policy is applied.
 * @param runs - Copied solver runs, including failed-run metadata when present.
 * @returns Self-contained HTML, readable Markdown and numeric comparison CSV.
 */
export function deliveryReport(task:OptimizationTask,selected:DeliverySelection,runs:DeliveryRun[]){
  const best=task.candidates.find(c=>c.id===task.bestCandidateId),chosen=task.candidates.find(c=>c.id===selected.candidateId);
  const title='设计与热仿真闭环报告',status=phases[task.phase]||task.phase;
  const recommendation=selected.kind==='verified_candidate'?`候选 ${chosen!.attempt}（相同加密网格已复核）`:'保留基准设计';
  const limits='本报告适用于冻结工况下的固体导热与给定换热边界；不包含空气流场、压降或风机性能求解。相同加密网格复核不是完整网格收敛性证明。未确认制造工艺、最小壁厚、加工公差和装配热阻，不能据此宣称可量产或热可靠性合格。CAD 交付为 Gmsh Python 参数源码和 STEP 实体，不包含专有 CAD 特征树或生产用二维公差图纸。';
  const rows=[['基准','冻结',num(task.baseline.maximumC),'0.000',num(task.baseline.massKg,5),'0.00'],...task.candidates.map(c=>[String(c.attempt),states[c.state]||c.state,num(c.maximumC),num(c.maximumC===undefined?undefined:task.baseline.maximumC-c.maximumC),num(c.massKg,5),num(c.massKg===undefined?undefined:(c.massKg/task.baseline.massKg-1)*100,2)])];
  const headings=['尝试','状态','末时刻最高温度 °C','相对基准降温 °C','质量 kg','质量变化 %'];
  const table=(headers:string[],values:string[][])=>`<div class="table-wrap"><table><thead><tr>${headers.map(v=>`<th>${escape(v)}</th>`).join('')}</tr></thead><tbody>${values.map(row=>`<tr>${row.map(v=>`<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const fine=task.verification;
  const fineText=fine?`同网格 ${num(fine.meshSizeM*1000,2)} mm：基准 ${num(fine.baselineMaximumC)} °C，候选 ${num(fine.candidateMaximumC)} °C，降温 ${num(fine.improvementC)} °C。显著改善阈值 ${task.policy.significantImprovementC} °C。`:'尚无完整成对加密复核结论；候选结果仅供复查，推荐交付保留基准。';
  const physics=JSON.stringify(task.baseline.config,compact,2);
  const body=`<header><p class="eyebrow">CoServe AI · 工程计算记录</p><h1>${title}</h1><p>${escape(status)} · 任务 ${escape(task.id)}</p></header>
<section><h2>交付结论</h2><p class="recommendation">推荐设计：${escape(recommendation)}</p><p>${escape(task.stopReason||'任务按策略结束')}${task.error?' · '+escape(task.error):''}</p><p>${escape(fineText)}</p><p>闭环执行状态与降温收益分别判断。全部候选、失败原因和原始求解结果均保留；未验证候选不会覆盖最终推荐设计。</p><p><a href="../final/design.py">可编辑建模源码</a> · <a href="../final/model.step">最终 STEP</a> · <a href="../final/design.json">设计与计算关联</a> · <a href="../manifest.json">完整文件与摘要清单</a></p></section>
<section><h2>冻结条件与约束</h2><p>安装包络、孔位孔径与贯通深度、热源接触位置、材料、完整热工况冻结；候选仅修改几何。质量上限为基准 ${(task.policy.massRatio*100).toFixed(1)}%，最多 ${task.policy.maxAttempts} 次候选尝试，每个候选最多 ${task.policy.maxRepairsPerCandidate} 次修复，总预算 ${task.policy.timeBudgetMs/60000} 分钟。</p><p><a href="../baseline/thermal-config.json">完整冻结工况 JSON</a> · <a href="../baseline/geometry.json">独立几何检查</a></p><details><summary>工况摘要（SI 单位）</summary><pre>${escape(physics)}</pre></details></section>
<section><h2>候选对比</h2><p>本表比较原网格下完整实体温度数据的末时刻最高值；加密复核值单独列示，不混合网格排名。</p>${table(headings,rows)}</section>
<section><h2>设计反馈与修改记录</h2>${task.candidates.map(c=>`<article><h3>尝试 ${c.attempt} · ${escape(states[c.state]||c.state)}${c.id===best?.id?' · 原网格最佳候选':''}</h3><p>${escape(c.rationale||'未取得有效提案')}</p><ul>${c.changes.map(change=>`<li>${escape(change)}</li>`).join('')}</ul>${c.error?`<p class="warning">${escape(c.error)}</p>`:''}${(c.warnings||[]).map(w=>`<p class="warning">${escape(w)}</p>`).join('')}<p>候选编号 ${escape(c.id)}；构建 ${escape(c.buildId)}；求解 ${escape(c.runId)}</p></article>`).join('')}</section>
<section><h2>同网格复核</h2><p>${escape(fineText)}</p><p>仅状态“完成并通过成对加密复核”的最佳候选进入 final/。取消、中断、复核失败或改善不稳定时，final/ 保留基准，候选仍可在 candidates/ 中检查。</p></section>
<section><h2>仿真报告与原始场数据</h2>${runs.map(({label,directory,run})=>{const backend=(run.result as (typeof run.result)&{backend?:unknown})?.backend;return `<article><h3>${escape(label)}</h3><p>状态 ${escape(run.state)} · 求解编号 ${escape(run.id)} · STEP SHA-256 ${escape(run.sourceHash)}</p>${run.state==='succeeded'?`<p><a href="../${directory}/job/report.pdf">求解报告 PDF</a> · <a href="../${directory}/job/report.md">求解报告文本</a> · <a href="../${directory}/job/history.csv">温度历程 CSV</a> · <a href="../${directory}/job/temperatures.npy">实体温度数据</a> · <a href="../${directory}/run.json">运行记录</a></p>${run.files.some(f=>f.path==='job/report-assets/temperature.png')?`<img alt="${escape(label)} 实际求解温度云图" src="../${directory}/job/report-assets/temperature.png">`:''}`:`<p class="warning">${escape(run.error||'无完整结果，不作为有效解')}</p>`}<details><summary>实际计算后端与警告</summary><pre>${escape(JSON.stringify({backend:backend??'未提供后端记录',warnings:run.result?.result.summary.warnings||[]},null,2))}</pre></details></article>`;}).join('')}</section>
<section><h2>适用范围与后续工作</h2><p class="warning">${escape(limits)}</p><p>要继续编辑，在独立文件夹运行 final/design.py 重新导出 STEP（输出文件名以源码为准），再重新解析热边界并求解。原始冻结配置不能直接套用到改变拓扑的模型面编号。不要覆盖已有交付文件。</p></section>
<footer>任务版本 ${task.revision} · 原项目 ${escape(task.sourceProjectId)} · 优化项目 ${escape(task.projectId)}<br>本报告可离线打开，使用浏览器打印可保存为 PDF。包内每份原始求解 PDF 随结果一并交付。</footer>`;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f3f6fa;color:#152638;font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1000px;margin:32px auto;background:white;padding:40px 48px}h1{font-size:30px;font-weight:500;line-height:1.3}h2{font-size:21px;font-weight:500;margin:28px 0 12px;border-bottom:1px solid #d5e0ea;padding-bottom:8px}h3{font-size:17px;font-weight:500}.eyebrow{color:#396d93}.recommendation{background:#eaf4f3;padding:16px;font-size:20px}.warning{color:#74440e;background:#fff7e9;padding:12px}article{margin:22px 0;overflow-wrap:anywhere}a{color:#156a9c}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:9px;border-bottom:1px solid #d5e0ea;text-align:left}th{font-weight:500;background:#edf3f8}.table-wrap{overflow-x:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;background:#f5f7f9;padding:12px}img{display:block;max-width:100%;max-height:500px;object-fit:contain}footer{border-top:1px solid #d5e0ea;margin-top:32px;padding-top:16px;font-size:12px;color:#52657a;overflow-wrap:anywhere}header p{overflow-wrap:anywhere}@media(max-width:700px){main{margin:0;padding:22px 16px}h1{font-size:25px}}@media print{body{background:white;font-size:11px}main{margin:0;padding:0;max-width:none}a{color:inherit}thead{display:table-header-group}tr,img{break-inside:avoid}h2,h3{break-after:avoid}.table-wrap{overflow:visible}details{display:none}@page{size:A4;margin:16mm}}</style></head><body><main>${body}</main></body></html>`;
  const markdown=[`# ${title}`,`状态：${status}；推荐设计：${recommendation}。`,task.stopReason||'',task.error||'',fineText,'','## 原网格对比',`| ${headings.join(' | ')} |`,'| --- | --- | ---: | ---: | ---: | ---: |',...rows.map(r=>`| ${r.map(cell).join(' | ')} |`),'','## 设计反馈',...task.candidates.flatMap(c=>[`### 尝试 ${c.attempt} · ${states[c.state]}`,c.rationale,...c.changes.map(x=>'- '+x),c.error||'',...(c.warnings||[])]),'','## 计算文件',...runs.map(r=>`- ${r.label}：${r.directory}/job/report.pdf；运行 ${r.run.id}；状态 ${r.run.state}；STEP SHA-256 ${r.run.sourceHash}`),'','## 范围与限制',limits,'',`任务 ${task.id}；版本 ${task.revision}。完整工况见 baseline/thermal-config.json，完整字段和可点击链接见 overview.html。`].join('\n');
  const csv=[headings,...rows].map(row=>row.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
  return {html,markdown,csv};
}
