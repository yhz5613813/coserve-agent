import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Store, inside, jsonWrite, safePath, scanArtifacts } from '../server/storage.js';
import { discoverSkills, parseSource, Plugins } from '../server/plugins.js';
import { zipSync, strToU8 } from 'fflate';
import { unpackPreview } from '../src/scene/loaders.js';
import { builtInSkillPaths, CADFLOW_PLUGIN_ID } from '../server/builtin.js';

test('CadFlow is bundled and cannot be installed, disabled or removed as an extension', async () => {
  const { root, cleanup } = await fixture();
  try {
    const paths = await builtInSkillPaths();
    assert.deepEqual(paths.map(p => path.basename(path.resolve(p))), ['cadflow', 'thermal-sim', 'structural-sim', 'heatsink-optimization']);
    for (const resource of paths) await fs.access(path.join(resource, 'SKILL.md'));
    assert.match(await fs.readFile(path.join(paths[0], 'SKILL.md'), 'utf8'), /name: cadflow/);
    const manager = new Plugins(root);
    const oldInstall = path.join(manager.root, CADFLOW_PLUGIN_ID);
    await fs.mkdir(oldInstall, { recursive: true });
    await fs.writeFile(path.join(oldInstall, 'plugin.json'), JSON.stringify({id: CADFLOW_PLUGIN_ID, enabled: false, skills: []}));
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.install('zion-zion-zion/CadFlow-Skill'), /已内置/);
    await assert.rejects(manager.enable(CADFLOW_PLUGIN_ID, false), /不能停用/);
    await assert.rejects(manager.remove(CADFLOW_PLUGIN_ID), /不能卸载/);
    assert.deepEqual(await builtInSkillPaths(), paths);
  } finally { await cleanup(); }
});

test('a separate projects directory holds project folders outside the data root', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(path.join(root, 'data'), path.join(root, 'D', 'Coserve CAD'));
    await store.init();
    const project = await store.createProject('Bracket');
    assert.equal(project.id, 'bracket');
    assert.equal(store.workspace(project.id), path.join(root, 'D', 'Coserve CAD', 'bracket'));
    await fs.access(path.join(root, 'D', 'Coserve CAD', 'bracket', 'artifacts'));
    await fs.access(path.join(root, 'D', 'Coserve CAD', '.coserve', 'bracket', 'project.json'));
    await assert.rejects(fs.access(path.join(root, 'data', 'projects')));
    assert.deepEqual((await store.records()).map(p => p.id), [project.id]);
    assert.deepEqual([(await store.createProject('Bracket')).id, (await store.createProject('散热器')).id, (await store.createProject('外壳')).id], ['bracket-2', 'project', 'project-2']);
  } finally { await cleanup(); }
});
test('the legacy id-folder layout moves records under .coserve and lifts root workspaces', async () => {
  const { root, cleanup } = await fixture();
  try {
    const dir = path.join(root, 'projects'), id = '12345678-1234-1234-1234-123456789abc', part = `${id}--gear`;
    const now = new Date().toISOString();
    await fs.mkdir(path.join(dir, id, 'workspace', 'parts', 'gear'), { recursive: true });
    await fs.writeFile(path.join(dir, id, 'workspace', 'model.step'), 'x');
    await jsonWrite(path.join(dir, id, 'project.json'), { id, name: 'Old', createdAt: now, updatedAt: now });
    await jsonWrite(path.join(dir, part, 'project.json'), { id: part, name: 'Gear', createdAt: now, updatedAt: now, parentId: id, slug: 'gear' });
    const store = new Store(root, dir);
    await store.init();
    assert.equal(await fs.readFile(path.join(dir, id, 'model.step'), 'utf8'), 'x');
    assert.deepEqual((await store.records()).map(p => p.id).sort(), [id, part].sort());
    assert.equal(store.workspace(part), path.join(dir, id, 'parts', 'gear'));
    await store.init();
    assert.equal(await fs.readFile(path.join(dir, id, 'model.step'), 'utf8'), 'x');
  } finally { await cleanup(); }
});

