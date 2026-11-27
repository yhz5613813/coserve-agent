import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultProjectsFolder, projectsFolderProblem, saveProjectsFolder } from '../src/projects-folder.ts'

const execPath = 'D:\\Tools\\Coserve\\app\\Coserve.exe'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('portable CAD project folder', () => {
  it('defaults to drive D: when it exists, otherwise the system drive', () => {
    expect(defaultProjectsFolder(path => path === 'D:\\Coserve CAD')).toBe('D:\\Coserve CAD')
    expect(defaultProjectsFolder(() => false, 'E:')).toBe('E:\\Coserve CAD')
    expect(defaultProjectsFolder(() => false)).toBe('C:\\Coserve CAD')
  })

  it.each([
    ['Projects', 'relative'],
    ['D:Projects', 'relative'],
    ['D:\\项目', 'non-ascii'],
    ['D:\\', 'drive-root'],
    ['\\\\server\\share', 'drive-root'],
    [`D:\\${'a'.repeat(78)}`, 'too-long'],
    ['D:\\Tools\\Coserve', 'install-directory'],
    ['d:\\tools\\coserve\\app\\projects', 'install-directory'],
    ['D:\\Tools', 'install-directory'],
  ] as const)('rejects %s as %s', (folder, problem) => {
    expect(projectsFolderProblem(folder, execPath)).toBe(problem)
  })

  it.each(['D:\\Coserve CAD', 'E:\\cad\\', 'D:\\Tools\\Coserve CAD', `D:\\${'a'.repeat(77)}`])('accepts %s', (folder) => {
    expect(projectsFolderProblem(folder, execPath)).toBeUndefined()
  })

  it('creates and records a valid folder, applies it, and restarts CAStudio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-'))
    roots.push(root)
    mkdirSync(join(root, 'install', 'app'), { recursive: true })
    const portableExec = join(root, 'install', 'app', 'Coserve.exe')
    const folder = join(root, 'cad')
    const environment: NodeJS.ProcessEnv = { STUDIO_PROJECTS_DIR: 'D:\\Coserve CAD' }
    const restart = vi.fn()
    expect(await saveProjectsFolder(folder, { execPath: portableExec, environment, restart })).toBeUndefined()
    expect(existsSync(folder)).toBe(true)
    expect(readFileSync(join(root, 'install', 'app', 'coserve-projects'), 'utf8')).toBe(folder)
    expect(environment.STUDIO_PROJECTS_DIR).toBe(folder)
    expect(restart).toHaveBeenCalledOnce()
  })

  it('keeps the previous folder without side effects for an invalid choice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-'))
    roots.push(root)
    const portableExec = join(root, 'install', 'app', 'Coserve.exe')
    const environment: NodeJS.ProcessEnv = { STUDIO_PROJECTS_DIR: 'D:\\Coserve CAD' }
    const restart = vi.fn()
    expect(await saveProjectsFolder(join(root, 'install', 'projects'), { execPath: portableExec, environment, restart })).toBe('install-directory')
    expect(existsSync(join(root, 'install'))).toBe(false)
    expect(environment.STUDIO_PROJECTS_DIR).toBe('D:\\Coserve CAD')
    expect(restart).not.toHaveBeenCalled()
  })
})
