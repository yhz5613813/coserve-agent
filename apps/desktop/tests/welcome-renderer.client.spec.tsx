// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { WelcomeFolderResult, WelcomeMode, WelcomeSaveResult } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

it('enters the local workspace once without account, credential or analytics requests', async () => {
  const view = mount()
  const entry = Promise.withResolvers<undefined>()
  view.api.skip.mockReturnValue(entry.promise)
  expect(view.document.querySelectorAll('#entry-actions button')).toHaveLength(1)
  fireEvent.click(view.button('#start'))
  fireEvent.click(view.button('#start'))
  expect(view.api.skip).toHaveBeenCalledOnce()
  expect(view.button('#start').disabled).toBe(true)
  expect(view.api.startSignIn).not.toHaveBeenCalled()
  expect(view.api.saveApiKey).not.toHaveBeenCalled()
  expect(view.api.projectsFolder).not.toHaveBeenCalled()
  expect(view.api.onAccountState).not.toHaveBeenCalled()
  expect(view.api.analytics).not.toHaveBeenCalled()
  await act(async () => { entry.resolve(undefined); await entry.promise })
  expect(view.button('#start').disabled).toBe(false)
})

it('shows a local workspace error and lets the user retry entry', async () => {
  const view = mount()
  view.api.skip.mockRejectedValueOnce(new Error('workspace unavailable'))
  fireEvent.click(view.button('#start'))
  await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeContinueFailed) })
  expect(view.button('#start').disabled).toBe(false)
  fireEvent.click(view.button('#start'))
  await vi.waitFor(() => { expect(view.api.skip).toHaveBeenCalledTimes(2) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(view.api.startSignIn).not.toHaveBeenCalled()
})

