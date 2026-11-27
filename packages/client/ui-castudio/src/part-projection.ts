/**
 * The `cadPart` projection unit: the part named by the latest human message that carries a valid `<cad-part>` marker.
 * The fold keeps one fixed-size value; a later marker replaces it and messages without one leave it unchanged.
 *
 * @module @deepseek-ai/dsh-client-ui-castudio/part-projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { findPartMarker, isPartSlug } from './part-marker.ts'
import type { CadPartProjection } from './types.ts'

const cadPartSchema: ZodType<CadPartProjection | null> = z.object({
  projectId: z.string(),
  slug: z.string().refine(isPartSlug),
  name: z.string(),
}).strict().nullable()

/**
 * Fold one committed event into the current part.
 * @param state - the part covering all prior events.
 * @param event - the next committed Session event.
 * @returns the next part; the same reference when the event names no other part.
 */
export function applyCadPart(state: CadPartProjection | null, event: SessionEvent): CadPartProjection | null {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return state
  let latest: CadPartProjection | null = null
  for (const block of event.data.content) {
    if (block.type !== 'text') continue
    for (let marker = findPartMarker(block.text, 0); marker !== undefined; marker = findPartMarker(block.text, marker.end)) {
      latest = { projectId: marker.reference.projectId, slug: marker.reference.part, name: marker.reference.name }
    }
  }
  if (latest === null || (state !== null && state.projectId === latest.projectId && state.slug === latest.slug && state.name === latest.name)) return state
  return latest
}

/** The `cadPart` unit the Host face registers on `ctx.sessionProjections`; its value is part of Session summaries. */
export const cadPartProjectionDefinition = {
  key: 'cadPart',
  stateVersion: 1,
  stateSchema: cadPartSchema,
  init: () => null,
  apply: applyCadPart,
  wire: { viewSchema: cadPartSchema, view: state => state },
} satisfies ProjectionDefinition<'cadPart', CadPartProjection | null>
