import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolCastudio from '@deepseek-ai/dsh-tool-castudio'
import type { Config } from '@deepseek-ai/dsh-tool-castudio'

const SIGNAL = new AbortController().signal

const VIEWPORT_STATE = {
  workspace: 'model',
  model: { path: null, demo: true, status: 'ready' },
  meshes: [
    { id: 'mesh-a', name: '底座', visible: true, triangles: 120 },
    { id: 'mesh-b', name: '螺栓 01', visible: false, triangles: 36 },
    { id: 'mesh-c', name: '螺栓 01', visible: true, triangles: 36 },
  ],
  selection: { meshId: 'mesh-a', name: '底座', bounds: [0, 0, 0, 1, 1, 1], triangles: 120 },
  options: { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' },
  camera: { position: [1, 2, 3], target: [0, 0, 0], projection: 'perspective' },
}

const VIEWPORT = {
  id: 'project-a',
  name: 'Enclosure',
  workspacePath: 'D:\\studio\\projects\\project-a\\workspace',
  ageMs: 50,
  state: VIEWPORT_STATE,
}

interface RecordedRequest {
  method: string
  url: string
  body: unknown
}

/** A scriptable CAStudio stand-in on an ephemeral loopback port. */
class FakeCAStudio {
  server: Server
  url = ''
  viewportsBody: unknown = [VIEWPORT]
  viewportsStatus = 200
  stateBody: unknown = { connected: true, ageMs: 5, state: VIEWPORT_STATE }
  commandStatus = 200
  commandBody: unknown = { ok: true, state: VIEWPORT_STATE }
  requests: RecordedRequest[] = []

  private constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: raw.length === 0 ? undefined : JSON.parse(raw),
        })
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.method === 'GET' && req.url === '/api/dsh/viewports') {
          json(this.viewportsStatus, this.viewportsBody)
          return
        }
        // The tool names the CAD instance in the query string; routing only looks at the path.
        const pathname = (req.url ?? '').split('?')[0] ?? ''
        if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/viewport\/state$/.test(pathname)) {
          json(200, this.stateBody)
          return
        }
        if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/viewport\/command$/.test(pathname)) {
          json(this.commandStatus, this.commandBody)
          return
        }
        res.writeHead(404).end()
      })
    })
  }

  static async start(): Promise<FakeCAStudio> {
    const fake = new FakeCAStudio()
    await new Promise<void>(resolve => fake.server.listen(0, '127.0.0.1', resolve))
    fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
    return fake
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
  }
}

const fakes: FakeCAStudio[] = []
const contexts: Context[] = []

async function fakeCAStudio(): Promise<FakeCAStudio> {
  const fake = await FakeCAStudio.start()
  fakes.push(fake)
  return fake
}

async function mount(config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const fiber = await ctx.plugin(ToolCastudio, config)
  return { ctx, fiber }
}

async function run(
  ctx: Context,
  args: Record<string, unknown>,
  signal: AbortSignal = SIGNAL,
): Promise<{ isError: boolean; text: string }> {
  const result = await executeModelToolFixture(ctx, {
    callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
    name: 'cad_workbench',
    arguments: args,
    signal,
  })
  const text = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { isError: result.isError, text }
}

