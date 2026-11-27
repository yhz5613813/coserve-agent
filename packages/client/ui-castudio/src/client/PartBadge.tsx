import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '../types.ts'
import css from './PartBadge.module.css'

/** Name the part a listed Session works on, from its `cadPart` summary value; nothing for a Session without one. */
export function PartBadge({ sessionId, useSessions }: Pick<PropsRuntime<'sidebar.session.row.trailing'>, 'sessionId' | 'useSessions'>) {
  const name = useSessions(list => list.byId[sessionId]?.projectionValues?.cadPart?.name)
  return name === undefined ? null : <span className={css.badge} title={name}>{name}</span>
}
