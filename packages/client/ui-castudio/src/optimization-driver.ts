/** Host scheduling for CAStudio's durable task service; no UI lifetime or scoring state. */
export interface PendingOptimization {
  id: string
  projectId: string
  workspacePath: string
  revision: number
  phase: string
  sessionId?: string
}

/** A model proposal is data, never an authority to run a simulation. */
export interface DesignProposal { code: string; rationale: string; changes: string[] }
/** DSH owns session creation, logged model requests and child cancellation. */
export interface DriverRuntime {
  openSession(task: PendingOptimization): Promise<string>
  propose(task: PendingOptimization, sessionId: string, prompt: string, signal: AbortSignal): Promise<DesignProposal & { childId: string }>
}
/** Local wire transport; a body selects POST, omission selects GET. */
export type OptimizationRequest = (path: string, body?: object) => Promise<unknown>

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid optimization response')
  return value as Record<string, unknown>
}
function textField(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string' || row[key].length === 0) throw new Error(`Invalid optimization ${key}`)
  return row[key]
}
function pending(value: unknown): PendingOptimization {
  const row = record(value)
  if (!Number.isSafeInteger(row.revision)) throw new Error('Invalid optimization revision')
  return { id: textField(row, 'id'), projectId: textField(row, 'projectId'), workspacePath: textField(row, 'workspacePath'), revision: row.revision as number, phase: textField(row, 'phase'), ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}) }
}
/** Validate model JSON before submitting it to independent CAStudio validation.
 * @param value - structured subagent output.
 * @returns Complete source and model-authored explanation.
 */
export function parseProposal(value: unknown): DesignProposal {
  const row = record(value)
  const code = textField(row, 'code')
  if (code.length > 500000 || typeof row.rationale !== 'string' || !Array.isArray(row.changes) || !row.changes.every(change => typeof change === 'string')) throw new Error('Invalid CAD proposal: code, rationale and changes are required')
  return { code, rationale: row.rationale, changes: row.changes }
}

interface Dispatch {
  task: PendingOptimization
  abort: AbortController
  work: Promise<void>
  submission?: object
  submitted: boolean
  sessionId?: string
  admitted: boolean
}

/** One host worker; backend revisions and claims arbitrate competing hosts. */
export class OptimizationDriver {
  private readonly running = new Map<string, Dispatch>()
  private closed = false
  private ticking: Promise<void> | undefined
  constructor(
    private readonly request: OptimizationRequest,
    private readonly runtime: DriverRuntime,
    private readonly config: { workerId: string; proposalTimeoutMs: number },
  ) {}

