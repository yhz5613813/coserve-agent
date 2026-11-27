import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './CadWorkspace.module.css'

export interface CadViewerFace {
  /**
   * Record a request to show the file an address names in a Session's CAD frame.
   * @param sessionId - the Session whose CAD tab shows the file.
   * @param address - the file address that was opened.
   * @returns whether the address names a CAD project file.
   */
  openFile(sessionId: SessionId, address: string): boolean
}

/**
 * Redirect for a CAD file opened from the file tree: ask the CAD frame to show it, switch to the CAD tab in this tab's place and close this tab.
 * A tab restored by a reload (`revision` 0) was not opened by anyone, so it only closes.
 */
export function CadViewer(props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'castudio'> & InjectFace<CadViewerFace>) {
  const { tab } = props.useTabInfo()
  const { sessionId, openFile } = props
  useEffect(() => {
    if (tab.navigation.revision > 0 && openFile(sessionId, tab.navigation.address)) tab.actions.openTab('cad', { replaceTab: true })
    tab.actions.close()
  }, [])
  return <div className={css.empty} role="status">{props.t('cadViewerOpening')}</div>
}
