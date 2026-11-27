// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { sessionFileAddress, absoluteFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CadViewer } from '../src/client/CadViewer.tsx'
import { CAD_VIEWER_ID, cadOpenTarget, cadViewerDefinition } from '../src/client/cad-viewer.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const projects = [{ id: 'cad-one', name: 'CAD', workspacePath: 'C:\\CAD\\one', workspaceUrl: 'http://127.0.0.1:4317/?project=cad-one' }]
const cwdOf = (id: string) => id === 's1' ? 'C:/CAD/one' : id === 's2' ? '/elsewhere' : undefined
const target = (address: string) => cadOpenTarget(address, cwdOf as (id: SessionId) => string | undefined, projects)

describe('cadOpenTarget', () => {
  it('names the project file of a Session rooted in a CAD project', () => {
    expect(target(sessionFileAddress('s1', 'models/a.step'))).toEqual({ projectId: 'cad-one', path: 'models/a.step' })
  })

  it('splits a part prefix off the path', () => {
    expect(target(sessionFileAddress('s1', 'parts/arm/b.stl'))).toEqual({ projectId: 'cad-one', part: 'arm', path: 'b.stl' })
    expect(target(sessionFileAddress('s1', 'parts/b.stl'))).toEqual({ projectId: 'cad-one', path: 'parts/b.stl' })
    expect(target(sessionFileAddress('s1', 'parts//b.stl'))).toEqual({ projectId: 'cad-one', path: 'parts//b.stl' })
  })

  it('makes an absolute path inside the workspace relative and rejects one outside it', () => {
    expect(target(sessionFileAddress('s1', 'C:/CAD/one/parts/arm/c.glb'))).toEqual({ projectId: 'cad-one', part: 'arm', path: 'c.glb' })
    expect(target(sessionFileAddress('s1', 'C:/other/c.glb'))).toBeUndefined()
  })

  it('declines addresses without a CAD project: another Session, an unknown Session, or no Session at all', () => {
    expect(target(sessionFileAddress('s2', 'a.step'))).toBeUndefined()
    expect(target(sessionFileAddress('s3', 'a.step'))).toBeUndefined()
    expect(target(absoluteFileAddress('/x/a.step'))).toBeUndefined()
    expect(target('dsh-resource://web/x')).toBeUndefined()
  })
})

describe('cadViewerDefinition', () => {
  const title = () => 'CAD'
  const definition = cadViewerDefinition(target, title)

  it('claims the CAD file types and a separate kind from the CAD page', () => {
    expect(definition).toMatchObject({ id: CAD_VIEWER_ID, kind: 'cad-viewer', title })
    expect(definition.kind).not.toBe('cad')
    expect(definition.patterns).toEqual(['*.step', '*.stp', '*.stl', '*.glb', '*.gltf', '*.obj', '*.CATPart', '*.CATProduct'])
  })

  it('vetoes files outside a CAD project', () => {
    expect(definition.canOpen!(sessionFileAddress('s1', 'a.step'))).toBe(true)
    expect(definition.canOpen!(sessionFileAddress('s2', 'a.step'))).toBe(false)
  })
})

const asProps = <T,>(value: object): T => value as T

describe('CadViewer', () => {
  const tab = (revision: number) => {
    const actions = { openTab: vi.fn(), close: vi.fn() }
    return { actions, info: { tab: { navigation: { address: sessionFileAddress('s1', 'a.step'), revision }, actions } } }
  }
  const renderViewer = (revision: number, known: boolean) => {
    const { actions, info } = tab(revision)
    const openFile = vi.fn(() => known)
    const props = { sessionId: 's1', t: (key: keyof typeof zh) => zh[key], useTabInfo: () => info, openFile }
    const view = render(<CadViewer {...asProps<ComponentProps<typeof CadViewer>>(props)} />)
    return { actions, openFile, view }
  }

  it('records the request, switches to the CAD tab in its place and closes itself', () => {
    const { actions, openFile, view } = renderViewer(1, true)
    expect(openFile).toHaveBeenCalledWith('s1', sessionFileAddress('s1', 'a.step'))
    expect(actions.openTab).toHaveBeenCalledWith('cad', { replaceTab: true })
    expect(actions.close).toHaveBeenCalledTimes(1)
    expect(view.getByRole('status').textContent).toBe(zh.cadViewerOpening)
  })

  it('only closes when the address no longer names a CAD file', () => {
    const { actions } = renderViewer(1, false)
    expect(actions.openTab).not.toHaveBeenCalled()
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('only closes a tab restored by a reload', () => {
    const { actions, openFile } = renderViewer(0, true)
    expect(openFile).not.toHaveBeenCalled()
    expect(actions.openTab).not.toHaveBeenCalled()
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('has copy in both dictionaries', () => {
    expect(zh.cadViewerOpening).not.toBe(en.cadViewerOpening)
  })
})
