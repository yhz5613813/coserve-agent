import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CadController, type CadProject } from './cad-controller.ts'
import { attachCadReference, cadPartReference, cadPartRule, cadPartSource, cadReference, cadReferenceRule, cadReferenceSource } from './cad-reference.ts'
import { CadPartReference, CadReference } from './CadReference.tsx'
import { PartChoice, type PartChoiceFace } from './PartChoice.tsx'
import { PartBadge } from './PartBadge.tsx'
import { partFolder, partSubgroup, recentParts, recommendPart } from './part-choice.ts'
import { CadWorkspace, CadOpenButton, type CadFace } from './CadWorkspace.tsx'
import { CadViewer } from './CadViewer.tsx'
import { CAD_VIEWER_ID, cadOpenTarget, cadViewerDefinition } from './cad-viewer.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh, en, type StudioKey } from './locales.ts'
import type { StudioBridge } from './types.ts'
import { createBrowserBridge } from './browser-bridge.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { castudio: StudioKey }
}

/** Attach CAD through public UI services; DSH retains the entire agent harness. */
export const inject = ['slots', 'locale', 'layout', 'theme', 'sidebarRight', 'sidebarRightTabs', 'workspaces', 'uiWorkspace', 'sessions', 'conversation', 'inputTriggers', 'uiConversation']

