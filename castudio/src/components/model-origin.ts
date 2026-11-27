import type { Artifact } from '../../shared/types';
import { choosePreview } from '../scene/preview-file';

/**
 * Where the current model came from, judged from the layouts the server writes:
 * `notebook` — a parametric publish (parametric/exports/<rid>/, never its frozen source/ copy);
 * `script` — a saved build (builds/<run>/ with its studio-build-manifest.json; Python CAD, Gmsh and optimizer builds all land there);
 * `imported` — an upload under imports/; `other` — anything else (files written directly, cylinder objects, assemblies).
 */
export type ModelOrigin = 'notebook' | 'script' | 'imported' | 'other';
export const originLabels: Record<ModelOrigin, string> = { notebook: '参数化程序', script: '脚本生成', imported: '导入', other: '其他来源' };

export function modelOrigin(path: string, filePaths: string[]): ModelOrigin {
  if (/^parametric\/exports\/[^/]+\/(?!source\/)/.test(path)) return 'notebook';
  const build = /^builds\/[^/]+\//.exec(path);
  if (build && filePaths.includes(`${build[0]}studio-build-manifest.json`)) return 'script';
  if (path.startsWith('imports/')) return 'imported';
  return 'other';
}

/** The current model of a part: the file open in the viewer, otherwise the file the viewer would open first. */
export function currentModel(asset: Artifact | null, files: Artifact[]): Artifact | undefined {
  return asset ?? choosePreview(files);
}

/** The simulation input for `model`: the model itself when `accept` matches it, else a same-stem sibling that matches (a publish's .scadpkg/.stl beside its .step); otherwise the model path, which the caller reports as incompatible. */
export function simulationInput(model: string, files: Artifact[], accept: RegExp): string {
  if (accept.test(model)) return model;
  const stem = model.replace(/\.[^./]+$/, '');
  return files.find(file => accept.test(file.path) && file.path.replace(/\.[^./]+$/, '') === stem)?.path ?? model;
}
