import { useState } from 'react';
import { Boxes, Check, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Part } from '../../shared/types';
import { Popover, PopoverItem } from './Popover';

const runMark = { succeeded: '✓', failed: '✗', running: '…' } as const;
/** Compact status of a part for its option text, e.g. "已发布 · 结构✓ · 热…"; empty when nothing was published or run. */
export const partStatusText = (part: Part) => [part.published && '已发布', part.structural && `结构${runMark[part.structural]}`, part.thermal && `热${runMark[part.thermal]}`].filter(Boolean).join(' · ');

/** Project / Part picker: the project is fixed by the host, parts are folders under `parts/` of its workspace. `projectName` is omitted where the host already shows it. `onCreate` resolves to whether the part was created; the typed name is kept when it was not. `onRename` and `onDelete` act on the part shown in the select and resolve to an error message (kept inline) or null. `onAssembly` creates or opens the current part's assembly.json. */
export function PartSwitcher({ projectName, parts, current, onSwitch, onCreate, onRename, onDelete, onAssembly, hasAssembly }: { projectName?: string; parts: Part[]; current: string; onSwitch: (slug: string) => void; onCreate: (name: string) => Promise<boolean>; onRename: (slug: string, name: string) => Promise<string | null>; onDelete: (slug: string) => Promise<string | null>; onAssembly: () => void; hasAssembly: boolean }) {
  const [naming, setNaming] = useState(false), [name, setName] = useState(''), [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null), [draft, setDraft] = useState(''), [working, setWorking] = useState(false), [error, setError] = useState('');
  const part = parts.find(p => p.slug === current), isDefault = current === 'default';
  const cancel = () => { setName(''); setNaming(false); };
  const submit = async () => { if (!name.trim() || creating) return; setCreating(true); try { if (await onCreate(name.trim())) cancel(); } finally { setCreating(false); } };
  const open = (next: 'rename' | 'delete') => { setDraft(part?.name ?? ''); setError(''); setMode(next); };
  const close = () => { setMode(null); setError(''); };
  const run = async (work: () => Promise<string | null>) => { setWorking(true); try { const message = await work(); if (message) setError(message); else close(); } finally { setWorking(false); } };
  const rename = () => { if (!draft.trim() || working) return; void run(() => onRename(current, draft.trim())); };
  return <div className={`part-switcher${mode === 'delete' ? ' confirming' : ''}`} role="group" aria-label={projectName ? '项目与零件' : '零件'}>
    {projectName ? <><span className="part-project" title={projectName}>{projectName}</span><span className="part-divider">/</span></> : <span className="part-label">零件</span>}
    {naming
      ? <><input aria-label="新零件名称" autoFocus value={name} placeholder="新零件名称" disabled={creating} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') void submit(); if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}/>
        <button className="icon-button" aria-label="创建零件" title={name.trim() ? '创建零件（回车）' : '先填写零件名称'} disabled={!name.trim() || creating} onClick={() => void submit()}><Check size={13}/></button>
        <button className="icon-button" aria-label="取消新建零件" title="取消（Esc）" disabled={creating} onClick={cancel}><X size={13}/></button></>
      : mode === 'rename'
      ? <><input aria-label="零件名称" autoFocus onFocus={e => e.currentTarget.select()} value={draft} maxLength={60} disabled={working} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') rename(); if (e.key === 'Escape') { e.stopPropagation(); close(); } }}/>
        <button className="icon-button" aria-label="确认重命名" title={draft.trim() ? '确认重命名（回车）' : '先填写零件名称'} disabled={!draft.trim() || working} onClick={rename}><Check size={13}/></button>
        <button className="icon-button" aria-label="取消重命名" title="取消（Esc）" disabled={working} onClick={close}><X size={13}/></button>
        {error && <span className="part-error" role="alert">{error}</span>}</>
      : mode === 'delete'
      ? <><span className="part-confirm" role="alertdialog" aria-label="确认删除零件">删除零件 {part?.name}？文件夹 parts/{current}/ 将移除，并移到项目文件夹下的 .trash/，可从该处手动恢复。</span>
        <button className="button danger" disabled={working} onClick={() => void run(() => onDelete(current))}>删除零件</button>
        <button className="button" autoFocus disabled={working} onClick={close}>取消</button>
        {error && <span className="part-error" role="alert">{error}</span>}</>
      : <><select aria-label="当前零件" value={current} onChange={e => onSwitch(e.target.value)}>{parts.map(item => <option key={item.slug} value={item.slug}>{[item.name, item.slug !== 'default' && item.slug, partStatusText(item)].filter(Boolean).join(' · ')}</option>)}</select>
        <button className="icon-button" aria-label="新建零件" title="新建零件（文件放在 parts/ 下的独立文件夹）" onClick={() => setNaming(true)}><Plus size={13}/></button>
        <Popover label="零件操作" icon={<MoreHorizontal size={13}/>} width={176}>
          <PopoverItem icon={<Boxes size={14}/>} label={hasAssembly ? '编辑装配' : '新建装配'} hint={hasAssembly ? undefined : '在本零件中创建 assembly.json'} onSelect={onAssembly}/>
          <PopoverItem icon={<Pencil size={14}/>} label="重命名" hint={isDefault ? '默认零件不能重命名' : undefined} disabled={isDefault} onSelect={() => open('rename')}/>
          <PopoverItem icon={<Trash2 size={14}/>} label="删除零件" hint={isDefault ? '默认零件不能删除' : undefined} disabled={isDefault} onSelect={() => open('delete')}/>
        </Popover></>}
  </div>;
}
