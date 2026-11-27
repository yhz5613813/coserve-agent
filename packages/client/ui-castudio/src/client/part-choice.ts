import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSubgroup } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '../types.ts'
import type { CadPart } from './cad-controller.ts'

/** Slug of the part that lives at the project root. */
export const DEFAULT_PART = 'default'

/** What the recommendation reads besides the parts themselves. */
export interface PartSignals {
  /** Part slugs recent Sessions of the same workspace worked on, newest Session first. */
  readonly recent: readonly string[]
  /** Part shown by the most recently active CAD workbench of the project, if any. */
  readonly shown: string | undefined
}

/**
 * Recommend the part a new conversation most likely continues. Each part scores 2 when the CAD
 * workbench shows it, 2 when the newest Session of the workspace worked on it (1 when only an older
 * recent Session did), and 1 when it has the latest `updatedAt`. The highest score wins; ties go to
 * the more recently updated part, then to the earlier listed one.
 * @param parts - the project's parts in service order.
 * @param signals - recent-Session and workbench signals.
 * @returns the recommended slug, or undefined for an empty list.
 */
export function recommendPart(parts: readonly CadPart[], signals: PartSignals): string | undefined {
  const latest = parts.reduce<CadPart | undefined>((best, part) => (part.updatedAt ?? -Infinity) > (best?.updatedAt ?? -Infinity) ? part : best, undefined)
  const score = (part: CadPart): number => (signals.shown === part.slug ? 2 : 0)
    + (signals.recent[0] === part.slug ? 2 : signals.recent.includes(part.slug) ? 1 : 0)
    + (latest !== undefined && latest === part ? 1 : 0)
  let best: CadPart | undefined
  for (const part of parts) {
    if (best === undefined) { best = part; continue }
    const difference = score(part) - score(best)
    if (difference > 0 || (difference === 0 && (part.updatedAt ?? -Infinity) > (best.updatedAt ?? -Infinity))) best = part
  }
  return best?.slug
}

/**
 * Part slugs the project's non-blank Sessions worked on, from their `cadPart` summary values.
 * @param rows - Session list rows.
 * @param projectId - root project whose parts count.
 * @returns one slug per Session that names a part of the project, most recently updated Session first.
 */
export function recentParts(rows: readonly SessionSummary[], projectId: string): string[] {
  return rows.flatMap((row) => {
    const part = row.projectionValues?.cadPart
    return !row.blank && part?.projectId === projectId ? [{ slug: part.slug, at: row.updatedAt }] : []
  }).sort((left, right) => right.at - left.at).map(item => item.slug)
}

/**
 * The Session-list subgroup of one Session: the part its latest `<cad-part>` marker names.
 * @param session - Session list row.
 * @returns the part subgroup, or undefined when the Session names no part.
 */
export function partSubgroup(session: SessionSummary): SessionSubgroup | undefined {
  const part = session.projectionValues?.cadPart
  return part ? { key: `${part.projectId}:${part.slug}`, label: part.name } : undefined
}

/**
 * Whether a new conversation should be asked which part it continues: the project has a part beyond
 * the root, or the root part already carries work (a published model or an earlier conversation).
 * @param parts - the project's parts.
 * @param workspaceHasHistory - whether another non-blank Session of the workspace exists.
 * @returns whether to show the part choice.
 */
export function offersPartChoice(parts: readonly CadPart[], workspaceHasHistory: boolean): boolean {
  if (parts.some(part => part.slug !== DEFAULT_PART)) return true
  const root = parts.find(part => part.slug === DEFAULT_PART)
  return root !== undefined && (workspaceHasHistory || root.flags.includes('published'))
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000_000], ['month', 2_592_000_000], ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]]

/**
 * Format how long ago a part changed, in the largest whole unit down to minutes.
 * @param at - epoch milliseconds of the change.
 * @param now - epoch milliseconds of the render.
 * @param locale - BCP 47 locale of the active DSH locale.
 * @returns the localized relative time, such as `3 days ago`.
 */
export function relativeTime(at: number, now: number, locale: string): string {
  const elapsed = Math.max(0, now - at)
  const [unit, size] = RELATIVE_UNITS.find(([, span]) => elapsed >= span) ?? ['minute', 60_000]
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(elapsed / size), unit)
}

/**
 * Workspace-relative folder of one part.
 * @param slug - part slug.
 * @returns `./` for the root part, otherwise `parts/<slug>/`.
 */
export function partFolder(slug: string): string {
  return slug === DEFAULT_PART ? './' : `parts/${slug}/`
}
