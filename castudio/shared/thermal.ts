export type ThermalConfig = Record<string, unknown>;
export type ThermalRun = {
  id: string; source: string; sourceHash: string; units: 'mm' | 'cm' | 'm';
  createdAt: string; finishedAt?: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  executable: string; config: ThermalConfig; log: string; error?: string; revision?: string;
  progress?: { phase: string; progress: number; detail: string };
  files: { path: string; size: number; hash: string }[];
  result?: ThermalManifest; stale?: boolean; published?: string; publishedRevision?: string;
  preview?: ThermalPreview; previewError?: string;
  surfaceHash?: string;
};
export type ThermalManifest = {
  schema_version: 1; source_sha256: string; engine_version: string;
  result: { analysis_mode?: 'steady' | 'transient'; times_s: number[]; vertices: number; frames: number; minimum_C: number; maximum_C: number;
    stats: { time_s: number; minimum_C: number; maximum_C: number; average_C: number }[];
    summary: { warnings?: string[] }; };
};
export type ThermalProbe = { ok: boolean; executable: string; version?: string; message: string };

export type Vec3=[number,number,number];
export type SurfacePatch={center_m:Vec3;u_axis:Vec3;v_axis:Vec3;width_m:number;height_m:number};
export type ThermalSelection={kind:'point'|'embedded'|'face'|'rectangle';face?:number;center_m?:Vec3;width_m?:number;height_m?:number;u_axis?:Vec3;v_axis?:Vec3};
export type ThermalSurface={schema_version:1;source_sha256:string;surface_sha256:string;units:'m';kind:'step'|'stl';
  points:number[];faces:number[];face_groups:number[];bounds_m:[Vec3,Vec3];
  groups:{id:number;name:string;planar:boolean;normal:Vec3;u_axis:Vec3;v_axis:Vec3;center_m:Vec3;area_m2:number;triangles:number}[]};
export type ThermalSelectionResult={kind:ThermalSelection['kind'];faces:number[];descriptor:ThermalSelection;
  area_m2:number;position_m?:Vec3;center_m?:Vec3;surface_patch?:SurfacePatch;overlay_points?:number[];group?:number};
export type ThermalInspection={id:string;source:string;sourceHash:string;units:'mm'|'cm'|'m';createdAt:string;finishedAt?:string;
  state:'running'|'succeeded'|'failed'|'cancelled'|'interrupted';error?:string;log:string;stale?:boolean;
  surfaceHash?:string;fileHash?:string;progress?:{phase:string;progress:number;detail:string}};
export type ThermalEditorState={schema_version:1;inspectionId?:string;sourceHash?:string;surfaceHash?:string;
  sourceIds:string[];coolingIds:string[];selections:Record<string,ThermalSelection>;requireConfirmation?:boolean};
export type ThermalCatalog={version:string;schema:Record<string,unknown>;materials:Record<string,unknown>[]};

/** Saved, unfinished fields. Frame files are immutable and indexed only after their atomic write. */
export type ThermalPreview = {
  schema_version: 1; source_sha256: string; geometry_sha256: string;
  vertices: number; analysis_mode: 'steady' | 'transient';
  frames: {time_s: number; minimum_C: number; maximum_C: number; average_C: number; sha256: string}[];
};
