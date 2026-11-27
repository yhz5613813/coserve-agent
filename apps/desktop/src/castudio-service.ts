/** Bundled CAStudio service lifecycle: spawn, instance-checked readiness, status, restart, and owned shutdown. */

import { type SpawnOptions, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCoserveHome } from '@deepseek-ai/dsh-home-paths'
import type { CAStudioFailure, CAStudioServiceStatus } from './castudio-protocol.ts'
import { caStudioOrigin } from './castudio-transport.ts'

const HEALTH_PATH = '/api/health'
const HEALTH_BODY_LIMIT = 65_536
const PROBE_TIMEOUT_MS = 1500
const READY_POLL_MS = 300
// tsx compilation and data recovery on a slow disk or under antivirus scanning can take tens of seconds.
const READY_TIMEOUT_MS = 60_000
const PORT_RETRY_DELAY_MS = 1000
const STOP_GRACE_MS = 5000
const STDERR_TAIL_LIMIT = 2048
const GPU_PROBE_TIMEOUT_MS = 5000
const EXIT_DATA_LOCKED = 75
const EXIT_PORT_IN_USE = 76
const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1,[::1]'
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Narrow child-process face the lifecycle needs; `ChildProcess` satisfies it. */
export interface CAStudioServiceChild extends EventEmitter {
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  /** Held open for the child's lifetime; CAStudio exits when it closes. Never written. */
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
}

export type CAStudioServiceSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => CAStudioServiceChild

/** `GET /api/health` body of a serving CAStudio; `instance` echoes the `STUDIO_INSTANCE` it was started with. */
export interface CAStudioHealth {
  readonly ok: true
  readonly instance: string | null
  readonly pid: number
}

/**
 * `self-managed` spawns CAStudio on a port this desktop allocated and adopts only the child it started; `external`
 * never spawns and adopts any origin whose health check answers.
 */
export type CAStudioMode = 'self-managed' | 'external'

export interface CAStudioServiceOptions {
  /** Origin accepted by `caStudioOrigin`; self-managed origins are `http://127.0.0.1:<port>`. */
  readonly origin: string
  readonly mode: CAStudioMode
  /** Node-compatible executable that runs the service (Electron Node mode in the app). */
  readonly executable: string
  /** `process.resourcesPath`; `COSERVE_CASTUDIO_DIR` overrides the service directory. */
  readonly resourcesPath?: string | undefined
  /** Offline runtime root (`<install>\runtime`); `COSERVE_CASTUDIO_RUNTIME` overrides it. */
  readonly runtimeDirectory?: string | undefined
  readonly environment?: NodeJS.ProcessEnv | undefined
  /** Harness home receiving the default `STUDIO_DATA_DIR`; defaults to `resolveCoserveHome()`. */
  readonly harnessHome?: string | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly spawn?: CAStudioServiceSpawn | undefined
  /** Resolves to the parsed health body of a 200 response, otherwise undefined. */
  readonly probe?: ((url: string) => Promise<CAStudioHealth | undefined>) | undefined
  readonly now?: (() => number) | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  readonly log?: ((level: 'info' | 'warn' | 'error', message: string) => void) | undefined
}

export interface CAStudioService {
  /** @returns the current status. */
  status(): CAStudioServiceStatus
  /** @returns the current status once it is no longer `starting`. */
  settled(): Promise<CAStudioServiceStatus>
  /**
   * Observe status changes.
   * @param listener - receives every new status.
   * @returns removal of the listener.
   */
  onStatus(listener: (status: CAStudioServiceStatus) => void): () => void
  /** Kills the owned child, if any, and starts again; resolves when the new start settles. No-op after `stop()`. */
  restart(): Promise<void>
  /** Idempotent; kills only a child this module spawned. */
  stop(): Promise<void>
}

/** A request found CAStudio failed, exited, or stopped. */
export class CAStudioUnavailableError extends Error {
  /** @param status - the non-ready settled status. */
  constructor(readonly status: Extract<CAStudioServiceStatus, { reason: CAStudioFailure }>) {
    super(`CAStudio service is not available (${status.state}: ${status.reason})${status.detail === '' ? '' : `: ${status.detail}`}`)
    this.name = 'CAStudioUnavailableError'
  }
}

/**
 * Wait while CAStudio starts; the service manager's readiness deadline bounds the wait.
 * @param service - the service manager.
 * @throws CAStudioUnavailableError when the service settles in any state but `ready`.
 */
export async function requireCAStudioReady(service: Pick<CAStudioService, 'settled'>): Promise<void> {
  const status = await service.settled()
  if (status.state === 'starting' || status.state === 'ready') return
  throw new CAStudioUnavailableError(status)
}

