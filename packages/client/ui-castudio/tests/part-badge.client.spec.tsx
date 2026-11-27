// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PartBadge } from '../src/client/PartBadge.tsx'

afterEach(cleanup)

const list: SessionListState = {
  ids: [SessionId('with-part'), SessionId('plain')], phase: 'ready', projectionsBySession: {},
  byId: {
    [SessionId('with-part')]: { id: SessionId('with-part'), displayTitle: 'a', running: false, retainedBy: {}, blank: false, updatedAt: 1, projectionValues: { cadPart: { projectId: 'root', slug: 'lid', name: '上盖' } } },
    [SessionId('plain')]: { id: SessionId('plain'), displayTitle: 'b', running: false, retainedBy: {}, blank: false, updatedAt: 1 },
  },
}
const useSessions: ComponentProps<typeof PartBadge>['useSessions'] = select => select(list)

it('names the part a listed Session works on and stays empty for a Session without one', () => {
  const view = render(<PartBadge sessionId={SessionId('with-part')} useSessions={useSessions} />)
  expect(view.getByTitle('上盖').textContent).toBe('上盖')
  view.rerender(<PartBadge sessionId={SessionId('plain')} useSessions={useSessions} />)
  expect(view.container.textContent).toBe('')
})
