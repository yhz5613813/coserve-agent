// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { CadOpenButton, CadWorkspace } from '../src/client/CadWorkspace.tsx'
import { zh } from '../src/client/locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CadState } from '../src/client/cad-controller.ts'

afterEach(cleanup)
const base: CadState = {
  pending: false, error: null, notice: null, theme: 'light', locale: 'zh', openRequest: null, service: null, serviceEpoch: 0,
  projects: [{ id: 'cad-one', name: 'CAD', workspacePath: 'C:/CAD', workspaceUrl: 'http://127.0.0.1:4317/?embedded=1&harness=dsh&project=cad-one' }],
}
const props = (cwd = 'C:/CAD', state: CadState = base, running = false) => ({
  sessionId: 'native-session', t: (key: keyof typeof zh) => zh[key],
  useCad: (select: (state: CadState) => unknown) => select(state),
  useSessions: (select: (sessions: { byId: Record<string, { cwd: string }> }) => unknown) => select({ byId: { 'native-session': { cwd } } }),
  useSession: (select: (session: { running: boolean }) => unknown) => select({ running }),
  openProject: vi.fn(async () => true), createProject: vi.fn(async () => true), renameProject: vi.fn(async () => true),
  retryOpen: vi.fn(async () => true), deleteProject: vi.fn(async () => true), dismissNotice: vi.fn(),
  refresh: vi.fn(), restartService: vi.fn(), appendContext: vi.fn(), attachSelection: vi.fn(), openCad: vi.fn(), autoOpenCad: vi.fn(),
  inputActions: { captureInsertion: () => ({ start: 3, end: 3, draftRev: 2 }) },
})

function renderCad(face: ReturnType<typeof props>) {
  return render(<CadWorkspace {...face as unknown as ComponentProps<typeof CadWorkspace>} />)
}

it('sends resolved native styling when the trusted iframe becomes ready after its load event', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  frame.style.setProperty('--dsw-alias-bg-base', 'rgb(20, 20, 20)')
  frame.style.fontFamily = 'Segoe UI'
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const ready = { type: 'castudio:ready', projectId: 'cad-one' }
  fireEvent(window, new MessageEvent('message', { source: window, origin: 'http://127.0.0.1:4317', data: ready }))
  expect(post).not.toHaveBeenCalled()
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:4317', data: ready }))
  expect(post).toHaveBeenCalledWith(expect.objectContaining({
    type: 'castudio:theme', projectId: 'cad-one', tokens: expect.objectContaining({ '--embed-bg': 'rgb(20, 20, 20)', '--embed-font': '"Segoe UI"' }),
  }), 'http://127.0.0.1:4317')
  expect(post).toHaveBeenCalledWith({ type: 'castudio:busy', projectId: 'cad-one', busy: false }, 'http://127.0.0.1:4317')
  post.mockRestore()
})

it('seeds the frame with the initial theme and locale and keeps it loaded across theme changes', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  const source = new URL(frame.src)
  expect(source.searchParams.get('client')).toBe('native-session')
  expect(source.searchParams.get('theme')).toBe('light')
  expect(source.searchParams.get('locale')).toBe('zh')
  view.rerender(<CadWorkspace {...props('C:/CAD', { ...base, theme: 'dark' }) as unknown as ComponentProps<typeof CadWorkspace>} />)
  expect(view.getByTitle('CAD 工作台')).toBe(frame)
  expect(frame.src).toBe(source.href)
})

it('tells the frame whenever the Session agent turn starts or stops running', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  view.rerender(<CadWorkspace {...props('C:/CAD', base, true) as unknown as ComponentProps<typeof CadWorkspace>} />)
  expect(post).toHaveBeenCalledWith({ type: 'castudio:busy', projectId: 'cad-one', busy: true }, 'http://127.0.0.1:4317')
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'castudio:theme' }), expect.anything())
  post.mockRestore()
})

it('attaches viewport choices through native references while leaving draft text alone', () => {
  const face = props()
  const view = renderCad(face)
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  const selection = { meshId: 'ring', name: '定位环', file: 'model.step', isDemo: false }
  const message = { type: 'castudio:selection', projectId: 'cad-one', selection }
  fireEvent(window, new MessageEvent('message', { source: window, origin: 'http://127.0.0.1:4317', data: message }))
  expect(face.attachSelection).not.toHaveBeenCalled()
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:4317', data: message }))
  expect(face.attachSelection).toHaveBeenCalledWith('native-session', 'cad-one', selection, { start: 3, end: 3, draftRev: 2 })
  expect(face.appendContext).not.toHaveBeenCalled()
})

it('routes only messages from the active CAD frame and project into the native draft', () => {
  const face = props()
  const view = renderCad(face)
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  const message = { type: 'castudio:draft', projectId: 'cad-one', text: 'Inspect this face' }
  fireEvent(window, new MessageEvent('message', { source: window, origin: 'http://127.0.0.1:4317', data: message }))
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'https://other.example', data: message }))
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:4317', data: { ...message, projectId: 'other' } }))
  expect(face.appendContext).not.toHaveBeenCalled()
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:4317', data: message }))
  expect(face.appendContext).toHaveBeenCalledWith('native-session', message.text)
})

