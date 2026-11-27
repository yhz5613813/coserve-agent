import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';

const CloseContext = createContext<() => void>(() => {});

/**
 * The workbench's one popover. The panel is fixed-positioned below its trigger (above when there is no room), clamped to both viewport edges,
 * and closes on an outside press, Escape, focus leaving it, or the window losing focus; Escape and item selection return focus to the trigger.
 * `kind="menu"` holds `PopoverItem` rows (arrow keys move between them); `kind="dialog"` holds free content such as inputs.
 */
export function Popover({ label, icon, text, kind = 'menu', width = 188, className = 'icon-button', onOpen, children }: { label: string; icon: ReactNode; text?: string; kind?: 'menu' | 'dialog'; width?: number; className?: string; onOpen?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false), [place, setPlace] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) { setPlace(null); return; }
    const position = () => {
      const r = trigger.current!.getBoundingClientRect(), w = Math.min(width, window.innerWidth - 16), below = window.innerHeight - r.bottom - 12, above = r.top - 12;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      setPlace(below >= 200 || below >= above ? { top: r.bottom + 4, left, width: w, maxHeight: below } : { bottom: window.innerHeight - r.top + 4, left, width: w, maxHeight: above });
    };
    position();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', outside); window.addEventListener('blur', blur); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, width]);
  // Focus moves into the panel once it is placed, so keyboard users land on the first item.
  const placed = !!place;
  useEffect(() => { if (placed) (panel.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') ?? panel.current)?.focus(); }, [placed]);
  const keys = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); return; }
    if (kind !== 'menu' || !open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []), at = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return <span className="ui-popover-anchor" ref={root} onKeyDown={keys} onBlur={event => { if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" className={`${className}${open ? ' selected' : ''}`} title={label} aria-label={label} aria-haspopup={kind} aria-expanded={open} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>{icon}{text && <span>{text}</span>}</button>
    {open && <div ref={panel} tabIndex={-1} className={`ui-popover ${kind}`} role={kind} aria-label={label} style={place ?? { visibility: 'hidden' }}>
      <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
    </div>}
  </span>;
}

/** A menu row. `checked` makes it a toggle; `hint` explains a disabled row in place. */
export function PopoverItem({ icon, label, hint, checked, disabled, onSelect }: { icon?: ReactNode; label: string; hint?: string; checked?: boolean; disabled?: boolean; onSelect: () => void }) {
  const close = useContext(CloseContext);
  return <button type="button" className="ui-menu-item" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled} onClick={() => { close(); onSelect(); }}>
    {icon}<span>{label}{hint && <small>{hint}</small>}</span>{checked && <Check className="ui-menu-check" size={13}/>}
  </button>;
}