function mount(language = 'zh-CN', mode: WelcomeMode = 'welcome', projectsFolder?: string) {
  cleanup()
  const stopAccount = vi.fn()
  const api = {
    mode,
    takeNotice: vi.fn(async () => undefined),
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onAccountState: vi.fn((_listener: (state: AccountView) => void) => stopAccount),
    startSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    cancelSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    projectsFolder: vi.fn<() => Promise<string | undefined>>().mockResolvedValue(projectsFolder),
    chooseProjectsFolder: vi.fn<() => Promise<WelcomeFolderResult>>().mockResolvedValue({ status: 'cancelled' }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  const mounted = render(<Welcome api={api} />)
  const input = document.querySelector('input')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enterKey = (value: string) => {
    fireEvent.change(input, { target: { value } })
  }
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...heading === 'key-title' ? [document.querySelector('#key-description')!.textContent, `${input.placeholder} [password]`] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, input, button, enterKey, submit, copy, unmount: mounted.unmount, stopAccount }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s welcome and model API setup', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    const setup = mount(language, 'setup')
    expect(setup.document.activeElement).toBe(setup.input)
    expect(setup.input.type).toBe('password')
    await expect(setup.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-api-key.expected.txt`)
  })

  it('sends the entered Base URL with the key and rejects one without an http(s) scheme', () => {
    const view = mount('zh-CN', 'setup')
    view.api.saveApiKey.mockReturnValue(Promise.resolve({ ok: true }))
    view.enterKey('sk-desktop-example')
    const endpoint = view.document.querySelector<HTMLInputElement>('#base-url-input')!
    fireEvent.change(endpoint, { target: { value: '10.0.0.8:8000' } })
    view.submit()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.document.querySelector<HTMLElement>('#key-error')!.textContent).toBe(view.api.messages.welcomeBaseUrlInvalid)
    fireEvent.change(endpoint, { target: { value: ' http://10.0.0.8:8000/ ' } })
    view.submit()
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('sk-desktop-example', 'http://10.0.0.8:8000')
  })

  it('hides the CAD project folder row where the Host reports no selectable folder', async () => {
    const view = mount('zh-CN', 'setup')
    await vi.waitFor(() => { expect(view.api.projectsFolder).toHaveBeenCalledOnce() })
    expect(view.document.querySelector('#projects-folder')).toBeNull()
  })

  it('shows the collapsed CAD project folder, applies a valid choice, and keeps it after an invalid one', async () => {
    const view = mount('zh-CN', 'setup', 'D:\\Coserve CAD')
    await vi.waitFor(() => { expect(view.document.querySelector('#projects-folder')).not.toBeNull() })
    const row = view.document.querySelector<HTMLDetailsElement>('#projects-folder')!
    const current = view.document.querySelector<HTMLInputElement>('#projects-folder-input')!
    expect(row.open).toBe(false)
    expect(row.querySelector('summary')!.textContent).toBe(view.api.messages.welcomeProjectsFolder)
    expect(current.value).toBe('D:\\Coserve CAD')
    expect(view.document.querySelector('#projects-folder-hint')!.textContent).toBe(view.api.messages.welcomeProjectsFolderHint)
    view.api.chooseProjectsFolder.mockResolvedValueOnce({ status: 'changed', folder: 'E:\\cad' })
    fireEvent.click(view.button('#projects-folder-change'))
    await vi.waitFor(() => { expect(current.value).toBe('E:\\cad') })
    view.api.chooseProjectsFolder.mockResolvedValueOnce({ status: 'invalid' })
    fireEvent.click(view.button('#projects-folder-change'))
    await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeProjectsFolderInvalid) })
    expect(current.value).toBe('E:\\cad')
    expect(view.button('#skip-key').disabled).toBe(false)
  })

  it('sends one trimmed key, prevents competing actions, and clears it after saving', async () => {
    const view = mount('zh-CN', 'setup')
    const saved = Promise.withResolvers<WelcomeSaveResult>()
    view.api.saveApiKey.mockReturnValue(saved.promise)
    view.enterKey('  sk-desktop-example  ')
    view.submit()
    view.submit()
    fireEvent.click(view.button('#skip-key'))
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('sk-desktop-example', undefined)
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.button('#save-key').textContent).toBe(view.api.messages.welcomeSetupSave)
    expect(view.button('#skip-key').disabled).toBe(true)
    saved.resolve({ ok: true })
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.document.body.textContent).not.toContain('sk-desktop-example')
  })

  it.each(['', 'bad key', '密钥', 'DEEPSEEK_API_KEY=sk-example', '"sk-example"', '`sk-example`'])(
    'rejects invalid input before sending it: %s', (value) => {
      const view = mount('zh-CN', 'setup')
      view.enterKey(value)
      view.submit()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
      expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(false)
      expect(view.input.getAttribute('aria-invalid')).toBe('true')
    },
  )

  it('retains an unsaved draft and allows retry after a refused save', async () => {
    const view = mount('zh-CN', 'setup')
    view.api.saveApiKey.mockResolvedValue({ ok: false })
    view.enterKey('sk-retry')
    view.submit()
    await vi.waitFor(() => { expect(view.button('#save-key').disabled).toBe(false) })
    expect(view.input.value).toBe('sk-retry')
    expect(view.document.querySelector('#key-error')!.textContent).toBe(view.api.messages.welcomeKeyFailed)
    view.api.saveApiKey.mockResolvedValue({ ok: true })
    view.submit()
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
  })

  it('dismisses setup without saving', async () => {
    const view = mount('zh-CN', 'setup')
    const skipped = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValue(skipped.promise)
    view.enterKey('sk-not-saved')
    fireEvent.click(view.button('#skip-key'))
    try {
      expect(view.button('#skip-key').textContent).toBe(view.api.messages.welcomeKeyLater)
      expect(view.button('#save-key').disabled).toBe(true)
      expect(view.button('#skip-key').disabled).toBe(true)
      fireEvent.click(view.button('#skip-key'))
      view.submit()
      expect(view.api.skip).toHaveBeenCalledOnce()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
    } finally {
      skipped.resolve(undefined)
    }
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.document.querySelector('#back-to-login')).toBeNull()
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})
