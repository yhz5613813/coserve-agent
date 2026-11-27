import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionInputShell, type SessionInputDeps } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import type { InputTriggerController } from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/input.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { attachCadReference, CAD_PART_SOURCE, cadPartReference, cadPartRule, cadPartSource, cadReference, cadReferenceRule, cadReferenceSource } from '../src/client/cad-reference.ts'

const selection = { meshId: 'ring', name: '上端定位环', file: 'assembly.step', isDemo: false, bounds: [0, 0, 0, 10, 10, 5] }
const reference = () => cadReference('project-one', selection, { face: '面', triangle: '三角面' })!

function makeInput(sink = vi.fn<SessionInputDeps['defaultSink']>(async () => ({ kind: 'success' }))) {
  const ctx = new Context()
  const triggers: InputTriggerController = {
    launcher: createSnapshotStore<string | null>(null), lexicon: createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()),
    track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
    serializeReference: (source, ref, signal) => (
      (source === CAD_PART_SOURCE ? cadPartSource : cadReferenceSource).codec!.serialize(ref, signal)
    ),
    adjudicate: async () => undefined, resolveClaim: async () => undefined,
    openReference: () => false, toggleSource: () => {},
  }
  const shell = new SessionInputShell({ actx: ctx, inputTriggers: () => triggers, defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
  onTestFinished(() => { shell.dispose(); ctx.fiber.dispose() })
  return { shell, sink }
}

it('keeps prose and a compact native chip, deduplicates repeated picks, and sends complete CAD context', async () => {
  const { shell, sink } = makeInput()
  shell.setDraft('检查这个部件 ')
  const end = shell.snapshot.draft.length
  expect(attachCadReference(shell, reference(), { start: 0, end, draftRev: shell.snapshot.draftRev })).toBe(true)
  expect(shell.snapshot.draft).toBe('检查这个部件 @上端定位环 ')
  expect(shell.snapshot.occurrences).toMatchObject([{ appearance: 'file', label: '上端定位环' }])
  attachCadReference(shell, reference(), shell.actions.captureInsertion())
  expect(shell.snapshot.occurrences).toHaveLength(1)
  shell.submit()
  await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce())
  const text = sink.mock.calls[0]![0] as string
  expect(text).toContain('检查这个部件 <cad-selection>')
  expect(text).toContain('"bounds":[0,0,0,10,10,5]')
  const node = cadReferenceRule.match(text, 0, { read: () => undefined })
  expect(node).toMatchObject({ id: 'cad-selection', data: { label: '上端定位环', file: 'assembly.step' } })
  await vi.waitFor(() => expect(shell.snapshot.occurrences).toHaveLength(0))
})

it('preserves the reference on rejection and omits it after native draft removal', async () => {
  const sink = vi.fn<SessionInputDeps['defaultSink']>(async () => ({ kind: 'error', text: 'offline' }))
  const { shell } = makeInput(sink)
  attachCadReference(shell, reference(), shell.actions.captureInsertion())
  shell.submit()
  await vi.waitFor(() => expect(shell.snapshot.phase).toBe('plain'))
  expect(shell.snapshot.occurrences).toHaveLength(1)
  shell.setDraft('只保留这句')
  sink.mockResolvedValue({ kind: 'success' })
  shell.submit()
  await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2))
  expect(sink.mock.calls[1]![0]).toBe('只保留这句')
})

it('keeps face identity distinct and restores the complete context from its persisted reference', async () => {
  const part = reference()
  const face = cadReference('project-one', { ...selection, cadFace: { id: 'F12' } }, { face: '面', triangle: '三角面' })!
  expect(face.label).toBe('上端定位环 · 面 F12')
  const { shell } = makeInput()
  attachCadReference(shell, part, shell.actions.captureInsertion())
  attachCadReference(shell, face, shell.actions.captureInsertion())
  expect(shell.snapshot.occurrences).toHaveLength(2)
  const persisted = JSON.parse(JSON.stringify(shell.draftSnapshot)) as typeof shell.draftSnapshot
  const serialized = await cadReferenceSource.codec!.serialize(persisted.references[1]!.ref, new AbortController().signal)
  expect(serialized).toContain('"cadFace":{"id":"F12"}')
  expect(cadReference('project-one', null, { face: '面', triangle: '三角面' })).toBeUndefined()
  expect(cadReferenceRule.match('<cad-selection>bad</cad-selection>', 0, { read: () => undefined })).toBeUndefined()
})

const labels = { face: '面', triangle: '三角面' }

