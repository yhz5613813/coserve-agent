import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { isAbsoluteWorkspacePath, parseFileAddress, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectForWorkspace, type CadOpenTarget, type CadProject } from './cad-controller.ts'

/** Tab type id of the redirect that sends CAD files from the file tree to the CAD workspace. */
export const CAD_VIEWER_ID = '@deepseek-ai/dsh-client-ui-castudio/cad-viewer'

/** File names the CAD workbench can show (STEP, meshes, and CATIA files it converts). */
const CAD_PATTERNS = ['*.step', '*.stp', '*.stl', '*.glb', '*.gltf', '*.obj', '*.CATPart', '*.CATProduct']

/**
 * Resolve a file address to the CAD project file it names.
 * @param address - a `dsh-resource://file/…` address.
 * @param cwdOf - the working directory of a Session id, when that Session is known.
 * @param projects - the CAD projects; a project owns the Sessions rooted in its workspace.
 * @returns the project, part and part-relative path, or `undefined` for an address that names no file inside a CAD project's workspace.
 */
export function cadOpenTarget(
  address: string, cwdOf: (sessionId: SessionId) => string | undefined, projects: readonly CadProject[],
): CadOpenTarget | undefined {
  const parsed = parseFileAddress(address)
  if (parsed?.scope !== 'session') return undefined
  // The address is a string boundary: its id segment is the Session id it names.
  const project = projectForWorkspace(projects, cwdOf(parsed.sessionId as SessionId))
  if (project === undefined) return undefined
  const relative = relativizeToCwd(parsed.path, project.workspacePath.replaceAll('\\', '/'))
  if (isAbsoluteWorkspacePath(relative)) return undefined
  const [top, slug, ...rest] = relative.split('/')
  return top === 'parts' && slug && rest.length > 0 ? { projectId: project.id, part: slug, path: rest.join('/') } : { projectId: project.id, path: relative }
}

/**
 * The tab type that claims CAD files for sessions inside a CAD project; every other file keeps its ordinary preview.
 * @param target - resolves an address to its CAD project file, as `cadOpenTarget` does for the live Sessions and projects.
 * @param title - the tab chip text.
 * @returns the type registration; its body redirects to the CAD tab.
 */
export function cadViewerDefinition(
  target: (address: string) => CadOpenTarget | undefined, title: () => string,
): SidebarRightTabDefinition {
  return { id: CAD_VIEWER_ID, kind: 'cad-viewer', patterns: CAD_PATTERNS, canOpen: address => target(address) !== undefined, title }
}
