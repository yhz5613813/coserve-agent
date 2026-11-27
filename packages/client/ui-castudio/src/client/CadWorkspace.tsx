import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectForWorkspace, type CadNotice, type CadState } from './cad-controller.ts'
import { cadThemeTokens } from './cad-theme.ts'
import type { StudioKey } from './locales.ts'
import type { StudioServiceFailure } from './types.ts'
import css from './CadWorkspace.module.css'

const SERVICE_REASON: Record<StudioServiceFailure, StudioKey> = {
  'unavailable': 'serviceUnavailable', 'spawn-failed': 'serviceSpawnFailed', 'data-locked': 'serviceDataLocked', 'port-in-use': 'servicePortInUse',
  'exited': 'serviceExitedReason', 'timeout': 'serviceTimeout', 'unreachable': 'serviceUnreachable', 'stopped': 'serviceStopped',
}

export interface CadFace {
  hooks: { cad: HostObservable<CadState> }
  openProject(id: string): Promise<boolean>
  createProject(name: string, mode: 'open' | 'keep'): Promise<boolean>
  renameProject(id: string, name: string): Promise<boolean>
  retryOpen(id: string): Promise<boolean>
  deleteProject(id: string): Promise<boolean>
  dismissNotice(): void
  refresh(): void
  /** Restart the CAStudio service; a failed project list reloads once it is ready. */
  restartService(): void
  appendContext(id: SessionId, text: string): void
  attachSelection(id: SessionId, projectId: string, selection: unknown, span: TokenSpan): void
}

