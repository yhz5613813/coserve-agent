import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { allocateCAStudioOrigin, configureBundledRuntime } from '../src/castudio-service.ts'
import { caStudioOrigin } from '../src/castudio-transport.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const THERMAL = ['thermal/python/python.exe', 'thermal/engine/.keep', 'thermal/cuda/bin/.keep']

function install(parts: readonly string[]): { runtime: string; data: string; service: string } {
  const root = mkdtempSync(join(tmpdir(), 'castudio-runtime-'))
  roots.push(root)
  for (const part of parts) {
    mkdirSync(join(root, 'runtime', part, '..'), { recursive: true })
    writeFileSync(join(root, 'runtime', part), '')
  }
  const service = join(root, 'castudio')
  mkdirSync(join(service, 'resources', 'structural-sim'), { recursive: true })
  return { runtime: join(root, 'runtime'), data: join(root, 'data'), service }
}
const read = (data: string, name: string): unknown => JSON.parse(readFileSync(join(data, name), 'utf8'))
const noGpu = (): boolean => false

it('writes auto records for the unpacked Windows runtime and keeps a user record whose executable exists', () => {
  const { runtime, data, service } = install(['python/python.exe', 'calculix/ccx.exe', ...THERMAL])
  const env = configureBundledRuntime(runtime, data, service, 'win32', { Path: 'C:\\Windows' }, noGpu)
  const python = join(runtime, 'python', 'python.exe')
  expect(read(data, 'runtime.json')).toEqual({ executable: python, auto: true })
  expect(read(data, 'parametric-runtime.json')).toEqual({ python, auto: true })
  expect(read(data, 'structural-runtime.json')).toEqual({ python, reportPython: python, packageRoot: join(service, 'resources', 'structural-sim'), solver: join(runtime, 'calculix', 'ccx.exe'), auto: true })
  expect(read(data, 'thermal-runtime.json')).toEqual({ executable: join(runtime, 'thermal', 'python', 'python.exe'), device: 'cpu', auto: true })
  expect(env.Path).toBe(`${join(runtime, 'thermal', 'cuda', 'bin')};C:\\Windows`)
  expect(env.COSERVE_THERMOFORGE_ROOT).toBe(join(runtime, 'thermal', 'engine'))

  const user = { executable: join(runtime, 'calculix', 'ccx.exe') }
  writeFileSync(join(data, 'runtime.json'), JSON.stringify(user))
  configureBundledRuntime(runtime, data, service, 'win32', {}, noGpu)
  expect(read(data, 'runtime.json')).toEqual(user)
})

it('recomputes the thermal device of an auto record on every start', () => {
  const { runtime, data, service } = install(['python/python.exe', ...THERMAL])
  configureBundledRuntime(runtime, data, service, 'win32', {}, () => true)
  expect(read(data, 'thermal-runtime.json')).toMatchObject({ device: 'cuda', auto: true })
  configureBundledRuntime(runtime, data, service, 'win32', {}, noGpu)
  expect(read(data, 'thermal-runtime.json')).toMatchObject({ device: 'cpu', auto: true })
})

it('deletes an auto record whose bundled component is gone and never puts the core python on PATH', () => {
  const { runtime, data, service } = install(['python/python.exe', 'calculix/ccx.exe', ...THERMAL])
  configureBundledRuntime(runtime, data, service, 'win32', {}, noGpu)
  rmSync(join(runtime, 'thermal'), { recursive: true })
  rmSync(join(runtime, 'calculix'), { recursive: true })
  const env = configureBundledRuntime(runtime, data, service, 'win32', { Path: 'C:\\Windows' }, noGpu)
  expect(existsSync(join(data, 'thermal-runtime.json'))).toBe(false)
  expect(existsSync(join(data, 'structural-runtime.json'))).toBe(false)
  expect(env.STUDIO_THERMAL_PYTHON).toBeUndefined()
  expect(env.Path).toBeUndefined()
})

it('replaces a user record naming a missing executable, deletes it without a bundle, and ignores non-Windows runtimes', () => {
  const { runtime, data, service } = install(['python/python.exe'])
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'parametric-runtime.json'), JSON.stringify({ python: 'D:\\old\\python.exe' }))
  writeFileSync(join(data, 'thermal-runtime.json'), JSON.stringify({ executable: 'D:\\old\\thermal.exe' }))
  configureBundledRuntime(runtime, data, service, 'win32', {}, noGpu)
  expect(read(data, 'parametric-runtime.json')).toEqual({ python: join(runtime, 'python', 'python.exe'), auto: true })
  expect(existsSync(join(data, 'thermal-runtime.json'))).toBe(false)
  expect(configureBundledRuntime(runtime, data, service, 'darwin', {}, noGpu)).toEqual({})
  expect(configureBundledRuntime(join(runtime, 'missing'), data, service, 'win32', {}, noGpu)).toEqual({})
})

it('moves off a busy preferred port', async () => {
  const busy = createServer()
  await new Promise<void>((resolve) => { busy.listen({ host: '127.0.0.1', port: 0 }, resolve) })
  const address = busy.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const origin = new URL(await allocateCAStudioOrigin(port))
    expect(origin.hostname).toBe('127.0.0.1')
    expect(origin.port).not.toBe(String(port))
  } finally {
    await new Promise<void>((resolve) => { busy.close(() => resolve()) })
  }
})

it('accepts the loopback hosts external mode allows and rejects port 0', () => {
  expect(caStudioOrigin('http://localhost:4317/')).toBe('http://localhost:4317')
  expect(caStudioOrigin('http://[::1]:4317')).toBe('http://[::1]:4317')
  expect(caStudioOrigin('https://127.0.0.1:8443')).toBe('https://127.0.0.1:8443')
  expect(() => caStudioOrigin('http://127.0.0.1:0')).toThrow()
})