it('offers the CAD surface automatically for a CAD session and keeps the explicit action available elsewhere', () => {
  const face = props()
  const view = render(<CadOpenButton {...face as unknown as ComponentProps<typeof CadOpenButton>} />)
  expect(face.autoOpenCad).toHaveBeenCalledTimes(1)
  expect(face.openCad).not.toHaveBeenCalled()
  const unrelated = props('C:/other')
  view.rerender(<CadOpenButton {...unrelated as unknown as ComponentProps<typeof CadOpenButton>} />)
  expect(unrelated.autoOpenCad).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'CAD 工作台' }))
  expect(unrelated.openCad).toHaveBeenCalledTimes(1)
})

it('suggests a free project name and lets the user create it in place or in a new session', async () => {
  const face = props('C:/other')
  const view = renderCad(face)
  fireEvent.click(view.getByRole('button', { name: '新建项目' }))
  const input = view.getByRole('textbox', { name: '新建项目' }) as HTMLInputElement
  expect(input.value).toBe('新设计')
  fireEvent.click(view.getByRole('button', { name: '创建并打开' }))
  await waitFor(() => expect(face.createProject).toHaveBeenCalledWith('新设计', 'open'))
  await waitFor(() => expect(view.queryByRole('textbox', { name: '新建项目' })).toBeNull())
})

it('creates without switching sessions when the user asks for creation only', async () => {
  const face = props('C:/other')
  const view = renderCad(face)
  fireEvent.click(view.getByRole('button', { name: '新建项目' }))
  fireEvent.change(view.getByRole('textbox', { name: '新建项目' }), { target: { value: '齿轮箱' } })
  fireEvent.click(view.getByRole('button', { name: '仅创建' }))
  await waitFor(() => expect(face.createProject).toHaveBeenCalledWith('齿轮箱', 'keep'))
})

it('keeps the name editor open when creation is rejected', async () => {
  const face = props('C:/other')
  face.createProject.mockResolvedValueOnce(false)
  const view = renderCad(face)
  fireEvent.click(view.getByRole('button', { name: '新建项目' }))
  fireEvent.click(view.getByRole('button', { name: '创建并打开' }))
  await waitFor(() => expect(face.createProject).toHaveBeenCalled())
  expect(view.getByRole('textbox', { name: '新建项目' })).toBeTruthy()
})

it('offers the existing project when the typed name is already in use', async () => {
  const face = props('C:/other')
  const view = renderCad(face)
  fireEvent.click(view.getByRole('button', { name: '新建项目' }))
  fireEvent.change(view.getByRole('textbox', { name: '新建项目' }), { target: { value: 'CAD' } })
  expect(view.getByText(zh.nameTaken.replace('{name}', 'CAD'))).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '打开已有项目' }))
  await waitFor(() => expect(face.openProject).toHaveBeenCalledWith('cad-one'))
})

it('reports a created project with explicit open, delete and dismiss actions', async () => {
  const state: CadState = { ...base, notice: { kind: 'created', projectId: 'cad-one', projectName: 'CAD' } }
  const face = props('C:/other', state)
  const view = renderCad(face)
  expect(view.getByText(zh.createdNotice.replace('{name}', 'CAD'))).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '打开' }))
  await waitFor(() => expect(face.openProject).toHaveBeenCalledWith('cad-one'))
  await waitFor(() => expect(face.dismissNotice).toHaveBeenCalled())
  fireEvent.click(view.getByRole('button', { name: '删除项目' }))
  await waitFor(() => expect(face.deleteProject).toHaveBeenCalledWith('cad-one'))
  fireEvent.click(view.getByRole('button', { name: '收起' }))
  expect(face.dismissNotice).toHaveBeenCalledTimes(2)
})

it('turns a failed workspace open into a retryable notice rather than a connection error', () => {
  const state: CadState = { ...base, notice: { kind: 'open-failed', projectId: 'cad-one', projectName: 'CAD', message: 'workspace busy' } }
  const face = props('C:/other', state)
  const view = renderCad(face)
  expect(view.getByText(`${zh.openFailedNotice.replace('{name}', 'CAD')} workspace busy`)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '重试' }))
  expect(face.retryOpen).toHaveBeenCalledWith('cad-one')
  fireEvent.click(view.getByRole('button', { name: '删除项目' }))
  expect(face.deleteProject).toHaveBeenCalledWith('cad-one')
})

it('names connection failures and rejected actions differently', () => {
  const connection = renderCad(props('C:/other', { ...base, error: { kind: 'connection', message: 'fetch failed' } }))
  expect(connection.getByRole('alert').textContent).toContain('无法连接 CAStudio')
  cleanup()
  const operation = renderCad(props('C:/other', { ...base, error: { kind: 'operation', message: '项目里还有 2 个文件' } }))
  expect(operation.getByRole('alert').textContent).toContain('操作失败：')
  expect(operation.getByRole('alert').textContent).toContain('项目里还有 2 个文件')
})

