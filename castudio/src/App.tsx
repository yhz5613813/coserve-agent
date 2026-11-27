import { choosePreview } from './scene/preview-file';
import { readHostTheme } from './host-theme';
import type { CSSProperties } from 'react';
import { ConversationMessages } from './components/ConversationMessages';
import { ParametricPanel } from './components/ParametricPanel';
import { CylinderObjectsPanel } from './components/CylinderObjectsPanel';
import { cylinderMeshId } from './scene/cylinder-selection';
import { StructuralPanel } from './components/StructuralPanel';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelLeft, PanelRight, Wrench, SlidersHorizontal, FlaskConical, Thermometer, ArrowDownToLine, ArrowUp, Box, Boxes, Braces, Camera, Check, ChevronDown, ChevronRight, Circle, CircleDot, Columns2, Crosshair, Download, Eye, EyeOff, FileCode2, FilePlus2, FileText, FolderOpen, Grid2X2, History, Layers3, LoaderCircle, Maximize, MessageSquare, Minus, MousePointer2, Package, PanelBottom, Pencil, Play, Plus, Rotate3d, Save, ScanLine, Scissors, Settings2, Square, Terminal, Upload, Workflow, X } from 'lucide-react';
import type { Artifact, BuildRun, Message, Part, Plugin, Project, Status, StudioEvent } from '../shared/types';
import { api, request as apiRequest } from './api';
import { Viewport, type ViewportHandle } from './components/Viewport';
import { applyViewportCommand, buildViewportState, type ViewportBridgeDeps, type ViewportCommandResult } from './viewport-bridge';
import type { ViewportCommand, ViewportPanel, ViewportPart } from '../shared/viewport';
import { PartSwitcher } from './components/PartSwitcher';
import { AssemblyPanel } from './components/AssemblyPanel';
import { BrandIcon } from './components/BrandIcon';
import { ModelTree } from './components/ModelTree';
import { ReviewPanel } from './components/ReviewPanel';
import { ThermalPanel } from './components/ThermalPanel';
import { BuildPanel } from './components/BuildPanel';
import { MeasurementPanel } from './components/MeasurementPanel';
import { CadInspectionPanel } from './components/CadInspectionPanel';
import type { ReviewNote } from '../shared/types';
import type { PreviewState } from './scene/review-selection';
import { SceneInspector } from './components/SceneInspector';
import type { PackageInfo } from './scene/package';
import { HistoryDialog } from './components/HistoryDialog';
import { SelectionProperties } from './components/SelectionProperties';
import { SourceEditor } from './components/SourceEditor';
import { Dialog, PluginDialog, SettingsDialog } from './components/Dialogs';
import type { MeshInfo, Selection, ViewOptions } from './scene/renderer';
import { LayoutPresetMenu, WorkbenchPanels } from './components/WorkbenchPanels';
import { FilePanel, fileLabel, uploadNotice, uploadOpenPath } from './components/FilePanel';
import { ExportMenu } from './components/ExportMenu';
import { ViewOptionsMenu } from './components/ViewOptionsMenu';
import { Popover, PopoverItem } from './components/Popover';
import { currentModel, modelOrigin, originLabels, simulationInput } from './components/model-origin';
import { expandPanel, loadLayout, saveLayout, sourceLinkFor, togglePanel, type PanelId } from './workbench-layout';

