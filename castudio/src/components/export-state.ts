import type { Artifact } from '../../shared/types';
import type { CadConverterStatus, UploadResult } from '../api';

export type ExportId = 'original' | 'glb' | 'stl' | 'obj' | 'step' | 'CATPart' | 'CATProduct';
/** `save` is false when the file already lives in the project (the original). `reason` explains a disabled item. */
export type ExportOption = { id: ExportId; label: string; enabled: boolean; reason?: string; save: boolean };

const stepName = /\.(step|stp)$/i, catiaName = /\.(CATPart|CATProduct)$/i;
const dirOf = (file: string) => file.slice(0, file.lastIndexOf('/') + 1);
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');
export const revisionPattern = /^V5-6R20\d\d$/;

/** The STEP file the shown model can be exported from: the model itself, or the STEP beside it (builds/<id>, parametric/exports/<rid>, imports/<id>/converted). */
export function findStepSource(asset: Artifact | null, files: Artifact[]): Artifact | undefined {
  if (!asset) return undefined;
  if (stepName.test(asset.name)) return asset;
  const beside = files.filter(f => stepName.test(f.name) && dirOf(f.path) === dirOf(asset.path));
  return beside.find(f => stemOf(f.name) === stemOf(asset.name)) ?? beside.find(f => f.name.toLowerCase() === 'model.step') ?? (beside.length === 1 ? beside[0] : undefined);
}

function catiaReason(format: 'CATPart' | 'CATProduct', step: Artifact | undefined, converter: CadConverterStatus | null) {
  if (!step) return '没有 STEP 源文件（网格模型不能导出为 STEP）';
  if (!converter) return '正在检测 CATIA 转换器…';
  if (!converter.installed) return '未安装 CATIA 转换器';
  if (converter.code) return `CATIA 转换器不可用：${converter.message ?? converter.code}`;
  if (!converter.write) return '转换器缺少写入授权';
  if (converter.formats?.length && !converter.formats.some(f => f.toLowerCase() === format.toLowerCase())) return `转换器不支持 ${format}`;
  return undefined;
}

/** Export items for the shown model. `visibleMeshes` is the number of visible meshes in the viewer; `converter` is null while the status is unknown. */
export function exportOptions({ asset, files, converter, visibleMeshes }: { asset: Artifact | null; files: Artifact[]; converter: CadConverterStatus | null; visibleMeshes: number }): { step?: Artifact; options: ExportOption[] } {
  // An assembly has no single STEP source (no kernel path combines components yet); mesh exports cover its visible components.
  const assembly = asset?.path === 'assembly.json' ? '装配暂不支持 STEP 导出' : undefined;
  const step = assembly ? undefined : findStepSource(asset, files);
  const noModel = asset ? undefined : '没有打开的模型';
  const mesh = (id: 'glb' | 'stl' | 'obj', label: string): ExportOption => { const reason = noModel ?? (visibleMeshes > 0 ? undefined : '没有可见的网格'); return { id, label, enabled: !reason, reason, save: true }; };
  const catia = (id: 'CATPart' | 'CATProduct', label: string): ExportOption => { const reason = noModel ?? assembly ?? catiaReason(id, step, converter); return { id, label, enabled: !reason, reason, save: true }; };
  const stepReason = noModel ?? assembly ?? (step ? undefined : '网格模型不能导出为 STEP');
  return { step, options: [
    { id: 'original', label: '下载原文件', enabled: !noModel, reason: noModel, save: false },
    mesh('glb', 'GLB（二进制 glTF）'), mesh('stl', 'STL（二进制）'), mesh('obj', 'OBJ'),
    { id: 'step', label: 'STEP', enabled: !stepReason, reason: stepReason, save: true },
    catia('CATPart', 'CATPart'), catia('CATProduct', 'CATProduct'),
  ] };
}

/** A .CATPart/.CATProduct uploaded to imports/<id>/ (zip packages are shown as models and excluded). */
export const isCatiaOriginal = (file: Artifact) => file.kind === 'file' && file.category === 'import' && catiaName.test(file.name) && file.path.split('/').length === 3;
/** The converted STEP of a CATIA original, when it exists in the file list. */
export const convertedStep = (original: Artifact, files: Artifact[]) => files.find(f => f.path === `${dirOf(original.path)}converted/model.step`);

/** Short Chinese toast for an upload response, including the CATIA conversion outcome. */
export function uploadNotice(result: UploadResult) {
  const head = result.duplicate ? `${result.name} 之前已导入过` : `已导入 ${result.name}`, c = result.conversion;
  if (!c) return result.duplicate ? `${head}，已打开已有副本` : head;
  if (c.state === 'done') return `${head}，已转换为 STEP`;
  if (c.state === 'unavailable') return `${head}，但未安装 CATIA 转换器，暂不能预览`;
  if (c.state === 'no-read-license') return `${head}，但转换器缺少读取授权，暂不能预览`;
  const detail = c.message.trim().split('\n')[0];
  return `${head}，但转换失败：${detail.length > 80 ? `${detail.slice(0, 80)}…` : detail}`;
}
/** Path App should open after an upload: the converted STEP for a converted CATIA file, otherwise the uploaded file. */
export const uploadOpenPath = (result: UploadResult) => result.conversion?.state === 'done' && result.conversion.step ? result.conversion.step : result.path;
