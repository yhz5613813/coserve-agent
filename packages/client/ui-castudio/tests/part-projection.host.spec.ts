import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { applyCadPart, cadPartProjectionDefinition } from '../src/part-projection.ts'

const marker = (part: string, name: string, projectId = 'root') => `<cad-part>${JSON.stringify({ projectId, part, name, folder: part === 'default' ? './' : `parts/${part}/` })}</cad-part>`

async function harness(register = true): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (register) await ctx.sessionProjections.register(cadPartProjectionDefinition)
  return { ctx, session: ctx.sessions.create(SessionId('cad')) }
}

function say(session: Session, ...texts: string[]) {
  return session.append('user/message', createUserMessage({ content: texts.map(text => ({ type: 'text' as const, text })), source: { kind: 'user' } }), { surfaceOp: 'append' })
}

const partOf = (ctx: Context, session: Session) => ctx.sessionProjections.snapshot(session).values.cadPart

describe('cadPart projection', () => {
  it('names no part before a marker and the marked part afterwards', async () => {
    const { ctx, session } = await harness()
    expect(partOf(ctx, session)).toBeNull()
    say(session, `${marker('lid', '盖')} 加一个安装孔`)
    expect(partOf(ctx, session)).toEqual({ projectId: 'root', slug: 'lid', name: '盖' })
  })

  it('keeps the part across messages without a marker and lets the latest marker win', async () => {
    const { ctx, session } = await harness()
    say(session, marker('lid', '盖'))
    say(session, '继续')
    expect(partOf(ctx, session)).toMatchObject({ slug: 'lid' })
    say(session, `${marker('default', 'CAD')} 先看根零件`, `再看 ${marker('housing', '壳体')}`)
    expect(partOf(ctx, session)).toEqual({ projectId: 'root', slug: 'housing', name: '壳体' })
  })

  it('ignores invalid markers and returns the same state for unrelated or repeated parts', async () => {
    const { session } = await harness(false)
    const state = { projectId: 'root', slug: 'lid', name: '盖' }
    const invalid = say(session, '<cad-part>{"projectId":"root","part":"../x","name":"x","folder":"./"}</cad-part>')
    expect(applyCadPart(state, invalid)).toBe(state)
    expect(applyCadPart(state, say(session, marker('lid', '盖')))).toBe(state)
    const steered = session.append('turn/start', { turn: 1 })
    expect(applyCadPart(state, steered)).toBe(state)
  })

  it('belongs to Session summaries so list rows can show and group by part', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.summaryKeys().has('cadPart')).toBe(true)
  })

  it('drops the key when the registering fiber is disposed (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    const fiber = await ctx.plugin({ name: 'cad-part-test', inject: ['sessionProjections'], async apply(ctx: Context) { await ctx.sessionProjections.register(cadPartProjectionDefinition) } })
    expect('cadPart' in ctx.sessionProjections.snapshot(session).values).toBe(true)
    await fiber.dispose()
    expect('cadPart' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('matches full replay when restored from a checkpoint plus its suffix, and rejects an invalid checkpoint', async () => {
    const { ctx, session } = await harness()
    say(session, marker('lid', '盖'))
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const suffix = say(session, marker('housing', '壳体'))
    const restored = ctx.sessionProjections.restore(
      checkpoint, [suffix], SessionLogOffset(suffix.seq), session.header, session.inheritedEventCount,
    )
    expect(restored.snapshot.values.cadPart).toEqual(partOf(ctx, session))
    const row = checkpoint.cadPart!
    expect(() => ctx.sessionProjections.restore({ ...checkpoint, cadPart: { ...row, val: { projectId: 'root', slug: 'Bad Slug', name: 'x' } } },
      [], SessionLogOffset(suffix.seq + 1), session.header, session.inheritedEventCount)).toThrow()
  })
})
