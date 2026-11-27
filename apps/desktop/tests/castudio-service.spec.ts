import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAStudioUnavailableError,
  requireCAStudioReady,
  startCAStudioService,
  type CAStudioHealth,
  type CAStudioServiceChild,
  type CAStudioServiceOptions,
} from '../src/castudio-service.ts'
import type { CAStudioServiceStatus } from '../src/castudio-protocol.ts'

const directories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'castudio-service-spec-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class FakeChild extends EventEmitter implements CAStudioServiceChild {
  readonly pid = 43210
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killed: (NodeJS.Signals | number | undefined)[] = []
  stdinEnded = false
  constructor(readonly behavior: { onKill?: 'exit'; onStdinEnd?: 'exit'; exitAfterSpawn?: number } = {}) {
    super()
    this.stdin.on('finish', () => {
      this.stdinEnded = true
      if (behavior.onStdinEnd === 'exit') queueMicrotask(() => this.emit('exit', 0, null))
    })
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal)
    if (this.behavior.onKill === 'exit') queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

interface SpawnCall {
  readonly file: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
}

/** Each service spawn takes the next child; taskkill gets a throwaway one. */
function fakeSpawn(...children: FakeChild[]) {
  const calls: SpawnCall[] = []
  const spawn = vi.fn((file: string, args: readonly string[], options: SpawnOptions): CAStudioServiceChild => {
    calls.push({ file, args, options })
    if (file === 'taskkill') return new FakeChild()
    const child = children.shift()
    if (child === undefined) throw new Error('unexpected spawn')
    if (child.behavior.exitAfterSpawn !== undefined) {
      const code = child.behavior.exitAfterSpawn
      queueMicrotask(() => child.emit('exit', code, null))
    }
    return child
  })
  const services = () => calls.filter(call => call.file !== 'taskkill')
  return { calls, services, spawn }
}

/** Health that echoes the instance of the latest service spawn, as the spawned CAStudio would. */
function ownHealth(services: () => SpawnCall[]) {
  return vi.fn(async (): Promise<CAStudioHealth | undefined> => {
    const instance = (services().at(-1)?.options.env as NodeJS.ProcessEnv | undefined)?.STUDIO_INSTANCE
    return instance === undefined ? undefined : { ok: true, instance, pid: 1 }
  })
}

function serviceTree(root: string, options: { dist?: boolean } = {}): string {
  const directory = join(root, 'castudio')
  mkdirSync(join(directory, 'server'), { recursive: true })
  writeFileSync(join(directory, 'server', 'index.ts'), 'export {}\n')
  mkdirSync(join(directory, 'node_modules', 'tsx', 'dist'), { recursive: true })
  writeFileSync(join(directory, 'node_modules', 'tsx', 'package.json'),
    JSON.stringify({ name: 'tsx', exports: { '.': './dist/loader.mjs' } }))
  writeFileSync(join(directory, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'export {}\n')
  if (options.dist !== false) {
    mkdirSync(join(directory, 'dist'), { recursive: true })
    writeFileSync(join(directory, 'dist', 'index.html'), '<html></html>\n')
  }
  return directory
}

/** A fake clock: every sleep advances `now`, so the wall-clock deadline elapses without real waiting. */
function baseOptions(overrides: Partial<CAStudioServiceOptions> = {}): CAStudioServiceOptions {
  let clock = 0
  return {
    origin: 'http://127.0.0.1:4317',
    mode: 'self-managed',
    executable: '/runtime/node',
    environment: { COSERVE_CASTUDIO_DIR: serviceTree(tempDir()) },
    harnessHome: tempDir(),
    platform: 'linux',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      await new Promise(resolve => setImmediate(resolve))
    },
    log: () => {},
    ...overrides,
  }
}

function recordStatuses(service: ReturnType<typeof startCAStudioService>): CAStudioServiceStatus['state'][] {
  const states: CAStudioServiceStatus['state'][] = []
  service.onStatus(status => states.push(status.state))
  return states
}

