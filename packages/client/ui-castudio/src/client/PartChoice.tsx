import { useEffect, useId, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectForWorkspace, type CadPart, type CadPartFlag, type CadProject, type CadState } from './cad-controller.ts'
import { CAD_PART_SOURCE } from './cad-reference.ts'
import { offersPartChoice, relativeTime } from './part-choice.ts'
import type { StudioKey } from './locales.ts'
import css from './PartChoice.module.css'

/** The parts a new conversation may continue, with the one the card preselects. */
export interface PartOffer { parts: CadPart[]; recommended: string | undefined }

/** Per-Session face of the part choice card. Parts are created only in the CAD workbench, never here. */
export interface PartChoiceFace {
  hooks: { cad: HostObservable<CadState>; partDeclined: HostObservable<{ declined: readonly SessionId[] }> }
  /** List the project's parts and recommend one. */
  loadParts(project: CadProject): Promise<PartOffer>
  /** Attach the part chip to the draft and show the part in the CAD tab. */
  choosePart(projectId: string, part: CadPart): void
  /** Start this Session without a part. */
  decline(): void
}

const FLAG_LABELS: Record<CadPartFlag, StudioKey> = { published: 'partFlagPublished', structural: 'partFlagStructural', thermal: 'partFlagThermal' }

/** Ask a blank CAD Session whether it continues an existing part; the choice becomes a logged chip of its first message. */
export function PartChoice(props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'castudio'> & InjectFace<PartChoiceFace>) {
  const { session, input, t } = props
  const sessionId = session.sessionId
  const projects = props.useCad(state => state.projects)
  const locale = props.useCad(state => state.locale)
  const directory = props.useSessions(list => list.byId[sessionId]?.cwd)
  const project = projectForWorkspace(projects, directory)
  const hasHistory = props.useSessions(list => project !== undefined && Object.values(list.byId)
    .some(row => row.id !== sessionId && !row.blank && row.origin !== 'subagent' && projectForWorkspace([project], row.cwd) !== undefined))
  const declined = props.usePartDeclined(state => state.declined.includes(sessionId))
  const chosen = input.occurrences.some(item => item.source === CAD_PART_SOURCE)
  const asking = session.blank && project !== undefined && !declined && !chosen
  const [offer, setOffer] = useState<PartOffer | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const titleId = useId()

  useEffect(() => {
    if (!asking) return
    let current = true
    setOffer(undefined); setFailure(undefined); setSelected(undefined)
    props.loadParts(project).then(
      (next) => { if (current) setOffer(next) },
      (error: unknown) => { if (current) setFailure(`${t('partLoadFailed')} ${error instanceof Error ? error.message : String(error)}`) },
    )
    return () => { current = false }
  }, [asking, project?.id, props.loadParts])

  if (!asking || (offer === undefined && failure === undefined)) return null
  // Without a part worth continuing the conversation simply starts without one.
  if (offer !== undefined && !offersPartChoice(offer.parts, hasHistory)) return null
  const pick = selected ?? offer?.recommended
  const part = offer?.parts.find(item => item.slug === pick)
  // The recommended part leads the list; the others keep their service order.
  const parts = offer === undefined ? [] : offer.parts.toSorted((left, right) => Number(right.slug === offer.recommended) - Number(left.slug === offer.recommended))
  const now = Date.now()

  return <section className={css.root} aria-labelledby={titleId}>
    <div className={css.body}>
      <div className={css.head}>
        <div className={css.title} id={titleId}>{t('partChoiceTitle')}</div>
        <div className={css.hint}>{t('partChoiceHint')}</div>
      </div>
      {failure !== undefined && <div className={css.failure} role="alert">{failure}</div>}
      {parts.length > 0 && <div className={css.list} role="radiogroup" aria-labelledby={titleId}>
        {parts.map((item) => {
          const status = item.flags.length > 0 ? item.flags.map(flag => t(FLAG_LABELS[flag])).join(' · ') : t('partNoStatus')
          return <button key={item.slug} type="button" role="radio" aria-checked={item.slug === pick}
            className={css.option} onClick={() => setSelected(item.slug)}>
            <span className={css.name}>{item.name}</span>
            {item.slug === offer?.recommended && <Tag tone="info">{t('partRecommended')}</Tag>}
            <span className={css.meta}>
              {status}{item.updatedAt !== undefined && ` · ${relativeTime(item.updatedAt, now, locale)}`}
            </span>
          </button>
        })}
      </div>}
      <div className={css.actions}>
        <Button size="sm" onClick={props.decline}>{t('partNoInherit')}</Button>
        {part !== undefined && <Button variant="primary" size="sm" onClick={() => props.choosePart(project.id, part)}>{t('partContinue')}</Button>}
      </div>
    </div>
  </section>
}
