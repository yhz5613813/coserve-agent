/** CoServe AI Desktop, and Web deployments configured with `localAccount`, use local identity; other Web deployments retain cloud accounts. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyCloudAccount } from './cloud-account.ts'
import { registerLocalAccount } from './LocalAccount.tsx'
import { LOCAL_ACCOUNT_GLOBAL } from '../contact-config.ts'
export { inject } from './cloud-account.ts'
export type { AccountSectionInjected, AccountSectionProps, AccountMenuProps, AccountSnapshot, AccountKey } from './cloud-account.ts'

/** Select the account surface owned by this application. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  const page = globalThis as Partial<Record<typeof LOCAL_ACCOUNT_GLOBAL, unknown>>
  if ('dshDesktop' in globalThis || page[LOCAL_ACCOUNT_GLOBAL] === true) registerLocalAccount(ctx)
  else applyCloudAccount(ctx)
}
