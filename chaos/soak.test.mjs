// A short slice of the randomized soak (chaos/soak.mjs) on every PR, so the
// fault schedules and the end checks themselves stay working. The long soak
// runs weekly and on demand (.github/workflows/chaos-soak.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAOS } from './lib/harness.mjs';
import { soakOne } from './soak.mjs';

const SEEDS = [11, 12, 13, 14, 15, 16, 17, 18];

test(`soak: ${SEEDS.length} seeded random fault schedules, each followed by a quiet spell; the loop recovers from every one`, CHAOS, async () => {
  const failed = [];
  for (const seed of SEEDS) {
    const out = await soakOne(seed, { faults: 12, hours: 4, recoverHours: 4 });
    if (!out.ok) failed.push(`seed ${seed}:\n  ${out.problems.join('\n  ')}\n  schedule:\n    ${out.schedule.join('\n    ')}`);
  }
  assert.deepEqual(failed, [], 'rerun one with: node chaos/soak.mjs --seed <n> --verbose');
});

test('soak: the same seed gives the same schedule and the same end state', CHAOS, async () => {
  const a = await soakOne(5, { faults: 10, hours: 3, recoverHours: 3 });
  const b = await soakOne(5, { faults: 10, hours: 3, recoverHours: 3 });
  assert.deepEqual(a.schedule, b.schedule);
  assert.equal(a.ok, b.ok);
});