async function fixture() { const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'unit-')); return { root, cleanup: async () => { assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } }; }
test('project file boundaries reject traversal and links while allowing new nested source', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init(); const project = await store.createProject('模型'); const cwd = store.workspace(project.id);
    for (const file of ['../private', '..\\private', '/etc/passwd', 'code/../../private', 'a\0.py']) await assert.rejects(safePath(cwd, file, false));
    const file = await safePath(cwd, 'code/model.py', false); assert.equal(file, path.join(cwd, 'code', 'model.py'));
    await fs.mkdir(path.join(root, 'external')); await fs.writeFile(path.join(root, 'external', 'secret.txt'), 'private');
    await fs.symlink(path.join(root, 'external'), path.join(cwd, 'escape'), 'junction');
    await assert.rejects(safePath(cwd, 'escape/secret.txt'));
    assert.deepEqual(await scanArtifacts(cwd), []);
  } finally { await cleanup(); }
});
test('concurrent message writes are serialized and sessions survive reopening', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init(); const p = await store.createProject('Persistent');
    await Promise.all(Array.from({ length: 15 }, (_, i) => store.addMessage(p.id, { id: String(i), role: 'assistant', text: `message ${i}`, timestamp: i })));
    assert.equal((await new Store(root).messages(p.id)).length, 15);
    await store.addMessage(p.id, { id: '1', role: 'assistant', text: 'updated', timestamp: 20 });
    assert.equal((await store.messages(p.id)).length, 15); assert.equal((await store.messages(p.id))[1].text, 'updated');
  } finally { await cleanup(); }
});
test('plugin sources are GitHub-only and optional refs cannot become git flags', () => {
  assert.deepEqual(parseSource('https://github.com/zion-zion-zion/CadFlow-Skill'), { url: 'https://github.com/zion-zion-zion/CadFlow-Skill.git', id: 'zion-zion-zion-cadflow-skill', ref: undefined });
  assert.equal(parseSource('owner/repo.git#main').ref, 'main');
  for (const source of ['file:///etc', 'https://evil.test/a/b', 'owner/repo#--upload-pack=x', 'owner/../a', 'owner/repo;rm -rf /']) assert.throws(() => parseSource(source));
});
test('only installed and enabled skills are exposed, preserving their reference directories', async () => {
  const { root, cleanup } = await fixture();
  try {
    const pluginRoot = path.join(root, 'plugins', 'example-cad');
    await fs.mkdir(path.join(pluginRoot, 'skills', 'cad', 'references'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'skills', 'cad', 'SKILL.md'), '---\nname: cad\ndescription: CAD geometry tools.\n---\nRead references/api.md');
    await fs.writeFile(path.join(pluginRoot, 'skills', 'cad', 'references', 'api.md'), 'API details');
    const skills = await discoverSkills(pluginRoot); assert.equal(skills[0].path, 'skills/cad');
    await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ id: 'example-cad', name: 'CAD', enabled: true, skills }));
    const manager = new Plugins(root); assert.equal((await manager.skillPaths()).length, 1);
    await manager.enable('example-cad', false); assert.equal((await manager.skillPaths()).length, 0);
    await manager.enable('example-cad', true); assert.equal((await manager.skillPaths()).length, 1);
    await manager.remove('example-cad'); assert.deepEqual(await manager.list(), []);
  } finally { await cleanup(); }
});
test('preview archive reader rejects unsafe paths and keeps render assets only', () => {
  const files = unpackPreview(zipSync({ 'assets/part.glb': new Uint8Array([1, 2]), 'scene.json': strToU8('{}'), 'sources/model.py': strToU8('print(1)') }));
  assert.deepEqual(Object.keys(files).sort(), ['assets/part.glb', 'scene.json']);
  assert.throws(() => unpackPreview(zipSync({ '../outside.glb': new Uint8Array([1]) })));
});
test('only skeleton-only projects may be deleted, and deleting removes the project directory', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init();
    const empty = await store.createProject('空项目');
    const cwd = store.workspace(empty.id);
    await fs.mkdir(path.join(cwd, '.agents', 'skills'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.agents', 'skills', 'SKILL.md'), 'skill');
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'instructions');
    await fs.mkdir(path.join(cwd, 'artifacts'), { recursive: true });
    assert.deepEqual(await store.userFiles(empty.id), []);
    assert.deepEqual(await store.deleteProject(empty.id), { deleted: true, id: empty.id });
    assert.equal((await store.projects()).some(project => project.id === empty.id), false);
    await assert.rejects(store.project(empty.id), /项目不存在/);

    const used = await store.createProject('有模型');
    await fs.mkdir(path.join(store.workspace(used.id), 'models'), { recursive: true });
    await fs.writeFile(path.join(store.workspace(used.id), 'models', 'part.step'), 'ISO-10303');
    assert.deepEqual(await store.userFiles(used.id), ['models/part.step']);
    await assert.rejects(store.deleteProject(used.id), /请先清空/);
    assert.equal((await store.projects()).some(project => project.id === used.id), true);
  } finally { await cleanup(); }
});
test('scanned files carry a role category and a short detail that tells same-named files apart', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init(); const project = await store.createProject('分类'); const cwd = store.workspace(project.id);
    const rid = '3f2a1b4c-1111-4222-8333-944445555666', imp = 'a1b2c3d4-aaaa-4bbb-8ccc-dddddddddddd', run = '0badcafe-1234-4567-89ab-cdef01234567';
    const expected: Record<string, [string, string]> = {
      'AGENTS.md': ['system', ''], 'notes.md': ['report', ''], 'design.py': ['source', ''], 'model.step': ['cad', ''], 'preview.zip': ['other', ''], 'photo.png': ['other', ''],
      'thermal-case.json': ['simulation', ''], 'workflow-result.json': ['system', ''], 'geometry-check.json': ['system', ''],
      [`imports/${imp}/part.step`]: ['import', '导入 a1b2c3d4'], [`imports/${imp}/notes.md`]: ['import', '导入 a1b2c3d4'],
      'parametric/cylinder.py': ['source', 'parametric'], 'parametric/published.json': ['system', 'parametric'],
      [`parametric/exports/${rid}/cylinder.step`]: ['cad', 'parametric/exports/3f2a1b4c'], [`parametric/exports/${rid}/cylinder.bindings.json`]: ['system', 'parametric/exports/3f2a1b4c'],
      [`parametric/exports/${rid}/source/cylinder.py`]: ['system', 'parametric/exports/3f2a1b4c/source'],
      'cylinder-objects/model.json': ['source', 'cylinder-objects'], 'cylinder-objects/state.json': ['system', 'cylinder-objects'],
      [`cylinder-objects/exports/${rid}/assembly.step`]: ['cad', 'cylinder-objects/exports/3f2a1b4c'], [`cylinder-objects/exports/${rid}/input-model.json`]: ['system', 'cylinder-objects/exports/3f2a1b4c'],
      [`builds/${run}/model.step`]: ['cad', 'builds/0badcafe'], [`builds/${run}/studio-build-manifest.json`]: ['system', 'builds/0badcafe'], [`builds/${run}/log.txt`]: ['system', 'builds/0badcafe'],
      [`simulations/${run}/result.zip`]: ['simulation', 'simulations/0badcafe'], [`simulations/${run}/field.png`]: ['simulation', 'simulations/0badcafe'], [`simulations/${run}/studio-simulation.json`]: ['system', 'simulations/0badcafe'],
      [`structural/${run}/source.step`]: ['simulation', 'structural/0badcafe'], [`structural/${run}/request.json`]: ['simulation', 'structural/0badcafe'], 'cases/shell.inp': ['simulation', 'cases'],
      [`studio/cad-inspections/${run}/report.json`]: ['system', 'studio/cad-inspections/0badcafe'], 'studio/annotations.json': ['system', 'studio'], 'artifacts/viewport/viewport-1.png': ['system', 'artifacts/viewport'],
      'artifacts/report.pdf': ['report', 'artifacts'], 'artifacts/table.csv': ['report', 'artifacts'], [`recordings/${run}/induction-motor-studio.webm`]: ['report', 'recordings/0badcafe'], 'artifacts/part.glb': ['cad', 'artifacts'], 'data/table.xyz': ['other', 'data'],
    };
    for (const file of Object.keys(expected)) { await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await fs.writeFile(path.join(cwd, file), 'x'); }
    const files = await scanArtifacts(cwd);
    assert.deepEqual(Object.fromEntries(files.map(f => [f.path, [f.category, f.detail]])), expected);
    assert.equal(files.find(f => f.path === 'preview.zip')?.kind, 'model');
  } finally { await cleanup(); }
});

test('records skip non-project entries of the projects directory but still surface corrupt records', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(path.join(root, 'data'), path.join(root, 'D', 'Coserve CAD'));
    await store.init();
    const project = await store.createProject('Bracket');
    await fs.writeFile(path.join(store.projectsDir, 'desktop.ini'), '[.ShellClassInfo]');
    await fs.mkdir(path.join(store.projectsDir, '.trash', '1-x'), { recursive: true });
    await fs.mkdir(path.join(store.projectsDir, 'Not A Project'));
    await fs.mkdir(path.join(store.projectsDir, 'empty-folder'));
    assert.deepEqual((await store.records()).map(p => p.id), [project.id]);
    await fs.writeFile(path.join(store.projectRoot(project.id), 'project.json'), '{ broken');
    await assert.rejects(store.records(), SyntaxError);
  } finally { await cleanup(); }
});
