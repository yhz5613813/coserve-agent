/** Windows portable builds have no release service and keep installer builds unchanged. */
import { describe, expect, it } from 'vitest'
import { localWindowsPortablePackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('Windows portable packaging', () => {
  it('assembles an unsigned app without release credentials or mandatory-update metadata', () => {
    const environment = localWindowsPortablePackageEnvironment({
      PATH: 'build-tools',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'test-only',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://example.com',
      DOWNLOAD_PROD_COS_SECRET_KEY: 'test-only',
    })
    expect(environment.PATH).toBe('build-tools')
    expect(environment.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBeUndefined()
    expect(environment.DOWNLOAD_PROD_COS_SECRET_KEY).toBeUndefined()
    validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: true })
    const config = createElectronBuilderConfig(environment, 'win32', 'x64')
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.publish).toBeNull()
    expect(config.win.forceCodeSigning).toBe(false)
  })

  it('refuses portable mode for signed builds and other platforms', () => {
    const environment = localWindowsPortablePackageEnvironment({})
    expect(() => { validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }) }).toThrow('portable mode')
    expect(() => createElectronBuilderConfig(environment, 'darwin', 'x64')).toThrow('portable mode')
    expect(() => createElectronBuilderConfig({ ...environment, DSH_DESKTOP_UNSIGNED: '0' }, 'win32', 'x64')).toThrow('portable mode')
  })

  it('retains the policy requirement for ordinary unsigned Windows installers', () => {
    const environment = { DSH_DESKTOP_APP_ID: 'ai.coserve.agent', DSH_DESKTOP_UNSIGNED: '1' }
    expect(() => { validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: true }) }).toThrow('HTTPS origin')
    expect(() => createElectronBuilderConfig(environment, 'win32', 'x64')).toThrow('HTTPS origin')
  })
})
