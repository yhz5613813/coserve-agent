// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { PartChoice, type PartOffer } from '../src/client/PartChoice.tsx'
import { zh } from '../src/client/locales.ts'
import type { CadPart, CadState } from '../src/client/cad-controller.ts'

afterEach(cleanup)

const state: CadState = {
  pending: false, error: null, notice: null, theme: 'light', locale: 'zh', openRequest: null, service: null, serviceEpoch: 0,
  projects: [{ id: 'root', name: 'CAD', workspacePath: 'C:/CAD', workspaceUrl: 'http://127.0.0.1:4317/' }],
}
const part = (slug: string, flags: CadPart['flags'] = []): CadPart => ({ id: `root--${slug}`, slug, name: `零件 ${slug}`, flags })

function mount(load: () => Promise<PartOffer>) {
  const face = {
    session: { sessionId: 'new', blank: true }, input: { occurrences: [] }, t: (key: keyof typeof zh) => zh[key],
    useCad: (select: (value: CadState) => unknown) => select(state),
    useSessions: (select: (list: { byId: Record<string, unknown> }) => unknown) => select({ byId: { new: { id: 'new', cwd: 'C:/CAD', blank: true } } }),
    usePartDeclined: (select: (value: { declined: string[] }) => unknown) => select({ declined: [] }),
    loadParts: vi.fn(load), choosePart: vi.fn(), decline: vi.fn(),
  }
  render(<PartChoice {...face as unknown as ComponentProps<typeof PartChoice>} />)
  return face
}

it('asks whether to continue an existing part, recommended first, without offering to create one', async () => {
  const face = mount(async () => ({ parts: [part('default', ['published']), part('lid', ['structural'])], recommended: 'lid' }))
  await screen.findByText(zh.partChoiceTitle)
  expect(screen.getByText(zh.partChoiceHint)).toBeTruthy()
  expect(screen.getAllByRole('radio').map(option => option.textContent)).toEqual([
    `零件 lid${zh.partRecommended}${zh.partFlagStructural}`, `零件 default${zh.partFlagPublished}`,
  ])
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.partContinue }))
  expect(face.choosePart).toHaveBeenLastCalledWith('root', part('lid', ['structural']))
  fireEvent.click(screen.getByRole('radio', { name: new RegExp('零件 default') }))
  fireEvent.click(screen.getByRole('button', { name: zh.partContinue }))
  expect(face.choosePart).toHaveBeenLastCalledWith('root', part('default', ['published']))
  fireEvent.click(screen.getByRole('button', { name: zh.partNoInherit }))
  expect(face.decline).toHaveBeenCalledOnce()
})

it('stays hidden when the project lists no parts', async () => {
  const face = mount(async () => ({ parts: [], recommended: undefined }))
  await vi.waitFor(() => { expect(face.loadParts).toHaveBeenCalledOnce() })
  await Promise.resolve()
  expect(screen.queryByText(zh.partChoiceTitle)).toBeNull()
})

it('keeps the start-without-a-part action when the parts cannot be listed', async () => {
  const face = mount(async () => { throw new Error('offline') })
  expect((await screen.findByRole('alert')).textContent).toBe(`${zh.partLoadFailed} offline`)
  expect(screen.queryByRole('button', { name: zh.partContinue })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.partNoInherit }))
  expect(face.decline).toHaveBeenCalledOnce()
})