function lastCommand(fake: FakeCAStudio): unknown {
  const post = [...fake.requests].reverse().find(request => request.method === 'POST')
  return post?.body
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

describe('cad_workbench state and project selection', () => {
  it('reads the live viewport state for the only connected workbench', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    const result = await run(ctx, { action: 'state' })

    expect(result.isError).toBe(false)
    expect(result.text).toContain('CAD workbench "Enclosure" (id project-a), part "default" (default)')
    expect(result.text).toContain('tab: model preview')
    expect(result.text).toContain('Model: demonstration geometry — loaded')
    expect(result.text).toContain('Meshes: 3 total, 1 hidden')
    expect(result.text).toContain('Selection: "底座" (mesh-a)')
    expect(result.text).toContain('Options: ortho off, section 100%, explode 0, mode component')
    expect(result.text).toContain('Camera: position [1, 2, 3]')
    expect(fake.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'GET /api/dsh/viewports',
      'GET /api/projects/project-a/viewport/state?client=main',
    ])
  })

  it('fails clearly when no workbench is connected', async () => {
    const fake = await fakeCAStudio()
    fake.viewportsBody = []
    const { ctx } = await mount({ url: fake.url })

    const result = await run(ctx, { action: 'state' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('no CAD workbench is open')
    expect(result.text).toContain('CAD workbench tab')
  })

  it('requires project when several workbenches are connected and honors an explicit id', async () => {
    const fake = await fakeCAStudio()
    fake.viewportsBody = [
      VIEWPORT,
      { ...VIEWPORT, id: 'project-b', name: 'Bracket' },
    ]
    const { ctx } = await mount({ url: fake.url })

    const ambiguous = await run(ctx, { action: 'state' })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('2 CAD workbenches are open')
    expect(ambiguous.text).toContain('"Enclosure" (id project-a)')
    expect(ambiguous.text).toContain('"Bracket" (id project-b)')

    const chosen = await run(ctx, { action: 'state', project: 'project-b' })
    expect(chosen.isError).toBe(false)
    expect(chosen.text).toContain('CAD workbench "Bracket" (id project-b)')

    const unknown = await run(ctx, { action: 'state', project: 'missing' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('no connected CAD workbench has id "missing"')
  })
})

describe('cad_workbench command mapping', () => {
  it('maps fit, options, workspace, and snapshot onto the service command shapes', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    const fit = await run(ctx, { action: 'fit', view: 'top' })
    expect(fit.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'fit', view: 'top' })

    const options = await run(ctx, { action: 'options', options: { ortho: true, section: 40 } })
    expect(options.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'options', options: { ortho: true, section: 40 } })

    const workspace = await run(ctx, { action: 'workspace', workspace: 'parametric' })
    expect(workspace.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'workspace', workspace: 'parametric' })

    fake.commandBody = {
      ok: true,
      state: VIEWPORT_STATE,
      snapshot: {
        path: 'artifacts/viewport/viewport-20260101-000000-000.png',
        absolutePath: 'D:\\studio\\projects\\project-a\\workspace\\artifacts\\viewport\\viewport-20260101-000000-000.png',
        width: 800,
        height: 600,
        bytes: 1234,
      },
    }
    const snapshot = await run(ctx, { action: 'snapshot' })
    expect(snapshot.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'snapshot' })
    expect(snapshot.text).toContain('viewport-20260101-000000-000.png')
    expect(snapshot.text).toContain('800×600')
    expect(snapshot.text).toContain('read_image')
  })

  it('sends partSlug as the command part on every action and echoes the part the viewer shows', async () => {
    const fake = await fakeCAStudio()
    const housing = { ...VIEWPORT_STATE, part: { slug: 'housing', name: 'Housing' } }
    fake.viewportsBody = [{ ...VIEWPORT, state: housing }]
    fake.stateBody = { connected: true, ageMs: 5, state: housing }
    fake.commandBody = { ok: true, state: housing }
    const { ctx } = await mount({ url: fake.url })

    const state = await run(ctx, { action: 'state', partSlug: 'housing' })
    expect(state.text).toContain('CAD workbench "Enclosure" (id project-a), part "Housing" (housing)')

    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ action: 'snapshot' }, { action: 'snapshot' }],
      [{ action: 'fit', view: 'top' }, { action: 'fit', view: 'top' }],
      [{ action: 'select', part: 'mesh-a' }, { action: 'select', meshId: 'mesh-a' }],
      [{ action: 'select_face', part: 'mesh-a', face: 1 }, { action: 'select_face', meshId: 'mesh-a', face: 1 }],
      [{ action: 'visible', part: 'mesh-a', visible: true }, { action: 'visible', meshId: 'mesh-a', visible: true }],
      [{ action: 'options', options: { grid: false } }, { action: 'options', options: { grid: false } }],
      [{ action: 'workspace', workspace: 'thermal' }, { action: 'workspace', workspace: 'thermal' }],
      [{ action: 'panel', panel: 'files', state: 'collapse' }, { action: 'panel', panel: 'files', state: 'collapse' }],
      [{ action: 'open', path: 'bracket.step' }, { action: 'open', path: 'bracket.step' }],
    ]
    for (const [args, command] of cases) {
      fake.commandBody = { ok: true, state: housing, ...(args.action === 'snapshot' ? { snapshot: { path: 'a.png', absolutePath: '/w/a.png', width: 1, height: 1, bytes: 1 } } : {}) }
      const result = await run(ctx, { ...args, partSlug: 'housing' })
      expect(result.isError, JSON.stringify(args)).toBe(false)
      expect(lastCommand(fake)).toEqual({ ...command, part: 'housing' })
      expect(result.text).toContain('part "Housing" (housing)')
    }
  })

  it('switches part with open and reports the part the viewer shows afterwards', async () => {
    const fake = await fakeCAStudio()
    fake.commandBody = { ok: true, state: { ...VIEWPORT_STATE, part: { slug: 'lid', name: 'Lid' } } }
    const { ctx } = await mount({ url: fake.url })

    const opened = await run(ctx, { action: 'open', path: 'lid.step', partSlug: 'lid' })

    expect(opened.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'open', path: 'lid.step', part: 'lid' })
    expect(opened.text).toContain('part "Lid" (lid)')
    expect(opened.text).toContain('open file applied')
  })

  it('names the part from the listed state when a command answers without state', async () => {
    const fake = await fakeCAStudio()
    fake.viewportsBody = [{ ...VIEWPORT, state: { ...VIEWPORT_STATE, part: { slug: 'housing', name: 'Housing' } } }]
    fake.commandBody = { ok: true, state: null }
    const { ctx } = await mount({ url: fake.url })

    const result = await run(ctx, { action: 'panel', panel: 'viewer', state: 'expand' })

    expect(result.text).toContain('part "Housing" (housing)')
    expect(result.text).toContain('did not report a new state')
  })

  it('resolves part ids and exact names before dispatching mesh commands', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    const byId = await run(ctx, { action: 'select', part: 'mesh-b' })
    expect(byId.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'select', meshId: 'mesh-b' })

    const byName = await run(ctx, { action: 'select', part: '底座' })
    expect(byName.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'select', meshId: 'mesh-a' })

    const face = await run(ctx, { action: 'select_face', part: '底座', face: 3 })
    expect(face.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'select_face', meshId: 'mesh-a', face: 3 })

    const visible = await run(ctx, { action: 'visible', part: 'mesh-c', visible: false })
    expect(visible.isError).toBe(false)
    expect(lastCommand(fake)).toEqual({ action: 'visible', meshId: 'mesh-c', visible: false })
  })

  it('rejects ambiguous and unknown part names with candidates', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    const ambiguous = await run(ctx, { action: 'select', part: '螺栓 01' })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('matches 2 parts')
    expect(ambiguous.text).toContain('mesh-b')
    expect(ambiguous.text).toContain('mesh-c')

    const unknown = await run(ctx, { action: 'select', part: '不存在的零件' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('no part has id or exact name')
    expect(unknown.text).toContain('底座')
    expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })
})