describe('CAStudio service lifecycle', () => {
  it('adopts any healthy external origin without spawning or killing it', async () => {
    const probe = vi.fn(async (): Promise<CAStudioHealth> => ({ ok: true, instance: null, pid: 7 }))
    const { calls, spawn } = fakeSpawn()
    const service = startCAStudioService(baseOptions({ mode: 'external', origin: 'http://localhost:4317', probe, spawn }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    expect(probe).toHaveBeenCalledWith('http://localhost:4317/api/health')
    await service.stop()
    expect(calls).toHaveLength(0)
  })

  it('reports an external origin that never answers as unreachable', async () => {
    const service = startCAStudioService(baseOptions({ mode: 'external', origin: 'http://[::1]:4317', probe: async () => undefined, spawn: fakeSpawn().spawn }))
    await expect(service.settled()).resolves.toMatchObject({ state: 'failed', reason: 'unreachable' })
  })

  it('rejects an origin the bridge would reject', () => {
    for (const origin of ['http://127.0.0.1:0', 'https://studio.example.com', 'file:///C:/']) {
      expect(() => startCAStudioService(baseOptions({ origin }))).toThrow()
    }
  })

  it('reports a missing service directory as unavailable', async () => {
    const { calls, spawn } = fakeSpawn()
    const service = startCAStudioService(baseOptions({ spawn, probe: async () => undefined, environment: { COSERVE_CASTUDIO_DIR: join(tempDir(), 'absent') } }))
    await expect(service.settled()).resolves.toMatchObject({ state: 'failed', reason: 'unavailable', detail: expect.stringContaining('service directory missing') })
    expect(calls).toHaveLength(0)
  })

  it('spawns the bundled node with piped stdio, an instance token, and a loopback proxy bypass', async () => {
    const serviceDirectory = serviceTree(tempDir())
    const harnessHome = tempDir()
    const { services, spawn } = fakeSpawn(new FakeChild())
    const service = startCAStudioService(baseOptions({
      probe: ownHealth(services), spawn, harnessHome,
      environment: {
        COSERVE_CASTUDIO_DIR: serviceDirectory,
        AWS_SECRET_ACCESS_KEY: 'secret',
        COSERVE_OTHER_SETTING: 'kept',
        NODE_OPTIONS: '--require evil',
        NODE_USE_ENV_PROXY: '1',
        NO_PROXY: 'intranet.local',
      },
    }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    const call = services()[0]!
    expect(call.file).toBe('/runtime/node')
    expect(call.args).toEqual(['--import', pathToFileURL(join(serviceDirectory, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, 'server/index.ts'])
    expect(call.options).toMatchObject({ cwd: serviceDirectory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const env = call.options.env as NodeJS.ProcessEnv
    expect(env).toMatchObject({
      STUDIO_PORT: '4317', STUDIO_DATA_DIR: join(harnessHome, 'castudio'), STUDIO_PARENT_PIPE: '1', ELECTRON_RUN_AS_NODE: '1',
      COSERVE_OTHER_SETTING: 'kept', NO_PROXY: 'intranet.local,127.0.0.1,localhost,::1,[::1]', no_proxy: 'intranet.local,127.0.0.1,localhost,::1,[::1]',
    })
    expect(env.STUDIO_INSTANCE).toMatch(/^[0-9a-f]{32}$/)
    for (const key of ['AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY']) expect(env[key]).toBeUndefined()
  })

  it('honors STUDIO_DATA_DIR and appends --dev only when dist/index.html is absent', async () => {
    const dataDirectory = join(tempDir(), 'custom-data')
    const { services, spawn } = fakeSpawn(new FakeChild())
    const service = startCAStudioService(baseOptions({
      probe: ownHealth(services), spawn,
      environment: { COSERVE_CASTUDIO_DIR: serviceTree(tempDir(), { dist: false }), STUDIO_DATA_DIR: dataDirectory },
    }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    expect(services()[0]!.args).toContain('--dev')
    expect((services()[0]!.options.env as NodeJS.ProcessEnv).STUDIO_DATA_DIR).toBe(dataDirectory)
  })

  it('resolves the default service directory under resourcesPath', async () => {
    const resources = tempDir()
    serviceTree(resources)
    const { services, spawn } = fakeSpawn(new FakeChild())
    const service = startCAStudioService(baseOptions({ probe: ownHealth(services), spawn, resourcesPath: resources, environment: {} }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    expect(services()[0]!.options.cwd).toBe(join(resources, 'castudio'))
  })

  it('never adopts a foreign CAStudio answering on the port, and kills its own child at the deadline', async () => {
    const child = new FakeChild()
    const { spawn } = fakeSpawn(child)
    const probe = vi.fn(async (): Promise<CAStudioHealth> => ({ ok: true, instance: 'stale-instance', pid: 99 }))
    const service = startCAStudioService(baseOptions({ probe, spawn }))
    await expect(service.settled()).resolves.toMatchObject({ state: 'failed', reason: 'timeout' })
    expect(probe.mock.calls.length).toBeGreaterThan(100)
    expect(child.stdinEnded).toBe(true)
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('keeps polling until its own instance answers', async () => {
    const { services, spawn } = fakeSpawn(new FakeChild())
    const own = ownHealth(services)
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementation(own)
    const service = startCAStudioService(baseOptions({ probe, spawn }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('retries once on the same port when CAStudio reports it taken (exit 76)', async () => {
    const { services, spawn } = fakeSpawn(new FakeChild({ exitAfterSpawn: 76 }), new FakeChild())
    const own = ownHealth(services)
    const probe = vi.fn(async () => services().length === 2 ? own() : undefined)
    const service = startCAStudioService(baseOptions({ probe, spawn }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    expect(services().map(call => (call.options.env as NodeJS.ProcessEnv).STUDIO_PORT)).toEqual(['4317', '4317'])
    const [first, second] = services().map(call => (call.options.env as NodeJS.ProcessEnv).STUDIO_INSTANCE)
    expect(first).not.toBe(second)
  })

  it('reports a port still taken after the retry, and a locked data directory without retrying', async () => {
    const busy = fakeSpawn(new FakeChild({ exitAfterSpawn: 76 }), new FakeChild({ exitAfterSpawn: 76 }))
    const portTaken = startCAStudioService(baseOptions({ probe: async () => undefined, spawn: busy.spawn }))
    await expect(portTaken.settled()).resolves.toMatchObject({ state: 'failed', reason: 'port-in-use' })
    expect(busy.services()).toHaveLength(2)

    const locked = fakeSpawn(new FakeChild({ exitAfterSpawn: 75 }))
    const dataLocked = startCAStudioService(baseOptions({ probe: async () => undefined, spawn: locked.spawn }))
    await expect(dataLocked.settled()).resolves.toMatchObject({ state: 'failed', reason: 'data-locked' })
    expect(locked.services()).toHaveLength(1)
  })

  it('reports an early exit with its code and stderr tail', async () => {
    const child = new FakeChild()
    const { spawn } = fakeSpawn(child)
    const log = vi.fn()
    const service = startCAStudioService(baseOptions({ probe: async () => undefined, spawn, log }))
    queueMicrotask(() => {
      child.stderr.write('module not found\n')
      child.emit('exit', 1, null)
    })
    await expect(service.settled()).resolves.toMatchObject({ state: 'failed', reason: 'exited', detail: expect.stringMatching(/code 1.*module not found/s) })
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('exited unexpectedly'))
  })

  it('reports an exit after readiness, restarts once automatically, then waits for a user restart', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    const { services, spawn } = fakeSpawn(...children)
    const service = startCAStudioService(baseOptions({ probe: ownHealth(services), spawn }))
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    const states = recordStatuses(service)
    children[0]!.emit('exit', 1, null)
    await vi.waitFor(() => expect(states).toEqual(['exited', 'starting', 'ready']))
    children[1]!.emit('exit', 1, null)
    await vi.waitFor(() => expect(service.status()).toMatchObject({ state: 'exited', reason: 'exited' }))
    expect(services()).toHaveLength(2)
    await service.restart()
    expect(service.status()).toEqual({ state: 'ready' })
    expect(services()).toHaveLength(3)
  })

  it('restarts a failed service on request', async () => {
    const { services, spawn } = fakeSpawn(new FakeChild({ exitAfterSpawn: 75 }), new FakeChild())
    const own = ownHealth(services)
    const service = startCAStudioService(baseOptions({ probe: async () => services().length === 2 ? own() : undefined, spawn }))
    await expect(service.settled()).resolves.toMatchObject({ state: 'failed', reason: 'data-locked' })
    const states = recordStatuses(service)
    await service.restart()
    expect(states).toEqual(['starting', 'ready'])
  })

  it('makes bridge requests wait while starting and fail with a typed error once failed', async () => {
    const pending = startCAStudioService(baseOptions({ probe: async () => undefined, spawn: fakeSpawn(new FakeChild({ exitAfterSpawn: 75 })).spawn }))
    expect(pending.status()).toEqual({ state: 'starting' })
    const error = await requireCAStudioReady(pending).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CAStudioUnavailableError)
    expect((error as CAStudioUnavailableError).status).toMatchObject({ state: 'failed', reason: 'data-locked' })
    expect((error as Error).message).toContain('data-locked')

    const { services, spawn } = fakeSpawn(new FakeChild())
    const ready = startCAStudioService(baseOptions({ probe: ownHealth(services), spawn }))
    await expect(requireCAStudioReady(ready)).resolves.toBeUndefined()
  })

  it('stops by closing stdin and never kills a child that exits on it', async () => {
    const child = new FakeChild({ onStdinEnd: 'exit' })
    const { services, spawn } = fakeSpawn(child)
    const service = startCAStudioService(baseOptions({ probe: ownHealth(services), spawn }))
    await service.settled()
    const first = service.stop()
    expect(service.stop()).toBe(first)
    await first
    expect(child.stdinEnded).toBe(true)
    expect(child.killed).toEqual([])
    expect(service.status()).toMatchObject({ state: 'failed', reason: 'stopped' })
  })

  it('escalates to SIGTERM and then SIGKILL when the child ignores stdin closure', async () => {
    const hung = new FakeChild()
    const one = fakeSpawn(hung)
    const service = startCAStudioService(baseOptions({ probe: ownHealth(one.services), spawn: one.spawn }))
    await service.settled()
    await service.stop()
    expect(hung.killed).toEqual(['SIGTERM', 'SIGKILL'])

    const graceful = new FakeChild({ onKill: 'exit' })
    const two = fakeSpawn(graceful)
    const second = startCAStudioService(baseOptions({ probe: ownHealth(two.services), spawn: two.spawn }))
    await second.settled()
    await second.stop()
    expect(graceful.killed).toEqual(['SIGTERM'])
  })

  it('kills the whole process tree through taskkill on Windows', async () => {
    const child = new FakeChild()
    const { calls, services, spawn } = fakeSpawn(child)
    const service = startCAStudioService(baseOptions({ probe: ownHealth(services), spawn, platform: 'win32' }))
    await service.settled()
    await service.stop()
    expect(calls.find(call => call.file === 'taskkill')?.args).toEqual(['/PID', String(child.pid), '/T', '/F'])
    expect(child.killed).toEqual(['SIGKILL'])
  })
})

describe('CAStudio service real process', () => {
  it('spawns a fake service, observes its instance, and the child exits when stdin closes', async () => {
    const serviceDirectory = serviceTree(tempDir())
    writeFileSync(join(serviceDirectory, 'server', 'index.ts'), [
      "import { createServer } from 'node:http'",
      'const port = Number(process.env.STUDIO_PORT)',
      'let probes = 0',
      '// Startup recovery answers 503 with the matching instance before the service is ready.',
      "createServer((request, response) => { const ready = ++probes > 2; response.statusCode = ready ? 200 : 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: ready, ready, instance: process.env.STUDIO_INSTANCE, pid: process.pid })) }).listen(port, '127.0.0.1')",
      "process.stdin.on('end', () => process.exit(0))",
      'process.stdin.resume()',
      '',
    ].join('\n'))
    const reservation = createServer()
    await new Promise<void>(resolveListen => reservation.listen(0, '127.0.0.1', resolveListen))
    const address = reservation.address()
    if (address === null || typeof address === 'string') throw new Error('Missing test port')
    await new Promise<void>(resolveClose => reservation.close(() => resolveClose()))
    const origin = `http://127.0.0.1:${address.port}`
    const service = startCAStudioService({
      origin,
      mode: 'self-managed',
      executable: process.execPath,
      environment: { ...process.env, COSERVE_CASTUDIO_DIR: serviceDirectory },
      harnessHome: tempDir(),
      log: () => {},
    })
    await expect(service.settled()).resolves.toEqual({ state: 'ready' })
    const alive = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })
    expect(alive.status).toBe(200)
    await service.stop()
    await expect(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  }, 30_000)
})
