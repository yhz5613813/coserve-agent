import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, CodeBlock, DisclosureRow, FishLogo, IconApiOutlineRegular, IconBrowseOutlineRegular,
  IconChevronDownOutlineRegular, IconCodeOutlineRegular, IconEditOutlineRegular,
  IconFolderOpenOutlineRegular, IconLoadingOutlineRegular, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, MarkdownText, Menu, UserMessageBubble,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { StudioRow, StudioState } from './types.ts'
import type { StudioKey } from './locales.ts'
import css from './StudioPanel.module.css'

/** The registration owns subscriptions; this component receives its framework-bound hook. */
export interface StudioFace {
  hooks: { studio: HostObservable<StudioState> }
  refresh(): void
  createProject(): void
  selectProject(projectId: string): void
  setDraft(text: string): void
  clearSelection(): void
  send(): void
  stop(): void
  selectModel(value: string): void
  bindWorkbench(element: HTMLIFrameElement | null): void
  workbenchLoaded(): void
}
type StudioPanelProps = PropsRuntime<'main'> & PropsLocale<'castudio'> & InjectFace<StudioFace>

/** Pi tool names mapped to the native DSH tool-category artwork. */
const TOOL_ICONS = new Map([
  ['read', <IconBrowseOutlineRegular size={14} />],
  ['ls', <IconBrowseOutlineRegular size={14} />],
  ['write', <IconEditOutlineRegular size={14} />],
  ['edit', <IconEditOutlineRegular size={14} />],
  ['grep', <IconSearchOutlineRegular size={14} />],
  ['find', <IconSearchOutlineRegular size={14} />],
  ['bash', <IconApiOutlineRegular size={14} />],
  ['powershell', <IconApiOutlineRegular size={14} />],
])

/** Use the shell's standard sidebar glyph size and inherited ink. */
export function StudioPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconCodeOutlineRegular size={size} />
}

/** Tool output uses the same compact disclosure as the native conversation. */
export function StudioTool({ message, t }: { message: StudioRow; t: (key: StudioKey) => string }) {
  const [open, setOpen] = useState(false)
  const title = message.toolName === 'read' ? t('toolRead')
    : message.toolName === 'write' ? t('toolWrite')
      : message.toolName === 'edit' ? t('toolEdit') : message.toolName ?? t('tool')
  const args = message.args
  const summary = args && typeof args === 'object'
    ? 'path' in args && typeof args.path === 'string' ? args.path
      : 'command' in args && typeof args.command === 'string' ? args.command
        : 'pattern' in args && typeof args.pattern === 'string' ? args.pattern : ''
    : ''
  const copyLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }
  return <DisclosureRow className={css.tool} icon={TOOL_ICONS.get(message.toolName ?? '') ?? <IconSparkleRegular size={14} />}
    title={title} open={open} expandable expandOnRowClick keepContentWhenOpen running={message.pending ?? false}
    contentLayoutClassName={css.toolHeading}
    onToggle={() => setOpen(!open)} collapsedContent={summary ? <span className={css.toolPath} title={summary}>{summary}</span> : undefined}
    headerAccessory={message.error ? <span className={css.toolFailure}>{t('toolFailed')}</span> : undefined}>
    <section className={css.toolDetails} aria-label={t('toolDetails')}>
      <div className={css.toolMeta}><code>{message.toolName ?? t('tool')}</code><span>{message.error ? t('toolFailed') : message.pending ? t('toolRunning') : t('toolDone')}</span></div>
      <div className={css.toolSectionLabel}>{t('toolInput')}</div>
      {args === undefined ? <p className={css.toolNotice}>{t('toolInputUnavailable')}</p>
        : <CodeBlock className={css.toolCode} code={JSON.stringify(args, null, 2)} lang="json" {...copyLabels} />}
      <div className={css.toolSectionLabel}>{t('toolOutput')}</div>
      {message.text ? <CodeBlock className={css.toolCode} code={message.text} streaming={message.pending} {...copyLabels} />
        : <p className={css.toolNotice}>{message.pending ? t('toolWaiting') : t('toolNoOutput')}</p>}
    </section>
  </DisclosureRow>
}

