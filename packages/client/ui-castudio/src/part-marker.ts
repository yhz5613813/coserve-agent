/**
 * The `<cad-part>` marker a chosen part leaves in a logged user message, read the same way by the Client chip rule and
 * the Host `cadPart` projection.
 *
 * @module @deepseek-ai/dsh-client-ui-castudio/part-marker
 */

/** CAStudio part slug: `default` for the project root, otherwise a folder name under `parts/`. */
const PART_SLUG = /^(default|[a-z0-9]+(?:-[a-z0-9]+)*)$/

/**
 * Whether a value is a CAStudio part slug.
 * @param value - candidate slug.
 * @returns whether it is `default` or a kebab-case folder name of at most 40 characters.
 */
export function isPartSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && PART_SLUG.test(value)
}

/** The part a message continues, as its chip stores it and its marker carries it. */
export interface CadPartReference {
  projectId: string
  part: string
  name: string
  /** Workspace-relative folder of the part's files. */
  folder: string
}

/**
 * Read one serialized part reference.
 * @param ref - JSON text of the reference.
 * @returns the reference, or undefined for malformed or invalid JSON.
 */
export function readPartReference(ref: string): CadPartReference | undefined {
  let value: unknown
  try { value = JSON.parse(ref) } catch (_error) { return undefined /* A stale or malformed persisted reference is not a CAD part. */ }
  if (typeof value !== 'object' || value === null || !('projectId' in value) || !('part' in value) || !('name' in value) || !('folder' in value)) return undefined
  return typeof value.projectId === 'string' && isPartSlug(value.part) && typeof value.name === 'string' && typeof value.folder === 'string'
    ? { projectId: value.projectId, part: value.part, name: value.name, folder: value.folder } : undefined
}

/**
 * Find the first valid part marker at or after one offset.
 * @param text - user message text.
 * @param from - offset to search from.
 * @returns the marker span and its reference, or undefined when none follows.
 */
export function findPartMarker(text: string, from: number): { start: number; end: number; reference: CadPartReference } | undefined {
  const pattern = /<cad-part>(.*?)<\/cad-part>/gs
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const reference = readPartReference(match[1] ?? '')
    if (reference) return { start: match.index, end: match.index + match[0].length, reference }
  }
  return undefined
}
