import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as castudioContext from '@deepseek-ai/dsh-castudio-context'
import type { Config } from '@deepseek-ai/dsh-castudio-context'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const SIGNAL = new AbortController().signal

const PROJECTS = [
  {
    id: 'project-b',
    name: 'Bracket',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    workspacePath: 'D:\\studio\\projects\\project-b\\workspace',
  },
  {
    id: 'project-a',
    name: 'Enclosure',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    workspacePath: 'D:\\studio\\projects\\project-a\\workspace',
  },
]

/** One connected workbench row as `GET /api/dsh/viewports` serves it. */
const VIEWPORT_STATE = {
  workspace: 'model',
  model: { path: null, demo: true, status: 'ready' },
  meshes: [
    { id: 'mesh-a', name: '底座', visible: true, triangles: 120 },
    { id: 'mesh-b', name: '螺栓 01', visible: false, triangles: 36 },
  ],
  selection: { meshId: 'mesh-a', name: '底座', bounds: [0, 0, 0, 10, 10, 10], triangles: 120 },
  options: { edges: true, grid: true, ortho: true, section: 40, explode: 30, mode: 'face' },
  camera: { position: [11, -22, 33], target: [0, 0, 0], projection: 'perspective' },
}

const VIEWPORTS = [{
  id: 'project-a',
  name: 'Enclosure',
  workspacePath: 'D:\\studio\\projects\\project-a\\workspace',
  ageMs: 120,
  state: VIEWPORT_STATE,
}]

/** A scriptable CAStudio stand-in on an ephemeral loopback port. */
class FakeCastudio {
  server: Server
  url = ''
  projectsRequests = 0
  viewportsRequests = 0
  runtimeRequests = 0
  status = 200
  viewportsStatus = 200
  runtimeStatus = 200
  body: unknown = PROJECTS
  viewportsBody: unknown = []
  runtimeBody: unknown = { configured: true }

  private constructor() {
    this.server = createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(404).end()
        return
      }
      if (req.url === '/api/dsh/projects') {
        this.projectsRequests += 1
        res.writeHead(this.status, { 'content-type': 'application/json' })
        res.end(typeof this.body === 'string' ? this.body : JSON.stringify(this.body))
        return
      }
      if (req.url === '/api/dsh/viewports') {
        this.viewportsRequests += 1
        res.writeHead(this.viewportsStatus, { 'content-type': 'application/json' })
        res.end(typeof this.viewportsBody === 'string' ? this.viewportsBody : JSON.stringify(this.viewportsBody))
        return
      }
      if (req.url === '/api/parametric/runtime') {
        this.runtimeRequests += 1
        res.writeHead(this.runtimeStatus, { 'content-type': 'application/json' })
        res.end(typeof this.runtimeBody === 'string' ? this.runtimeBody : JSON.stringify(this.runtimeBody))
        return
      }
      res.writeHead(404).end()
    })
  }

  static async start(): Promise<FakeCastudio> {
    const fake = new FakeCastudio()
    await new Promise<void>(resolve => fake.server.listen(0, '127.0.0.1', resolve))
    fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
    return fake
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
  }
}

const fakes: FakeCastudio[] = []

