import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { FILES, LANE_SLOTS, PINS, SLOTS, main as gen } from '../gen-workflows.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => parseYaml(readFileSync(new URL(rel, ROOT), 'utf8'));

test('the committed workflows are what meta/gen-workflows.mjs writes', () => {
  assert.equal(gen(['--check']), 0);
  assert.deepEqual(Object.keys(FILES).sort(), ['.github/workflows/meta-fixture.yml', '.github/workflows/meta-github.yml', '.github/workflows/meta-registry.yml', '.github/workflows/release-diff.yml']);
});

test('pump/workflows.json dispatches these files with a shard no larger than the slots', () => {
  const wf = JSON.parse(readFileSync(new URL('pump/workflows.json', ROOT), 'utf8')).workflows;
  for (const lane of ['meta-github', 'meta-registry', 'release-diff']) {
    assert.equal(wf[lane].repo, 'isokron-ai/tool-qa');
    assert.equal(wf[lane].file, `${lane}.yml`);
    assert.ok(wf[lane].shard_size <= LANE_SLOTS[lane], `${lane} shard_size ${wf[lane].shard_size} > ${LANE_SLOTS[lane]} slots`);
  }
  assert.equal(wf['release-diff'].enabled, false, 'release-diff is off until it is switched on by review');
});

for (const lane of ['meta-github', 'meta-registry', 'release-diff']) {
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
    assert.equal(kit.length, LANE_SLOTS[lane]);
    kit.forEach((s, i) => {
      // release-diff's skips carry a fault side, which the kit knows from 2ffcea1 on.
      assert.equal(s.uses, (lane === 'release-diff' ? PINS.workerKitFault : PINS.workerKit).split(' ')[0]);
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
  const kit = steps.filter((s) => s.uses === PINS.workerKit.split(' ')[0]);
  assert.equal(kit.length, SLOTS);
  assert.ok(kit.every((s) => s.with['dry-run'] === "${{ matrix.mode == 'check' && 'true' || 'false' }}"));
  assert.deepEqual(w.jobs.fixture.strategy.matrix.mode, ['check', 'upload']);
  assert.match(steps.at(-1).run, /meta\/fixture\.mjs judge/);
  const rd = w.jobs['release-diff-fixture'];
  assert.deepEqual(rd.permissions, { contents: 'read' });
  const rdKit = rd.steps.filter((s) => s.uses === PINS.workerKitFault.split(' ')[0]);
  assert.equal(rdKit.length, LANE_SLOTS['release-diff']);
  assert.ok(!('GITHUB_TOKEN' in rd.steps.find((s) => s.id === 'collect').env), 'release-diff gets no token');
  assert.match(rd.steps.at(-1).run, /meta\/fixture\.mjs judge release-diff/);
});