function parseHealth(text: string): CAStudioHealth | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch (_error) {
    // A 200 whose body is not JSON is not CAStudio.
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true
    || !('instance' in value) || !('pid' in value)) return undefined
  const { instance, pid } = value
  if ((instance !== null && typeof instance !== 'string') || typeof pid !== 'number') return undefined
  return { ok: true, instance, pid }
}

// A direct loopback request: a fresh agent never routes through an environment-configured proxy.
function defaultProbe(url: string): Promise<CAStudioHealth | undefined> {
  return new Promise((resolve) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { agent: false, timeout: PROBE_TIMEOUT_MS }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > HEALTH_BODY_LIMIT) request.destroy()
        else chunks.push(chunk)
      })
      response.on('end', () => resolve(response.statusCode === 200 ? parseHealth(Buffer.concat(chunks).toString('utf8')) : undefined))
      response.on('close', () => resolve(undefined))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(undefined))
    request.end()
  })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `desktop castudio: ${message}`
  if (level === 'info') console.log(line)
  else if (level === 'warn') console.warn(line)
  else console.error(line)
}

function serviceEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key === 'NODE_USE_ENV_PROXY') continue
    scrubbed[key] = value
  }
  return { ...scrubbed, ...overrides }
}

/**
 * Choose the CAStudio origin for a self-managed launch: the conventional port when it is free, otherwise any free
 * loopback port. The port is released before CAStudio binds it; CAStudio exit code 76 reports a port taken meanwhile.
 * @param preferredPort - port tried first so the embedded page keeps one origin across ordinary launches.
 * @returns a loopback HTTP origin whose port was free a moment ago.
 */
export async function allocateCAStudioOrigin(preferredPort = 4317): Promise<string> {
  const tryListen = (port: number): Promise<number | undefined> => new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(undefined))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : undefined))
    })
  })
  const port = await tryListen(preferredPort) ?? await tryListen(0)
  if (port === undefined) throw new Error('desktop castudio: no free loopback port')
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Whether `nvidia-smi -L` lists at least one GPU within a short timeout.
 * @param windir - Windows directory holding `System32\nvidia-smi.exe`.
 * @returns true only for a successful run that lists a GPU.
 */
export function nvidiaGpuPresent(windir: string): boolean {
  const result = spawnSync(join(windir, 'System32', 'nvidia-smi.exe'), ['-L'], { encoding: 'utf8', timeout: GPU_PROBE_TIMEOUT_MS, windowsHide: true })
  return result.status === 0 && /^GPU \d+:/m.test(result.stdout)
}

/**
 * Point CAStudio at the offline runtime the Windows installer unpacks beside the app
 * (`<install>\runtime\{python,calculix,thermal}`). Records this function writes carry `"auto": true` and are rewritten
 * from the current bundle on every start, or deleted when their bundled component is absent. A record without `auto`
 * is the user's and is kept while the executable it names exists; otherwise it is replaced like an auto record.
 * @param runtime - runtime root; absent or incomplete roots leave CAStudio on its own defaults.
 * @param dataDirectory - CAStudio data root holding the `*-runtime.json` records.
 * @param serviceDirectory - staged CAStudio service, which carries the structural package sources.
 * @param platform - host platform; only Windows ships the bundled runtime.
 * @param parent - environment the child inherits; its PATH follows the thermal CUDA libraries.
 * @param gpuPresent - GPU check choosing the thermal device; defaults to `nvidia-smi -L`.
 * @returns environment overrides for the CAStudio child.
 */