async function fakeCastudio(): Promise<FakeCastudio> {
  const fake = await FakeCastudio.start()
  fakes.push(fake)
  return fake
}

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(castudioContext, config)
  return { ctx }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('castudio-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'castudio-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

describe('castudio-context injection', () => {
  it('injects the CAStudio project list on the first step of a turn', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(fake.projectsRequests).toBe(1)
    expect(fake.runtimeRequests).toBe(1)
    expect(contextTexts(session)).toEqual([
      'CAStudio CAD service (turn 1):\n'
      + 'A local CAStudio CAD service is running at ' + fake.url + '. '
      + 'It manages these CAD projects:\n'
      + '- "Enclosure" — id project-a, workspace D:\\studio\\projects\\project-a\\workspace; '
      + 'CAD skill guide: D:\\studio\\projects\\project-a\\workspace\\.agents\\skills\\castudio\\SKILL.md\n'
      + '- "Bracket" — id project-b, workspace D:\\studio\\projects\\project-b\\workspace; '
      + 'CAD skill guide: D:\\studio\\projects\\project-b\\workspace\\.agents\\skills\\castudio\\SKILL.md\n'
      + `Each project exposes a HTTP API at ${fake.url}/api/projects/<id> for parametric editing, builds, `
      + 'measurements, and structural and thermal simulation; project files live in the workspace path. '
      + 'A prepared project workspace carries AGENTS.md and .agents/skills (castudio, cadflow, '
      + 'structural-sim, thermal-sim) documenting its API — read the castudio skill guide listed per project '
      + 'before CAD work. '
      + "Use ordinary shell and file tools against the API; do not call the service's /prompt endpoint."
      + ' The parametric CAD environment is configured, so geometry, colour and parameter edits '
      + 'through the parametric code API are available.',
    ])
    const event = session.snapshotEvents().at(-1)
    if (event?.type !== 'user/message') throw new Error('missing castudio context')
    expect(event.data.source).toMatchObject({
      kind: 'castudio-context',
      form: 'snapshot',
      sections: [{ name: 'castudio-context' }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('does not run on later steps of a turn', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('later-step'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(fake.projectsRequests + fake.viewportsRequests + fake.runtimeRequests).toBe(0)
    expect(contextTexts(session)).toHaveLength(0)
  })

  it('re-injects a new turn only when the project set changed', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('change'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Same projects reordered by the service: suppressed.
    fake.body = [...PROJECTS].reverse()
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(contextTexts(session)).toHaveLength(1)

    // A renamed project on turn 3: re-injected.
    fake.body = PROJECTS.map(project => project.id === 'project-a'
      ? { ...project, name: 'Enclosure v2' }
      : project)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('CAStudio CAD service (turn 3):')
    expect(texts[1]).toContain('"Enclosure v2"')
  })

  it('honors a positive refresh interval between injections', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url, refreshIntervalMs: 10_000 })
    const session = Session.create(SessionId('interval'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Changed state but inside the interval: suppressed, and never queried.
    fake.body = [...PROJECTS, {
      id: 'project-c',
      name: 'Flange',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      workspacePath: 'D:\\studio\\projects\\project-c\\workspace',
    }]
    vi.setSystemTime(5_000)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(contextTexts(session)).toHaveLength(1)
    expect(fake.projectsRequests).toBe(1)

    // Past the interval: queried and re-injected.
    vi.setSystemTime(12_000)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)
    expect(contextTexts(session)).toHaveLength(2)
    expect(fake.projectsRequests).toBe(2)
  })

  it('bounds the project list and summarizes the remainder', async () => {
    const fake = await fakeCastudio()
    fake.body = Array.from({ length: 25 }, (_, index) => ({
      id: `p-${String(index).padStart(2, '0')}`,
      name: `Part ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspacePath: `D:\\studio\\p-${index}\\workspace`,
    }))
    const { ctx } = await mount({ url: fake.url, maxProjects: 5 })
    const session = Session.create(SessionId('bounded'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('"Part 0"')
    expect(text).toContain('"Part 4"')
    expect(text).not.toContain('"Part 5"')
    expect(text).toContain('…and 20 more projects')
  })

  it('joins the skill guide path with the separator of a POSIX workspace path', async () => {
    const fake = await fakeCastudio()
    fake.body = [{ ...PROJECTS[0], workspacePath: '/Users/me/.coserve/castudio/projects/project-b/workspace/' }]
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('posix'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)[0]).toContain('CAD skill guide: /Users/me/.coserve/castudio/projects/project-b/workspace/.agents/skills/castudio/SKILL.md\n')
  })

  it('reports a reachable service with no projects', async () => {
    const fake = await fakeCastudio()
    fake.body = []
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('empty'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('It manages no CAD projects yet.')
    expect(text).not.toContain('It manages these CAD projects:')
  })

  it('appends a stable workbench summary for each connected viewport', async () => {
    const fake = await fakeCastudio()
    fake.viewportsBody = [
      // Served newest-first by the service; the reading sorts by project id.
      { ...VIEWPORTS[0]!, id: 'project-b', name: 'Bracket', state: { ...VIEWPORT_STATE, workspace: 'parametric' } },
      VIEWPORTS[0]!,
    ]
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('workbenches'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(fake.viewportsRequests).toBe(1)
    expect(text).toContain('The user currently has these CAD workbenches open:')
    const enclosure = text!.indexOf('"Enclosure" — id project-a')
    const bracket = text!.indexOf('"Bracket" — id project-b')
    expect(enclosure).toBeGreaterThan(-1)
    expect(bracket).toBeGreaterThan(enclosure)
    expect(text).toContain('tab: model preview')
    expect(text).toContain('tab: parametric modeling')
    expect(text).toContain('Model: demonstration geometry — loaded')
    expect(text).toContain('Meshes: 2 total, 1 hidden')
    expect(text).not.toContain('Parts:')
    // A page that reports no part is the legacy default part at the workspace root.
    expect(text).toContain('Project / Part: "Enclosure" / "default" (default) — part files are in the workspace root; model paths are relative to it')
    expect(text).toContain('Selection: "底座" (mesh-a)')
    expect(text).toContain('View: orthographic projection; section at 40%; explode 30; face selection mode')
    expect(text).toContain('You can inspect and operate this workbench with the cad_workbench tool.')
    // Volatile wire fields never reach the model-facing summary.
    expect(text).not.toContain('position')
    expect(text).not.toContain('11,-22,33')
    expect(text).not.toContain('ageMs')
    expect(text).not.toContain('mesh-b')
  })

  it('re-injects only when the stable workbench summary changes', async () => {
    const fake = await fakeCastudio()
    fake.viewportsBody = VIEWPORTS
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('workbench-dedupe'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // New report age and camera pose are volatile: the summary is unchanged.
    fake.viewportsBody = [{
      ...VIEWPORTS[0]!,
      ageMs: 9_999,
      state: { ...VIEWPORT_STATE, camera: { position: [1, 2, 3], target: [4, 5, 6], projection: 'orthographic' } },
    }]
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(contextTexts(session)).toHaveLength(1)

    // A selection change is stable state: re-injected on the next turn.
    fake.viewportsBody = [{
      ...VIEWPORTS[0]!,
      state: { ...VIEWPORT_STATE, selection: { meshId: 'mesh-b', name: '螺栓 01', bounds: [0, 0, 0, 1, 1, 1], triangles: 36 } },
    }]
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('CAStudio CAD service (turn 3):')
    expect(texts[1]).toContain('Selection: "螺栓 01" (mesh-b)')
  })

  it('names the part the viewer shows and re-injects when the part changes', async () => {
    const fake = await fakeCastudio()
    fake.viewportsBody = [{ ...VIEWPORTS[0]!, state: { ...VIEWPORT_STATE, part: { slug: 'housing', name: 'Housing' } } }]
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('part-switch'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fake.viewportsBody = [{ ...VIEWPORTS[0]!, state: { ...VIEWPORT_STATE, part: { slug: 'lid', name: 'Lid' } } }]
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('Project / Part: "Enclosure" / "Housing" (housing) — part files are in parts/housing/ under the workspace root; model paths are relative to it')
    expect(texts[1]).toContain('Project / Part: "Enclosure" / "Lid" (lid) — part files are in parts/lid/ under the workspace root')
  })

  it('degrades to the project-only reading when a reported part is malformed', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('part-malformed'))
    const agent = sessionAgent(session)
    let turn = 0
    for (const part of [{ slug: 3, name: 'Housing' }, { slug: 'housing' }, null, 'housing']) {
      turn += 1
      fake.viewportsBody = [{ ...VIEWPORTS[0]!, state: { ...VIEWPORT_STATE, part } }]
      openMessageTurn(session, turn)
      await fire(ctx, agent, turn, 1)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }

    const [text] = contextTexts(session)
    expect(contextTexts(session)).toHaveLength(1)
    expect(text).toContain('It manages these CAD projects:')
    expect(text).not.toContain('workbenches open')
  })

  it('degrades to the project-only reading when the workbench list fails', async () => {
    const fake = await fakeCastudio()
    fake.viewportsStatus = 503
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('workbench-down'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('It manages these CAD projects:')
    expect(text).not.toContain('workbenches open')
    expect(fake.projectsRequests).toBe(1)
  })

  it('degrades to the project-only reading when the workbench payload is malformed', async () => {
    const fake = await fakeCastudio()
    fake.viewportsBody = [{ id: 'project-a' }]
    const { ctx } = await mount({ url: fake.url })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('workbench-malformed'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('It manages these CAD projects:')
    expect(text).not.toContain('workbenches open')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'))
  })

  it('warns that parametric edits need the optional CAD environment when unconfigured', async () => {
    const fake = await fakeCastudio()
    fake.runtimeBody = { configured: false }
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('parametric-down'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(fake.runtimeRequests).toBe(1)
    expect(text).toContain('The optional parametric CAD environment is not installed')
    expect(text).toContain('geometry, colour and material edits are unavailable until the user installs it')
    expect(text).toContain('Installing the CAD environment')
    expect(text).not.toContain('parametric CAD environment is configured')
  })

  it('re-injects when only the parametric runtime status flips', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('parametric-flip'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(contextTexts(session)).toHaveLength(1)

    // Same projects and workbenches, but the environment was uninstalled:
    // the status line is stable state, so the reading re-injects once.
    fake.runtimeBody = { configured: false }
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('CAStudio CAD service (turn 2):')
    expect(texts[1]).toContain('optional parametric CAD environment is not installed')
  })

  it('degrades to a reading without the parametric line when the runtime probe fails', async () => {
    const fake = await fakeCastudio()
    fake.runtimeStatus = 404
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('parametric-404'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('It manages these CAD projects:')
    expect(text).toContain('CAD skill guide:')
    expect(text).not.toContain('parametric CAD environment')
  })

  it('degrades to a reading without the parametric line when the runtime payload is malformed', async () => {
    const fake = await fakeCastudio()
    fake.runtimeBody = { configured: 'yes' }
    const { ctx } = await mount({ url: fake.url })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('parametric-malformed'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const [text] = contextTexts(session)
    expect(text).toContain('It manages these CAD projects:')
    expect(text).not.toContain('parametric CAD environment')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'))
  })

  it('reads the service origin from COSERVE_CASTUDIO_URL when config omits url', async () => {
    const fake = await fakeCastudio()
    const previous = process.env['COSERVE_CASTUDIO_URL']
    process.env['COSERVE_CASTUDIO_URL'] = fake.url
    onTestFinished(() => {
      if (previous === undefined) delete process.env['COSERVE_CASTUDIO_URL']
      else process.env['COSERVE_CASTUDIO_URL'] = previous
    })
    const { ctx } = await mount()
    const session = Session.create(SessionId('env'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(fake.projectsRequests).toBe(1)
    expect(contextTexts(session)).toHaveLength(1)
  })
})

describe('castudio-context no-op paths', () => {
  it('is a no-op when the service is unreachable', async () => {
    const fake = await fakeCastudio()
    const url = fake.url
    await fake.close()
    fakes.splice(fakes.indexOf(fake), 1)
    const { ctx } = await mount({ url })
    const session = Session.create(SessionId('down'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('is a no-op when the service answers non-OK', async () => {
    const fake = await fakeCastudio()
    fake.status = 503
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('non-ok'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })

  it('warns and injects nothing when the payload is not JSON', async () => {
    const fake = await fakeCastudio()
    fake.body = 'not json {'
    const { ctx } = await mount({ url: fake.url })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('bad-json'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
  })

  it('warns and injects nothing when a project row is malformed', async () => {
    const fake = await fakeCastudio()
    fake.body = [{ id: 'p-1', name: 'Part', workspacePath: 42 }]
    const { ctx } = await mount({ url: fake.url })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('bad-shape'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'))
  })

  it('skips an already-aborted prompt submission', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('ordering'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 1, abort.signal)
    expect(contextTexts(session)).toHaveLength(0)

    await fire(ctx, agent, 1, 1)
    expect(contextTexts(session)).toHaveLength(1)
  })
})

describe('castudio-context prior-reading resilience', () => {
  it('treats a prior non-text plugin reading as absent and injects afresh', async () => {
    const fake = await fakeCastudio()
    const { ctx } = await mount({ url: fake.url })
    const session = Session.create(SessionId('prior-non-text'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'not a reading' }],
      source: { kind: 'castudio-context' },
    }), { surfaceOp: 'append' })

    await fire(ctx, agent, 1, 1)

    expect(contextTexts(session).at(-1)).toContain('CAStudio CAD service (turn 1):')
  })
})

describe('castudio-context configuration', () => {
  it('rejects a non-URL service origin at plugin load', async () => {
    await expect(mount({ url: 'not a url' })).rejects.toThrow(/valid URL/)
  })

  it('rejects a non-http service origin at plugin load', async () => {
    await expect(mount({ url: 'ftp://127.0.0.1:4317' })).rejects.toThrow(/http or https/)
  })

  it('rejects a non-positive timeout at plugin load', async () => {
    await expect(mount({ url: 'http://127.0.0.1:1', timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be a positive safe integer/,
    )
  })

  it('rejects a negative refresh interval at plugin load', async () => {
    await expect(mount({ url: 'http://127.0.0.1:1', refreshIntervalMs: -1 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })

  it('rejects a non-integer refresh interval at plugin load', async () => {
    await expect(mount({ url: 'http://127.0.0.1:1', refreshIntervalMs: 1.5 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })

  it('rejects a non-positive project bound at plugin load', async () => {
    await expect(mount({ url: 'http://127.0.0.1:1', maxProjects: 0 })).rejects.toThrow(
      /maxProjects must be a positive safe integer/,
    )
  })
})
