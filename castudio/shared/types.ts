/** A part record carries `parentId` (its root project) and `slug`; its workspace is `<root workspace>/parts/<slug>`. */
export type Project = { id: string; name: string; createdAt: string; updatedAt: string; sessionFile?: string; parentId?: string; slug?: string };
/** Latest run of a simulation service: queued/running → 'running', failed/interrupted → 'failed'; no run or a cancelled latest run → absent. */
export type PartRunStatus = 'succeeded' | 'failed' | 'running';
/**
 * `default` is the root project itself (id = root id); other parts are addressed by their own record id.
 * GET /api/projects/:root/parts adds the optional status fields, read from files the services already write:
 * `updatedAt` (ISO) is the later of the record's `updatedAt` and its history index mtime; `published` is true when the part has a
 * parametric publication (parametric/published.json) or any CAD STEP file; `structural` / `thermal` are the state of the latest run.
 */
export type Part = { id: string; slug: string; name: string; updatedAt?: string; published?: boolean; structural?: PartRunStatus; thermal?: PartRunStatus };
/**
 * `assembly.json` at a part's workspace root. Each component places one CAD file (STEP/GLB/STL) of part `part` (slug; `default` is the root)
 * at `position` (mm) and `rotation` (degrees, applied X then Y then Z). `visible: false` keeps the component in the file but out of the viewer.
 */
export type AssemblyComponent = { id: string; part: string; path: string; name?: string; position: [number, number, number]; rotation: [number, number, number]; visible?: boolean };
export type Assembly = { version: 1; components: AssemblyComponent[] };
/** GET /api/projects/:id/assembly: `etag` is the SHA-256 of the file text ('' when absent); each component carries the cross-part file `url`, and `missing` names why the referenced file cannot be read. */
export type AssemblyView = { version: 1; exists: boolean; etag: string; components: (AssemblyComponent & { url: string; missing?: string })[] };
export type RuntimeProbe = { executable: string; python: boolean; version?: string; platform?: string; cadflow: boolean; cadflowVersion?: string; message: string; checkedAt: string };
export type BuildRun = { id: string; source: string; sourceHash: string; parameters?: import('./parameters').BuildParameters; executable: string; engine?: 'cadflow' | 'gmsh'; createdAt: string; finishedAt?: string; state: 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; log: string; truncated: boolean; exitCode?: number | null; error?: string; revision?: string; artifacts: { path: string; size: number; hash: string }[]; published?: string; publishedRevision?: string };
export type ArtifactCategory = 'cad' | 'source' | 'import' | 'simulation' | 'report' | 'system' | 'other';
/** `detail` distinguishes same-named files: parent folder with run ids shortened to 8 characters, `导入 <id>` for imports, '' at the workspace root. */
export type Artifact = { path: string; name: string; size: number; modified: number; kind: 'model' | 'source' | 'image' | 'file'; category: ArtifactCategory; detail: string };
export type ReviewAnchor = { file: string; sourceHash: string; profile: string; meshKey: string; name: string; kind: 'component' | 'step-face' | 'triangle'; faceIndex?: number; triangleIndex?: number; nodeId?: string; definitionId?: string; bounds: number[]; units?: 'mm' };
export type ReviewNote = { id: string; anchor: ReviewAnchor; text: string; intent: 'inspect' | 'dimension' | 'hole' | 'fillet' | 'assembly'; status: 'open' | 'resolved'; priority: 'normal' | 'important'; createdAt: string; updatedAt: string };
export type ReviewDocument = { schemaVersion: 1; notes: ReviewNote[]; etag: string };
export type RevisionKind = 'manual' | 'before-save' | 'after-save' | 'before-agent' | 'after-agent' | 'before-import' | 'after-import' | 'before-restore' | 'after-restore';
export type Revision = { id: string; label: string; kind: RevisionKind; createdAt: string; files: number; bytes: number; fingerprint: string };
export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted'; beforeSize: number; afterSize: number };
export type RevisionComparison = { revision: Revision; fingerprint: string; changes: FileChange[]; models: { path: string; size: number }[] };
export type RevisionFileDiff = { path: string; before: string | null; after: string | null; binary: boolean; truncated: boolean };
export type Plugin = { id: string; name: string; description: string; source: string; revision: string; installedAt: string; enabled: boolean; skills: { name: string; description: string; path: string }[] };
export type Message = { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; timestamp: number; toolName?: string; args?: unknown; error?: boolean };
export type StudioEvent = { id: number; type: string; data: Record<string, unknown> };
export type ModelOption = { provider: string; id: string; name: string; reasoning: boolean; input: ('text' | 'image')[] };
export type ProviderProbe = { ok: boolean; message?: string; ms?: number };
export type ProviderProbes = { text: ProviderProbe; image: ProviderProbe; reasoning: ProviderProbe };
export type ProviderConnection = ProviderProbes & { ok: true; registered: { input: ('text' | 'image')[]; reasoning: boolean; thinking: Settings['thinking'] } };
export type Settings = { provider: string; model: string; thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
export type ChatGPTLogin = { id?: string; phase: 'idle' | 'starting' | 'waiting' | 'verifying' | 'success' | 'error' | 'cancelled'; message?: string; verificationUrl?: string; userCode?: string; expiresAt?: number; authenticated?: boolean };
export type Status = { pi: string; platform: string; models: ModelOption[]; settings: Settings; hasCredentials: boolean; cadPlatformSupported: boolean; busyProjects: string[] };
