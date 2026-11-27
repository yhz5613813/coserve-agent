import type { Artifact } from '../../shared/types';

/**
 * `currentModel` is the part's current model resolved to a STEP path (undefined when the part has none). When given, it decides the automatic choice:
 * the published solver STEP beside it (a cylinder-object publish previews assembly.step next to cylinder.step), itself when it is a solver STEP, otherwise '' so the page explains why.
 */
export function chooseStructuralSource(files: Artifact[], current: string, publishedSource?: string, explicitlySelected = false, currentModel?: string): string {
  if (explicitlySelected) return current;
  const steps = files.filter(file => file.kind === 'model' && /\.step$/i.test(file.name) && !file.path.startsWith('structural/') && !file.path.startsWith('studio/cad-inspections/'));
  const folder = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
  if (currentModel !== undefined) {
    if (publishedSource && steps.some(file => file.path === publishedSource) && folder(publishedSource) === folder(currentModel)) return publishedSource;
    return steps.some(file => file.path === currentModel) ? currentModel : '';
  }
  if (publishedSource && steps.some(file => file.path === publishedSource)) return publishedSource;
  return current || steps[0]?.path || '';
}