const initialOptions: ViewOptions = { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' };
const sizeLabel = (bytes: number) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) { return <button className={`tool-button ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button>; }
export default function App() {
  const [embedding] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return { enabled: query.get('embedded') === '1', nativeHarness: query.get('harness') === 'dsh', projectId: query.get('project'), client: query.get('client'), theme: query.get('theme') === 'dark' ? 'dark' : 'light', locale: query.get('locale') };
  });
  // Workbench copy is Chinese only for now; the host locale still sets the document language for fonts and assistive tech.
  useEffect(() => { if (embedding.locale) document.documentElement.lang = embedding.locale; }, [embedding.locale]);
  const [projectError, setProjectError] = useState('');
  const [requestedPart, setRequestedPart] = useState<string | null>(null);
  const [embeddedTheme, setEmbeddedTheme] =useState<'light' | 'dark'>(embedding.theme === 'dark' ? 'dark' : 'light');
  const [hostTheme, setHostTheme] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!embedding.enabled) return;
    const onHostMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || window.parent === window || event.data?.projectId !== embedding.projectId) return;
      const parentOrigin = document.referrer ? new URL(document.referrer).origin : 'null';
      if (parentOrigin !== 'null' && event.origin !== parentOrigin) return;
      if (event.data?.type === 'castudio:theme' && ['light', 'dark'].includes(event.data.theme)) {
        setEmbeddedTheme(event.data.theme);
        setHostTheme(readHostTheme(event.data.tokens));
      }
      // The host's session turn is the only agent run under DSH; while it runs, sources are read-only here.
      if (event.data?.type === 'castudio:busy' && typeof event.data.busy === 'boolean') setBusy(event.data.busy);
      // A file opened from the host's file tree: `path` is relative to the part workspace, `part` omitted for the default part.
      if (event.data?.type === 'castudio:open' && typeof event.data.path === 'string' && (event.data.part === undefined || typeof event.data.part === 'string')) {
        void viewportDepsRef.current().openModel(event.data.path, event.data.part ?? 'default').then(error => { if (error) notify(error); });
      }
      // A part chosen in the host without a model file: switch to the part only.
      if (event.data?.type === 'castudio:open' && event.data.path === undefined && typeof event.data.part === 'string') setRequestedPart(event.data.part);
    };
    window.addEventListener('message', onHostMessage);
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : 'null';
    window.parent.postMessage({ type: 'castudio:ready', projectId: embedding.projectId }, parentOrigin === 'null' ? '*' : parentOrigin);
    return () => window.removeEventListener('message', onHostMessage);
  }, [embedding.enabled, embedding.projectId]);
  const [structuralSource,setStructuralSource]=useState('');
  const [publishedStructuralSource, setPublishedStructuralSource] = useState('');
  const [structuralSourceRequest, setStructuralSourceRequest] = useState(0);
  type Workspace = 'model' | 'parametric' | 'structural' | 'thermal';
  const [workspaceMode, setWorkspaceMode] = useState<Workspace>('model');
  const [visited, setVisited] = useState<Workspace[]>(['model']);
  const [sidebarOpen, setSidebarOpen] = useState(() => !embedding.enabled && window.innerWidth >= 760);
  const [assistantOpen, setAssistantOpen] = useState(() => !embedding.enabled && window.innerWidth >= 1200);
  const openWorkspace = (mode: Workspace) => {
    setWorkspaceMode(mode); setVisited(old => old.includes(mode) ? old : [...old, mode]);
    if (window.innerWidth < 760) setSidebarOpen(false);
  };
  const workspaceTitle = {model:'模型', parametric:'参数', structural:'结构仿真', thermal:'热仿真'}[workspaceMode];
  // `rootProject` is the CAD project (one per DSH workspace); `project` is the part being worked on, the root itself for `default`.
  const [rootProject, setRootProject] = useState<Project | null>(null), [parts, setParts] = useState<Part[]>([]);
  const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project | null>(null), [status, setStatus] = useState<Status | null>(null), [plugins, setPlugins] = useState<Plugin[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]), [messages, setMessages] = useState<Message[]>([]), [busy, setBusy] = useState(false), [draft, setDraft] = useState('');
  const [asset, setAsset] = useState<Artifact | null>(null), [reference, setReference] = useState<(Artifact & { revision?: string; revisionLabel?: string }) | null>(null), [comparison, setComparison] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null), [pendingReview, setPendingReview] = useState<ReviewNote | null>(null), [reviewRevision, setReviewRevision] = useState(0);
  const [scenePackage, setScenePackage] = useState<PackageInfo | null>(null);
  const [cylinderObjectsOpen, setCylinderObjectsOpen] = useState(false);
  /** The assembly panel shows beside the viewer while assembly.json is open, until dismissed. */
  const [assemblyOpen, setAssemblyOpen] = useState(true);
  /** Reloads the root's part list (with statuses); set by the root event stream. */
  const refreshParts = useRef<() => void>(() => {});
  const [cylinderObjectsVisited, setCylinderObjectsVisited] = useState(false);
  const [cylinderSelectedId, setCylinderSelectedId] = useState('skin');
  const cylinderSelectedRef = useRef('skin');
  const cylinderPanelPreference = useRef<boolean | null>(null);
  const requestedPreview = useRef<{ projectId: string; path: string } | null>(null);
  /** A model to show once the part switch it waits for has reset the page. */
  const pendingOpen = useRef<{ projectId: string; path: string } | null>(null);
  const openProject = (next: Project) => { setProject(next); setRootProject(next); setParts([]); };
  const partRecord = (root: Project, part: Part): Project => part.slug === 'default' ? root : { ...root, id: part.id, name: part.name, parentId: root.id, slug: part.slug };
  const currentPart: ViewportPart = project?.slug ? { slug: project.slug, name: project.name } : { slug: 'default', name: parts[0]?.name ?? '默认零件' };
  const [meshes, setMeshes] = useState<MeshInfo[]>([]), [selection, setSelection] = useState<Selection | null>(null), [options, setOptions] = useState(initialOptions);
  const [dialog, updateDialog] = useState<'plugins' | 'settings' | 'new' | 'projects' | 'rename' | 'resources' | 'history' | 'scene' | 'reviews' | 'builds' | 'structural' | 'parametric' | 'thermal' | 'measurements' | null>(null), [newName, setNewName] = useState(''), [toast, setToast] = useState('');
  const [geometryTab, setGeometryTab] = useState<'cad' | 'mesh'>('cad');
  const [layout, setLayout] = useState(loadLayout), [propertiesTab, setPropertiesTab] = useState<'properties' | 'activity'>('properties');
  useEffect(() => saveLayout(layout), [layout]);
  /** Brings one of the model page's panels into view (expanded) without moving the others. */
  const setDock = (panel: 'files' | 'source' | 'properties' | 'activity') => {
    const id: PanelId = panel === 'source' ? 'editor' : panel === 'activity' ? 'properties' : panel;
    if (panel === 'activity' || panel === 'properties') setPropertiesTab(panel);
    setLayout(old => expandPanel(old, id));
  };
  const [linkedSource, setLinkedSource] = useState<{ model: string; source: string; hash?: string } | null>(null);
  const [treeTab, setTreeTab] = useState<'model' | 'files'>('model');
  const [sourcePath, setSourcePath] = useState(''), [sourceText, setSourceText] = useState(''), [savedText, setSavedText] = useState(''), [sending, setSending] = useState(false);
  const view = useRef<ViewportHandle>(null), referenceView = useRef<ViewportHandle>(null), upload = useRef<HTMLInputElement>(null), chatEnd = useRef<HTMLDivElement>(null);
  const currentProject = useRef<string>(''), assetRef = useRef<Artifact | null>(null); assetRef.current = asset;
  const projectEpoch = useRef(0), fileRequest = useRef(0), appliedFileRequest = useRef(0);
  const viewportLive = useRef<{ workspace: Workspace; modelPath: string | null; demo: boolean; preview: PreviewState | null; previewCurrent: boolean; meshes: MeshInfo[]; selection: Selection | null; options: ViewOptions; part?: ViewportPart }>({ workspace: 'model', modelPath: null, demo: true, preview: null, previewCurrent: false, meshes: [], selection: null, options: initialOptions });
  const handledViewportCommands = useRef<Set<string>>(new Set()), viewportCommandQueue = useRef<Promise<void>>(Promise.resolve());
  const notify = (text: string) => setToast(text);
  const postWorkspaceMessage = useCallback((type: 'castudio:selection' | 'castudio:draft' | 'castudio:settings-changed', data: Record<string, unknown>) => {
    if (!embedding.enabled || !project || window.parent === window) return;
    // Electron file origins are opaque; the host checks this frame's source, origin and project.
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : 'null';
    // The host knows the root project only; the part travels inside the selection.
    window.parent.postMessage({ type, projectId: project.parentId ?? project.id, ...data }, parentOrigin === 'null' ? '*' : parentOrigin);
  }, [embedding.enabled, project?.id, project?.parentId]);
  // Selecting geometry only changes the viewer; the conversation gets a reference when the user asks for one.
  const quoteSelection = () => { if (selection && asset) postWorkspaceMessage('castudio:selection', { selection: { ...selection, file: asset.path, part: currentPart.slug } }); };
  const appendConversationContext = (text: string) => {
    if (embedding.enabled) {
      postWorkspaceMessage('castudio:draft', { text, selection: selection && asset ? { ...selection, file: asset.path, part: currentPart.slug } : null });
    } else {
      setDraft(old => old ? `${old}\n\n${text}` : text);
      setAssistantOpen(true);
    }
  };
  const parameterEdits = useRef({ dirty: false, working: false });
  const trackParameterEdits = useCallback((state: { dirty: boolean; working: boolean }) => { parameterEdits.current = state; }, []);
  const thermalUnsaved = useRef(false);
  /** What a part switch would lose, as a phrase; empty when nothing is unsaved. Switching remounts every page, so the source, the thermal case and build parameters all go. */
  const unsavedWork = () => [sourceText !== savedText && '源码', thermalUnsaved.current && '热仿真工况', parameterEdits.current.dirty && '构建参数'].filter(Boolean).join('、');
  /** Unsaved edits are never dropped silently: `proceed` runs now, or after the user confirms in the inline bar. */
  const [pendingDiscard, setPendingDiscard] = useState<{ text: string; proceed: () => void } | null>(null);
  const confirmDiscard = (dirty: boolean, text: string, proceed: () => void) => { if (dirty) setPendingDiscard({ text, proceed }); else proceed(); };
  const setDialog = (next: typeof dialog) => {
    if (dialog === 'builds' && next !== 'builds') {
      if (parameterEdits.current.working) { notify('正在保存或提交参数，请稍候。'); return; }
      if (parameterEdits.current.dirty) { setPendingDiscard({ text: '参数有未保存修改，离开会丢弃这些修改。', proceed: () => { parameterEdits.current = { dirty: false, working: false }; setDialog(next); } }); return; }
    }
    if (next === 'parametric' || next === 'structural' || next === 'thermal') { openWorkspace(next); updateDialog(null); return; }
    updateDialog(next);
  };
  useEffect(() => { if (dialog !== 'projects') return; let live = true; void api.projects().then(list => { if (live) setProjects(list); }).catch(e => { if (live) notify(e.message); }); return () => { live = false; }; }, [dialog]);
  const refreshGlobal = useCallback(async () => {
    if (embedding.nativeHarness) { setProjects(await api.projects()); return; }
    const [s, p, list] = await Promise.all([api.status(), api.plugins(), api.projects()]); setStatus(s); setPlugins(p); setProjects(list);
  }, [embedding.nativeHarness]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await api.projects();
        const requested = list.find(p => p.id === (embedding.projectId || (!embedding.enabled && localStorage.getItem('pi-studio-project'))));
        if (embedding.enabled && !requested) throw new Error('未找到指定项目，请在桌面端重新选择项目。');
        const selected = requested || list[0] || await api.createProject('我的第一个设计');
        if (!live) return;
        openProject(selected); setProjects(list.length ? list : [selected]);
        await refreshGlobal();
      } catch (e) { if (live) { const message = (e as Error).message; setProjectError(message); notify(message); } }
    })();
    return () => { live = false; };
  }, [embedding, refreshGlobal]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 7000); return () => clearTimeout(timer); }, [toast]);
  const refreshFiles = useCallback(async (id: string) => {
    if (currentProject.current !== id) return;
    const epoch = projectEpoch.current, request = ++fileRequest.current;
    // Only resolve the published default while no model is selected. Recheck selection after both reads.
    const [incoming, cylinderState] = await Promise.all([
      api.files(id),
      !assetRef.current ? apiRequest<{ published?: { preview?: string; source?: string } | null }>(
        'api/projects/' + encodeURIComponent(id) + '/cylinder-objects',
      ).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (currentProject.current !== id || epoch !== projectEpoch.current || request < appliedFileRequest.current) return;
    appliedFileRequest.current = request;
    setFiles(incoming);
    if (typeof cylinderState?.published?.source === 'string') setPublishedStructuralSource(cylinderState.published.source);
    const requested = requestedPreview.current;
    const exact = requested?.projectId === id ? incoming.find(f => f.path === requested.path && f.kind === 'model') : undefined;
    if (exact) { requestedPreview.current = null; assetRef.current = exact; setAsset(exact); return; }
    const current = assetRef.current;
    if (current) { const updated = incoming.find(f => f.path === current.path); if (!updated) setAsset(null); else if (updated.modified !== current.modified) setAsset(updated); }
    else { const preferred = cylinderState?.published?.preview; const preview = choosePreview(incoming, typeof preferred === 'string' ? preferred : undefined); if (preview) { assetRef.current = preview; setAsset(preview); } }
  }, []);

  const toggleCylinderObjects = (open: boolean) => {
    setCylinderObjectsOpen(open); if (open) setCylinderObjectsVisited(true);
    cylinderPanelPreference.current = open;
    if (project) { try { localStorage.setItem('castudio:cylinder-panel:' + project.id, open ? '1' : '0'); } catch { /* optional preference */ } }
  };
  useEffect(() => {
    if (cylinderPanelPreference.current === null && files.some(file => file.path.startsWith('cylinder-objects/'))) {
      setCylinderObjectsOpen(true); setCylinderObjectsVisited(true);
    }
  }, [files]);
  const rememberCylinderSelection = (id: string) => {
    cylinderSelectedRef.current = id; setCylinderSelectedId(id);
    if (project) { try { localStorage.setItem('castudio:cylinder-selection:' + project.id, id); } catch { /* optional preference */ } }
  };
  const receiveSelection = (next: Selection | null) => {
    setSelection(next);
    if (next?.cylinderObjectId) {
      rememberCylinderSelection(next.cylinderObjectId);
      setCylinderObjectsVisited(true);
    }
  };
  const receiveMeshes = (next: MeshInfo[]) => {
    setMeshes(next);
    const id = cylinderMeshId(next, cylinderSelectedRef.current);
    if (id) view.current?.select(id);
  };
  const selectCylinderObject = (id: string) => {
    rememberCylinderSelection(id);
    const meshId = cylinderMeshId(meshes, id);
    if (meshId) {
      view.current?.visible(meshId, true);
      setMeshes(old => old.map(mesh => mesh.id === meshId ? { ...mesh, visible: true } : mesh));
      view.current?.select(meshId);
    }
  };
  /** Viewport commands arrive on the root project's event stream whichever part is shown; replies go to the root too. */
  const viewportDepsRef = useRef<() => ViewportBridgeDeps>(null!);
  const handleViewportCommand = useCallback((rootId: string, data: Record<string, unknown>) => {
    const commandId = String(data.id || ''), expiresAt = Number(data.expiresAt || 0);
    // Another session's workbench shares this project's event stream: act only on commands addressed to this instance.
    const target = typeof data.client === 'string' ? data.client : '';
    if (target && embedding.client && target !== embedding.client) return;
    if (!commandId || expiresAt < Date.now() || handledViewportCommands.current.has(commandId)) return;
    handledViewportCommands.current.add(commandId);
    if (handledViewportCommands.current.size > 50) { const oldest = handledViewportCommands.current.values().next().value; if (oldest !== undefined) handledViewportCommands.current.delete(oldest); }
    const command = data.command as ViewportCommand;
    viewportCommandQueue.current = viewportCommandQueue.current.then(async () => {
      const result = await applyViewportCommand(command, viewportDepsRef.current()).catch((error): ViewportCommandResult => ({ ok: false, error: (error as Error).message }));
      await fetch(`api/projects/${encodeURIComponent(rootId)}/viewport/results/${encodeURIComponent(commandId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }).catch(() => {});
    });
  }, [embedding.client]);
  // One root stream for the whole project session: viewport commands and part changes are addressed to the root,
  // and a fresh EventSource has no replay, so reopening it on every part switch could drop a command.
  useEffect(() => {
    const rootId = rootProject?.id;
    if (!rootId) return;
    let live = true;
    const loadParts = () => void api.parts(rootId).then(list => { if (live) setParts(list); }).catch(e => notify((e as Error).message));
    loadParts(); refreshParts.current = loadParts;
    const events = new EventSource(`api/projects/${rootId}/events`);
    events.onmessage = event => {
      const payload = JSON.parse(event.data) as StudioEvent;
      if (payload.type === 'viewport_command') handleViewportCommand(rootId, payload.data);
      if (payload.type === 'parts_changed') loadParts();
    };
    return () => { live = false; events.close(); };
  }, [rootProject?.id, handleViewportCommand]);
  // A host request for a part waits until the part list contains it (a part the host just created arrives with parts_changed).
  useEffect(() => {
    if (requestedPart === null || !parts.some(p => p.slug === requestedPart)) return;
    setRequestedPart(null); switchPart(requestedPart);
  }, [requestedPart, parts]);
  const switchPart = (slug: string) => {
    const part = parts.find(p => p.slug === slug);
    if (!rootProject || !part || part.id === project?.id) return;
    if (parameterEdits.current.working) { notify('正在保存或提交参数，请稍候。'); return; }
    const lost = unsavedWork();
    confirmDiscard(!!lost, `${lost}有未保存修改，切换到零件 ${part.name} 会丢弃这些修改。`, () => { parameterEdits.current = { dirty: false, working: false }; setProject(partRecord(rootProject, part)); });
  };
  /** Resolves to whether the part was created, so the switcher keeps the typed name after a failure. */
  const createPart = async (name: string) => {
    if (!rootProject) return false;
    try {
      const part = await api.createPart(rootProject.id, name); setParts(await api.parts(rootProject.id));
      const lost = unsavedWork();
      if (!lost) setProject(partRecord(rootProject, part));
      notify(lost ? `已创建零件 ${part.name}；${lost}有未保存修改，未自动切换` : `已创建零件 ${part.name}，文件位于 parts/${part.slug}/`);
      return true;
    } catch (e) { notify((e as Error).message); return false; }
  };
  /** Both resolve to an error message for the switcher to show inline, or null on success. */
  const renamePart = async (slug: string, name: string) => {
    if (!rootProject) return '项目尚未打开';
    try {
      const part = await api.renamePart(rootProject.id, slug, name); setParts(await api.parts(rootProject.id));
      if (project?.slug === slug) setProject({ ...project, name: part.name });
      notify(`已重命名为 ${part.name}`);
      return null;
    } catch (e) { return (e as Error).message; }
  };
  /** Deleting the current part first returns to the default part, through the unsaved-edits confirmation when needed. */
  const deletePart = async (slug: string) => {
    const part = parts.find(p => p.slug === slug);
    if (!rootProject || !part) return '零件不存在';
    const isCurrent = project?.id === part.id, previous = project;
    const run = async () => {
      if (isCurrent) { parameterEdits.current = { dirty: false, working: false }; setProject(rootProject); }
      try {
        const result = await api.deletePart(rootProject.id, slug); setParts(await api.parts(rootProject.id));
        notify(`已删除零件 ${part.name}，文件夹已移到 ${result.trash}`);
        return null;
      } catch (e) { if (isCurrent) setProject(previous); return (e as Error).message; }
    };
    if (!isCurrent) return run();
    if (parameterEdits.current.working) return '正在保存或提交参数，请稍候。';
    const lost = unsavedWork();
    if (!lost) return run();
    confirmDiscard(true, `${lost}有未保存修改，删除当前零件 ${part.name} 会丢弃这些修改。`, () => void run().then(error => { if (error) notify(error); }));
    return null;
  };
  /** The `open` viewport command: switch part when asked, then show `path` once that part's files load. */
  const openModel = async (path: string, slug?: string): Promise<string | null> => {
    if (!rootProject || !project) return '项目尚未打开';
    let target = project;
    if (slug !== undefined && slug !== currentPart.slug) {
      let list = parts;
      if (!list.some(p => p.slug === slug)) { list = await api.parts(rootProject.id); setParts(list); }
      const part = list.find(p => p.slug === slug);
      if (!part) return `项目中没有零件 ${slug}`;
      const lost = unsavedWork();
      if (lost) return `工作台的${lost}有未保存修改，不能切换零件；请让用户先保存`;
      target = partRecord(rootProject, part);
    }
    const file = (await api.files(target.id)).find(f => f.path === path);
    const where = target.slug ? `零件 ${target.slug}（parts/${target.slug}/）` : '默认零件（工作区根目录）';
    if (!file) return `${where}中没有文件 ${path}`;
    if (file.kind !== 'model') return `${path} 不是可在查看器中显示的模型`;
    openWorkspace('model');
    if (target.id !== project.id) { pendingOpen.current = { projectId: target.id, path }; setProject(target); }
    else { assetRef.current = file; setAsset(file); }
    return null;
  };
  const showCylinderPreview = (id: string, path: string) => {
    if (currentProject.current !== id) return;
    requestedPreview.current = { projectId: id, path };
    // Refresh callbacks and artifact events can overlap; the exact requested path survives either response.
    void refreshFiles(id).catch(e => notify((e as Error).message));
  };
  useLayoutEffect(() => {
    if (!project) return;
    projectEpoch.current++;
    setFiles([]); setMeshes([]); setScenePackage(null); setStructuralSource(''); setPublishedStructuralSource(''); requestedPreview.current = null;
    if (pendingOpen.current?.projectId === project.id) { requestedPreview.current = pendingOpen.current; pendingOpen.current = null; }
    let selectedObject = 'skin', panelPreference: string | null = null;
    try { selectedObject = localStorage.getItem('castudio:cylinder-selection:' + project.id) || 'skin'; panelPreference = localStorage.getItem('castudio:cylinder-panel:' + project.id); } catch { /* optional preferences */ }
    cylinderSelectedRef.current = selectedObject; setCylinderSelectedId(selectedObject);
    cylinderPanelPreference.current = panelPreference === null ? null : panelPreference === '1';
    setCylinderObjectsOpen(panelPreference === '1'); setCylinderObjectsVisited(panelPreference === '1');
    const id = project.id; localStorage.setItem('pi-studio-project', project.parentId ?? id); currentProject.current = id; setPendingReview(null); setPreview(null); setAsset(null); assetRef.current = null; setReference(null); setMessages([]); setSelection(null); setSourcePath(''); setSourceText(''); setSavedText('');
    // Under DSH the host reports busy only when it changes, so a part switch must keep the last value.
    if (!embedding.nativeHarness) setBusy(false);
    let live = true;
    if (!embedding.nativeHarness) void api.messages(id).then(m => { if (live) setMessages(m); }).catch(e => notify(e.message));
    void refreshFiles(id).catch(e => notify(e.message));
    if (!embedding.nativeHarness) void api.status().then(s => { if (live) { setStatus(s); setBusy(s.busyProjects.includes(id)); } }).catch(() => {});
    const events = new EventSource(`api/projects/${id}/events`);
    events.onmessage = event => {
      if (!live) return; const payload = JSON.parse(event.data) as StudioEvent, data = payload.data;
      if (['annotations_changed', 'artifacts_changed', 'history_changed'].includes(payload.type)) setReviewRevision(n => n + 1);
      if (payload.type === 'message') setMessages(old => { const m = data as unknown as Message, index = old.findIndex(v => v.id === m.id); return index < 0 ? [...old, m] : old.map(v => v.id === m.id ? m : v); });
      if (payload.type === 'delta') setMessages(old => { const id = String(data.id), existing = old.find(m => m.id === id); return existing ? old.map(m => m.id === id ? { ...m, text: m.text + String(data.text) } : m) : [...old, { id, role: 'assistant', text: String(data.text), timestamp: Date.now() }]; });
      if (payload.type === 'tool_start') setMessages(old => [...old.filter(m => m.id !== data.id), { id: String(data.id), role: 'tool', text: JSON.stringify(data.args, null, 2), toolName: String(data.toolName), timestamp: Date.now() }]);
      if (payload.type === 'tool_update') setMessages(old => old.map(m => m.id === data.id ? { ...m, text: String(data.text) } : m));
      if (payload.type === 'run_start') setBusy(true);
      if (payload.type === 'run_end') { setBusy(false); void refreshGlobal(); }
      if (payload.type === 'artifacts_changed' && typeof data.open === 'string') { requestedPreview.current = { projectId: id, path: data.open }; openWorkspace('model'); }
      if (payload.type === 'artifacts_changed' || payload.type === 'run_end') void refreshFiles(id);
      // A part's files decide its `published` status in the part switcher.
      if (payload.type === 'artifacts_changed') refreshParts.current();
    };
    // The server watches the workspace and emits artifacts_changed; a (re)connect may have missed events, so refetch once.
    events.onopen = () => { void refreshFiles(id).catch(() => {}); if (!embedding.nativeHarness) void api.status().then(s => { if (live) setBusy(s.busyProjects.includes(id)); }).catch(() => {}); };
    return () => { live = false; projectEpoch.current++; currentProject.current = ''; events.close(); };
  }, [project?.id, refreshFiles, refreshGlobal, embedding.nativeHarness, handleViewportCommand]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [messages.length, busy]);
  const doUpload = async (file: File) => {
    if (!project) return;
    try { notify(`正在导入 ${file.name}…`); const result = await api.upload(project.id, file); const list = await api.files(project.id); setFiles(list); const imported = list.find(f => f.path === uploadOpenPath(result)); if (imported?.kind === 'model') setAsset(imported); setDock('files'); notify(uploadNotice(result)); } catch (e) { notify((e as Error).message); }
  };
  const send = async () => {
    if (!project || !draft.trim() || sending || busy) return;
    if (!status?.hasCredentials) { setDialog('settings'); return; }
    setSending(true);
    try { await api.prompt(project.id, draft.trim(), selection ? { ...selection, file: asset?.path || 'UI demonstration mesh', isDemo: !asset } : undefined); setDraft(''); setBusy(true); }
    catch (e) { notify((e as Error).message); } finally { setSending(false); }
  };
  const openSource = (file: Artifact) => confirmDiscard(sourceText !== savedText && sourcePath !== file.path, `源码有未保存修改，打开 ${file.name} 会丢弃这些修改。`, () => void loadSource(file));
  const loadSource = async (file: Artifact) => { if (!project) return; try { const text = await api.source(project.id, file.path); setSourcePath(file.path); setSourceText(text); setSavedText(text); setDock('source'); } catch (e) { notify((e as Error).message); } };
  const setOption = <K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) => setOptions(old => ({ ...old, [key]: value }));
  const demo = !asset;
  const hasCylinderObjects = meshes.some(m => m.cylinderObjectId) || files.some(f => f.path.startsWith('cylinder-objects/'));
  const isAssembly = asset?.path === 'assembly.json', hasAssembly = files.some(f => f.path === 'assembly.json');
  const modelUrl = asset && project ? isAssembly ? `${api.assemblyUrl(project.id)}?v=${asset.modified}` : `${api.fileUrl(project.id, asset.path)}&v=${asset.modified}` : undefined;
  useEffect(() => { if (isAssembly) setAssemblyOpen(true); }, [isAssembly]);
  /** 新建装配 / 编辑装配: creates an empty assembly.json in the current part when there is none, then shows it with its component panel. */
  const openAssembly = async () => {
    if (!project) return;
    const id = project.id;
    try {
      if (!hasAssembly) { const current = await api.assembly(id); if (!current.exists) await api.saveAssembly(id, current.etag, { version: 1, components: [] }); }
      setAssemblyOpen(true); setComparison(false); openWorkspace('model'); showCylinderPreview(id, 'assembly.json');
    } catch (e) { notify((e as Error).message); }
  };
  /** 用对话描述: starts a conversation draft for the Agent; the returned hint says where it went. */
  const describePart = () => {
    appendConversationContext(`请为零件「${currentPart.name}」编写参数化 CadFlow 程序并发布 STEP。零件的形状、尺寸与用途：`);
    return embedding.enabled ? '已在对话输入框写入开头，补充零件的形状、尺寸与用途后发送。' : '已在设计助手输入框写入开头，补充零件的形状、尺寸与用途后发送。';
  };
  // Every page after 模型 acts on this model; simulations take it as their STEP/STL input when it is one (or has one beside it).
  const model = currentModel(asset, files);
  const modelSource = model && { path: model.path, name: model.name, origin: modelOrigin(model.path, files.map(f => f.path)) };
  /** 让 Agent 转为参数化: asks for the current model rewritten as the part's parametric notebook. */
  const convertModel = () => {
    if (!modelSource) return '';
    appendConversationContext(`请把零件「${currentPart.name}」的当前模型 ${modelSource.path} 改写为参数化 CadFlow 程序（参数化 notebook）：几何与该模型一致，把主要尺寸设为命名参数，完成后告诉我在「参数」页发布。`);
    return embedding.enabled ? '已写入对话输入框，确认后发送。' : '已写入设计助手输入框，确认后发送。';
  };
  viewportLive.current = { workspace: workspaceMode, modelPath: asset?.path ?? null, demo, preview, previewCurrent: preview?.url === modelUrl, meshes, selection, options, part: currentPart };
  const currentViewportState = () => buildViewportState({ ...viewportLive.current, camera: view.current?.state().camera ?? null });
  const setPanel = (panel: ViewportPanel, state: 'expand' | 'collapse') => setLayout(old => state === 'expand' ? expandPanel(old, panel) : old.collapsed.includes(panel) ? old : togglePanel(old, panel));
  const viewportDeps = (): ViewportBridgeDeps => ({ handle: view.current, meshes: viewportLive.current.meshes, setOptions, setMeshes, revealViewer: () => setLayout(old => expandPanel(old, 'viewer')), openWorkspace, openModel, setPanel, buildState: currentViewportState });
  viewportDepsRef.current = viewportDeps;
  const reportViewport = useCallback((id: string) => {
    const instance = embedding.client ? `?client=${encodeURIComponent(embedding.client)}` : '';
    void fetch(`api/projects/${encodeURIComponent(id)}/viewport/state${instance}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentViewportState()) }).catch(() => {});
  }, [embedding.client]);
  // The viewer reports under the root project; `state.part` says which part it shows.
  useEffect(() => {
    const id = rootProject?.id;
    if (!id) return;
    const timer = setTimeout(() => reportViewport(id), 250);
    return () => clearTimeout(timer);
  }, [rootProject?.id, project?.id, workspaceMode, asset?.path, demo, preview, meshes, selection, options, reportViewport]);
  useEffect(() => {
    const id = rootProject?.id;
    if (!id) return;
    const heartbeat = setInterval(() => reportViewport(id), 5000);
    return () => clearInterval(heartbeat);
  }, [rootProject?.id, reportViewport]);
  const locateReview = (note: ReviewNote) => {
    const file = files.find(f => f.path === note.anchor.file);
    if (!file) { notify('批注对应的模型文件已不存在，原批注仍保留'); return; }
    openWorkspace('model'); setPendingReview(note); setAsset(file); setDialog(null);
  };
  useEffect(() => {
    if (!pendingReview || !preview || asset?.path !== pendingReview.anchor.file || preview.url !== modelUrl || preview.status === 'loading') return;
    if (preview.status === 'error') { notify(preview.error || '模型读取失败'); setPendingReview(null); return; }
    const result = view.current?.locateReview(pendingReview.anchor);
    if (result?.error || !result?.meshId) notify(result?.error || '无法定位批注');
    else { setMeshes(old => old.map(m => m.id === result.meshId ? { ...m, visible: true } : m)); setDock('properties'); notify('已定位批注对应的几何'); }
    setPendingReview(null);
  }, [pendingReview, preview, modelUrl, asset?.path]);
  const reviewAnchor = asset && selection?.review && preview?.status === 'ready' && preview.url === modelUrl ? { ...selection.review, file: asset.path } : null;
  const activeModel = status?.settings.model || status?.models[0]?.name;
  const sourceDirty = sourceText !== savedText;
  // The editor's target follows the viewer: a model's source is whatever its build manifest names, otherwise there is none.
  const filePathsKey = files.map(f => f.path).join('\n');
  useEffect(() => {
    const id = project?.id, model = asset?.path, link = sourceLinkFor(model, filePathsKey.split('\n'));
    if (!id || !model || !link) { setLinkedSource(null); return; }
    if (link.kind === 'parametric') { setLinkedSource({ model, source: link.source }); return; }
    let live = true;
    void fetch(api.fileUrl(id, link.manifest)).then(r => r.ok ? r.json() as Promise<{ source?: string; sourceHash?: string }> : null)
      .then(m => { if (live) setLinkedSource(m?.source ? { model, source: m.source, hash: m.sourceHash } : null); }, () => { if (live) setLinkedSource(null); });
    return () => { live = false; };
  }, [project?.id, asset?.path, filePathsKey]);
  const [sourceMatches, setSourceMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const hash = linkedSource?.hash;
    if (!hash || sourcePath !== linkedSource.source) { setSourceMatches(null); return; }
    let live = true;
    void studioSha256(new TextEncoder().encode(savedText)).then(d => { if (live) setSourceMatches([...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') === hash); });
    return () => { live = false; };
  }, [linkedSource, sourcePath, savedText]);
  const leaveSource = (proceed: () => void) => confirmDiscard(sourceDirty, '源码有未保存修改，继续会丢弃这些修改。', proceed);
  // Restoring a revision reloads the open source, so unsaved edits are given up before the history opens.
  const openHistory = () => confirmDiscard(sourceDirty, '源码有未保存修改；恢复历史版本会覆盖编辑器内容，继续会丢弃这些修改。', () => { setSourceText(savedText); setDialog('history'); });
  const [building, setBuilding] = useState('');
  /** 保存并构建 from the source panel: the steps of 构建与运行 in one go (save, build the saved text, keep the products), then the viewer shows the built model. */
  const buildSource = async () => {
    if (!project || !sourcePath || building) return;
    const id = project.id, source = sourcePath, text = sourceText;
    setBuilding('正在保存');
    try {
      if (text !== savedText) { await api.saveSource(id, source, text, savedText); setSavedText(text); }
      const parameters = await api.parameters(id, source);
      setBuilding('正在构建');
      let run = await api.startBuild(id, source, text, parameters.hash);
      while (run.state === 'preparing' || run.state === 'running') { await new Promise(ok => setTimeout(ok, 1500)); run = await apiRequest<BuildRun>(`api/projects/${id}/builds/${run.id}`); }
      if (run.state !== 'succeeded') throw new Error(run.error || '脚本没有执行完成');
      const { path } = await api.publishBuild(id, run.id);
      const built = choosePreview((await api.files(id)).filter(f => f.path.startsWith(path + '/')));
      if (built) showCylinderPreview(id, built.path); else await refreshFiles(id);
      notify(built ? `构建完成，查看器已显示 ${built.name}` : `构建完成，但没有生成可显示的模型；产物在 ${path}`);
    } catch (e) { notify(`构建未完成：${(e as Error).message.trim().split('\n').pop()}（日志见「工具 → 构建与运行环境」）`); }
    finally { setBuilding(''); }
  };
  const createSource = () => leaveSource(() => void makeSource());
  const makeSource = async () => {
    if (!project) return;
    try {
      const existing = await api.files(project.id);
      let path = 'model.py', suffix = 1;
      while (existing.some(file => file.path === path)) path = `model_${suffix++}.py`;
      const text = '# 在此编写 Python 建模程序\n';
      await api.saveSource(project.id, path, text, null);
      await refreshFiles(project.id); setSourcePath(path); setSourceText(text); setSavedText(text);
    } catch (e) { notify((e as Error).message); }
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (sourceDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [sourceDirty]);
  // The one tools menu: in the header bar when embedded (with the entries the standalone page keeps in its sidebar), otherwise in the page heading.
  const toolsMenu = <Popover label="工具" icon={<Wrench size={15}/>} width={200}>
    {embedding.enabled && <><PopoverItem icon={<Layers3 size={14}/>} label="模型部件" onSelect={() => setDialog('resources')}/><PopoverItem icon={<History size={14}/>} label="项目历史" disabled={!project} onSelect={openHistory}/><hr/></>}
    <PopoverItem icon={<Terminal size={14}/>} label="构建与运行环境" disabled={!project} onSelect={() => setDialog('builds')}/>
    <PopoverItem icon={<ScanLine size={14}/>} label="几何检查与对比" disabled={!project} onSelect={() => setDialog('measurements')}/>
    <PopoverItem icon={<MessageSquare size={14}/>} label="批注与检查清单" disabled={!project} onSelect={() => setDialog('reviews')}/>
    <PopoverItem icon={<Workflow size={14}/>} label="场景与特征" disabled={!scenePackage} hint={scenePackage ? undefined : '当前模型不是场景包'} onSelect={() => setDialog('scene')}/>
    {workspaceMode === 'model' && project && !hasCylinderObjects && !cylinderObjectsOpen && <PopoverItem icon={<SlidersHorizontal size={14}/>} label="圆柱对象" onSelect={() => toggleCylinderObjects(true)}/>}
    {embedding.enabled && !embedding.nativeHarness && <><hr/><PopoverItem icon={<Settings2 size={14}/>} label="模型设置" onSelect={() => setDialog('settings')}/></>}
  </Popover>;
  return <div className={`studio ${embedding.enabled ? 'embedded-workspace' : ''} ${embedding.nativeHarness ? 'dsh-workspace' : ''} ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${assistantOpen ? "assistant-open" : "assistant-closed"}`} data-theme={embeddedTheme} style={hostTheme as CSSProperties} onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) void doUpload(e.dataTransfer.files[0]); }}>

    <header className="topbar">
      <div className="breadcrumb"><button className="icon-button" aria-label="切换项目导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft size={18}/></button><button className="project-breadcrumb" onClick={() => setDialog('projects')} title={project?.name}>{project?.name || '正在打开项目'}<ChevronDown size={13}/></button><span className="header-divider"/><span className="workspace-breadcrumb">{workspaceTitle}</span></div>
      <div className="top-actions"><span className="saved-indicator"><Check size={13}/>{sourceDirty ? '源码未保存' : '已保存'}</span><button className="button import-button" onClick={() => upload.current?.click()}><FilePlus2 size={14}/><span>导入</span></button><button className="button" onClick={() => { openWorkspace('model'); setDock('files'); }}><FolderOpen size={14}/><span>文件</span></button><button className={`button assistant-toggle ${assistantOpen ? 'active' : ''}`} aria-label="切换设计助手" aria-expanded={assistantOpen} onClick={() => setAssistantOpen(!assistantOpen)}><PanelRight size={16}/><span>助手</span></button></div>
    </header>
    {sidebarOpen && <button className="navigation-scrim" aria-label="收起项目导航" onClick={() => setSidebarOpen(false)}/>}
    <aside className="navigator" aria-label="项目导航">
      <div className="sidebar-brand"><div className="brand-symbol"><Boxes size={22}/></div><strong>CAStudio</strong><span>Workspace</span></div>
      <button className="new-project" onClick={() => setDialog('new')}><Plus size={16}/>新建项目</button>
      <div className="sidebar-section-label">工作空间<button className="icon-button" aria-label="切换项目" onClick={() => setDialog('projects')}><FolderOpen size={15}/></button></div>
      <nav className="workspace-navigation" aria-label="工作区">
        <button className={workspaceMode === 'model' ? 'active' : ''} aria-current={workspaceMode === 'model' ? 'page' : undefined} onClick={() => openWorkspace('model')}><Box size={17}/><span>模型</span></button>
        <button className={workspaceMode === 'parametric' ? 'active' : ''} aria-current={workspaceMode === 'parametric' ? 'page' : undefined} onClick={() => setDialog('parametric')}><SlidersHorizontal size={17}/><span>参数</span></button>
        <button className={workspaceMode === 'structural' ? 'active' : ''} aria-current={workspaceMode === 'structural' ? 'page' : undefined} onClick={() => setDialog('structural')}><FlaskConical size={17}/><span>结构仿真</span></button>
        <button className={workspaceMode === 'thermal' ? 'active' : ''} aria-current={workspaceMode === 'thermal' ? 'page' : undefined} onClick={() => setDialog('thermal')}><Thermometer size={17}/><span>热仿真</span></button>
        <button onClick={openHistory}><History size={17}/><span>项目历史</span></button>
      </nav>
      <div className="resource-section"><div className="tabs small"><button className={treeTab === 'model' ? 'active' : ''} onClick={() => setTreeTab('model')}>模型树 <span>{meshes.length}</span></button><button className={treeTab === 'files' ? 'active' : ''} onClick={() => setTreeTab('files')}>文件 <span>{files.length}</span></button></div>
            <div className="tree-scroll">{treeTab === 'model' ? <ModelTree key={asset?.path || 'demo'} meshes={meshes} selection={selection} name={asset?.name || '示例模型'} demo={demo} select={id=>view.current?.select(id)} visibility={(ids, visible)=>{ const affected=new Set(ids); ids.forEach(id=>view.current?.visible(id,visible)); setMeshes(old=>old.map(mesh=>affected.has(mesh.id)?{...mesh,visible}:mesh)); }}/> : <>{files.length === 0 && <div className="small-empty">导入模型或让 Agent 创建文件</div>}{files.map(file => <button className="file-tree-row" key={file.path} onClick={() => (() => { openWorkspace('model'); if (file.kind === 'model') setAsset(file); else if (file.kind === 'source') void openSource(file); else setDock('files'); })()}>{file.kind === 'model' ? <Box size={14}/> : <FileCode2 size={14}/>}<span>{file.name}</span></button>)}</>}</div>
</div>
      <div className="navigator-bottom"><button onClick={() => setDialog('plugins')}><Package size={16}/>扩展</button><button onClick={() => setDialog('settings')}><Settings2 size={16}/>设置</button><span className="local-workspace"><span className="status-dot"/>本地工作空间</span></div>
    </aside>
    <main className="model-workspace">
      {embedding.enabled && <div className="embedded-workspace-bar">
        <nav aria-label="CAD 工作区" className="embedded-workspace-tabs">
          <button aria-current={workspaceMode === 'model' ? 'page' : undefined} title="查看模型、文件与源码" onClick={() => openWorkspace('model')}>模型</button>
          <button aria-current={workspaceMode === 'parametric' ? 'page' : undefined} title="调整当前模型的参数，或从模板生成 CAD" onClick={() => setDialog('parametric')}>参数</button>
          <button aria-current={workspaceMode === 'structural' ? 'page' : undefined} title="圆柱壳的应力与位移分析" onClick={() => setDialog('structural')}>结构仿真</button>
          <button aria-current={workspaceMode === 'thermal' ? 'page' : undefined} title="放置热源并计算温度场" onClick={() => setDialog('thermal')}>热仿真</button>
        </nav>
        <div className="embedded-file-actions">
          <button className="button" title="把本机的模型或源码文件导入项目" disabled={!project} onClick={() => upload.current?.click()}><FilePlus2 size={14}/><span>导入</span></button>
          {toolsMenu}
        </div>
      </div>}
      {embedding.enabled && project && busy && <div className="embedded-busy" role="status"><LoaderCircle className="spin" size={13}/>对话中的 Agent 正在运行，源码暂为只读</div>}
      {embedding.enabled && !project && <div className="embedded-project-state" role={projectError ? 'alert' : 'status'}>{projectError || '正在打开 CAD 工作区…'}</div>}
      {embedding.enabled && selection && <div className="embedded-selection-context"><MousePointer2 size={13}/><span>{selection.name}{selection.cadFace ? ` · STEP 面 ${selection.cadFace.index}` : selection.triangle !== undefined ? ` · 网格面 ${selection.triangle}` : ''}</span><button className="text-button" disabled={!asset} title={asset ? '把当前选择作为引用加入对话输入框' : '示例模型不是项目文件，不能引用'} onClick={quoteSelection}>引用到对话</button><button className="icon-button" aria-label="清除选择上下文" onClick={() => setSelection(null)}><X size={13}/></button></div>}
      <div className="workspace-heading"><div>{!embedding.enabled && <h1>{workspaceTitle}</h1>}{rootProject && project && <PartSwitcher projectName={embedding.enabled ? undefined : rootProject.name} parts={parts} current={currentPart.slug} onSwitch={switchPart} onCreate={createPart} onRename={renamePart} onDelete={deletePart} onAssembly={() => void openAssembly()} hasAssembly={hasAssembly}/>}</div><div className="workspace-actions">{workspaceMode === 'model' && <LayoutPresetMenu onApply={setLayout}/>}{workspaceMode === 'model' && project && (hasCylinderObjects || cylinderObjectsOpen) && <button className={'icon-button cylinder-objects-toggle' + (cylinderObjectsOpen ? ' selected' : '')} aria-label="圆柱对象" title="圆柱对象" aria-pressed={cylinderObjectsOpen} aria-controls="cylinder-object-sidebar" onClick={() => toggleCylinderObjects(!cylinderObjectsOpen)}><SlidersHorizontal size={15}/></button>}<button className="icon-button" aria-label="专注工作区" title="收起导航与助手" onClick={() => { setSidebarOpen(false); setAssistantOpen(false); }}><Maximize size={17}/></button>{!embedding.enabled && toolsMenu}</div></div>
      {workspaceMode !== 'model' && modelSource && <div className="embedded-selection-context"><Box size={13}/><span title={modelSource.path}>当前模型：{modelSource.name} · {originLabels[modelSource.origin]}</span><button className="text-button" title="在「模型」页打开其他模型" onClick={() => openWorkspace('model')}>切换</button></div>}
      <section className="model-stage" hidden={workspaceMode !== 'model'} aria-label="模型工作区"><WorkbenchPanels layout={layout} onChange={setLayout} panels={[
      { id: 'viewer', title: '查看器', purpose: '渲染选中的模型文件；在这里选择部件或面', target: <span title={asset?.path}>{asset?.name ?? '示例模型（非项目文件）'}</span>, status: demo ? '示例' : preview?.url !== modelUrl || preview?.status === 'loading' ? '读取中' : preview?.status === 'error' ? '读取失败' : '已渲染',
        actions: <button className={`compare-button ${comparison ? 'active' : ''}`} aria-pressed={comparison} onClick={() => setComparison(!comparison)}><Columns2 size={14}/>对比</button>, body: <>
      <div className="viewport-toolbar"><div className="tool-group selection-mode-tools"><ToolButton label="选择部件" active={options.mode === 'component'} onClick={() => setOption('mode', 'component')}><MousePointer2 size={16}/><span>部件</span></ToolButton><ToolButton label="选择面（STEP 面或网格三角面）" active={options.mode === 'face'} onClick={() => setOption('mode', 'face')}><ScanLine size={16}/><span>{/\.(step|stp)$/i.test(asset?.name || '') ? '几何面' : '三角面'}</span></ToolButton></div><div className="tool-group"><ToolButton label="边线" active={options.edges} onClick={() => setOption('edges', !options.edges)}><Box size={16}/></ToolButton><ToolButton label="网格" active={options.grid} onClick={() => setOption('grid', !options.grid)}><Grid2X2 size={16}/></ToolButton><ViewOptionsMenu items={[
        { label: '正交投影', icon: <Square size={14}/>, checked: options.ortho, onSelect: () => setOption('ortho', !options.ortho) },
        { label: '剖切', icon: <Scissors size={14}/>, checked: options.section < 100, onSelect: () => setOption('section', options.section < 100 ? 100 : 60) },
        { label: '拆分显示', icon: <Layers3 size={14}/>, checked: options.explode > 0, disabled: options.explode === 0 && meshes.filter(m => m.visible).length < 2, hint: options.explode === 0 && meshes.filter(m => m.visible).length < 2 ? '需要两个以上可见部件' : undefined, onSelect:() => setOption('explode', options.explode > 0 ? 0 : 30) },
        { label: '保存视口截图', icon: <Camera size={14}/>, onSelect: () => view.current?.snapshot() },
      ]}/></div><div className="toolbar-spacer"/>{project && <ExportMenu projectId={project.id} asset={asset} files={files} url={isAssembly ? undefined : modelUrl} viewport={view} visibleMeshes={meshes.filter(m => m.visible).length}/>}<ToolButton label="适应视图" onClick={() => { view.current?.fit(); referenceView.current?.fit(); }}><Maximize size={16}/></ToolButton></div>
      <div className="model-canvas-layout"><div className={`viewports ${comparison ? 'compare' : ''}`}><Viewport appearance={embedding.nativeHarness && hostTheme['--embed-surface'] ? { background: hostTheme['--embed-surface'], dark: embeddedTheme === 'dark' } : undefined} key={`result-${project?.id || ''}`} ref={view} projectId={project?.id} url={modelUrl} name={asset?.name} demo={demo} options={options} onMeshes={receiveMeshes} onSelection={receiveSelection} onPackage={setScenePackage} onPreview={setPreview} label={comparison ? '当前设计' : undefined}/>{comparison && <Viewport appearance={embedding.nativeHarness && hostTheme['--embed-surface'] ? { background: hostTheme['--embed-surface'], dark: embeddedTheme === 'dark' } : undefined} key={`reference-${project?.id}-${reference?.revision || 'current'}-${reference?.path || ''}`} ref={referenceView} url={reference && project ? reference.revision ? api.revisionFileUrl(project.id, reference.revision, reference.path) : `${api.fileUrl(project.id, reference.path)}&v=${reference.modified}` : undefined} name={reference?.name} options={options} label={reference?.revisionLabel ? `历史 · ${reference.revisionLabel}` : '参考模型'}/>}<div className="canvas-meta">{demo ? '交互示例 · 非 CAD 验证结果' : `${/\.(zip|scadpkg)$/i.test(asset.name) ? scenePackage ? '场景包（已校验）' : '归档预览' : /\.(step|stp)$/i.test(asset.name) ? 'STEP' : isAssembly ? '装配' : '网格预览'} · ${meshes.length} 个网格 · ${Math.round(meshes.reduce((sum, m) => sum + m.triangles, 0)).toLocaleString()} 三角面`}</div>{options.section < 100 && <div className="section-control"><Scissors size={14}/><span>Z 剖切</span><input aria-label="剖切位置" type="range" min="0" max="100" value={options.section} onChange={e => setOption('section', Number(e.target.value))}/><span>{options.section}%</span><button className="icon-button" aria-label="关闭剖切" onClick={() => setOption('section', 100)}><X size={13}/></button></div>}</div>
      {project && cylinderObjectsVisited && <aside id="cylinder-object-sidebar" className="cylinder-object-sidebar" hidden={!cylinderObjectsOpen}><CylinderObjectsPanel projectId={project.id} selectedId={cylinderSelectedId} onSelect={selectCylinderObject} onPreview={path => showCylinderPreview(project.id, path)} onSimulate={source => { setStructuralSource(source); setStructuralSourceRequest(n => n + 1); setDialog('structural'); }} onChanged={() => refreshFiles(project.id)}/></aside>}
      {project && asset && isAssembly && <aside className="assembly-sidebar" aria-label="装配组件" hidden={!assemblyOpen}><AssemblyPanel key={project.id} projectId={project.id} parts={parts} revision={asset.modified} close={() => setAssemblyOpen(false)}/></aside>}
      </div>
      </> },
      { id: 'files', title: '文件', purpose: '项目工作区里的模型、源码、导入与结果文件', target: `${files.length} 个`, body: <div className="files-dock">{files.length === 0 ? <div className="files-empty"><div className="file-empty-icon"><FilePlus2 size={23}/></div><div><strong>让想法成为第一个文件</strong><p>导入 STEP、GLB、STL、OBJ 或 CATIA（CATPart / CATProduct），或向 Agent 描述你的设计。</p></div><button className="button" onClick={() => upload.current?.click()}><Plus size={13}/>导入文件</button></div> : <FilePanel projectId={project!.id} files={files} activePath={asset?.path} openModel={setAsset} openSource={file => void openSource(file)} setReference={file => { setReference(file); setComparison(true); }} onConverted={async c => { const list = await api.files(project!.id); setFiles(list); const f = c.step && list.find(x => x.path === c.step); if (f) setAsset(f); }}/>}</div> },
      { id: 'editor', title: '源码', purpose: '编辑生成模型的 Python 源码；点「构建」后查看器显示新模型', target: <span title={sourcePath}>{sourcePath || '未打开源码'}</span>, status: !sourcePath ? undefined : building ? `${building}…` : sourceDirty ? '未保存' : linkedSource?.source !== sourcePath ? '已保存' : sourceMatches === false ? '已在生成模型后修改' : '生成当前模型', body: <div className="source-dock"><div className="source-bar"><select aria-label="选择源码文件" value={sourcePath} onChange={e => { const f = files.find(f => f.path === e.target.value); if (f) void openSource(f); }}><option value="">选择一个源文件</option>{files.filter(f => f.kind === 'source').map(f => <option key={f.path} value={f.path} title={f.path}>{fileLabel(f)}</option>)}</select><button className="text-button" disabled={busy || !sourcePath || !sourceDirty || !!building} title={busy ? 'Agent 运行中，源码暂为只读' : !sourcePath ? '先打开一个源码文件' : !sourceDirty ? '没有未保存的修改' : undefined} onClick={async () => { try { await api.saveSource(project!.id, sourcePath, sourceText, savedText); setSavedText(sourceText); notify('源码已保存；点「构建」后查看器才会更新'); } catch (e) { notify((e as Error).message); } }}><Save size={13}/>保存</button><button className="text-button" disabled={busy || !/\.py$/i.test(sourcePath) || !!building} title={busy ? 'Agent 运行中，暂不能构建' : !sourcePath ? '先打开一个源码文件' : !/\.py$/i.test(sourcePath) ? '只有 Python 源码可以构建' : '运行这份源码，保留产物，并在查看器中显示生成的模型'} onClick={() => void buildSource()}>{building ? <LoaderCircle className="spin" size={13}/> : <Play size={13}/>}{building ? `${building}…` : sourceDirty ? '保存并构建' : '构建'}</button><button className="icon-button" aria-label="新建 Python 源码" title="新建 Python 源码" disabled={busy || !project || !!building} onClick={() => void createSource()}><Plus size={14}/></button></div>{sourcePath ? <SourceEditor theme={embedding.nativeHarness ? embeddedTheme : undefined} value={sourceText} onChange={setSourceText} readOnly={busy}/> : <div className="no-source">{linkedSource ? <><strong>当前模型由 {linkedSource.source} 生成</strong><div className="no-source-actions"><button className="button" onClick={() => { const f = files.find(file => file.path === linkedSource.source); if (f) void openSource(f); else notify('生成该模型的源码已不在项目中'); }}><FileCode2 size={13}/>打开该源码</button></div></> : <><strong>{asset ? '当前模型没有可编辑的源码' : '尚未打开源码'}</strong><span>{asset ? '导入的模型或无构建记录的文件只能查看。可以打开已有源码，或新建 Python 程序重新建模。' : '打开项目里的 Python 源码，或新建一个。'}</span></>}</div>}</div> },
      { id: 'properties', title: '属性', purpose: '查看选中部件或面的几何属性', target: selection?.name, body: <>{!embedding.nativeHarness && <div className="tabs small" role="tablist"><button role="tab" aria-selected={propertiesTab === 'properties'} className={propertiesTab === 'properties' ? 'active' : ''} onClick={() => setPropertiesTab('properties')}>属性</button><button role="tab" aria-selected={propertiesTab === 'activity'} className={propertiesTab === 'activity' ? 'active' : ''} onClick={() => setPropertiesTab('activity')}><Terminal size={13}/>运行记录</button></div>}
      {(embedding.nativeHarness || propertiesTab === 'properties') ? <div className="properties-dock"><SelectionProperties selection={selection} selectFace={(id, face) => view.current?.selectFace(id, face) ?? false}/></div>
      : <div className="activity-dock">{messages.filter(m => m.role === 'tool' || m.role === 'system').length ? messages.filter(m => m.role === 'tool' || m.role === 'system').map(m => <details key={m.id}><summary><span className={m.error ? 'error-text' : 'positive'}>●</span>{m.toolName || '系统'}<time>{new Date(m.timestamp).toLocaleTimeString()}</time></summary><pre>{m.text}</pre></details>) : <div className="small-empty">Agent 运行后，这里会记录工具调用与错误信息。</div>}</div>}</> },
      ]}/>
      </section>
      {project && visited.includes('parametric') && <section className="workspace-content parametric-workspace" hidden={workspaceMode !== 'parametric'} aria-label="参数工作区"><ParametricPanel active={workspaceMode === 'parametric'} key={project.id} projectId={project.id} model={modelSource} convert={convertModel} changed={() => refreshFiles(project.id)} open={path => { showCylinderPreview(project.id, path); setComparison(false); openWorkspace('model'); }} simulate={source => { setStructuralSource(source); setStructuralSourceRequest(n => n + 1); void refreshFiles(project.id); setDialog('structural'); }} describe={describePart} importModel={() => { openWorkspace('model'); upload.current?.click(); }}/></section>}
      {project && visited.includes('structural') && <section className="workspace-content" hidden={workspaceMode !== 'structural'} aria-label="结构仿真工作区"><StructuralPanel active={workspaceMode === 'structural'} key={project.id} projectId={project.id} partName={currentPart.name} initialSource={structuralSource} defaultSource={publishedStructuralSource} sourceRequest={structuralSourceRequest} currentModel={model && simulationInput(model.path, files, /\.(step|stp)$/i)} files={files} changed={() => refreshFiles(project.id)} openParametric={() => openWorkspace('parametric')}/></section>}
      {project && visited.includes('thermal') && <section className="workspace-content" hidden={workspaceMode !== 'thermal'} aria-label="热仿真工作区"><ThermalPanel active={workspaceMode === 'thermal'} key={project.id} projectId={project.id} partName={currentPart.name} files={files} currentModel={model && simulationInput(model.path, files, /\.(step|stp|stl)$/i)} busy={busy} unsaved={thermalUnsaved} changed={() => refreshFiles(project.id)} feedback={text => { appendConversationContext(text); notify('分析反馈已加入对话草稿'); }}/></section>}
    </main>
    <aside className="agent-panel" aria-label="设计助手"><div className="agent-heading"><div className="agent-title"><div className="agent-spark"><MessageSquare size={18}/></div><h2>设计助手</h2><span className="pill">AI</span></div><button className="icon-button" aria-label="收起设计助手" onClick={() => setAssistantOpen(false)}><X size={17}/></button></div><button className="model-selector" onClick={() => setDialog('settings')}><span className={`status-dot ${status?.hasCredentials ? '' : 'neutral'}`}/><span>{activeModel || '连接一个模型，开始设计'}</span><ChevronDown size={13}/></button>
      <div className="conversation">{messages.length === 0 && <div className="welcome"><div className="welcome-mark"><BrandIcon size={40}/></div><span className="eyebrow">DESIGN WITH AI</span><h2>一起完成<br/><em>下一个设计。</em></h2><p>描述你的设计意图，或选中一个部件。在这里编写代码、检查结构与导出模型。</p><div className="suggestions">{['创建一块带 4 个安装孔的支架', '检查我导入的模型尺寸', '修改参数并导出 STEP 和 GLB'].map((text, i) => <button key={text} onClick={() => setDraft(text)}>{i === 0 ? <Box size={16}/> : i === 1 ? <Crosshair size={16}/> : <FileCode2 size={16}/>}<span>{text}</span><ChevronRight size={13}/></button>)}</div><div className="welcome-foot"><Box size={13}/>参数化建模 · 装配 · 几何检查</div></div>}
        <ConversationMessages messages={messages} busy={busy}/>
        {busy && <div className="agent-working"><LoaderCircle className="spin" size={13}/>Agent 正在处理<span className="thinking-dots">···</span></div>}<div ref={chatEnd}/></div>
      <div className="composer-area">{selection && <div className="selection-chip"><MousePointer2 size={12}/><span>{selection.name}{selection.cadFace ? ` · STEP 面 ${selection.cadFace.index}` : selection.triangle !== undefined ? ` · 网格面 ${selection.triangle}` : ''}</span><button title="清除选择上下文" onClick={() => setSelection(null)}><X size={12}/></button></div>}<div className="composer"><textarea aria-label="设计需求" value={draft} onChange={e => setDraft(e.target.value)} placeholder="描述你的设计，或选择模型后提问…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-actions"><button className="icon-button" title="添加模型" onClick={() => upload.current?.click()}><Plus size={18}/></button><span>Enter 发送 · Shift Enter 换行</span>{busy ? <button className="send-button stop" aria-label="停止 Agent" onClick={() => project && void api.stop(project.id).catch(e => notify(e.message))}><Square size={14} fill="currentColor"/></button> : <button className="send-button" aria-label="发送消息" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={17}/> : <ArrowUp size={19}/>}</button>}</div></div><div className="composer-footer"><span className="status-dot"/>CAStudio<span>本地工作空间</span></div></div>
    </aside>
    <footer className="statusbar"><span><span className="status-dot"/>{busy ? 'Agent 运行中' : '工作空间就绪'}</span><span>{demo ? '示例视图' : '模型文件'}<i/>旋转：左键拖动<i/>缩放：滚轮</span><span className="status-right">{status?.platform || 'LOCAL'}<i/>CAStudio</span></footer>
    <input ref={upload} type="file" hidden accept=".glb,.gltf,.stl,.obj,.step,.stp,.CATPart,.CATProduct,.zip,.scadpkg,.py,.json,.png,.jpg,.jpeg,.webp" onChange={e => { if (e.target.files?.[0]) void doUpload(e.target.files[0]); e.target.value = ''; }}/>
    {dialog === 'resources' && <Dialog title="模型部件" subtitle={asset?.name || '示例模型（非项目文件）'} close={()=>setDialog(null)}><ModelTree meshes={meshes} selection={selection} name={asset?.name || '示例模型'} demo={demo} select={id=>view.current?.select(id)} visibility={(ids, visible)=>{ const affected=new Set(ids); ids.forEach(id=>view.current?.visible(id,visible)); setMeshes(old=>old.map(mesh=>affected.has(mesh.id)?{...mesh,visible}:mesh)); }}/></Dialog>}
    {dialog === 'history' && project && <HistoryDialog key={project.id} projectId={project.id} busy={busy} close={() => setDialog(null)} restored={async () => {
      const id = project.id;
      setSelection(null);
      await refreshFiles(id);
      if (sourcePath) { try { const text = await api.source(id, sourcePath); setSourceText(text); setSavedText(text); } catch { setSourcePath(''); setSourceText(''); setSavedText(''); } }
      setMessages(await api.messages(id)); await refreshGlobal();
    }} preview={(revision, file) => { setReference({ ...file, name: file.path.split('/').pop() || file.path, kind: 'model', category: 'cad', detail: revision.label, modified: Date.parse(revision.createdAt), revision: revision.id, revisionLabel: revision.label }); setComparison(true); openWorkspace('model'); setDialog(null); }}/>}
    {dialog === 'builds' && project && <Dialog title="构建与运行环境" subtitle="执行项目源码，检查日志，保留每次构建成果。" close={() => setDialog(null)}><BuildPanel key={project.id} filesChanged={() => refreshFiles(project.id)} editState={trackParameterEdits} confirmDiscard={confirmDiscard} projectId={project.id} files={files} initialSource={sourcePath} sourceDirty={sourceDirty} busy={busy} published={path => { void refreshFiles(project.id); openWorkspace('model'); setDock('files'); notify(`产物已另存到 ${path}`); }}/></Dialog>}
    {dialog === 'measurements' && project && <Dialog title="几何检查与对比" subtitle="检查 CAD 实体属性、比较材料变化，或检查预览网格。" close={() => setDialog(null)}>
      <div className="geometry-check-tabs" role="tablist" aria-label="几何检查方法"><button role="tab" aria-selected={geometryTab === 'cad'} onClick={() => setGeometryTab('cad')}>CAD 实体检查</button><button role="tab" aria-selected={geometryTab === 'mesh'} onClick={() => setGeometryTab('mesh')}>预览网格检查</button></div>
      {geometryTab === 'cad' ? <CadInspectionPanel key={project.id} projectId={project.id} files={files} currentFile={asset?.path} currentHash={preview?.status === 'ready' && preview.url === modelUrl ? preview.identity?.sourceHash : undefined} reference={reference ? {path:reference.path,revision:reference.revision,label:reference.revisionLabel} : undefined} changed={() => refreshFiles(project.id)} context={text => { appendConversationContext(text); setDialog(null); notify('CAD 检查结果已加入对话草稿'); }} preview={path => { showCylinderPreview(project.id,path); setComparison(false); openWorkspace('model'); setDialog(null); }} compare={(source,baseline) => { const ref=files.find(f=>f.path===baseline); if(ref){setReference(ref);setComparison(true);showCylinderPreview(project.id,source);openWorkspace('model');setDialog(null);}else notify('参考文件列表正在更新，请稍后重试'); }}/> : <MeasurementPanel key={project.id} projectId={project.id} anchor={reviewAnchor} busy={busy} currentFile={asset?.path} currentHash={preview?.status === 'ready' && preview.url === modelUrl ? preview.identity?.sourceHash : undefined} measure={(anchor, signal) => view.current ? view.current.measure(anchor, signal) : Promise.reject(new Error('视口尚未就绪'))} context={text => { appendConversationContext(text); setDialog(null); notify('检查结果已加入对话草稿'); }}/>}
    </Dialog>}
    {dialog === 'reviews' && project && <Dialog title="批注与检查清单" subtitle="把设计意图绑定到几何，跟踪处理结果。" close={() => setDialog(null)}><ReviewPanel key={project.id} projectId={project.id} anchor={reviewAnchor} currentFile={asset?.path} currentHash={preview?.status === 'ready' && preview.url === modelUrl ? preview.identity?.sourceHash : undefined} revision={reviewRevision} busy={busy} locate={locateReview} context={text => { appendConversationContext(text); setDialog(null); notify('批注已加入对话草稿'); }}/></Dialog>}
    {dialog === 'scene' && <Dialog title="场景与特征" subtitle="查看装配、特征依赖与包内源码快照。" close={() => setDialog(null)}>{scenePackage ? <SceneInspector info={scenePackage} selectedNodeId={selection?.packageMesh?.nodeId} select={id => { view.current?.select(id); }} context={text => { appendConversationContext(text); setDialog(null); notify('特征信息已加入对话草稿'); }}/> : <div className="small-empty">当前没有已载入的场景包。</div>}</Dialog>}
    {dialog === 'plugins' && <PluginDialog plugins={plugins} refresh={refreshGlobal} close={() => setDialog(null)}/>}
    {dialog === 'settings' && <SettingsDialog status={status} refresh={async () => { await refreshGlobal(); postWorkspaceMessage('castudio:settings-changed', {}); }} close={() => setDialog(null)}/>}
    {/* Embedded, the host owns project creation, switching and naming (one project per workspace). */}
    {dialog === 'new' && !embedding.enabled && <Dialog title="新建设计项目" subtitle="每个项目保存独立的源码、模型和设计会话。" close={() => setDialog(null)}><form onSubmit={e => { e.preventDefault(); leaveSource(async () => { try { const created = await api.createProject(newName || '新设计'); openProject(created); setNewName(''); await refreshGlobal(); setDialog(null); } catch (e) { notify((e as Error).message); } }); }}><label className="field">项目名称<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：减速器安装支架" maxLength={80}/></label><button className="button primary full" type="submit"><Plus size={16}/>创建项目</button></form></Dialog>}
    {dialog === 'projects' && !embedding.enabled && <Dialog title="项目" subtitle="继续一个设计，或从新的想法开始。" close={() => setDialog(null)}><div className="project-list">{projects.map(p => <button key={p.id} onClick={() => { if (p.id === rootProject?.id) { setDialog(null); return; } leaveSource(() => { openProject(p); setDialog(null); }); }}><FolderOpen size={19}/><span><strong>{p.name}</strong><small>{new Date(p.updatedAt).toLocaleString()}</small></span>{rootProject?.id === p.id && <Check size={16}/>}</button>)}</div><form style={{marginTop: 14}} onSubmit={async event => {
  event.preventDefault()
  if (!project) return
  const name = String(new FormData(event.currentTarget).get('name') || '').trim()
  try {
    const updated = await api.renameProject((rootProject ?? project).id, name)
    setRootProject(updated); if (project.id === updated.id) setProject(updated)
    setProjects(list => list.map(item => item.id === updated.id ? updated : item))
    ;(event.currentTarget as HTMLFormElement).reset()
    notify(`已重命名为 ${updated.name}`)
  } catch (error) { notify((error as Error).message) }
}}><label className="field">重命名当前项目<input name="name" defaultValue={rootProject?.name ?? ''} maxLength={80}/></label><button className="button" type="submit">保存名称</button></form><button className="button primary full" onClick={() => setDialog('new')}><Plus size={16}/>新建项目</button></Dialog>}
    {dialog === 'rename' && project && !embedding.enabled && <Dialog title="重命名项目" subtitle="名称写入项目文件，项目列表与工作台立即更新。" close={() => setDialog(null)}><form onSubmit={async event => {
  event.preventDefault()
  if (!project) return
  const name = String(new FormData(event.currentTarget).get('name') || '').trim()
  try {
    const updated = await api.renameProject((rootProject ?? project).id, name)
    setRootProject(updated); if (project.id === updated.id) setProject(updated)
    setProjects(list => list.map(item => item.id === updated.id ? updated : item))
    notify(`已重命名为 ${updated.name}`)
    setDialog(null)
  } catch (error) { notify((error as Error).message) }
}}><label className="field">项目名称<input name="name" autoFocus defaultValue={project.name} maxLength={80}/></label><button className="button primary full" type="submit">保存名称</button></form></Dialog>}
    {pendingDiscard && <div className="ui-confirm" role="alertdialog" aria-label="确认放弃修改"><span>{pendingDiscard.text}</span><button className="button" autoFocus onClick={() => setPendingDiscard(null)}>取消</button><button className="button danger" onClick={() => { const next = pendingDiscard; setPendingDiscard(null); next.proceed(); }}>放弃修改</button></div>}
    {toast && <div className="toast" role="status"><Circle size={12}/><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={13}/></button></div>}
  </div>;
}
function SlidersIcon() { return <Settings2 size={13}/>; }
