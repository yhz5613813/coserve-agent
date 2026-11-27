/** Desktop welcome presentation; account and credential operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Render the first-launch welcome or the one-time model API setup using shell-owned operations and localized copy.
 * Welcome's only action enters the local workspace without an account request; setup never blocks the workspace.
 * @param props.api - isolated preload API; no account credentials reach the renderer.
 * @returns the page for `api.mode` with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const page = api.mode === 'setup' ? 'key' : 'entry'
  const title = page === 'key' ? m.welcomeSetupTitle : m.welcomeTitle
  const [draft, setDraft] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [folder, setFolder] = useState<string>()
  const [folderError, setFolderError] = useState('')
  const [choosingFolder, setChoosingFolder] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = title
    return () => { mounted.current = false }
  }, [api, title])

  useEffect(() => {
    if (page !== 'key') return
    input.current?.focus()
    // The optional folder row stays hidden when the Host cannot report it; saving and dismissing never wait for it.
    api.projectsFolder().then((current) => { if (mounted.current) setFolder(current) }, () => undefined)
  }, [page, api])

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
      || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
      setError(value === '' ? m.welcomeKeyBlank : m.welcomeKeyInvalid)
      input.current?.focus()
      return
    }
    // Blank keeps the configured endpoint; intranet deployments enter their gateway here.
    const endpoint = baseURL.trim().replace(/\/+$/, '')
    if (endpoint !== '' && !/^https?:\/\/[\x21-\x7e]+$/.test(endpoint)) {
      setError(m.welcomeBaseUrlInvalid)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveApiKey(value, endpoint === '' ? undefined : endpoint)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setError(m.welcomeKeyFailed)
    } catch {
      if (mounted.current) setError(m.welcomeKeyFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function chooseFolder() {
    setChoosingFolder(true)
    setFolderError('')
    try {
      const result = await api.chooseProjectsFolder()
      if (!mounted.current) return
      if (result.status === 'changed') setFolder(result.folder)
      else if (result.status === 'invalid') setFolderError(m.welcomeProjectsFolderInvalid)
      else if (result.status === 'failed') setFolderError(m.welcomeProjectsFolderFailed)
    } catch {
      if (mounted.current) setFolderError(m.welcomeProjectsFolderFailed)
    } finally {
      if (mounted.current) setChoosingFolder(false)
    }
  }
  async function skip() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.skip()
      if (mounted.current) setDraft('')
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const heading = page === 'entry' ? 'welcome-heading' : 'key-title'

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby={heading}>
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
        <p className="key-error" role="alert" hidden={error === ''}>{error}</p>
      </div>
      <form id="key-form" className="key-form" hidden={page !== 'key'} noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeSetupTitle}</h1><p id="key-description">{m.welcomeSetupDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="new-password" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError('') }} />
          <label className="visually-hidden" htmlFor="base-url-input">{m.welcomeBaseUrlPlaceholder}</label>
          <input id="base-url-input" type="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
            placeholder={m.welcomeBaseUrlPlaceholder} value={baseURL} disabled={busy}
            onChange={(event) => { setBaseURL(event.target.value); setError('') }} />
          {folder !== undefined && <details id="projects-folder">
            <summary>{m.welcomeProjectsFolder}</summary>
            <div className="key-field">
              <label className="visually-hidden" htmlFor="projects-folder-input">{m.welcomeProjectsFolder}</label>
              <input id="projects-folder-input" type="text" readOnly value={folder} aria-describedby="projects-folder-hint projects-folder-error" />
              <button id="projects-folder-change" type="button" disabled={busy || choosingFolder} onClick={() => { void chooseFolder() }}>{m.welcomeProjectsFolderChange}</button>
              <p id="projects-folder-hint">{m.welcomeProjectsFolderHint}</p>
              <p id="projects-folder-error" role="alert" hidden={folderError === ''}>{folderError}</p>
            </div>
          </details>}
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button id="start" className="primary" type="button" disabled={busy} aria-busy={busy} onClick={() => { void skip() }}>{m.welcomeStart}</button>
      </div>
      <div id="key-actions" className="actions" hidden={page !== 'key'}>
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || draft.trim() === ''}>{m.welcomeSetupSave}</button>
        <button id="skip-key" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
      </div>
    </main>
  </>
}
