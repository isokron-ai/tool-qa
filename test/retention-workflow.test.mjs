// The keep-forever copy follows the repository's workflow conventions, and the
// pump uploads what it copies (loop upgrade 20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../scripts/lib/yaml-lite.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const wf = parseYaml(read('.github/workflows/keep-forever.yml'));

test('R-RET-21: keep-forever.yml has the guard first, a lane switch, least-privilege permissions, pinned actions and a schedule that dispatches serialised', () => {
  assert.deepEqual(wf.permissions, {});
  assert.equal(String(wf.concurrency['cancel-in-progress']), 'false');
  assert.ok(wf.on.schedule && wf.on.workflow_dispatch !== undefined);
  const job = wf.jobs.copy;
  assert.deepEqual(job.permissions, { contents: 'write', actions: 'read' });
  assert.ok(job['timeout-minutes'] > 0);
  const [checkout, guard, ...rest] = job.steps;
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(guard.id, 'guard');
  assert.match(guard.run, /node scripts\/guard\.mjs --job keep-forever --no-slots/);
  for (const v of ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_KEEP_FOREVER_ENABLED']) assert.equal(guard.env[v], `\${{ vars.${v} }}`, v);
  for (const step of rest) assert.equal(step.if, "steps.guard.outputs.proceed == 'true'", step.name);
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  assert.match(rest.at(-1).run, /node keep\/copy\.mjs/);
});

test('R-RET-21: the lane switch really stops it, and the watchdog expects the workflow and reads the lane', () => {
  const run = (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'keep-guard-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync('node', ['scripts/guard.mjs', '--job', 'keep-forever', '--no-slots'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
      return { status: r.status, out: readFileSync(out, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.match(run({ LOOP_ENABLED: 'true', LANE_KEEP_FOREVER_ENABLED: 'true' }).out, /proceed=true/);
  assert.match(run({ LOOP_ENABLED: 'true', LANE_KEEP_FOREVER_ENABLED: 'false' }).out, /proceed=false/);
  assert.ok(JSON.parse(read('watchdog/expected-workflows.json')).workflows.includes('.github/workflows/keep-forever.yml'));
  assert.match(read('.github/workflows/watchdog.yml'), /LANE_KEEP_FOREVER_ENABLED: \$\{\{ vars\.LANE_KEEP_FOREVER_ENABLED \}\}/);
});

test('R-RET-21: the pump uploads the keep-forever outputs as ingest-keep-<run>-<attempt> from the directory it writes them to', () => {
  const pump = read('.github/workflows/pump.yml');
  assert.match(pump, /--keep-out "\$RUNNER_TEMP\/keep-out"/);
  assert.match(pump, /name: ingest-keep-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/keep-out\//);
});
