import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionSubgroupRegistry, sessionSubgroupOf, type SessionSubgroupProvider } from '../src/client/session-subgroups.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { sessionSubgroupTestRegistry: SessionSubgroupRegistry }
}

const session = (id: string): SessionSummary => ({
  id: id as SessionId, title: id, displayTitle: id, running: false, blank: false, updatedAt: 0, retainedBy: {},
})

const provider = (id: string, answer: string | undefined): SessionSubgroupProvider => ({
  id, groupOf: () => answer === undefined ? undefined : { key: answer, label: answer },
})

function setup(): { ctx: Context; registry: SessionSubgroupRegistry } {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, registry: new SessionSubgroupRegistry(ctx) }
}

describe('SessionSubgroupRegistry', () => {
  it('lets the first answering provider decide and rejects a duplicate id', () => {
    const { registry } = setup()
    registry.register(provider('silent', undefined))
    registry.register(provider('first', 'a'))
    registry.register(provider('second', 'b'))
    expect(sessionSubgroupOf(registry.getSnapshot(), session('s'))).toEqual({ key: 'a', label: 'a' })
    expect(() => registry.register(provider('first', 'c'))).toThrow('already registered')
  })

  it('publishes registration and disposer removal to subscribers', () => {
    const { registry } = setup()
    const listener = vi.fn()
    registry.subscribe(listener)
    const dispose = registry.register(provider('part', 'a'))
    const registered = registry.getSnapshot()
    expect(registered.map(entry => entry.id)).toEqual(['part'])
    dispose()
    dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(registry.getSnapshot()).not.toBe(registered)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('removes only the contributing fiber provider when that fiber is disposed', async () => {
    const { ctx, registry } = setup()
    ctx.provide('sessionSubgroupTestRegistry', registry)
    registry.register(provider('root', undefined))
    const feature = ctx.inject(['sessionSubgroupTestRegistry'], (featureCtx) => {
      featureCtx.sessionSubgroupTestRegistry.register(provider('feature', 'a'))
    })
    await feature.await()
    expect(registry.getSnapshot().map(entry => entry.id)).toEqual(['root', 'feature'])
    await feature.dispose()
    expect(registry.getSnapshot().map(entry => entry.id)).toEqual(['root'])
    await ctx.fiber.dispose()
    expect(registry.getSnapshot()).toEqual([])
  })
})
