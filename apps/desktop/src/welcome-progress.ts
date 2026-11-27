/** First-launch onboarding progress kept beside other Electron shell state in userData. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `new`: the welcome window has not been dismissed; `welcomed`: the one-time model API setup window is still due;
 * `done`: neither window opens again.
 */
export type WelcomeProgress = 'new' | 'welcomed' | 'done'

/**
 * Read onboarding progress without requiring the Host.
 * @param userData - Electron userData directory; portable builds keep it beside the executable.
 * @returns Recorded progress, or `new` when the record is missing or unreadable.
 */
export function readWelcomeProgress(userData: string): WelcomeProgress {
  try {
    const value = readFileSync(join(userData, 'desktop', 'welcome-progress'), 'utf8').trim()
    if (value === 'new' || value === 'welcomed' || value === 'done') return value
    throw new Error(`expected new, welcomed, or done, got ${JSON.stringify(value)}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('desktop welcome: treating onboarding as new because its record could not be read', error)
    return 'new'
  }
}

/**
 * Record onboarding progress; a write failure only repeats the step on the next launch.
 * @param userData - Electron userData directory.
 * @param progress - completed onboarding step.
 */
export function writeWelcomeProgress(userData: string, progress: WelcomeProgress): void {
  try {
    const directory = join(userData, 'desktop')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'welcome-progress'), `${progress}\n`, { mode: 0o600 })
  } catch (error) {
    console.warn('desktop welcome: onboarding progress could not be saved for the next startup', error)
  }
}
