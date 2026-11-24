// The snapshot workflow holds the least it needs: no secrets, no key, no
// environment, and only contents: write on its one job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const text = readFileSync(join(ROOT, '.github/workflows/state-snapshot.yml'), 'utf8');
const wf = parseYaml(text);

test('R-SNAP-06: the snapshot workflow holds only contents: write, no secrets or key, and checks the kill switch first', () => {
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(Object.keys(wf.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(wf.on.schedule[0].cron, '41 * * * *');
  assert.equal(wf.concurrency.group, 'state-snapshot', 'its own group, never the pump\'s');
  assert.deepEqual(Object.keys(wf.jobs), ['snapshot']);
  const job = wf.jobs.snapshot;
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.equal(job.environment, undefined, 'no environment: it needs none of its secrets');
  assert.ok(job['timeout-minutes'] <= 15);
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /AGE_IDENTITY|install-age|--decrypt/);
  const [checkout, guard, ...rest] = job.steps;
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(String(checkout.with['persist-credentials']), 'false');
  assert.equal(guard.id, 'guard');
  assert.equal(guard.run, 'node scripts/guard.mjs --job state-snapshot --no-slots');
  for (const v of ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_STATE_SNAPSHOT_ENABLED']) assert.equal(guard.env[v], `\${{ vars.${v} }}`, v);
  for (const s of rest) assert.equal(s.if, "steps.guard.outputs.proceed == 'true'", s.name);
  const run = rest.find((s) => s.name === 'Snapshot');
  assert.equal(run.run, 'node snapshot/snapshot.mjs');
  assert.deepEqual(run.env, { GITHUB_TOKEN: '${{ github.token }}' });
});
