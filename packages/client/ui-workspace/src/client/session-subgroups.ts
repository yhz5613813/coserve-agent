/**
 * Plugin-contributed secondary grouping of one Workspace's Sessions in the
 * Workspace browser tree. A provider names the subgroup of a Session from the
 * Session's list summary; the browser partitions each Workspace group by that
 * key in the `workspace` and `workspace-tree` groupings.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'

/** One secondary group: `key` is stable within a Workspace and `label` is already localized. */
export interface SessionSubgroup {
  readonly key: string
  readonly label: string
}

/** A registered source of Session subgroups. */
export interface SessionSubgroupProvider {
  /** Registry-unique provider id. */
  readonly id: string
  /**
   * Name the subgroup of one Session; must be synchronous and pure over the summary.
   * @param session - list summary, including its summary projection values.
   * @returns the subgroup, or undefined to leave the Session ungrouped.
   */
  groupOf(session: SessionSummary): SessionSubgroup | undefined
}

/** Effect-owned subgroup providers in registration order; the first provider that answers decides. */
export class SessionSubgroupRegistry {
  private readonly providers = new Map<string, SessionSubgroupProvider>()
  private readonly listeners = new Set<() => void>()
  private cached: readonly SessionSubgroupProvider[] = []

  /** @param ctx - Context whose effects own contributed providers. */
  constructor(protected readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, { value: { property: 'ctx' } })
  }

  /**
   * Register one provider for the caller's fiber lifetime.
   * @param provider - provider with a registry-unique id.
   * @returns idempotent disposer; disposal also runs when the caller's fiber is disposed.
   * @throws when another provider already holds the id.
   */
  register(provider: SessionSubgroupProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`session subgroup provider "${provider.id}" is already registered`)
    const dispose = this.ctx.effect(() => {
      this.providers.set(provider.id, provider)
      this.refresh()
      return () => {
        if (this.providers.get(provider.id) !== provider) return
        this.providers.delete(provider.id)
        this.refresh()
      }
    }, `uiWorkspace.sessionSubgroups.register(${JSON.stringify(provider.id)})`)
    return () => { void dispose() }
  }

  /**
   * Read the current providers.
   * @returns reference-stable providers in registration order, replaced on every change.
   */
  getSnapshot(): readonly SessionSubgroupProvider[] {
    return this.cached
  }

  /**
   * Observe provider changes.
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private refresh(): void {
    this.cached = [...this.providers.values()]
    notifySubscribers(this.listeners, '[ui-workspace] session subgroup registry')
  }
}

/**
 * Resolve one Session's subgroup through the providers in order.
 * @param providers - registered providers.
 * @param session - Session list summary.
 * @returns the first provider's answer, or undefined when none groups the Session.
 */
export function sessionSubgroupOf(
  providers: readonly SessionSubgroupProvider[],
  session: SessionSummary,
): SessionSubgroup | undefined {
  for (const provider of providers) {
    const subgroup = provider.groupOf(session)
    if (subgroup !== undefined) return subgroup
  }
  return undefined
}