  /** Poll task authority and dispatch at most one child per claimed attempt.
   * @returns Completion of this poll, without waiting for model turns.
   */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.ticking !== undefined) return this.ticking
    this.ticking = this.poll().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async poll(): Promise<void> {
    await this.request('/api/optimizations/driver', { workerId: this.config.workerId })
    for (const entry of this.running.values()) {
      const state = record(await this.request(this.path(entry.task)))
      if (!entry.admitted) {
        if (state.phase === 'claimed' || state.phase === 'awaiting_proposal') await this.dispatch(entry)
        else {
          entry.abort.abort(new Error('Optimization claim is no longer admitted'))
          this.running.delete(entry.task.id)
        }
        continue
      }
      if (state.phase !== 'claimed') {
        entry.abort.abort(new Error('Optimization proposal is no longer admitted'))
        if (entry.submission !== undefined || entry.submitted) this.running.delete(entry.task.id)
      } else if (entry.submission !== undefined) await this.submit(entry)
    }
    const list = await this.request('/api/optimizations/pending')
    if (!Array.isArray(list)) throw new Error('Invalid optimization queue')
    for (const item of list) {
      const task = pending(item)
      if (this.closed || this.running.has(task.id)) continue
      const entry: Dispatch = { task, abort: new AbortController(), work: Promise.resolve(), submitted: false, admitted: false }
      this.running.set(task.id, entry)
      // Await session/claim admission, never the model turn. This establishes ownership
      // before a subsequent poll can consider the same task.
      await this.dispatch(entry)
    }
  }

  private path(task: PendingOptimization): string {
    return `/api/projects/${encodeURIComponent(task.projectId)}/optimizations/${encodeURIComponent(task.id)}`
  }

  private async dispatch(entry: Dispatch): Promise<void> {
    try {
      const sessionId = entry.sessionId ?? await this.runtime.openSession(entry.task)
      entry.sessionId = sessionId
      if (entry.abort.signal.aborted || this.closed) return
      const claim = record(await this.request(`${this.path(entry.task)}/claim`, { workerId: this.config.workerId, revision: entry.task.revision, sessionId }))
      const proposal = record(claim.proposal)
      const token = textField(proposal, 'token')
      const prompt = textField(proposal, 'prompt')
      if (!Number.isSafeInteger(proposal.attempt)) throw new Error('Invalid optimization attempt')
      const identity = { token, attempt: proposal.attempt, sessionId }
      entry.admitted = true
      entry.work = this.design(entry, prompt, sessionId, identity)
    } catch (error) {
      const rejected = error instanceof OptimizationHttpError && error.status >= 400 && error.status < 500
      // A lost admission response may have committed server-side. Retain the original
      // session and revision so the next poll can replay that same claim safely.
      if (entry.sessionId === undefined || rejected || this.closed) this.running.delete(entry.task.id)
      if (entry.sessionId === undefined && !this.closed && !(error instanceof OptimizationHttpError && error.status === 409)) {
        await this.request(`${this.path(entry.task)}/dispatch-error`, { revision: entry.task.revision, workerId: this.config.workerId, error: error instanceof Error ? error.message : 'Optimization session creation failed' }).catch(() => { /* the next poll retries when the task service is unavailable */ })
      }
      throw error
    }
  }

  private async design(entry: Dispatch, prompt: string, sessionId: string, identity: object): Promise<void> {
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; entry.abort.abort(new Error('Design proposal timed out')) }, this.config.proposalTimeoutMs)
    try {
      const proposal = await this.runtime.propose(entry.task, sessionId, prompt, entry.abort.signal)
      if (!entry.abort.signal.aborted && !this.closed) entry.submission = { ...identity, ...proposal }
    } catch (error) {
      if (!this.closed && !entry.abort.signal.aborted) entry.submission = { ...identity, error: error instanceof Error ? error.message : 'Design agent failed' }
    } finally { clearTimeout(deadline) }
    if (timedOut && !this.closed) entry.submission = { ...identity, error: 'Design proposal timed out' }
    if (entry.submission !== undefined && !this.closed) await this.submit(entry)
    else this.running.delete(entry.task.id)
  }

  private async submit(entry: Dispatch): Promise<void> {
    // The exact same attempt/token/body is retained on a lost response. A successful
    // replay is idempotent; a stale or cancelled proposal is rejected by the task service.
    try {
      await this.request(`${this.path(entry.task)}/proposal`, entry.submission)
      entry.submitted = true
      this.running.delete(entry.task.id)
    } catch (error) {
      if (error instanceof OptimizationHttpError && error.status >= 400 && error.status < 500) this.running.delete(entry.task.id)
    }
  }

  /** Await current dispatches, primarily for graceful shutdown and verification.
   * @returns Completion of the currently owned child work.
   */
  async drain(): Promise<void> { await Promise.allSettled([...this.running.values()].map(entry => entry.work)) }

  /** Stop dispatch before cancelling every actual child and waiting for cleanup.
   * @returns Completion of shutdown.
   */
  async dispose(): Promise<void> {
    this.closed = true
    for (const entry of this.running.values()) entry.abort.abort(new Error('Optimization host stopped'))
    await this.ticking?.catch(() => { /* shutdown still drains children after a failed poll */ })
    await this.drain()
    this.running.clear()
  }
}

/** A known HTTP rejection distinguishes stale submissions from lost responses. */
export class OptimizationHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
