// The manual re-ingest workflow re-checks its switches once it holds the
// `pump` concurrency group (R-ING-13). The step's script is run here as
// GitHub would run it, with a scratch GITHUB_OUTPUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../scripts/lib/yaml-lite.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wf = parseYaml(readFileSync(join(ROOT, '.github/workflows/ingest.yml'), 'utf8'));

test('R-ING-13: the ingest job checks the kill switch and the pump lane again before anything else', () => {
  const job = wf.jobs.ingest;
  assert.equal(job.concurrency.group, 'pump');
  const steps = job.steps;
  assert.match(steps[0].uses, /^actions\/checkout@/);
  const guard = steps[1];
  assert.equal(guard.id, 'guard');
  assert.match(guard.run, /node scripts\/guard\.mjs --job ingest --no-slots/);
  for (const v of ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_INGEST_ENABLED', 'LANE_PUMP_ENABLED']) {
    assert.equal(guard.env[v], `\${{ vars.${v} }}`, v);
  }
  assert.equal(guard.if, undefined, 'it always runs');

  const run = (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-guard-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync('bash', ['-e', '-c', guard.run], {
        cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      });
      return { status: r.status, text: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const on = { LOOP_ENABLED: 'true', LANE_INGEST_ENABLED: 'true', LANE_PUMP_ENABLED: 'false' };
  assert.equal(run(on).status, 0);
  const off = run({ ...on, LOOP_ENABLED: 'false' });
  assert.equal(off.status, 1);
  assert.match(off.text, /switched off while this run waited/);
  assert.equal(run({ ...on, LANE_INGEST_ENABLED: 'false' }).status, 1);
  const pump = run({ ...on, LANE_PUMP_ENABLED: 'true' });
  assert.equal(pump.status, 1);
  assert.match(pump.text, /pump was switched back on/);
  assert.equal(run({ ...on, LANE_PUMP_ENABLED: '' }).status, 1, 'an unset pump lane means on');
});
