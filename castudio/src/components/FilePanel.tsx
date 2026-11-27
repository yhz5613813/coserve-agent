import { Fragment, useState } from 'react';
import { Box, Columns2, Download, FileCode2, FileText } from 'lucide-react';
import type { Artifact, ArtifactCategory } from '../../shared/types';
import { api, type CadConversion } from '../api';
import { convertedStep, isCatiaOriginal } from './export-state';
import './ExportMenu.css';

export { uploadNotice, uploadOpenPath } from './export-state';

const groups: { id: ArtifactCategory; label: string }[] = [
  { id: 'cad', label: 'CAD 模型' }, { id: 'source', label: '源码' }, { id: 'import', label: '导入' },
  { id: 'simulation', label: '仿真' }, { id: 'report', label: '报告与录像' }, { id: 'other', label: '其他' }, { id: 'system', label: '系统记录' },
];
/** Option text for a file select: the name first, then its folder, so equal names in different exports stay distinguishable. */
export const fileLabel = (file: Artifact) => file.detail ? `${file.name} · ${file.detail}` : file.name;
const sizeLabel = (bytes: number) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Project files grouped by the server's category; system bookkeeping (manifests, run records) stays hidden unless asked for. */
export function FilePanel({ projectId, files, activePath, openModel, openSource, setReference, onConverted }: { projectId: string; files: Artifact[]; activePath?: string; openModel: (file: Artifact) => void; openSource: (file: Artifact) => void; setReference: (file: Artifact) => void; onConverted?: (conversion: CadConversion) => void }) {
  const [filter, setFilter] = useState<ArtifactCategory | 'all'>('all'), [showSystem, setShowSystem] = useState(false);
  const [converting, setConverting] = useState(''), [convertError, setConvertError] = useState<{ path: string; message: string } | null>(null);
  async function retry(file: Artifact) {
    setConverting(file.path); setConvertError(null);
    try { onConverted?.(await api.importCatia(projectId, file.path)); }
    catch (e) { setConvertError({ path: file.path, message: (e as Error).message }); }
    finally { setConverting(''); }
  }
  const count = (id: ArtifactCategory) => files.filter(f => f.category === id).length;
  const visible = groups.filter(g => (filter === 'all' ? g.id !== 'system' || showSystem : g.id === filter) && count(g.id));
  return <div className="file-panel">
    <div className="file-filters" role="group" aria-label="按类别筛选">
      <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <span>{files.length - (showSystem ? 0 : count('system'))}</span></button>
      {groups.filter(g => g.id !== 'system' && count(g.id)).map(g => <button key={g.id} aria-pressed={filter === g.id} className={filter === g.id ? 'active' : ''} onClick={() => setFilter(g.id)}>{g.label} <span>{count(g.id)}</span></button>)}
      {count('system') > 0 && <label className="file-system-toggle"><input type="checkbox" checked={showSystem} onChange={e => { setShowSystem(e.target.checked); if (!e.target.checked && filter === 'system') setFilter('all'); }}/>系统记录 {count('system')}</label>}
    </div>
    <div className="file-list">{visible.map(group => <section key={group.id} className="file-group" aria-label={group.label}>
      {filter === 'all' && <h3>{group.label}<span>{count(group.id)}</span></h3>}
      {files.filter(f => f.category === group.id).map(file => { const catia = isCatiaOriginal(file), converted = catia ? convertedStep(file, files) : undefined; return <Fragment key={file.path}><div className={`artifact-row ${activePath === file.path ? 'active' : ''}`}>
        {file.kind === 'model' || file.kind === 'source'
          ? <button className="artifact-name" title={file.path} onClick={() => file.kind === 'model' ? openModel(file) : openSource(file)}>{file.kind === 'model' ? <Box size={15}/> : <FileCode2 size={15}/>}<span><strong>{file.name}</strong><small>{file.detail || '项目根目录'}</small></span></button>
          : <a className="artifact-name" title={file.path} href={api.fileUrl(projectId, file.path)} target="_blank" rel="noreferrer"><FileText size={15}/><span><strong>{file.name}</strong><small>{file.detail || '项目根目录'}</small></span></a>}
        {catia && <span className={`file-chip ${converted ? 'done' : ''}`}>{converted ? '已转换' : '需转换'}</span>}
        {catia && (converted
          ? <button className="text-button" onClick={() => openModel(converted)}>打开转换结果</button>
          : <button className="text-button" disabled={!!converting} onClick={() => void retry(file)}>{converting === file.path ? '转换中…' : '重试转换'}</button>)}
        <span className="file-size">{sizeLabel(file.size)}</span>
        {file.kind === 'model' && <button className="icon-button" aria-label={`将 ${file.name} 设为参考`} title="设为参考（与当前模型对比）" onClick={() => setReference(file)}><Columns2 size={14}/></button>}
        <a className="icon-button" aria-label={`下载 ${file.name}`} title={`下载 ${file.name}`} href={api.fileUrl(projectId, file.path)} download={file.name}><Download size={14}/></a>
      </div>{convertError?.path === file.path && <p className="file-convert-error" role="alert">{convertError.message}</p>}</Fragment>; })}
    </section>)}</div>
  </div>;
}
