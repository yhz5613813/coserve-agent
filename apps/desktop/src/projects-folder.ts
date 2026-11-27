/** Portable-build CAD project folder: default choice, validation, and the record beside the executable. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'

/** File beside the portable executable holding the chosen absolute project folder as UTF-8 text. */
export const PROJECTS_FOLDER_FILE = 'coserve-projects'

/** Reason a chosen folder cannot hold CAD projects. */
export type ProjectsFolderProblem = 'relative' | 'non-ascii' | 'drive-root' | 'too-long' | 'install-directory'

/**
 * Choose the portable default outside the user profile, because the Python/gmsh toolchain accepts only ASCII paths.
 * @param creatable - creates the folder if needed and reports success; a missing D:, an optical drive (with or without media) or a read-only volume reports false.
 * @param systemDrive - Windows `SystemDrive`, such as `C:`.
 * @returns `D:\Coserve CAD` when it can be created, otherwise `<systemDrive>\Coserve CAD`.
 */
export function defaultProjectsFolder(creatable: (folder: string) => boolean, systemDrive = 'C:'): string {
  return creatable('D:\\Coserve CAD') ? 'D:\\Coserve CAD' : `${systemDrive}\\Coserve CAD`
}

/**
 * Check a folder against the portable toolchain's path limits using Windows path rules.
 * @param folder - candidate folder.
 * @param execPath - portable executable inside `<install>\app\`; the install root must neither contain nor lie inside the folder.
 * @returns the first problem found, or undefined for a usable folder.
 */
export function projectsFolderProblem(folder: string, execPath: string): ProjectsFolderProblem | undefined {
  if (!win32.isAbsolute(folder)) return 'relative'
  if (!/^[\x20-\x7e]+$/.test(folder)) return 'non-ascii'
  const normalized = win32.normalize(folder)
  if (win32.parse(normalized).root === normalized) return 'drive-root'
  const path = normalized.replace(/\\+$/, '').toLowerCase()
  if (path.length > 80) return 'too-long'
  const install = win32.normalize(win32.dirname(win32.dirname(execPath))).replace(/\\+$/, '').toLowerCase()
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}\\`)
  if (within(path, install) || within(install, path)) return 'install-directory'
  return undefined
}

/**
 * Create, record, and apply a chosen folder; projects in the previous folder stay where they are.
 * @param folder - folder returned by the native picker.
 * @param options.execPath - portable executable; the record is written beside it.
 * @param options.environment - receives `STUDIO_PROJECTS_DIR` for later CAStudio starts.
 * @param options.restart - restarts the running CAStudio so it serves the new folder.
 * @returns the validation problem without side effects, or undefined once the folder applies; file-system failures reject.
 */
export async function saveProjectsFolder(
  folder: string,
  options: { readonly execPath: string; readonly environment: NodeJS.ProcessEnv; readonly restart: () => void },
): Promise<ProjectsFolderProblem | undefined> {
  const problem = projectsFolderProblem(folder, options.execPath)
  if (problem !== undefined) return problem
  await mkdir(folder, { recursive: true })
  await writeFile(join(dirname(options.execPath), PROJECTS_FOLDER_FILE), folder, 'utf8')
  options.environment.STUDIO_PROJECTS_DIR = folder
  options.restart()
  return undefined
}
