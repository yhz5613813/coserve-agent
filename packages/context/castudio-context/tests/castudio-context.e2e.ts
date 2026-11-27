import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// Keep the Loader config under examples so both modes exercise the same deployable
// topology: local fixture source plus bare plugins owned by the examples workspace.
const driver = fileURLToPath(new URL(
  './fixtures/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  './fixtures/castudio-context.patch.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('castudio-context through the production headless profile', () => {
  it('injects the CAStudio reading once per stable state across three turns', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'castudio-context headless smoke',
      tempDirPrefix: 'castudio-context-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(3)

    const contexts = events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'castudio-context')
    const starts = events.filter(event => event.type === 'step/start')
    // Turn two reports the same workbench state, so its reading is suppressed;
    // the driver's selection change before turn three makes the summary differ
    // and re-injects exactly once more.
    expect(contexts).toHaveLength(2)
    expect(starts.length).toBeGreaterThanOrEqual(3)
    expect(contexts[0]!.seq).toBeGreaterThan(starts[0]!.seq)
    expect(contexts[0]!.surfaceOp).toBe('append')
    // `snapshot` form: one named contribution whose text is exactly what the
    // model read, so a consumer attributes it without re-splitting prose.
    expect(contexts[0]!.data.source).toMatchObject({
      kind: 'castudio-context',
      form: 'snapshot',
      sections: [{ name: 'castudio-context' }],
    })
    const contextText = contexts[0]!.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(contextText).toMatch(/^CAStudio CAD service \(turn \d+\):\n/)
    expect(contextText).toContain('"Fixture Bracket" — id fixture-project')
    expect(contextText).toContain('/api/projects/<id>')
    expect(contextText).toContain("do not call the service's /prompt endpoint")
    // Each project carries its absolute castudio skill path plus the parametric
    // environment status line.
    expect(contextText).toContain(
      'CAD skill guide: D:\\studio\\projects\\fixture-project\\workspace\\.agents\\skills\\castudio\\SKILL.md')
    expect(contextText).toContain('The parametric CAD environment is configured')
    // The connected workbench summary rides in the same durable reading.
    expect(contextText).toContain('The user currently has these CAD workbenches open:')
    expect(contextText).toContain('tab: model preview')
    expect(contextText).toContain('Model: demonstration geometry — loaded')
    expect(contextText).toContain('Meshes: 2 total, 1 hidden')
    expect(contextText).toContain('Project / Part: "Fixture Bracket" / "default" (default)')
    expect(contextText).toContain('Selection: "底座" (mesh-a)')
    expect(contextText).toContain('cad_workbench tool')
    const reloadedText = contexts[1]!.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(reloadedText).toContain('Selection: "螺栓 01" (mesh-b)')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
