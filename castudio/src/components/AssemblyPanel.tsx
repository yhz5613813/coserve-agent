import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Artifact, AssemblyComponent, AssemblyView, Part } from '../../shared/types';
import { api } from '../api';
import { Numeric } from './Numeric';
import { fileLabel } from './FilePanel';

const axes = ['X', 'Y', 'Z'] as const;
const componentFile = (f: Artifact) => f.category === 'cad' && /\.(step|stp|glb|stl)$/i.test(f.name);

/** Component list of the current part's assembly.json. Every edit is saved at once (PUT with the last etag); `revision` reloads the list after the file changed. */
export function AssemblyPanel({ projectId, parts, revision, close }: { projectId: string; parts: Part[]; revision: number; close: () => void }) {
  const [view, setView] = useState<AssemblyView | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const [addPart, setAddPart] = useState('default'), [candidates, setCandidates] = useState<Artifact[]>([]), [addPath, setAddPath] = useState('');
  useEffect(() => { let live = true; void api.assembly(projectId).then(v => { if (live) setView(v); }, e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [projectId, revision]);
  const target = parts.find(p => p.slug === addPart);
  useEffect(() => {
    if (!target) return;
    let live = true;
    void api.files(target.id).then(list => { if (!live) return; const models = list.filter(componentFile); setCandidates(models); setAddPath(models[0]?.path ?? ''); }, e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [target?.id]);
  const save = async (components: AssemblyComponent[]) => {
    if (!view) return;
    setWorking(true); setError('');
    try { setView(await api.saveAssembly(projectId, view.etag, { version: 1, components: components.map(({ id, part, path, name, position, rotation, visible }) => ({ id, part, path, name, position, rotation, visible })) })); }
    catch (e) { setError((e as Error).message); setView(await api.assembly(projectId).catch(() => view)); }
    finally { setWorking(false); }
  };
  const components = view?.components ?? [];
  const change = (id: string, patch: Partial<AssemblyComponent>) => void save(components.map(c => c.id === id ? { ...c, ...patch } : c));
  const add = () => {
    let n = components.length + 1; while (components.some(c => c.id === `c${n}`)) n++;
    const same = components.filter(c => c.part === addPart).length;
    void save([...components, { id: `c${n}`, part: addPart, path: addPath, name: same ? `${target!.name} ${same + 1}` : target!.name, position: [0, 0, 0], rotation: [0, 0, 0] }]);
  };
  return <div className="assembly-panel ui-stack">
    <div className="ui-actions"><strong>装配</strong><span className="ui-hint">{components.length} 个组件 · assembly.json</span><span className="ui-spacer"/><button className="icon-button" aria-label="关闭装配面板" title="关闭装配面板" onClick={close}><X size={14}/></button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {components.map(c => <details key={c.id} className="ui-disclosure">
      <summary>{c.name || c.path.split('/').pop()}{c.missing && <span className="ui-chip">缺失</span>}{c.visible === false && <span className="ui-chip">隐藏</span>}</summary>
      <div className="ui-stack">
        <p className="ui-hint" title={c.path}>零件 {parts.find(p => p.slug === c.part)?.name ?? c.part} · {c.path}</p>
        {c.missing && <p className="ui-hint warn">{c.missing}</p>}
        <div className="assembly-vector">{axes.map((axis, i) => <Numeric key={axis} required label={`${axis}（mm）`} disabled={working} value={c.position[i]} onCommit={v => { if (v !== undefined && v !== c.position[i]) change(c.id, { position: c.position.map((old, j) => j === i ? v : old) as AssemblyComponent['position'] }); }}/>)}</div>
        <div className="assembly-vector">{axes.map((axis, i) => <Numeric key={axis} required label={`绕 ${axis}（°）`} disabled={working} value={c.rotation[i]} onCommit={v => { if (v !== undefined && v !== c.rotation[i]) change(c.id, { rotation: c.rotation.map((old, j) => j === i ? v : old) as AssemblyComponent['rotation'] }); }}/>)}</div>
        <div className="ui-actions"><label className="ui-check"><input type="checkbox" checked={c.visible !== false} disabled={working} onChange={e => change(c.id, { visible: e.target.checked ? undefined : false })}/>显示</label><span className="ui-spacer"/><button className="text-button" disabled={working} onClick={() => void save(components.filter(item => item.id !== c.id))}>移除</button></div>
      </div>
    </details>)}
    <div className="ui-section">
      <label className="ui-field">添加组件 · 零件<select value={addPart} onChange={e => setAddPart(e.target.value)}>{parts.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></label>
      <label className="ui-field">CAD 文件<select value={addPath} disabled={!candidates.length} onChange={e => setAddPath(e.target.value)}>{candidates.length ? candidates.map(f => <option key={f.path} value={f.path} title={f.path}>{fileLabel(f)}</option>) : <option value="">该零件没有 STEP、GLB 或 STL</option>}</select></label>
      <div className="ui-actions"><button className="button" disabled={!view || !addPath || working} onClick={add}>添加</button></div>
    </div>
  </div>;
}