export function configureBundledRuntime(runtime: string | undefined, dataDirectory: string, serviceDirectory: string, platform: NodeJS.Platform, parent: NodeJS.ProcessEnv, gpuPresent: () => boolean = () => nvidiaGpuPresent(parent.windir ?? 'C:\\Windows')): Record<string, string> {
  const python = runtime === undefined ? '' : join(runtime, 'python', 'python.exe')
  if (platform !== 'win32' || runtime === undefined || !existsSync(python)) return {}
  mkdirSync(dataDirectory, { recursive: true })
  const record = (name: string, executable: string, bundled: Record<string, string> | undefined): void => {
    const file = join(dataDirectory, name)
    let current: Record<string, unknown> | undefined
    if (existsSync(file)) {
      try {
        current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch (_error) {
        // An unreadable record is replaced like a missing one when the bundle has a component for it.
      }
    }
    const named = current?.[executable]
    if (current !== undefined && current.auto !== true && typeof named === 'string' && existsSync(named)) return
    if (bundled !== undefined) writeFileSync(file, JSON.stringify({ ...bundled, auto: true }))
    else if (current !== undefined) rmSync(file, { force: true })
  }
  record('runtime.json', 'executable', { executable: python })
  record('parametric-runtime.json', 'python', { python })
  const ccx = join(runtime, 'calculix', 'ccx.exe')
  const packageRoot = join(serviceDirectory, 'resources', 'structural-sim')
  record('structural-runtime.json', 'python', existsSync(ccx) && existsSync(packageRoot)
    ? { python, reportPython: python, packageRoot, solver: ccx }
    : undefined)
  const thermal = join(runtime, 'thermal')
  const thermalPython = join(thermal, 'python', 'python.exe')
  const engine = join(thermal, 'engine')
  const cuda = join(thermal, 'cuda')
  const thermalPresent = existsSync(thermalPython) && existsSync(engine) && existsSync(cuda)
  record('thermal-runtime.json', 'executable', thermalPresent
    ? { executable: thermalPython, device: gpuPresent() ? 'cuda' : 'cpu' }
    : undefined)
  // Every runtime record and STUDIO_PYTHON name absolute executables; a PATH python would become thermal's fallback.
  const environment: Record<string, string> = { STUDIO_PYTHON: python, PYTHONUTF8: '1' }
  if (thermalPresent) {
    Object.assign(environment, {
      STUDIO_THERMAL_PYTHON: thermalPython,
      COSERVE_THERMOFORGE_ROOT: engine,
      CUDA_PATH: cuda,
      THERMAL_CUDA_BACKEND: 'native_cudss',
    })
    const pathKey = Object.keys(parent).find(name => name.toLowerCase() === 'path') ?? 'Path'
    environment[pathKey] = [join(cuda, 'bin'), parent[pathKey] ?? ''].join(';')
  }
  return environment
}

function tsxLoaderEntry(serviceDirectory: string): string | undefined {
  const manifestPath = join(serviceDirectory, 'node_modules', 'tsx', 'package.json')
  if (!existsSync(manifestPath)) return undefined
  let manifest: { exports?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: unknown }
  } catch {
    return undefined
  }
  const dot = typeof manifest.exports === 'object' && manifest.exports !== null
    ? (manifest.exports as Record<string, unknown>)['.']
    : manifest.exports
  const entry = typeof dot === 'string' ? dot
    : typeof dot === 'object' && dot !== null
      ? (['import', 'default', 'node', 'require'] as const)
        .map(key => (dot as Record<string, unknown>)[key])
        .find((value): value is string => typeof value === 'string')
      : undefined
  if (entry === undefined) return undefined
  const loader = join(serviceDirectory, 'node_modules', 'tsx', entry)
  return existsSync(loader) ? loader : undefined
}

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error | undefined
}

interface OwnedChild {
  readonly process: CAStudioServiceChild
  readonly exited: Promise<void>
  exit: ChildExit | undefined
  stderrTail: string
  stopping: Promise<void> | undefined
}

