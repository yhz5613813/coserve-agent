import { useEffect, useState, type RefObject } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { Popover } from './Popover';
import type { Artifact } from '../../shared/types';
import { api, type CadConverterStatus } from '../api';
import type { ViewportHandle } from './Viewport';
import { exportOptions, revisionPattern, type ExportId } from './export-state';
import './ExportMenu.css';

type Mode = 'download' | 'save';
type Props = { projectId: string; asset: Artifact | null; files: Artifact[]; url?: string; viewport: RefObject<ViewportHandle | null>; visibleMeshes: number };
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');
function download(href: string, name: string) {
  const link = document.createElement('a'); link.href = href; link.download = name; document.body.append(link); link.click(); link.remove();
}
function downloadBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob); download(href, name); setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Export popover for the model shown in the viewer: original file, client-side mesh exports, STEP, and CATIA via the converter. */
export function ExportMenu({ projectId, asset, files, url, viewport, visibleMeshes }: Props) {
  const [converter, setConverter] = useState<CadConverterStatus | null>(null), [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(''), [message, setMessage] = useState<{ text: string; error?: boolean; href?: string; name?: string } | null>(null);
  const { step, options } = exportOptions({ asset, files, converter, visibleMeshes }), revisionBad = revision !== '' && !revisionPattern.test(revision);
  const probe = () => { void api.cadConvertStatus().then(setConverter, error => setConverter({ installed: true, code: 'failed', message: (error as Error).message })); };
  useEffect(() => setMessage(null), [asset?.path]);

  async function run(id: ExportId, mode: Mode) {
    if (!asset) return;
    setBusy(`${id}:${mode}`); setMessage(null);
    try {
      if (id === 'original') { download(url ?? api.fileUrl(projectId, asset.path), asset.name); setMessage({ text: `已下载 ${asset.name}` }); }
      else if (id === 'CATPart' || id === 'CATProduct') {
        const result = await api.exportCatia(projectId, step!.path, id, revision || undefined), href = api.fileUrl(projectId, result.path);
        if (mode === 'download') download(href, result.name);
        setMessage({ text: `已保存到项目：${result.path}`, href, name: result.name });
      } else {
        const name = `${stemOf(id === 'step' ? step!.name : asset.name)}.${id}`;
        const blob = id === 'step' ? await fetch(api.fileUrl(projectId, step!.path)).then(r => { if (!r.ok) throw new Error('STEP 文件读取失败'); return r.blob(); }) : await viewport.current!.exportModel(id);
        if (mode === 'download') { downloadBlob(blob, name); setMessage({ text: `已下载 ${name}` }); }
        else { const saved = await api.saveExport(projectId, id, stemOf(name), blob); setMessage({ text: `已保存到项目：${saved.path}` }); }
      }
    } catch (e) { setMessage({ text: (e as Error).message, error: true }); }
    finally { setBusy(''); }
  }

  const row = (o: (typeof options)[number]) => {
    const catia = o.id === 'CATPart' || o.id === 'CATProduct', off = !o.enabled || !!busy || (catia && revisionBad);
    const act = (mode: Mode, text: string) => <button className="text-button" disabled={off} onClick={() => void run(o.id, mode)}>{busy === `${o.id}:${mode}` ? <LoaderCircle className="spin" size={12}/> : text}</button>;
    return <div className="export-row" key={o.id}>
      <span><strong>{o.label}</strong>{o.reason && <small>{o.reason}</small>}</span>
      {act('download', '下载')}{o.save && act('save', '保存到项目')}
    </div>;
  };
  const missing = !!converter && !converter.installed;
  return <Popover label={asset ? `导出 ${asset.name}` : '导出'} icon={<Download size={14}/>} text="导出" kind="dialog" width={300} className="button export-trigger" onOpen={probe}>
    <div className="export-body">
      {options.slice(0, 5).map(row)}
      <p className="export-note">网格导出使用 mm，仅包含当前可见的零件（GLB 为 Y 轴向上）。</p>
      <div className="export-catia">
        {!missing && <label>CATIA 版本<input value={revision} onChange={e => setRevision(e.target.value.trim())} placeholder="V5-6R2024（可选）" aria-label="CATIA 版本" aria-invalid={revisionBad}/></label>}
        {!missing && revisionBad && <small className="export-error">版本格式应为 V5-6R20xx</small>}
      </div>
      {options.slice(5).map(row)}
      {missing
        ? <details className="ui-disclosure export-howto"><summary>如何安装 CATIA 转换器</summary>
          <p>CATIA 格式需要单独安装的商业转换器（如 Datakit CrossCad/Ware）。</p>
          <p>在运行 CAStudio 服务的环境里，把环境变量 <code>CASTUDIO_CAD_CONVERTER</code> 设为转换器可执行文件的绝对路径，然后重启 CAStudio 服务。</p>
          <p>该可执行文件需支持 <code>probe</code>、<code>import</code>、<code>export</code> 三个子命令，约定见 <code>server/cad-convert.ts</code> 文件头。</p>
        </details>
        : <p className="export-note">CATIA 导出总会保存到项目的 exports/catia/ 目录。</p>}
      {message && <div className={`export-message ${message.error ? 'error' : ''}`} role="status"><span>{message.text}</span>{message.href && <a href={message.href} download={message.name}>下载</a>}</div>}
    </div>
  </Popover>;
}
