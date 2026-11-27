import type { ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';

/** `current` shows its body; `done` and `open` collapse to a one-line summary and can be reopened; `locked` shows why it is not available yet. */
export type StepState = 'current' | 'done' | 'open' | 'locked';

/** A page's primary path as an ordered list; only the current step is expanded. */
export function Steps({ label, children }: { label: string; children: ReactNode }) {
  return <ol className="ui-steps" aria-label={label}>{children}</ol>;
}

export function Step({ n, title, state, summary, onOpen, children }: { n: number; title: string; state: StepState; summary?: ReactNode; onOpen: () => void; children?: ReactNode }) {
  const current = state === 'current';
  return <li className={`ui-step ${state}`} aria-current={current ? 'step' : undefined}>
    <button type="button" className="ui-step-head" disabled={state === 'locked'} aria-expanded={current} onClick={onOpen}>
      <span className="ui-step-num" aria-hidden="true">{state === 'done' ? <Check size={12}/> : n}</span>
      <strong>{title}</strong>
      {!current && summary !== undefined && <span className="ui-step-summary">{summary}</span>}
      {state === 'done' && <span className="ui-step-edit">修改</span>}
      {state === 'open' && <ChevronRight className="ui-step-edit" size={14}/>}
    </button>
    {current && <div className="ui-step-body">{children}</div>}
  </li>;
}

/** Compact step bar for pages whose working area must stay mounted (the parametric editor); every step that is not locked can be opened. */
export function StepIndicator({ label, steps, onOpen }: { label: string; steps: { title: string; state: StepState; reason?: string }[]; onOpen: (index: number) => void }) {
  return <ol className="ui-indicator" aria-label={label}>{steps.map((step, i) => <li key={step.title} className={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
    <button type="button" disabled={step.state === 'locked'} title={step.state === 'locked' ? step.reason : undefined} onClick={() => onOpen(i)}><span className="ui-step-num" aria-hidden="true">{step.state === 'done' ? <Check size={12}/> : i + 1}</span>{step.title}</button>
  </li>)}</ol>;
}

/** The one empty-state pattern: icon, one sentence, at most one action. */
export function Empty({ icon, text, action }: { icon: ReactNode; text: ReactNode; action?: ReactNode }) {
  return <div className="ui-empty">{icon}<p>{text}</p>{action}</div>;
}