interface Launch {
  readonly serviceDirectory: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/**
 * Manage CAStudio for the desktop. Self-managed mode spawns CAStudio with a fresh `STUDIO_INSTANCE` token and is
 * ready only when `/api/health` echoes that token; a port taken between allocation and spawn (exit 76) is retried once.
 * A readiness timeout kills the child tree; an exit after readiness reports `exited` and restarts once automatically.
 * External mode only waits for any healthy answer. Never throws: failures become a `failed` status.
 * @param options - origin, mode, executable, and injectable process/environment seams.
 * @returns the status and lifecycle handle.
 */
export function startCAStudioService(options: CAStudioServiceOptions): CAStudioService {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const spawnFn = options.spawn ?? ((file, args, spawnOptions) => nodeSpawn(file, [...args], spawnOptions))
  const probe = options.probe ?? defaultProbe
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? defaultLog
  const harnessHome = options.harnessHome ?? resolveCoserveHome()
  const origin = caStudioOrigin(options.origin)
  const healthUrl = `${origin}${HEALTH_PATH}`

  let status: CAStudioServiceStatus = { state: 'starting' }
  const listeners = new Set<(status: CAStudioServiceStatus) => void>()
  const waiters: ((status: CAStudioServiceStatus) => void)[] = []
  let child: OwnedChild | undefined
  let generation = 0
  let stopped = false
  let autoRestarted = false
  let stopPromise: Promise<void> | undefined

  const report = (next: CAStudioServiceStatus): void => {
    status = next
    for (const listener of listeners) listener(next)
    if (next.state !== 'starting') for (const resolve of waiters.splice(0)) resolve(next)
  }
  const fail = (reason: CAStudioFailure, detail: string): void => report({ state: 'failed', reason, detail })

  const waitForExit = (target: OwnedChild, ms: number): Promise<boolean> => {
    if (target.exit !== undefined) return Promise.resolve(true)
    return Promise.race([target.exited.then(() => true as const), sleep(ms).then(() => false as const)])
  }

  const terminate = (target: OwnedChild): Promise<void> => {
    target.stopping ??= (async () => {
      if (target.exit !== undefined) return
      // CAStudio exits when its stdin closes; the forced path below covers a hung process.
      target.process.stdin?.end()
      if (await waitForExit(target, STOP_GRACE_MS)) return
      if (platform === 'win32') {
        // Node reports SIGTERM on Windows as TerminateProcess: there is no graceful
        // console signal for a hidden child, so kill the whole tree directly.
        if (target.process.pid !== undefined) {
          try {
            spawnFn('taskkill', ['/PID', String(target.process.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
              .on('error', () => {})
          } catch (error) {
            log('warn', `taskkill failed: ${String(error)}`)
          }
        }
      } else target.process.kill('SIGTERM')
      if (!await waitForExit(target, STOP_GRACE_MS)) target.process.kill('SIGKILL')
    })()
    return target.stopping
  }

  const exitFailure = (target: OwnedChild): { reason: CAStudioFailure; detail: string } => {
    const exit = target.exit
    if (exit?.error !== undefined) return { reason: 'spawn-failed', detail: String(exit.error) }
    const code = exit?.code ?? null
    const reason = code === EXIT_DATA_LOCKED ? 'data-locked' : code === EXIT_PORT_IN_USE ? 'port-in-use' : 'exited'
    const tail = target.stderrTail.trimEnd()
    return { reason, detail: `code ${String(code)}, signal ${String(exit?.signal ?? null)}${tail === '' ? '' : `; stderr tail: ${tail}`}` }
  }

  const prepare = (): Launch | string => {
    const serviceDirectory = environment.COSERVE_CASTUDIO_DIR
      ?? (options.resourcesPath === undefined ? undefined : join(options.resourcesPath, 'castudio'))
    if (serviceDirectory === undefined || !existsSync(join(serviceDirectory, 'server', 'index.ts'))) {
      const looked = serviceDirectory ?? (options.resourcesPath === undefined ? 'an unknown resources path' : join(options.resourcesPath, 'castudio'))
      return `CAStudio service directory missing (no server/index.ts under ${looked}); CAD workspace unavailable`
    }
    const loader = tsxLoaderEntry(serviceDirectory)
    if (loader === undefined) return `CAStudio service at ${serviceDirectory} has no usable tsx loader; CAD workspace unavailable`
    const dataDirectory = environment.STUDIO_DATA_DIR !== undefined && environment.STUDIO_DATA_DIR !== ''
      ? environment.STUDIO_DATA_DIR
      : join(harnessHome, 'castudio')
    const args = ['--import', pathToFileURL(loader).href, 'server/index.ts']
    if (!existsSync(join(serviceDirectory, 'dist', 'index.html'))) args.push('--dev')
    const runtime = environment.COSERVE_CASTUDIO_RUNTIME ?? options.runtimeDirectory
    // Intranet machines often set a system proxy; loopback calls between the services must bypass it.
    const noProxy = [environment.NO_PROXY ?? environment.no_proxy, LOOPBACK_NO_PROXY].filter(Boolean).join(',')
    const env = serviceEnvironment(environment, {
      ...configureBundledRuntime(runtime, dataDirectory, serviceDirectory, platform, environment),
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      STUDIO_PORT: new URL(origin).port,
      STUDIO_DATA_DIR: dataDirectory,
      STUDIO_PARENT_PIPE: '1',
      ELECTRON_RUN_AS_NODE: '1',
    })
    return { serviceDirectory, args, env }
  }

  const spawnChild = (launch: Launch, instance: string): OwnedChild => {
    const spawned = spawnFn(options.executable, launch.args, {
      cwd: launch.serviceDirectory,
      env: { ...launch.env, STUDIO_INSTANCE: instance },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let finish!: () => void
    const owned: OwnedChild = { process: spawned, exited: new Promise((resolve) => { finish = resolve }), exit: undefined, stderrTail: '', stopping: undefined }
    spawned.stdin?.on('error', (_error: Error) => {
      // EPIPE after the child exits; the exit event reports the outcome.
    })
    spawned.stdout?.on('data', chunk => log('info', `stdout: ${String(chunk).trimEnd()}`))
    spawned.stderr?.on('data', (chunk) => {
      owned.stderrTail = `${owned.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT)
      log('warn', `stderr: ${String(chunk).trimEnd()}`)
    })
    spawned.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      owned.exit ??= { code, signal }
      finish()
    })
    spawned.once('error', (error: Error) => {
      // A process that never started has no pid and emits no exit.
      if (spawned.pid !== undefined) return
      owned.exit ??= { code: null, signal: null, error }
      finish()
    })
    return owned
  }

  const awaitReady = async (target: OwnedChild, instance: string, current: () => boolean): Promise<'ready' | 'exited' | 'timeout' | 'superseded'> => {
    const deadline = now() + READY_TIMEOUT_MS
    let foreignLogged = false
    for (;;) {
      if (target.exit !== undefined) return 'exited'
      if (!current()) return 'superseded'
      const health = await probe(healthUrl)
      if (health !== undefined && health.instance === instance) return 'ready'
      if (health !== undefined && !foreignLogged) {
        foreignLogged = true
        log('warn', `another CAStudio (pid ${String(health.pid)}) answers at ${origin}; waiting for the spawned instance`)
      }
      if (now() >= deadline) return 'timeout'
      await sleep(READY_POLL_MS)
    }
  }

  const launch = async (launchGeneration: number): Promise<void> => {
    const current = (): boolean => launchGeneration === generation && !stopped
    if (options.mode === 'external') {
      const deadline = now() + READY_TIMEOUT_MS
      for (;;) {
        const health = await probe(healthUrl)
        if (!current()) return
        if (health !== undefined) {
          log('info', `using external CAStudio at ${origin}`)
          report({ state: 'ready' })
          return
        }
        if (now() >= deadline) {
          log('warn', `external CAStudio at ${origin} did not answer ${HEALTH_PATH}`)
          fail('unreachable', `${origin} did not answer ${HEALTH_PATH}`)
          return
        }
        await sleep(READY_POLL_MS)
      }
    }
    const prepared = prepare()
    if (typeof prepared === 'string') {
      log('warn', prepared)
      fail('unavailable', prepared)
      return
    }
    for (let attempt = 1; ; attempt += 1) {
      if (!current()) return
      const instance = randomBytes(16).toString('hex')
      log('info', `starting bundled CAStudio from ${prepared.serviceDirectory} on ${origin}`)
      const spawned = spawnChild(prepared, instance)
      child = spawned
      const result = await awaitReady(spawned, instance, current)
      if (!current() || result === 'superseded') return
      if (result === 'ready') {
        log('info', `CAStudio service ready at ${origin}`)
        report({ state: 'ready' })
        void spawned.exited.then(() => {
          if (!current()) return
          const failure = exitFailure(spawned)
          log('warn', `CAStudio service exited unexpectedly (${failure.detail})`)
          report({ state: 'exited', ...failure })
          if (autoRestarted) return
          autoRestarted = true
          report({ state: 'starting' })
          void run(launchGeneration)
        })
        return
      }
      if (result === 'timeout') {
        log('warn', `CAStudio service did not become ready within ${READY_TIMEOUT_MS / 1000}s; stopping it`)
        await terminate(spawned)
        if (current()) fail('timeout', `no matching ${HEALTH_PATH} answer within ${READY_TIMEOUT_MS / 1000}s`)
        return
      }
      const failure = exitFailure(spawned)
      if (failure.reason === 'port-in-use' && attempt === 1) {
        log('warn', `CAStudio port ${origin} was taken before the service bound it; retrying once`)
        await sleep(PORT_RETRY_DELAY_MS)
        continue
      }
      log('warn', `CAStudio service exited unexpectedly (${failure.detail})`)
      fail(failure.reason, failure.detail)
      return
    }
  }

  const run = (launchGeneration: number): Promise<void> => launch(launchGeneration).catch((error: unknown) => {
    log('error', `CAStudio service lifecycle failed: ${String(error)}`)
    if (launchGeneration === generation && !stopped) fail('spawn-failed', String(error))
  })

  const restart = async (): Promise<void> => {
    if (stopped) return
    generation += 1
    const restartGeneration = generation
    autoRestarted = false
    report({ state: 'starting' })
    const previous = child
    child = undefined
    if (previous !== undefined) await terminate(previous)
    if (restartGeneration === generation && !stopped) await run(restartGeneration)
  }

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopped = true
      generation += 1
      fail('stopped', '')
      if (child !== undefined) await terminate(child)
    })()
    return stopPromise
  }

  void run(generation)
  return {
    status: () => status,
    settled: () => status.state === 'starting' ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(status),
    onStatus: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    restart,
    stop,
  }
}
