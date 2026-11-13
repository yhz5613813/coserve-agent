import { describe, expect, it, vi } from 'vitest'
import { OptimizationDriver, parseProposal, type DriverRuntime } from '../src/optimization-driver.ts'

function fixture() {
  let phase = 'awaiting_proposal'
  let finish!: (value: { code: string; rationale: string; changes: string[]; childId: string }) => void
  const result = new Promise<{ code: string; rationale: string; changes: string[]; childId: string }>((resolve) => { finish = resolve })
  const task = { id: 'task', projectId: 'project', workspacePath: 'D:/optimization', revision: 1, phase }
  const request = vi.fn(async (path: string, body?: object): Promise<unknown> => {
    if (path.endsWith('/driver')) return { available: true }
    if (path.endsWith('/pending')) return phase === 'awaiting_proposal' ? [{ ...task, phase }] : []
    if (path.endsWith('/claim')) { phase = 'claimed'; return { task: { ...task, phase }, proposal: { token: 'token', attempt: 1, prompt: 'design using frozen inputs' } } }
    if (path.endsWith('/proposal')) { phase = 'building'; return { ...task, phase, received: body } }
    return { ...task, phase }
  })
  let signal: AbortSignal | undefined
  const runtime: DriverRuntime = {
    openSession: vi.fn(async () => 'session'),
    propose: vi.fn(async (_task, _session, _prompt, cancellation) => { signal = cancellation; return result }),
  }
  const driver = new OptimizationDriver(request, runtime, { workerId: 'worker', proposalTimeoutMs: 300000 })
  return { driver, request, runtime, finish, get signal() { return signal }, cancel: () => { phase = 'cancelled' } }
}

describe('host-owned optimization dispatch', () => {
  it('claims once and submits the structured result without an open UI', async () => {
    const f = fixture()
    await f.driver.tick()
    await f.driver.tick()
    expect(f.runtime.propose).toHaveBeenCalledTimes(1)
    f.finish({ code: 'import gmsh', rationale: 'reduce spreading resistance', changes: ['base'], childId: 'child' })
    await f.driver.drain()
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/proposal'))).toEqual([
      ['/api/projects/project/optimizations/task/proposal', { token: 'token', attempt: 1, code: 'import gmsh', rationale: 'reduce spreading resistance', changes: ['base'], sessionId: 'session', childId: 'child' }],
    ])
    await f.driver.dispose()
  })

  it('cancels the actual child and refuses its late result', async () => {
    const f = fixture()
    await f.driver.tick()
    f.cancel()
    await f.driver.tick()
    expect(f.signal?.aborted).toBe(true)
    f.finish({ code: 'late', rationale: '', changes: [], childId: 'child' })
    await f.driver.drain()
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/proposal'))).toBe(false)
    await f.driver.dispose()
  })

  it('retries a lost submission with the same token without generating again', async () => {
    const f = fixture()
    const request = f.request.getMockImplementation()!
    let lost = true
    f.request.mockImplementation(async (path, body) => {
      if (path.endsWith('/proposal') && lost) { lost = false; throw new Error('connection lost') }
      return request(path, body)
    })
    await f.driver.tick()
    f.finish({ code: 'candidate', rationale: 'r', changes: ['fins'], childId: 'child' })
    await f.driver.drain()
    await f.driver.tick()
    expect(f.runtime.propose).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/proposal'))).toHaveLength(2)
    await f.driver.dispose()
  })

  it('rejects malformed model output instead of starting a build', () => {
    expect(() => parseProposal({ code: 'x', rationale: 'r', changes: [3] })).toThrow()
    expect(() => parseProposal({ rationale: 'r', changes: [] })).toThrow()
    expect(parseProposal({ code: 'x', rationale: 'r', changes: [] })).toEqual({ code: 'x', rationale: 'r', changes: [] })
  })

  it.each([false, true])('recovers a lost claim response without duplicate design, cancelled=%s', async (cancelled) => {
    const f = fixture()
    const request = f.request.getMockImplementation()!
    let lost = true
    f.request.mockImplementation(async (path, body) => {
      const response = await request(path, body)
      if (path.endsWith('/claim') && lost) { lost = false; throw new Error('claim response lost') }
      return response
    })
    try {
      await expect(f.driver.tick()).rejects.toThrow('claim response lost')
      expect(f.runtime.propose).not.toHaveBeenCalled()
      if (cancelled) f.cancel()
      await f.driver.tick()
      expect(f.runtime.openSession).toHaveBeenCalledTimes(1)
      expect(f.runtime.propose).toHaveBeenCalledTimes(cancelled ? 0 : 1)
      const claims = f.request.mock.calls.filter(([path]) => path.endsWith('/claim'))
      if (!cancelled) {
        expect(claims).toHaveLength(2)
        expect(claims[1]).toEqual(claims[0])
        f.finish({ code: 'candidate', rationale: 'r', changes: [], childId: 'child' })
        await f.driver.drain()
        expect(f.request.mock.calls.filter(([path]) => path.endsWith('/proposal'))).toHaveLength(1)
      }
      expect(f.request.mock.calls.some(([path]) => path.endsWith('/dispatch-error'))).toBe(false)
    } finally { await f.driver.dispose() }
  })

  it('does not claim when shutdown arrives during session creation', async () => {
    const f = fixture()
    const opening = Promise.withResolvers<string>()
    vi.mocked(f.runtime.openSession).mockReturnValue(opening.promise)
    const tick = f.driver.tick()
    await vi.waitFor(() => expect(f.runtime.openSession).toHaveBeenCalledOnce())
    const stopped = f.driver.dispose()
    opening.resolve('session')
    await Promise.all([tick, stopped])
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/claim'))).toBe(false)
    expect(f.runtime.propose).not.toHaveBeenCalled()
  })

  it('reports session permission failures to the durable task authority', async () => {
    const f = fixture()
    vi.mocked(f.runtime.openSession).mockRejectedValue(new Error('Workspace permission denied'))
    await expect(f.driver.tick()).rejects.toThrow('Workspace permission denied')
    expect(f.request).toHaveBeenCalledWith('/api/projects/project/optimizations/task/dispatch-error', { revision: 1, workerId: 'worker', error: 'Workspace permission denied' })
    expect(f.runtime.propose).not.toHaveBeenCalled()
    await f.driver.dispose()
  })

  it('limits overlapping polls to one claim', async () => {
    const f = fixture()
    await Promise.all([f.driver.tick(), f.driver.tick(), f.driver.tick()])
    expect(f.runtime.propose).toHaveBeenCalledTimes(1)
    f.finish({ code: 'candidate', rationale: 'r', changes: [], childId: 'child' })
    await f.driver.drain()
    await f.driver.dispose()
  })
})