describe('cad_workbench argument and failure handling', () => {
  it('rejects fields that do not belong to the action and missing required fields', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    const cases: [Record<string, unknown>, string][] = [
      [{ action: 'fit', part: 'mesh-a' }, '"part" does not apply to action "fit"'],
      [{ action: 'snapshot', view: 'top' }, '"view" does not apply to action "snapshot"'],
      [{ action: 'state', bogus: 1 }, '"bogus" does not apply to action "state"'],
      [{ action: 'select' }, 'action "select" requires "part"'],
      [{ action: 'select_face', part: 'mesh-a' }, 'action "select_face" requires "face"'],
      [{ action: 'select_face', part: 'mesh-a', face: -1 }, '"face" must be a non-negative integer'],
      [{ action: 'visible', part: 'mesh-a' }, 'action "visible" requires "visible"'],
      [{ action: 'options', options: {} }, '"options" must set at least one display option'],
      [{ action: 'workspace' }, 'action "workspace" requires "workspace"'],
      [{ action: 'open' }, 'action "open" requires "path"'],
      [{ action: 'panel', panel: 'files' }, 'action "panel" requires "state"'],
      [{ action: 'open', path: 'a.step', part: 'mesh-a' }, '"part" does not apply to action "open"'],
    ]
    for (const [args, message] of cases) {
      const result = await run(ctx, args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.text).toContain(message)
    }
    expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('maps service error statuses onto model-facing failures', async () => {
    const fake = await fakeCAStudio()
    const { ctx } = await mount({ url: fake.url })

    for (const status of [409, 422, 504]) {
      fake.commandStatus = status
      fake.commandBody = { error: '服务端拒绝原因' }
      const result = await run(ctx, { action: 'fit' })
      expect(result.isError, `status ${status}`).toBe(true)
      expect(result.text).toContain(`HTTP ${status}`)
      expect(result.text).toContain('服务端拒绝原因')
    }
    fake.commandStatus = 200

    fake.viewportsStatus = 503
    const listing = await run(ctx, { action: 'state' })
    expect(listing.isError).toBe(true)
    expect(listing.text).toContain('HTTP 503')
  })

  it('explains a part mismatch when a command naming a part is refused with 409', async () => {
    const fake = await fakeCAStudio()
    fake.commandStatus = 409
    fake.commandBody = { error: '视口当前显示零件 default，不是 housing；请先用 open 切换零件' }
    const { ctx } = await mount({ url: fake.url })

    const mismatch = await run(ctx, { action: 'fit', partSlug: 'housing' })
    expect(mismatch.isError).toBe(true)
    expect(mismatch.text).toContain('HTTP 409')
    expect(mismatch.text).toContain('视口当前显示零件 default')
    expect(mismatch.text).toContain('call action "open" with partSlug "housing"')

    // A refused `open` is not a mismatch, and a command without partSlug names no part to explain.
    const open = await run(ctx, { action: 'open', path: 'a.step', partSlug: 'housing' })
    expect(open.text).toContain('HTTP 409')
    expect(open.text).not.toContain('partSlug "housing" to switch')
    const unnamed = await run(ctx, { action: 'fit' })
    expect(unnamed.text).not.toContain('partSlug')
  })

  it('reports an unreachable service and honors caller cancellation', async () => {
    const fake = await fakeCAStudio()
    const url = fake.url
    await fake.close()
    fakes.splice(fakes.indexOf(fake), 1)
    const { ctx } = await mount({ url })

    const down = await run(ctx, { action: 'state' })
    expect(down.isError).toBe(true)
    expect(down.text).toContain('cannot reach the CAStudio service')

    const abort = new AbortController()
    abort.abort()
    const cancelled = await run(ctx, { action: 'state' }, abort.signal)
    expect(cancelled.isError).toBe(true)
  })
})

describe('cad_workbench registration lifecycle', () => {
  it('unregisters the tool when the plugin fiber is disposed', async () => {
    const fake = await fakeCAStudio()
    const { ctx, fiber } = await mount({ url: fake.url })

    expect(ctx.tools.get('cad_workbench')).toBeDefined()
    const before = await run(ctx, { action: 'state' })
    expect(before.isError).toBe(false)

    await fiber.dispose()
    expect(ctx.tools.get('cad_workbench')).toBeUndefined()
    const after = await executeModelToolFixture(ctx, {
      callId: ToolCallId('call-after-dispose'),
      name: 'cad_workbench',
      arguments: { action: 'state' },
      signal: SIGNAL,
    })
    expect(after.isError).toBe(true)
  })

  it('rejects invalid timeout configuration at plugin load', async () => {
    const fake = await fakeCAStudio()
    await expect(mount({ url: fake.url, stateTimeoutMs: 0 })).rejects.toThrow(/stateTimeoutMs/)
    await expect(mount({ url: fake.url, commandTimeoutMs: -5 })).rejects.toThrow(/commandTimeoutMs/)
  })
})