/** Only the CAD surface is embedded; the native conversation stays its sole host. */
export function CadWorkspace(props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'castudio'> & InjectFace<CadFace>) {
  const state = props.useCad(value => value)
  const directory = props.useSessions(value => value.byId[props.sessionId]?.cwd)
  const busy = props.useSession(session => session.running)
  const project = projectForWorkspace(state.projects, directory)
  const frame = useRef<HTMLIFrameElement>(null)
  // The frame source whose page last reported `castudio:ready`. The report can precede the frame's `load` event,
  // so only a changed source makes the frame not ready again.
  const ready = useRef<string | undefined>(undefined)
  const sent = useRef(0)
  const open = state.openRequest
  const request = open?.sessionId === props.sessionId && open.projectId === project?.id ? open : undefined
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<'create' | 'rename' | null>(null)
  const [draft, setDraft] = useState('')
  const { t, sessionId, appendContext, attachSelection, inputActions } = props
  // Project names are free-form; only the DSH sidebar title has to be unique. A default that
  // collides would create a second "新设计" nobody can tell apart, so offer the next free one.
  const suggestedName = useMemo(() => {
    const base = t('newName')
    const taken = new Set(state.projects.map(item => item.name.trim().toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let index = 2; index < 100; index += 1) if (!taken.has(`${base} ${index}`.toLowerCase())) return `${base} ${index}`
    return base
  }, [state.projects, t])
  const trimmed = draft.trim()
  // Same-name projects are allowed on purpose; this only offers to reuse the one that exists.
  const duplicate = editing === 'create' && trimmed !== ''
    ? state.projects.find(item => item.name.trim().toLowerCase() === trimmed.toLowerCase())
    : undefined
  const notice = state.notice
  // A failed or exited service explains every request failure, so it replaces the generic error.
  const service = state.service?.state === 'failed' || state.service?.state === 'exited' ? state.service : undefined
  const openExisting = (id: string, done: () => void): void => { void props.openProject(id).then((opened) => { if (opened) done() }) }
  const submitEditing = (mode: 'open' | 'keep'): void => {
    const name = trimmed || t('newName')
    const action = editing === 'rename'
      ? project === undefined ? Promise.resolve(true) : props.renameProject(project.id, name)
      : props.createProject(name, mode)
    // Keep the editor open when the service rejects the action; the notice explains why.
    void action.then((saved) => { if (saved) setEditing(null) })
  }
  // Two sessions may open the same project: give each its own CAD instance so cameras,
  // selections and workbench commands never cross between conversations.
  // `theme` and `locale` only seed the first paint; later theme changes arrive as `castudio:theme`,
  // so they stay out of the dependencies and never reload the frame.
  const source = useMemo(() => {
    const base = project?.workspaceUrl
    if (base === undefined) return undefined
    const url = new URL(base)
    url.searchParams.set('client', sessionId)
    url.searchParams.set('theme', state.theme)
    url.searchParams.set('locale', state.locale)
    return url.href
  }, [project?.workspaceUrl, sessionId])
  useEffect(() => {
    if (!project) return
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(project.workspaceUrl).origin
        || event.data?.projectId !== project.id) return
      if (event.data.type === 'castudio:selection' && event.data.selection != null)
        attachSelection(sessionId, project.id, event.data.selection, inputActions.captureInsertion())
      if (event.data.type === 'castudio:draft' && typeof event.data.text === 'string' && event.data.text.trim())
        appendContext(sessionId, event.data.text)
      if (event.data.type === 'castudio:ready') { ready.current = source; sendTheme(); sendBusy(); sendOpen() }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [project, sessionId, appendContext, attachSelection, inputActions, state.theme, busy, request])
  const sendTheme = () => {
    if (project && frame.current) frame.current.contentWindow?.postMessage({
      type: 'castudio:theme', projectId: project.id, theme: state.theme, tokens: cadThemeTokens(frame.current),
    }, new URL(project.workspaceUrl).origin)
  }
  // Whether this Session's agent turn is running, so the workbench can reflect the conversation's activity.
  const sendBusy = () => {
    if (project && frame.current) frame.current.contentWindow?.postMessage({ type: 'castudio:busy', projectId: project.id, busy }, new URL(project.workspaceUrl).origin)
  }
  // A file or part DSH asked for: sent as soon as the frame is ready, and replayed on `castudio:ready` when it was not yet.
  const sendOpen = () => {
    if (!project || !frame.current || !request || sent.current === request.seq) return
    sent.current = request.seq
    const { path, part } = request
    frame.current.contentWindow?.postMessage({ type: 'castudio:open', projectId: project.id, ...(path !== undefined && { path }), ...(part !== undefined && { part }) }, new URL(project.workspaceUrl).origin)
  }
  useEffect(() => { if (ready.current === source) sendOpen() }, [project, request?.seq])
  useEffect(sendTheme, [project, state.theme])
  useEffect(sendBusy, [project, busy])
  const noticeText = (value: CadNotice): string => value.kind === 'created'
    ? t('createdNotice').replace('{name}', value.projectName)
    : `${t('openFailedNotice').replace('{name}', value.projectName)} ${value.message ?? ''}`.trim()
  return <section className={css.workspace} aria-label={t('workspace')}>
    <div className={css.toolbar}>
      {editing !== null ? <div className={css.rename}>
        <input autoFocus value={draft} maxLength={80} aria-label={editing === 'create' ? t('newProject') : t('rename')}
          placeholder={editing === 'create' ? t('newName') : undefined}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitEditing('open')
            if (event.key === 'Escape') setEditing(null)
          }}/>
        {editing === 'create' ? <>
          <Button size="sm" disabled={state.pending} onClick={() => submitEditing('open')}>{t('createAndOpen')}</Button>
          <Button size="sm" disabled={state.pending} onClick={() => submitEditing('keep')}>{t('createOnly')}</Button>
        </> : <Button size="sm" disabled={state.pending} onClick={() => submitEditing('open')}>{t('saveName')}</Button>}
        <Button size="sm" disabled={state.pending} onClick={() => setEditing(null)}>{t('cancelRename')}</Button>
      </div> : <>
        <Menu open={menu} onClose={() => setMenu(false)} portal compact selectedId={project?.id}
          items={state.projects.map(item => ({ id: item.id, label: item.name }))}
          onSelect={(id) => { setMenu(false); setEditing(null); void props.openProject(id) }}
          anchor={<Button className={css.project} size="sm" disabled={state.pending} aria-label={t('projects')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{project?.name ?? t('pickProject')}</Button>} />
        <Button size="sm" disabled={state.pending || project === undefined} onClick={() => { setDraft(project?.name ?? ''); setEditing('rename') }}>{t('rename')}</Button>
        <Button size="sm" disabled={state.pending} onClick={() => { setDraft(suggestedName); setEditing('create') }}>{t('newProject')}</Button>
        <Button size="sm" disabled={state.pending} onClick={props.refresh}>{t('refresh')}</Button>
      </>}
    </div>
    {duplicate && <div className={css.hint} role="status">
      <span>{t('nameTaken').replace('{name}', duplicate.name)}</span>
      <Button size="sm" onClick={() => openExisting(duplicate.id, () => setEditing(null))}>{t('openExisting')}</Button>
    </div>}
    {notice && <div className={css.notice} role="status" data-notice={notice.kind}>
      <span className={css.noticeText}>{noticeText(notice)}</span>
      <span className={css.noticeActions}>
        {notice.kind === 'created' && <Button size="sm" disabled={state.pending}
          onClick={() => openExisting(notice.projectId, props.dismissNotice)}>{t('openProject')}</Button>}
        {notice.kind === 'open-failed' && <Button size="sm" disabled={state.pending}
          onClick={() => { void props.retryOpen(notice.projectId) }}>{t('retry')}</Button>}
        <Button size="sm" disabled={state.pending}
          onClick={() => { void props.deleteProject(notice.projectId) }}>{t('deleteProject')}</Button>
        <Button size="sm" disabled={state.pending} onClick={props.dismissNotice}>{t('dismiss')}</Button>
      </span>
    </div>}
    {service !== undefined ? <div className={css.notice} role="alert" data-service={service.state}>
      <span className={css.noticeText} title={service.detail}>
        {t(service.state === 'exited' ? 'serviceExited' : 'serviceFailed')} {t(SERVICE_REASON[service.reason])}
      </span>
      <span className={css.noticeActions}>
        <Button size="sm" disabled={state.pending} onClick={props.restartService}>{t('serviceRestart')}</Button>
      </span>
    </div> : state.error && <div className={css.notice} role="alert">
      {state.error.kind === 'connection' ? t('connectionFailed') : t('operationFailed')} {state.error.message}
    </div>}
    {project ? <iframe ref={frame} key={`${project.id}:${sessionId}:${state.serviceEpoch}`} className={css.frame} title={t('workspace')} src={source} onLoad={() => sendTheme()} />
      : <div className={css.empty} role="status">{state.pending ? t('loading') : t('pickProjectHint')}</div>}
  </section>
}

/**
 * Contribute one utility to DSH's existing conversation header. A CAD Session offers the CAD tab
 * through `autoOpenCad`, which leaves any tab the user already shows or collapsed in place.
 */
export function CadOpenButton(props: PropsRuntime<'conversation.hero.options'> & PropsLocale<'castudio'> & InjectFace<{ hooks: { cad: HostObservable<CadState> }; openCad(): void; autoOpenCad(): void }>) {
  const projects = props.useCad(value => value.projects)
  const directory = props.useSessions(value => value.byId[props.sessionId]?.cwd)
  const project = projectForWorkspace(projects, directory)
  useEffect(() => { if (project) props.autoOpenCad() }, [project?.id, props.sessionId, props.autoOpenCad])
  return <Button size="sm" onClick={props.openCad}>{props.t('workspace')}</Button>
}
