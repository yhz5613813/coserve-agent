import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
/** Localized welcome copy and write-only credential actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeApi, type WelcomeFolderResult, type WelcomeNotice, type WelcomeSaveResult } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const mode = process.argv.includes('--dsh-welcome-mode=setup') ? 'setup' : 'welcome'
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  mode,
  analytics: async (eventName, attributes) => {
    if (await api.analyticsEnabled()) await ipcRenderer.invoke(WELCOME_IPC.analytics, eventName, attributes)
  },
  analyticsEnabled: () => ipcRenderer.invoke(WELCOME_IPC.analyticsEnabled) as Promise<boolean>,
  takeNotice: () => ipcRenderer.invoke(WELCOME_IPC.takeNotice) as Promise<WelcomeNotice | undefined>,
  startSignIn: () => ipcRenderer.invoke(WELCOME_IPC.start) as Promise<AccountView>,
  cancelSignIn: (id: SignInAttemptId) => ipcRenderer.invoke(WELCOME_IPC.cancel, id) as Promise<AccountView>,
  copySignInLink: (id: SignInAttemptId) => ipcRenderer.invoke(WELCOME_IPC.copyLink, id) as Promise<void>,
  onAccountState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: AccountView): void =>{  listener(state) }
    ipcRenderer.on(WELCOME_IPC.state, receive)
    return () => { ipcRenderer.removeListener(WELCOME_IPC.state, receive) }
  },
  saveApiKey: (value: string, baseURL?: string) => ipcRenderer.invoke(WELCOME_IPC.saveApiKey, value, baseURL) as Promise<WelcomeSaveResult>,
  projectsFolder: () => ipcRenderer.invoke(WELCOME_IPC.projectsFolder) as Promise<string | undefined>,
  chooseProjectsFolder: () => ipcRenderer.invoke(WELCOME_IPC.chooseProjectsFolder) as Promise<WelcomeFolderResult>,
  skip: () => ipcRenderer.invoke(WELCOME_IPC.skip) as Promise<void>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
