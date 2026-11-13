import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../server/process.js';

test('solver subprocess receives the configured engine root without inheriting credentials', async () => {
  const keys = ['COSERVE_THERMOFORGE_ROOT', 'CASTUDIO_TEST_SECRET'] as const;
  const previous = keys.map(key => process.env[key]);
  const engine = path.join(os.tmpdir(), 'custom thermal engine');
  try {
    process.env.COSERVE_THERMOFORGE_ROOT = engine;
    process.env.CASTUDIO_TEST_SECRET = 'fixture-only';
    let output = '';
    const result = await runProcess(process.execPath, ['-e',
      'console.log(JSON.stringify({root:process.env.COSERVE_THERMOFORGE_ROOT,secret:process.env.CASTUDIO_TEST_SECRET}))'],
      { cwd: os.tmpdir(), timeout: 10000, output: text => { output += text; } });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(JSON.parse(output), { root: engine });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
