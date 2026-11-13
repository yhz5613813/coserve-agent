import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/storage.js';
import { prepareDshWorkspace } from '../server/dsh-workspace.js';
import { builtInSkillPaths } from '../server/builtin.js';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

const resources = fileURLToPath(new URL('../resources/', import.meta.url));

test('DSH gets the real project, engineering skills and preserved local instructions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-dsh-'));
  try {
    const store = new Store(root); await store.init();
    const project = await store.createProject('Native CAD');
    const instructions = path.join(store.workspace(project.id), 'AGENTS.md');
    await fs.writeFile(instructions, '# Project rules\nPreserve these instructions.\n');
    const prepared = await prepareDshWorkspace(store, project.id);
    assert.equal(prepared.workspacePath, store.workspace(project.id));
    const text = await fs.readFile(instructions, 'utf8');
    assert.match(text, /Preserve these instructions/);
    assert.match(text, /DSH is the sole conversation/);
    const workflow = await fs.readFile(path.join(prepared.workspacePath, '.agents/skills/castudio/SKILL.md'), 'utf8');
    assert.match(workflow, /engine: 'gmsh'/);
    assert.match(workflow, /baselineRunId/);
    assert.match(workflow, /deliveries/);
    assert.match(workflow, /archive.sha256/);
    assert.match(workflow, /selected.kind/);
    assert.match(workflow, /thermal` with/);
    assert.doesNotMatch(workflow, /finish the turn instead of polling/);
    for (const skill of ['castudio', 'cadflow', 'thermal-sim', 'structural-sim', 'heatsink-optimization'])
      assert.ok((await fs.stat(path.join(prepared.workspacePath, '.agents', 'skills', skill, 'SKILL.md'))).isFile());
    const structural = await fs.readFile(path.join(prepared.workspacePath, '.agents/skills/structural-sim/SKILL.md'), 'utf8');
    assert.doesNotMatch(structural, /\/structural\/queue|current agent turn holds the project editing lock/);
    const cadflow = await fs.readFile(path.join(prepared.workspacePath, '.agents/skills/cadflow/SKILL.md'), 'utf8');
    assert.match(cadflow, /<!-- coserve-platform-note -->/);
    assert.ok(cadflow.indexOf('<!-- coserve-platform-note -->') > cadflow.indexOf('---', 3));
    assert.match(cadflow, /parametric cell API/);
    assert.match(cadflow, /native `cadflow_core`/);
    assert.match(text, /castudio\/SKILL\.md first/);
    await prepareDshWorkspace(store, project.id);
    assert.equal(await fs.readFile(instructions, 'utf8'), text);
    const cadflowAgain = await fs.readFile(path.join(prepared.workspacePath, '.agents/skills/cadflow/SKILL.md'), 'utf8');
    assert.equal(cadflowAgain.match(/<!-- coserve-platform-note -->/g)?.length, 1);
    assert.deepEqual(await store.messages(project.id), []);
    await assert.rejects(prepareDshWorkspace(store, '../outside'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the packaged optimization skill is discoverable and local customized copies are preserved', async () => {
  const catalog=(await builtInSkillPaths()).flatMap(dir=>loadSkillsFromDir({dir,source:'studio-builtin'}).skills);
  assert.ok(catalog.find(skill=>skill.name==='heatsink-optimization'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'castudio-dsh-skill-'));
  try {
    const store=new Store(root);await store.init();const project=await store.createProject('Custom skill');
    const prepared=await prepareDshWorkspace(store,project.id);
    const file=path.join(prepared.workspacePath,'.agents/skills/heatsink-optimization/SKILL.md');
    const custom='---\nname: heatsink-optimization\ndescription: Local design guidance\n---\nCustom manufacturing notes.\n';
    await fs.writeFile(file,custom);await prepareDshWorkspace(store,project.id);
    assert.equal(await fs.readFile(file,'utf8'),custom);
    assert.deepEqual(await store.messages(project.id),[]);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('DSH refreshes a stale AGENTS.md marker block and backfills the cadflow platform note', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-dsh-refresh-'));
  try {
    const store = new Store(root); await store.init();
    const project = await store.createProject('Legacy CAD');
    const workspacePath = store.workspace(project.id);
    const skillRoot = path.join(workspacePath, '.agents', 'skills');
    // Simulate a project prepared before the platform note and marker refresh existed.
    await fs.cp(path.join(resources, 'cadflow'), path.join(skillRoot, 'cadflow'), { recursive: true });
    for (const name of ['thermal-sim', 'structural-sim'])
      await fs.cp(path.join(resources, name), path.join(skillRoot, name), { recursive: true });
    const instructions = path.join(workspacePath, 'AGENTS.md');
    await fs.writeFile(instructions, `# Rules\n\n<!-- coserve-dsh-workspace -->\nThis is a CoServe AI CAD project. Before CAD, parametric editing, build or simulation tasks, read .agents/skills/castudio/SKILL.md and the relevant bundled engineering skill. Use the configured runtime and existing project services. DSH is the sole conversation and tool-execution harness.\n\nUser notes stay.\n`);
    await prepareDshWorkspace(store, project.id);
    const text = await fs.readFile(instructions, 'utf8');
    assert.match(text, /castudio\/SKILL\.md first, then the relevant bundled engineering skill/);
    assert.doesNotMatch(text, /SKILL\.md and the relevant bundled engineering skill/);
    assert.match(text, /User notes stay\./);
    const cadflow = await fs.readFile(path.join(skillRoot, 'cadflow', 'SKILL.md'), 'utf8');
    assert.equal(cadflow.match(/<!-- coserve-platform-note -->/g)?.length, 1);
    assert.ok(cadflow.indexOf('<!-- coserve-platform-note -->') < cadflow.indexOf('# CadFlow'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
