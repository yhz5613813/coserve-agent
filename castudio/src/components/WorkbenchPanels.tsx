import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, LayoutPanelTop, RotateCcw } from 'lucide-react';
import { Popover, PopoverItem } from './Popover';
import { layoutPresets, minPanelPx, movePanel, placeLayout, setSplit, shiftWeight, togglePanel, type PanelId, type PresetId, type Splitter, type WorkbenchLayout } from '../workbench-layout';
import '../workbench.css';

/** Each panel states what it is for (`purpose`), what it currently shows (`target`) and its state (`status`). */
export type PanelSpec = { id: PanelId; title: string; purpose: string; target?: ReactNode; status?: ReactNode; actions?: ReactNode; body: ReactNode; bodyClassName?: string };

export function WorkbenchPanels({ layout, onChange, panels }: { layout: WorkbenchLayout; onChange: (layout: WorkbenchLayout) => void; panels: PanelSpec[] }) {
  const root = useRef<HTMLDivElement>(null), elements = useRef<Partial<Record<PanelId, HTMLElement | null>>>({});
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const host = root.current!; const observer = new ResizeObserver(() => setWidth(host.clientWidth));
    observer.observe(host); setWidth(host.clientWidth); return () => observer.disconnect();
  }, []);
  const place = placeLayout(layout, width), title = (id: PanelId) => panels.find(p => p.id === id)!.title;
  const latest = useRef(layout); latest.current = layout;

  const dragRows = (splitter: Splitter, event: PointerEvent<HTMLDivElement>) => {
    const a = elements.current[splitter.a]!.getBoundingClientRect().height, b = elements.current[splitter.b]!.getBoundingClientRect().height;
    const start = event.clientY, base = latest.current, share = base.weight[splitter.a] / (base.weight[splitter.a] + base.weight[splitter.b]);
    track(event, e => { const next = Math.min(a + b - minPanelPx, Math.max(minPanelPx, a + e.clientY - start)); onChange(shiftWeight(base, splitter.a, splitter.b, next / (a + b) - share)); });
  };
  const dragColumns = (event: PointerEvent<HTMLDivElement>) => {
    const box = root.current!.getBoundingClientRect();
    track(event, e => onChange(setSplit(latest.current, (e.clientX - box.left) / box.width)));
  };
  const rowKeys = (splitter: Splitter, event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0;
    if (step) { event.preventDefault(); onChange(shiftWeight(layout, splitter.a, splitter.b, step)); }
  };
  const columnKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0;
    if (step) { event.preventDefault(); onChange(setSplit(layout, layout.split + step)); }
  };

  return <div className="workbench" ref={root} style={place.grid} data-side-by-side={place.sideBySide || undefined}>
    {panels.map(panel => {
      const collapsed = layout.collapsed.includes(panel.id), index = layout.order.indexOf(panel.id);
      return <section key={panel.id} ref={el => { elements.current[panel.id] = el; }} className={`wb-panel wb-${panel.id} ${collapsed ? 'collapsed' : ''}`} style={place.panels[panel.id]} aria-label={panel.title}>
        <header className="wb-head" title={panel.purpose}>
          <button className="wb-toggle" aria-expanded={!collapsed} aria-controls={`wb-body-${panel.id}`} onClick={() => onChange(togglePanel(layout, panel.id))}>{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<strong>{panel.title}</strong></button>
          {panel.target !== undefined && <span className="wb-target">{panel.target}</span>}
          {panel.status !== undefined && <span className="wb-status">{panel.status}</span>}
          <span className="wb-spacer"/>
          {!collapsed && panel.actions}
          <span className="wb-order">
            <button className="icon-button" aria-label={`上移${panel.title}面板`} title="上移面板" disabled={index === 0} onClick={() => onChange(movePanel(layout, panel.id, -1))}><ArrowUp size={13}/></button>
            <button className="icon-button" aria-label={`下移${panel.title}面板`} title="下移面板" disabled={index === layout.order.length - 1} onClick={() => onChange(movePanel(layout, panel.id, 1))}><ArrowDown size={13}/></button>
          </span>
        </header>
        <div id={`wb-body-${panel.id}`} className={`wb-body ${panel.bodyClassName ?? ''}`} hidden={collapsed}>{panel.body}</div>
      </section>;
    })}
    {[0, 1, 2].map(i => {
      const splitter = place.splitters[i];
      if (!splitter) return <div key={i} hidden/>;
      const share = Math.round(100 * layout.weight[splitter.a] / (layout.weight[splitter.a] + layout.weight[splitter.b]));
      return <div key={i} className="wb-splitter rows" style={splitter.style} role="separator" aria-orientation="horizontal" aria-label={`调整${title(splitter.a)}与${title(splitter.b)}的高度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-disabled={splitter.disabled || undefined} tabIndex={splitter.disabled ? -1 : 0} onPointerDown={e => { if (!splitter.disabled) dragRows(splitter, e); }} onKeyDown={e => { if (!splitter.disabled) rowKeys(splitter, e); }}/>;
    })}
    {place.vertical ? <div className="wb-splitter columns" style={place.vertical} role="separator" aria-orientation="vertical" aria-label="调整左右两栏宽度" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(layout.split * 100)} tabIndex={0} onPointerDown={dragColumns} onKeyDown={columnKeys}/> : <div hidden/>}
  </div>;
}

export function LayoutPresetMenu({ onApply }: { onApply: (layout: WorkbenchLayout) => void }) {
  return <Popover label="面板布局" icon={<LayoutPanelTop size={15}/>} width={168}>
    {(Object.keys(layoutPresets) as PresetId[]).filter(id => id !== 'default').map(id => <PopoverItem key={id} label={layoutPresets[id].label} onSelect={() => onApply(layoutPresets[id].layout)}/>)}
    <hr/>
    <PopoverItem icon={<RotateCcw size={13}/>} label="恢复默认布局" onSelect={() => onApply(layoutPresets.default.layout)}/>
  </Popover>;
}

function track(event: PointerEvent<HTMLDivElement>, move: (e: globalThis.PointerEvent) => void) {
  event.preventDefault();
  const target = event.currentTarget; target.focus(); target.setPointerCapture(event.pointerId); target.classList.add('dragging');
  const onMove = (e: globalThis.PointerEvent) => move(e);
  const onUp = () => { target.classList.remove('dragging'); target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); target.removeEventListener('pointercancel', onUp); };
  target.addEventListener('pointermove', onMove); target.addEventListener('pointerup', onUp); target.addEventListener('pointercancel', onUp);
}