/** Register a CAD tab beside the original conversation, without a separate chat. */
export function apply(ctx: Context): void {
  // Desktop exposes a preload bridge; a browser reaches CAStudio through the gateway's same-origin `castudio/` mount.
  const bridge = (globalThis as typeof globalThis & { dshCAStudio?: StudioBridge }).dshCAStudio
    ?? createBrowserBridge(new URL('castudio/', document.baseURI))
  ctx.effect(() => ctx.locale.register('castudio', { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'castudio.locale')
  const t = ctx.locale.bind('castudio')
  ctx.effect(() => ctx.inputTriggers.registerSource(cadReferenceSource), 'castudio.reference-source')
  ctx.effect(() => ctx.uiConversation.userText.register(cadReferenceRule), 'castudio.reference-rule')
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'cad-selection',
  }, CadReference)), 'castudio.reference-view')
  ctx.effect(() => ctx.inputTriggers.registerSource(cadPartSource), 'castudio.part-source')
  ctx.effect(() => ctx.uiConversation.userText.register(cadPartRule), 'castudio.part-rule')
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'cad-part',
  }, CadPartReference)), 'castudio.part-view')
  // Workspace titles must be unique: another project may already carry the same name.
  // Try the plain title first, then numbered suffixes; never let this block opening the project.
  const renameWorkspace = async (workspaceId: Parameters<typeof ctx.workspaces.rename>[0], desired: string): Promise<void> => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const title = attempt === 1 ? desired : `${desired} (${attempt})`
      try { await ctx.workspaces.rename(workspaceId, title); return }
      catch (error) {
        const message = String((error as Error)?.message ?? error)
        if (!message.includes('name-conflict')) { console.warn('castudio: workspace title left unchanged', error); return }
      }
    }
    console.warn('castudio: workspace title left unchanged; every candidate name was taken')
  }
  const normalizePath = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const workspaceRow = (workspacePath: string) => ctx.workspaces.list.getSnapshot().items
    .find(row => normalizePath(row.path) === normalizePath(workspacePath))
  const workspaceIdle = (workspaceId: Parameters<typeof ctx.workspaces.delete>[0]): boolean => {
    const row = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    return row !== undefined && row.sessionIds.length === 0
  }
  /** Opening a project registers its workspace; a failed open must not leave that empty entry behind. */
  const openWorkspace = async (project: CadProject): Promise<void> => {
    const existing = workspaceRow(project.workspacePath)
    const workspace = existing ?? await ctx.workspaces.create({ path: project.workspacePath })
    try { await ctx.uiWorkspace.openWorkspace(workspace.workspaceId) }
    catch (error) {
      if (existing === undefined && workspaceIdle(workspace.workspaceId)) {
        try { await ctx.workspaces.delete(workspace.workspaceId) }
        catch { /* reopening a leftover empty entry is harmless; the failure still surfaces */ }
      }
      throw error
    }
    if (workspace.title !== project.name) await renameWorkspace(workspace.workspaceId, project.name)
  }
  /** Deleting a project drops its empty workspace too, so the sidebar keeps no dead entry. */
  const forgetWorkspace = async (project: CadProject): Promise<void> => {
    const workspace = workspaceRow(project.workspacePath)
    if (workspace === undefined || !workspaceIdle(workspace.workspaceId)) return
    try { await ctx.workspaces.delete(workspace.workspaceId) }
    catch { /* the project is gone either way; the sidebar entry can be removed from its own menu */ }
  }
  /**
   * CAD workspaces are created by this plugin, so a workspace whose project no longer exists can
   * never open again: drop that leftover. The project list is the authority, and an empty or
   * not-yet-loaded list is never evidence that every project disappeared.
   */
  const sweepOrphanWorkspaces = (): void => {
    const projects = controller.snapshot.getSnapshot().projects
    if (projects.length === 0) return
    const known = new Set(projects.map(project => project.id))
    for (const row of ctx.workspaces.list.getSnapshot().items) {
      const path = normalizePath(row.path)
      const owner = /\/\.coserve\/castudio\/projects\/([^/]+)\/workspace$/.exec(path)?.[1]
      if (row.sessionIds.length > 0 || owner === undefined || known.has(owner)) continue
      void ctx.workspaces.delete(row.workspaceId).catch(error => console.warn('castudio: stale project workspace left in place', error))
    }
  }
  const controller = new CadController(bridge, openWorkspace, forgetWorkspace)
  controller.setTheme(ctx.theme.getTheme().active.colorScheme)
  ctx.on('theme/change', theme => controller.setTheme(theme.active.colorScheme))
  controller.setLocale(ctx.locale.getLocale().active)
  ctx.on('locale/change', locale => controller.setLocale(locale.active))
  ctx.effect(() => () => controller.dispose(), 'castudio.controller')
  const face: CadFace = {
    hooks: { cad: controller.snapshot },
    refresh: () => { void controller.load() },
    restartService: () => { void controller.restartService() },
    createProject: async (name, mode) => {
      const created = await controller.create(name, mode)
      if (created) sweepOrphanWorkspaces()
      return created
    },
    openProject: id => controller.open(id),
    retryOpen: id => controller.retryOpen(id),
    deleteProject: async (id) => {
      const removed = await controller.remove(id)
      if (removed) sweepOrphanWorkspaces()
      return removed
    },
    dismissNotice: () => controller.dismissNotice(),
    renameProject: async (id, name) => {
      const renamed = await controller.rename(id, name)
      if (!renamed) return false
      // Keep the DSH sidebar entry in step with the project name; it is only a label.
      const project = controller.snapshot.getSnapshot().projects.find(item => item.id === id)
      if (project === undefined) return true
      const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      const workspace = ctx.workspaces.list.getSnapshot().items
        .find(row => normalize(row.path) === normalize(project.workspacePath))
      if (workspace !== undefined && workspace.title !== name) await renameWorkspace(workspace.workspaceId, name)
      return true
    },
    appendContext: (id, text) => {
      const binding = ctx.sessions.binding(id)
      if (binding) ctx.conversation.input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' })
    },
    attachSelection: (id, projectId, selection, span) => {
      const binding = ctx.sessions.binding(id)
      const reference = cadReference(projectId, selection, { face: t('cadFace'), triangle: t('cadTriangle') })
      if (binding && reference) attachCadReference(ctx.conversation.input.for(binding.ctx), reference, span)
    },
  }
  const tabId = '@deepseek-ai/dsh-client-ui-castudio/cad'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabId, kind: 'cad', priority: 'builtin', title: () => t('workspace'), keepMounted: true }), 'castudio.tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: tabId, locale: 'castudio', inject: () => face,
  }, CadWorkspace)), 'castudio.workspace')
  // CAD files opened from DSH's file tree show in the CAD tab; only Sessions inside a CAD project claim them.
  const viewerTarget = (address: string) => cadOpenTarget(
    address, id => ctx.sessions.list.getSnapshot().byId[id]?.cwd, controller.snapshot.getSnapshot().projects,
  )
  ctx.effect(() => ctx.sidebarRightTabs.register(cadViewerDefinition(viewerTarget, () => t('workspace'))), 'castudio.viewer-tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CAD_VIEWER_ID, locale: 'castudio',
    inject: () => ({
      openFile: (id: SessionId, address: string) => {
        const target = viewerTarget(address)
        if (target !== undefined) controller.requestOpen(id, target)
        return target !== undefined
      },
    }),
  }, CadViewer)), 'castudio.viewer')
  const openCad = () => { ctx.sidebarRight.openTab('cad') }
  // Open automatically only into an empty right sidebar: a tab the user selected, or a column
  // collapsed with its tabs kept, is never replaced.
  const autoOpenCad = () => { if (ctx.sidebarRight.active() === undefined) openCad() }
  const buttonFace = () => ({ hooks: { cad: controller.snapshot }, openCad, autoOpenCad })
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'cad-workspace', order: -10, locale: 'castudio', inject: buttonFace,
  }, CadOpenButton)), 'castudio.header')
  ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: 'cad-workspace', order: -10, locale: 'castudio', inject: buttonFace,
  }, CadOpenButton)), 'castudio.hero')
  // A blank CAD Session asks which part it continues; the answer is a chip its first, logged message carries.
  const declinedParts = createSnapshotStore<{ declined: SessionId[] }>({ declined: [] })
  const partChoiceFace = (sessionId: SessionId): PartChoiceFace => ({
    hooks: { cad: controller.snapshot, partDeclined: declinedParts },
    loadParts: async (project) => {
      const [parts, shown] = await Promise.all([controller.parts(project.id), controller.shownPart(project)])
      const recent = recentParts(Object.values(ctx.sessions.list.getSnapshot().byId), project.id)
      return { parts, recommended: recommendPart(parts, { recent, shown }) }
    },
    choosePart: (projectId, part) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      const input = ctx.conversation.input.for(binding.ctx)
      const reference = cadPartReference(projectId, part.slug, part.name, partFolder(part.slug))
      if (!input.insertReference(reference, { start: 0, end: 0, draftRev: input.state.getSnapshot().draftRev })) return
      openCad()
      // Show the part's first model, or the part alone when it has none yet.
      void controller.firstModel(part).then((path) => {
        controller.requestOpen(sessionId, { projectId, part: part.slug, ...(path !== undefined && { path }) })
      }, error => console.warn('castudio: the chosen part was not opened in the CAD tab', error))
    },
    decline: () => declinedParts.update((state) => { state.declined.push(sessionId) }),
  })
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'cad-part', order: -10, locale: 'castudio', inject: partChoiceFace,
  }, PartChoice)), 'castudio.part-choice')
  // Session rows show and group by the part each Session's `cadPart` summary value names.
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'cad-part', order: 0,
  }, PartBadge)), 'castudio.part-badge')
  ctx.effect(() => ctx.uiWorkspace.sessionSubgroups.register({ id: 'castudio.part', groupOf: partSubgroup }), 'castudio.part-subgroups')
  ctx.layout.selectPanel(null)
  void controller.load().then((loaded) => { if (loaded) sweepOrphanWorkspaces() })
  ctx.effect(() => ctx.workspaces.list.subscribe(sweepOrphanWorkspaces), 'castudio.workspace-sweep')
}