it('explains a failed service instead of the request error and offers a restart', () => {
  const service = { state: 'failed', reason: 'data-locked', detail: 'code 75' } as const
  const face = props('C:/other', { ...base, service, error: { kind: 'operation', message: 'CAStudio service is not available' } })
  const view = renderCad(face)
  expect(view.getByRole('alert').textContent).toBe(`${zh.serviceFailed} ${zh.serviceDataLocked}${zh.serviceRestart}`)
  fireEvent.click(view.getByRole('button', { name: zh.serviceRestart }))
  expect(face.restartService).toHaveBeenCalledTimes(1)
})

const origin = 'http://127.0.0.1:4317'
const withRequest = (request: Partial<NonNullable<CadState['openRequest']>> = {}): CadState => ({
  ...base, openRequest: { seq: 1, sessionId: 'native-session' as SessionId, projectId: 'cad-one', path: 'a.step', ...request },
})

const asProps = <T,>(face: ReturnType<typeof props>): T => face as T
const rerenderCad = (view: ReturnType<typeof renderCad>, face: ReturnType<typeof props>) =>
  view.rerender(<CadWorkspace {...asProps<ComponentProps<typeof CadWorkspace>>(face)} />)

it('replays a file requested before the frame is ready once it reports ready, and only once', () => {
  const view = renderCad(props('C:/CAD', withRequest({ part: 'arm', path: 'b.stl' })))
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const ready = new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'castudio:ready', projectId: 'cad-one' } })
  fireEvent(window, ready)
  expect(post).toHaveBeenCalledWith({ type: 'castudio:open', projectId: 'cad-one', path: 'b.stl', part: 'arm' }, origin)
  fireEvent(window, ready)
  expect(post.mock.calls.filter(([message]) => (message as { type: string }).type === 'castudio:open')).toHaveLength(1)
  post.mockRestore()
})

it('sends a new file request straight away once the frame is ready, without a part for the default part', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'castudio:ready', projectId: 'cad-one' } }))
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  rerenderCad(view, props('C:/CAD', withRequest()))
  expect(post).toHaveBeenCalledWith({ type: 'castudio:open', projectId: 'cad-one', path: 'a.step' }, origin)
  rerenderCad(view, props('C:/CAD', withRequest({ seq: 2, path: 'c.glb' })))
  expect(post).toHaveBeenLastCalledWith({ type: 'castudio:open', projectId: 'cad-one', path: 'c.glb' }, origin)
  post.mockRestore()
})

it('keeps the frame ready when its load event follows the ready report', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'castudio:ready', projectId: 'cad-one' } }))
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  fireEvent.load(frame)
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'castudio:theme' }), origin)
  rerenderCad(view, props('C:/CAD', withRequest()))
  expect(post).toHaveBeenCalledWith({ type: 'castudio:open', projectId: 'cad-one', path: 'a.step' }, origin)
  post.mockRestore()
})

it('holds a file request back after the frame source changes until the new page reports ready and ignores requests for another Session or project', () => {
  const view = renderCad(props())
  const title = 'CAD 工作台', moved = 'http://127.0.0.1:4318'
  fireEvent(window, new MessageEvent('message', { source: (view.getByTitle(title) as HTMLIFrameElement).contentWindow, origin, data: { type: 'castudio:ready', projectId: 'cad-one' } }))
  const relocated = (request: Partial<NonNullable<CadState['openRequest']>> = {}): CadState => ({
    ...withRequest(request), projects: [{ ...base.projects[0]!, workspaceUrl: `${moved}/?embedded=1&harness=dsh&project=cad-one` }],
  })
  rerenderCad(view, props('C:/CAD', relocated()))
  // jsdom may replace the frame's window when its source changes, so the spy is taken after the change;
  // a request already sent to the old page would not be sent again below.
  const target = (view.getByTitle(title) as HTMLIFrameElement).contentWindow!
  const post = vi.spyOn(target, 'postMessage')
  fireEvent(window, new MessageEvent('message', { source: target, origin: moved, data: { type: 'castudio:ready', projectId: 'cad-one' } }))
  expect(post).toHaveBeenCalledWith({ type: 'castudio:open', projectId: 'cad-one', path: 'a.step' }, moved)
  post.mockClear()
  for (const other of [{ sessionId: 'other-session' as SessionId }, { projectId: 'other' }])
    rerenderCad(view, props('C:/CAD', relocated({ seq: 5, ...other })))
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'castudio:open' }), expect.anything())
  post.mockRestore()
})

it('opens a chosen part without a path when the part has no model file yet', () => {
  const view = renderCad(props())
  const frame = view.getByTitle('CAD 工作台') as HTMLIFrameElement
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'castudio:ready', projectId: 'cad-one' } }))
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  rerenderCad(view, props('C:/CAD', { ...base, openRequest: { seq: 1, sessionId: 'native-session' as SessionId, projectId: 'cad-one', part: 'lid' } }))
  expect(post).toHaveBeenCalledWith({ type: 'castudio:open', projectId: 'cad-one', part: 'lid' }, origin)
  post.mockRestore()
})
