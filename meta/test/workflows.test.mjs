import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { FILES, PINS, SLOTS, main as gen } from '../gen-workflows.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => parseYaml(readFileSync(new URL(rel, ROOT), 'utf8'));

test('the committed workflows are what meta/gen-workflows.mjs writes', () => {
  assert.equal(gen(['--check']), 0);
  assert.deepEqual(Object.keys(FILES).sort(), ['.github/workflows/meta-fixture.yml', '.github/workflows/meta-github.yml', '.github/workflows/meta-registry.yml']);
});

test('pump/workflows.json dispatches these files with a shard no larger than the slots', () => {
  const wf = JSON.parse(readFileSync(new URL('pump/workflows.json', ROOT), 'utf8')).workflows;
  for (const lane of ['meta-github', 'meta-registry']) {
    assert.equal(wf[lane].repo, 'isokron-ai/tool-qa');
    assert.equal(wf[lane].file, `${lane}.yml`);
    assert.ok(wf[lane].shard_size <= SLOTS, `${lane} shard_size ${wf[lane].shard_size} > ${SLOTS} slots`);
  }
});

for (const lane of ['meta-github', 'meta-registry']) {
  test(`${lane}.yml follows the worker contract`, () => {
    const w = read(`.github/workflows/${lane}.yml`);
    assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
    assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs), ['shard_id', 'attempt_id', 'items']);
    assert.equal(w['run-name'], 'shard ${{ inputs.shard_id }}');
    assert.deepEqual(w.permissions, {});
    const job = w.jobs.collect;
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.ok(Number(job['timeout-minutes']) <= 40);
    // The first step checks LOOP_ENABLED, before anything is checked out.
    assert.equal(job.steps[0].env.LOOP_ENABLED, '${{ vars.LOOP_ENABLED }}');
    assert.match(job.steps[0].run, /"\$LOOP_ENABLED" == "true"/);
    const guard = job.steps.find((s) => s.id === 'guard');
    assert.match(guard.run, new RegExp(`scripts/guard.mjs --job ${lane} --no-slots`));
    assert.ok(Object.keys(guard.env).includes(`LANE_${lane.toUpperCase().replace('-', '_')}_ENABLED`));
    const kit = job.steps.filter((s) => typeof s.uses === 'string' && s.uses.startsWith('isokron-ai/tool-qa/worker-kit@'));
    assert.equal(kit.length, SLOTS);
    kit.forEach((s, i) => {
      assert.equal(s.uses, PINS.workerKit.split(' ')[0]);
      assert.equal(s.with['item-index'], String(i));
      assert.equal(s.with.fence, `\${{ steps.collect.outputs.fence_${i} }}`);
      assert.equal(s.with['run-key'], `\${{ steps.collect.outputs.run_key_${i} }}`);
      assert.match(s.if, new RegExp(`steps\\.collect\\.outputs\\.has_${i} == 'true'`));
      assert.equal(s.with['dry-run'], undefined);
    });
    const collect = job.steps.find((s) => s.id === 'collect');
    assert.equal('GITHUB_TOKEN' in collect.env, lane === 'meta-github', 'only meta-github gets the job token');
    for (const s of job.steps) {
      if (typeof s.run === 'string') assert.ok(!/\$\{\{/.test(s.run), `no expression inside run: (${s.name ?? s.id})`);
    }
  });
}

test('meta-fixture.yml runs on pull requests only, dry-run, and judges the bundles', () => {
  const w = read('.github/workflows/meta-fixture.yml');
  assert.deepEqual(Object.keys(w.on), ['pull_request']);
  assert.deepEqual(w.permissions, {});
  const steps = w.jobs.fixture.steps;
  const kit = steps.filter((s) => s.uses === './worker-kit');
  assert.equal(kit.length, SLOTS);
  assert.ok(kit.every((s) => s.with['dry-run'] === 'true'));
  assert.match(steps.at(-1).run, /meta\/fixture\.mjs judge/);
});