it('locks the part of a submitted message when the viewer later switches to another part', async () => {
  const { shell, sink } = makeInput()
  const inA = cadReference('project-one', { ...selection, part: 'housing' }, labels)!
  attachCadReference(shell, inA, shell.actions.captureInsertion())
  // The viewer switches to part B; the same mesh id picked there is a different selection, not a duplicate.
  const inB = cadReference('project-one', { ...selection, part: 'lid' }, labels)!
  expect(attachCadReference(shell, inB, shell.actions.captureInsertion())).toBe(true)
  expect(shell.snapshot.occurrences).toHaveLength(2)

  const persisted = JSON.parse(JSON.stringify(shell.draftSnapshot)) as typeof shell.draftSnapshot
  const restoredA = await cadReferenceSource.codec!.serialize(persisted.references[0]!.ref, new AbortController().signal)
  expect(restoredA).toContain('"part":"housing"')
  expect(restoredA).not.toContain('"part":"lid"')

  shell.submit()
  await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce())
  const text = sink.mock.calls[0]![0] as string
  expect(text.match(/"part":"housing"/g)).toHaveLength(2)
  expect(text.match(/"part":"lid"/g)).toHaveLength(2)
  const replayed = cadReferenceRule.match(text, 0, { read: () => undefined })
  expect(replayed).toMatchObject({ id: 'cad-selection', data: { label: '上端定位环', file: 'assembly.step' } })
})

it('keeps legacy selections without a part unchanged and rejects an invalid part slug', () => {
  expect(reference().ref).not.toContain('"part"')
  expect(cadReference('project-one', { ...selection, part: 'default' }, labels)!.ref).toContain('"part":"default"')
  for (const part of ['Housing', '../x', 'a--b', 'x'.repeat(41), 7]) {
    expect(cadReference('project-one', { ...selection, part }, labels), String(part)).toBeUndefined()
  }
  const tampered = JSON.stringify({ projectId: 'project-one', part: 'A/B', label: 'x', selection })
  expect(cadReferenceRule.match(`<cad-selection>${tampered}</cad-selection>`, 0, { read: () => undefined })).toBeUndefined()
})

it('labels a triangle pick and rejects references that are not valid CAD selections', async () => {
  const triangle = cadReference('project-one', { ...selection, triangle: 5 }, labels)!
  expect(triangle.label).toBe('上端定位环 · 三角面 5')
  const { shell } = makeInput()
  for (const ref of ['not json', 'null', '{"projectId":1}']) {
    expect(attachCadReference(shell, { ...triangle, ref }, shell.actions.captureInsertion()), ref).toBe(false)
  }
  const codec = cadReferenceSource.codec!
  expect(codec.clipboardText(triangle.ref)).toBe('@上端定位环 · 三角面 5')
  expect(codec.clipboardText('not json')).toBe('@')
  await expect(codec.serialize('not json', new AbortController().signal)).rejects.toThrow('Invalid CAD selection reference')
  await expect(cadReferenceSource.candidates({} as never, {} as never)).resolves.toEqual([])
  expect(cadReferenceSource.onPick({} as never)).toBeUndefined()
  const text = `<cad-selection>bad</cad-selection> <cad-selection>${triangle.ref}</cad-selection>`
  expect(cadReferenceRule.match(text, 0, { read: () => undefined })).toMatchObject({ data: { label: '上端定位环 · 三角面 5' } })
})

it('sends the chosen part as a logged marker that replays as its folder chip', async () => {
  const { shell, sink } = makeInput()
  shell.setDraft('加一个安装孔')
  expect(shell.insertReference(cadPartReference('project-one', 'lid', '<盖>', 'parts/lid/'), { start: 0, end: 0, draftRev: shell.snapshot.draftRev })).toBe(true)
  expect(shell.snapshot.occurrences).toMatchObject([{ source: CAD_PART_SOURCE, appearance: 'folder', label: '<盖>' }])
  shell.submit()
  await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce())
  const text = sink.mock.calls[0]![0] as string
  expect(text).toBe('<cad-part>{"projectId":"project-one","part":"lid","name":"\\u003c盖>","folder":"parts/lid/"}</cad-part> 加一个安装孔')
  expect(cadPartRule.match(text, 0, { read: () => undefined })).toMatchObject({ id: 'cad-part', start: 0, data: { name: '<盖>', folder: 'parts/lid/' } })
})

it('rejects part references that are not valid CAD parts', async () => {
  const codec = cadPartSource.codec!
  expect(codec.clipboardText(cadPartReference('project-one', 'default', 'CAD', './').ref)).toBe('@CAD')
  expect(codec.clipboardText('not json')).toBe('@')
  await expect(codec.serialize(JSON.stringify({ projectId: 'project-one', part: '../x', name: 'x', folder: './' }), new AbortController().signal)).rejects.toThrow('Invalid CAD part reference')
  await expect(cadPartSource.candidates({} as never, {} as never)).resolves.toEqual([])
  expect(cadPartSource.onPick({} as never)).toBeUndefined()
  expect(cadPartRule.match('<cad-part>null</cad-part> <cad-part>{"projectId":"p"}</cad-part>', 0, { read: () => undefined })).toBeUndefined()
})

it('ignores references owned by other sources when deduplicating', () => {
  const { shell } = makeInput()
  shell.insertReference({ source: 'other-source', ref: 'x', label: 'other', appearance: 'file', clipboardText: '@other' }, shell.actions.captureInsertion())
  expect(attachCadReference(shell, reference(), shell.actions.captureInsertion())).toBe(true)
  expect(shell.snapshot.occurrences).toHaveLength(2)
})