/** Native conversation controls and the existing CAstudio CAD surface share one project. */
export function StudioPanel(props: StudioPanelProps) {
  const { t } = props
  const state = props.useStudio(value => value)
  const [workspaceShown, showWorkspace] = useState(true)
  const [menu, setMenu] = useState<'model' | 'actions' | 'project' | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const labels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t])
  // Scroll position belongs to this mounted viewport. CSS cannot follow an appended row
  // while preserving a reader who has intentionally scrolled into earlier history.
  useEffect(() => {
    if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [state.messages])
  useEffect(() => { following.current = true }, [state.projectId])
  const activeModel = state.status ? `${state.status.settings.provider}/${state.status.settings.model}` : ''
  const modelName = state.status?.models.find(model => `${model.provider}/${model.id}` === activeModel)?.name ?? t('noModel')
  const projectName = state.projects.find(project => project.id === state.projectId)?.name ?? t('newName')
  const empty = state.phase === 'ready' && !state.messages.length
  return <section className={css.panel} aria-label={t('title')}>
    <header className={css.header}>
      <div className={css.identity}><IconCodeOutlineRegular size={20} /><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div></div>
      <div className={css.projectControls}>
        <select aria-label={t('projects')} value={state.projectId ?? ''} disabled={state.pending} onChange={event => props.selectProject(event.target.value)}>
          {state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <Button size="sm" title={t('newProject')} aria-label={t('newProject')} icon={<IconPlusOutlineRegular size={16} />} disabled={state.pending} onClick={props.createProject} />
        <Button size="sm" title={t('refresh')} aria-label={t('refresh')} icon={<IconRefreshOutlineRegular size={16} />} disabled={state.pending} onClick={props.refresh} />
        <Button size="sm" onClick={() => showWorkspace(!workspaceShown)}>{workspaceShown ? t('hideWorkspace') : t('showWorkspace')}</Button>
      </div>
    </header>
    <div className={css.body} data-workspace={workspaceShown}>
      <section className={css.chat} data-empty={empty} aria-label={t('assistant')}>
        {state.error && <div className={css.error} role="alert"><span>{state.error}</span><Button size="sm" disabled={state.pending} onClick={props.refresh}>{t('retry')}</Button></div>}
        <div className={css.transcript} ref={transcript} onScroll={(event) => {
          const node = event.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
        }}>
          {state.phase === 'loading' && !state.messages.length && <div className={css.empty}><IconLoadingOutlineRegular className={css.spinner} size={24} /><span>{t('loading')}</span></div>}
          <div className={css.messageColumn}>
            {state.messages.map(message => message.role === 'user'
              ? <div key={message.id} className={css.userRow}>
                <UserMessageBubble className={css.userText}>{message.text}</UserMessageBubble>
              </div>
              : message.role === 'tool' ? <StudioTool key={message.id} message={message} t={t} />
                : <article key={message.id} className={css.assistant} data-error={message.error || undefined}>
                  {message.role === 'system' && <div className={css.messageLabel}>{t('system')}</div>}
                  <MarkdownText text={message.text} streaming={message.pending ?? false} labels={labels} />
                </article>)}
          </div>
        </div>
        <div className={css.composerArea}>
          {empty && <>
            <div className={css.headline}><FishLogo size={34} /><div className={css.heroTitle}><h2>{t('empty')}</h2><span className={css.preview}>{t('preview')}</span></div></div>
            <div className={css.workspaceRow}><Menu open={menu === 'project'} onClose={() => setMenu(null)} portal compact
              selectedId={state.projectId ?? undefined} items={state.projects.map(project => ({ id: project.id, label: project.name }))}
              onSelect={(id) => { setMenu(null); props.selectProject(id) }}
              anchor={<button className={css.workspaceChip} aria-label={t('projects')} aria-haspopup="menu" aria-expanded={menu === 'project'} disabled={state.pending} onClick={() => setMenu(menu === 'project' ? null : 'project')}><IconFolderOpenOutlineRegular size={16} /><span>{projectName}</span><IconChevronDownOutlineRegular size={12} /></button>} />
            </div>
          </>}
          <div className={css.composer}>
            {state.selection != null && <div className={css.selection}><span>{t('selection')}</span><Button size="sm" onClick={props.clearSelection}>{t('clearSelection')}</Button></div>}
            <textarea rows={1} aria-label={t('placeholder')} placeholder={t('placeholder')} value={state.draft} onChange={event => props.setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); props.send() }
            }} />
            <div className={css.composerFooter}>
              <Menu open={menu === 'actions'} onClose={() => setMenu(null)} side="top" portal compact
                items={[{ id: 'new', label: t('newProject'), icon: <IconPlusOutlineRegular size={16} /> }, { id: 'refresh', label: t('refresh'), icon: <IconRefreshOutlineRegular size={16} /> }]}
                onSelect={(id) => { setMenu(null); if (id === 'new') props.createProject(); else props.refresh() }}
                anchor={<button className={css.plusButton} title={t('moreActions')} aria-label={t('moreActions')} aria-haspopup="menu" aria-expanded={menu === 'actions'} disabled={state.pending} onClick={() => setMenu(menu === 'actions' ? null : 'actions')}><IconPlusOutlineRegular size={18} /></button>} />
              <div className={css.trailing}>
                <Menu open={menu === 'model'} onClose={() => setMenu(null)} side="top" align="end" portal compact selectedId={activeModel}
                  items={state.status?.models.map(model => ({ id: `${model.provider}/${model.id}`, label: model.name })) ?? []}
                  onSelect={(id) => { setMenu(null); props.selectModel(id) }}
                  anchor={<button className={css.modelChip} title={modelName} aria-label={t('model')} aria-haspopup="menu" aria-expanded={menu === 'model'} disabled={state.busy || state.pending || !state.status?.models.length} onClick={() => setMenu(menu === 'model' ? null : 'model')}><span>{modelName}</span><IconChevronDownOutlineRegular size={12} /></button>} />
                <button className={css.primaryButton} title={state.busy ? t('stop') : t('send')} aria-label={state.busy ? t('stop') : t('send')}
                  disabled={state.pending || (!state.busy && (!state.connected || !state.draft.trim() || !state.status?.hasCredentials))}
                  onClick={state.busy ? props.stop : props.send}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{state.busy ? <rect x="3" y="3" width="10" height="10" rx="3" /> : <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" />}</svg>
                </button>
              </div>
            </div>
          </div>
          <div className={css.composerDock}>{!state.status?.hasCredentials && state.phase === 'ready' && <span>{t('noCredentials')}</span>}</div>
        </div>
      </section>
      {workspaceShown && <section className={css.workspace} aria-label={t('workspace')}>
        {state.workspaceUrl ? <iframe key={state.projectId} ref={props.bindWorkbench} src={state.workspaceUrl} title={t('workspace')} allow="clipboard-read; clipboard-write" onLoad={props.workbenchLoaded} />
          : <div className={css.empty}><IconCodeOutlineRegular size={28} /><span>{t('workspace')}</span></div>}
      </section>}
    </div>
  </section>
}
