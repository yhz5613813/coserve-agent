/** CAStudio's browser surface and UI-independent DSH optimization worker. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { OptimizationDriver, OptimizationHttpError, parseProposal } from './optimization-driver.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'cad-design': 'cad-design' }
}

/** Host plugin identity. */
export const name = 'ui-castudio'
/** These host services own sessions, model execution and background work. */
export const inject = ['sessionController', 'subagents', 'jobs', 'agentPresets']
/** Deployment-owned local service and scheduling limits. */
export interface Config {
  /** Enable the host-owned optimization queue worker. */
  optimizationEnabled: boolean
  /** Loopback HTTP origin of the CAStudio task service. */
  url: string
  /** Delay in milliseconds between task queue polls. */
  pollIntervalMs: number
  /** Maximum milliseconds for one task service request. */
  requestTimeoutMs: number
  /** Maximum milliseconds for one model design proposal. */
  proposalTimeoutMs: number
  /** Registered preset identifier for restricted design sessions. */
  agentPreset: string
  /** Proposal reasoning effort; an empty string inherits the parent setting. */
  proposalReasoningEffort: string
}
/** Validated defaults keep work bounded while allowing local configuration. */
export const Config: z<Config> = z.object({
  optimizationEnabled: z.boolean().default(true),
  url: z.string().default('http://127.0.0.1:4317'),
  pollIntervalMs: z.number().min(250).max(10000).default(2000),
  requestTimeoutMs: z.number().min(1000).max(60000).default(10000),
  proposalTimeoutMs: z.number().min(10000).max(1800000).default(360000),
  agentPreset: z.string().default('castudio-optimization'),
  proposalReasoningEffort: z.string().default('low'),
})

/** Start the host worker; disposing a view has no effect on it.
 * @param ctx - public DSH extension services.
 * @param config - validated deployment settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.optimizationEnabled) return
  const origin = new URL(config.url)
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('CAStudio optimization requires a plain loopback HTTP origin')
  // The local activation runtime supplies its structured result tool. No shell,
  // filesystem, external connectors or user-question tools enter this preset.
  const unregisterPreset = await ctx.agentPresets.register({ id: config.agentPreset, name: 'CAD optimization', order: 100, plugins: [] })
  ctx.effect(() => unregisterPreset, 'castudio.optimization.preset')
  const designParents = new Set<string>()
  const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  ctx.on('agent/created', ({ agent }) => {
    const parentSession = agent.session.header.parentSession
    if (parentSession !== undefined && designParents.has(parentSession)) agent.ctx.tools.restrict({ allow: [] })
    return undefined
  })
  // Model proposals have no filesystem/shell authority. CAD build and validation are
  // owned by the task service; the only accepted child tool submits structured data.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const parentSession = exec.agent?.session.header.parentSession
    if (parentSession !== undefined && designParents.has(parentSession) && exec.name !== 'structured_output') return { kind: 'deny', reason: 'Optimization design agents only submit structured_output; the task service builds and validates CAD.' }
    return next()
  })
  const driver = new OptimizationDriver(async (path, body) => {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
    if (!response.ok) throw new OptimizationHttpError(response.status, `CAStudio request failed (${response.status})`)
    return response.json()
  }, {
    async openSession(task) {
      if (task.sessionId !== undefined) {
        const found = await ctx.sessionController.resolveAgent(SessionId(task.sessionId))
        if ('error' in found) throw found.error
        if (normalize(found.agent.session.header.cwd ?? '') !== normalize(task.workspacePath)) throw new Error('Optimization session workspace differs from the task workspace')
        designParents.add(task.sessionId)
        return task.sessionId
      }
      const created = await ctx.sessionController.create({ cwd: task.workspacePath, agentPreset: config.agentPreset })
      designParents.add(created.sessionId)
      await ctx.sessionController.rename({ sessionId: created.sessionId, title: `CAD 自动优化 ${task.id.slice(0, 8)}` })
      return created.sessionId
    },
    async propose(task, sessionId, prompt, signal) {
      const found = await ctx.sessionController.resolveAgent(SessionId(sessionId))
      if ('error' in found) throw found.error
      const parent = found.agent
      const cancellation = new AbortController()
      const abort = (): void => cancellation.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const result = Promise.withResolvers<Awaited<ReturnType<typeof ctx.subagents.startActivation>>>()
      const jobId = ctx.jobs.start({
        kind: 'cad-design', owner: parent.id, label: `CAD optimization ${task.id}`,
        run: () => {
          const work = ctx.subagents.startActivation({
            provider: 'spawn', parent, cwd: task.workspacePath, delivery: 'caller',
            label: 'CAD geometry proposal', signal: cancellation.signal,
            ...(config.proposalReasoningEffort
              ? { agentOptions: { reasoningEffort: ReasoningEffortId(config.proposalReasoningEffort) } }
              : {}),
            prompt: [{ type: 'text', text: `${prompt}\nUse structured_output to submit the complete proposal. Do not call filesystem, shell, CAD or simulation tools. All construction and independent checks are performed by the optimization task service.` }],
            outputSchema: {
              type: 'object', properties: { code: { type: 'string' }, rationale: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
              required: ['code', 'rationale', 'changes'], additionalProperties: false,
            },
          }).then(async (activation) => {
            result.resolve(activation)
            const stop = (): void => { void activation.dispose().catch(() => { /* activation result owns diagnostics */ }) }
            cancellation.signal.addEventListener('abort', stop, { once: true })
            if (cancellation.signal.aborted) stop()
            try {
              const ended = await activation.result
              return { status: ended.stopReason === 'completed' ? 'completed' as const : cancellation.signal.aborted ? 'killed' as const : 'failed' as const, result: ended.diagnostic ?? ended.stopReason }
            } finally { cancellation.signal.removeEventListener('abort', stop); await activation.dispose() }
          }).catch((error) => {
            result.reject(error)
            return { status: 'failed' as const, result: error instanceof Error ? error.message : 'CAD design failed' }
          })
          return { cancel: () => cancellation.abort(new Error('CAD design cancelled')), done: work }
        },
      })
      try {
        const activation = await result.promise
        const output = await activation.result
        if (output.stopReason !== 'completed') throw new Error(output.diagnostic ?? `Design agent stopped: ${output.stopReason}`)
        return { ...parseProposal(output.structured), childId: activation.childId }
      } finally {
        signal.removeEventListener('abort', abort)
        await ctx.jobs.wait(jobId, config.proposalTimeoutMs, parent.id)
      }
    },
  }, { workerId: randomUUID(), proposalTimeoutMs: config.proposalTimeoutMs })
  ctx.effect(() => ctx.jobs.attachController('castudio-optimization'), 'castudio.optimization.jobs')
  ctx.effect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try { await driver.tick() }
      catch (error) {
        // Offline CAStudio is expected in browser-only deployments; owned tasks
        // remain durable in CAStudio and the next heartbeat retries connection.
        if (!(error instanceof TypeError) && !(error instanceof OptimizationHttpError && error.status === 404)) console.warn('CAStudio optimization worker:', error instanceof Error ? error.message : error)
      }
      if (!closed) timer = setTimeout(() => { void poll() }, config.pollIntervalMs)
    }
    void poll()
    return async () => { closed = true; clearTimeout(timer); await driver.dispose() }
  }, 'castudio.optimization.worker')
}
