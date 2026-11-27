import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Number field that keeps what the user types until blur or Enter, so clearing it never writes 0 mid-edit.
 * `factor` converts the stored value to the displayed unit. A cleared field commits `undefined`, or restores its value when `required`.
 */
export function Numeric({ label, value, disabled, onCommit, factor = 1, min, max, step = 'any', required, className = 'ui-field', inputClassName, style }: { label: string; value: unknown; disabled?: boolean; onCommit: (value: number | undefined) => void; factor?: number; min?: number; max?: number; step?: number | 'any'; required?: boolean; className?: string; inputClassName?: string; style?: CSSProperties }) {
  const format = () => typeof value === 'number' && Number.isFinite(value) ? String(Number((value * factor).toPrecision(10))) : '';
  const [text, setText] = useState(format), focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(format()); }, [value, factor]);
  return <label className={className}>{label}<input aria-label={label} className={inputClassName} style={style} type="number" step={step} min={min} max={max} disabled={disabled} value={text}
    onFocus={() => { focused.current = true; }} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    onBlur={() => { if (!focused.current) return; focused.current = false; const n = Number(text); if (!text.trim()) { if (required) setText(format()); else onCommit(undefined); } else if (Number.isFinite(n)) onCommit(n / factor); else setText(format()); }}/></label>;
}
