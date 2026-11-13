import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { Thermal } from '../server/thermal.js';
import { Events } from '../server/events.js';

test('saving the interpreter preserves the CUDA choice and verifies the real GPU', {skip: !process.env.STUDIO_THERMAL_TEST_GPU}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thermal-gpu-save-'));
  const store = new Store(root); await store.init();
  const thermal = new Thermal(store, new History(store), new Events());
  try {
    await jsonWrite(path.join(root, 'thermal-runtime.json'), {executable:process.env.STUDIO_THERMAL_TEST_PYTHON, device:'cuda'});
    const probe = await thermal.saveRuntime(process.env.STUDIO_THERMAL_TEST_PYTHON);
    assert.equal(probe.ok, true);
    assert.match(probe.message, /GPU/);
    assert.equal((await thermal.config()).device, 'cuda');
  } finally { await thermal.dispose(); await fs.rm(root, {recursive:true, force:true}); }
});

for (const device of ['cpu', 'cuda', 'invalid-device']) {
  test(`thermal job freezes or rejects configured device ${device}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thermal-device-'));
    const store = new Store(root); await store.init();
    const project = await store.createProject('device test');
    const thermal = new Thermal(store, new History(store), new Events());
    const release = store.acquire(project.id);
    try {
      await jsonWrite(path.join(root, 'thermal-runtime.json'), {executable: 'python', device});
      await fs.writeFile(path.join(store.workspace(project.id), 'model.stl'), 'solid example\nendsolid example');
      const start = () => thermal.start(project.id, {source:'model.stl', units:'mm', config:{environment_only:true}}, true);
      if (device === 'invalid-device') { await assert.rejects(start, /设备/); return; }
      const run = await start();
      const request = JSON.parse(await fs.readFile(path.join(root, 'thermal-work', run.id, 'request.json'), 'utf8'));
      assert.equal(request.device, device);
      await thermal.cancel(project.id, run.id);
    } finally { release(); await thermal.dispose(); await fs.rm(root, {recursive:true, force:true}); }
  });
}
