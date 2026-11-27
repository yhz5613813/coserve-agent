import { describe, expect, it, vi } from 'vitest'
import { CadController, parseParts, type CadPart, type CadProject } from '../src/client/cad-controller.ts'
import { offersPartChoice, partFolder, partSubgroup, recentParts, recommendPart, relativeTime } from '../src/client/part-choice.ts'
import type { StudioBridge } from '../src/client/types.ts'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CadPartProjection } from '../src/types.ts'

const row = (id: string, updatedAt: number, cadPart?: CadPartProjection, blank = false): SessionSummary => ({
  id: SessionId(id), displayTitle: id, running: false, retainedBy: {}, blank, updatedAt, ...(cadPart && { projectionValues: { cadPart } }),
})

const part = (slug: string, updatedAt?: number, flags: CadPart['flags'] = []): CadPart => ({ id: `root--${slug}`, slug, name: slug, ...(updatedAt !== undefined && { updatedAt }), flags })
const project: CadProject = { id: 'root', name: 'CAD', workspacePath: 'C:\\CAD\\root', workspaceUrl: 'http://127.0.0.1:4317/' }

function bridge(answer: (path: string, method?: string, body?: unknown) => unknown) {
  const request = vi.fn(async (path: string, method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown) => answer(path, method, body))
  const transport: StudioBridge = { request, subscribe: async () => {}, unsubscribe: async () => {}, onEvent: () => () => {}, workspaceUrl: async id => id }
  return { request, controller: new CadController(transport, async () => {}) }
}

describe('part recommendation', () => {
  const parts = [part('default', 100), part('housing', 300), part('lid', 200)]

  it('prefers the part the CAD workbench shows over the most recently updated one', () => {
    expect(recommendPart(parts, { recent: [], shown: 'lid' })).toBe('lid')
  })

  it('weighs the newest Session like the shown part, above an older recent Session, and breaks ties by update time', () => {
    expect(recommendPart(parts, { recent: ['default', 'lid'], shown: undefined })).toBe('default')
    expect(recommendPart(parts, { recent: ['lid'], shown: 'default' })).toBe('lid')
    expect(recommendPart(parts, { recent: ['lid'], shown: 'housing' })).toBe('housing')
    expect(recommendPart(parts, { recent: ['lid', 'default'], shown: 'lid' })).toBe('lid')
  })

  it('falls back to the latest update, then to service order, without signals', () => {
    expect(recommendPart(parts, { recent: [], shown: undefined })).toBe('housing')
    expect(recommendPart([part('a'), part('b')], { recent: [], shown: undefined })).toBe('a')
    expect(recommendPart([], { recent: [], shown: 'lid' })).toBeUndefined()
  })
})

describe('Session part signals', () => {
  const lid = { projectId: 'root', slug: 'lid', name: '盖' }
  const housing = { projectId: 'root', slug: 'housing', name: '壳体' }

  it('lists the parts of the project\'s non-blank Sessions, most recently updated first', () => {
    const rows = [row('old', 1, lid), row('new', 3, housing), row('blank', 9, lid, true), row('other', 5, { ...lid, projectId: 'other' }), row('plain', 4)]
    expect(recentParts(rows, 'root')).toEqual(['housing', 'lid'])
  })

  it('groups a Session under the part its summary names and leaves the rest ungrouped', () => {
    expect(partSubgroup(row('a', 1, lid))).toEqual({ key: 'root:lid', label: '盖' })
    expect(partSubgroup(row('b', 1, { ...lid, projectId: 'other' }))?.key).toBe('other:lid')
    expect(partSubgroup(row('c', 1))).toBeUndefined()
  })
})

describe('part choice gate', () => {
  it('asks when a part beyond the root exists, or the root already carries work', () => {
    expect(offersPartChoice([part('default'), part('lid')], false)).toBe(true)
    expect(offersPartChoice([part('default', undefined, ['published'])], false)).toBe(true)
    expect(offersPartChoice([part('default')], true)).toBe(true)
  })

  it('stays silent for a fresh project with neither parts nor history', () => {
    expect(offersPartChoice([part('default')], false)).toBe(false)
    expect(offersPartChoice([], true)).toBe(false)
  })

  it('maps the root part to the workspace root and other parts to their folders', () => {
    expect(partFolder('default')).toBe('./')
    expect(partFolder('lid')).toBe('parts/lid/')
  })

  it('formats the last activity in the largest whole unit', () => {
    const now = Date.UTC(2026, 10, 26, 12)
    expect(relativeTime(now - 3 * 86_400_000, now, 'en')).toBe('3 days ago')
    expect(relativeTime(now - 2 * 3_600_000, now, 'zh')).toBe('2小时前')
    expect(relativeTime(now + 5_000, now, 'en')).toBe('this minute')
  })
})

describe('part listing', () => {
  it('reads status flags by presence and the update time as epoch milliseconds', () => {
    expect(parseParts([
      { id: 'root', slug: 'default', name: '根', updatedAt: '2026-11-20T00:00:00Z', published: { at: 1 }, structural: null, thermal: false },
      { id: 'root--lid', slug: 'lid', name: '盖', updatedAt: 'not a date', structural: 'report.json', thermal: '' },
    ])).toEqual([
      { id: 'root', slug: 'default', name: '根', updatedAt: Date.UTC(2026, 10, 20), flags: ['published'] },
      { id: 'root--lid', slug: 'lid', name: '盖', flags: ['structural'] },
    ])
  })

  it('rejects a response that is not a list of parts', () => {
    expect(() => parseParts({ parts: [] })).toThrow('Invalid CAD part response')
    expect(() => parseParts([{ id: 'root', name: 'CAD' }])).toThrow('Invalid CAD part response')
  })

  it('lists parts through the project parts endpoint', async () => {
    const { request, controller } = bridge(() => [{ id: 'root', slug: 'default', name: 'CAD' }])
    expect(await controller.parts('root')).toEqual([{ id: 'root', slug: 'default', name: 'CAD', flags: [] }])
    expect(request).toHaveBeenLastCalledWith('/api/projects/root/parts')
  })

  it('reads the shown part from the first live workbench of the project or one of its parts', async () => {
    const { controller } = bridge(() => [
      { workspacePath: 'C:/CAD/other', state: { part: { slug: 'gear' } } },
      { workspacePath: 'C:/CAD/root/parts/lid/', state: { part: { slug: 'lid' } } },
      { workspacePath: 'C:\\CAD\\root', state: { part: { slug: 'default' } } },
    ])
    expect(await controller.shownPart(project)).toBe('lid')
    expect(await bridge(() => [{ workspacePath: 'C:/CAD/root', state: {} }]).controller.shownPart(project)).toBeUndefined()
  })

  it('finds the first model file a part can be opened with', async () => {
    const { controller } = bridge(() => [{ path: 'notes.md', kind: 'text' }, { path: 'lid.step', kind: 'model' }])
    expect(await controller.firstModel(part('lid'))).toBe('lid.step')
    expect(await bridge(() => [{ path: 'notes.md', kind: 'text' }]).controller.firstModel(part('lid'))).toBeUndefined()
  })
})
