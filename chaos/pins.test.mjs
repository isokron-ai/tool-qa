// Chaos, end to end: version pins (R-PIN-01). The simulated worker is honest:
// it reports its own code at the commit it ran (tool_sha when the pump sent
// one, else its branch head) and every other pin as pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOUR, MIN, WORKER, WORKER_FILE, WORKFLOW } from './lib/sim.mjs';
import { CHAOS, logLines, startPump, withSim } from './lib/harness.mjs';

const OLD = 'c0ffee1'.padEnd(40, '5'); // an older commit of the worker repository than its branch head
const HEAD = 'b'.repeat(40); // the simulated worker repository's main
const CONTRACT = ['shard_id', 'attempt_id', 'items'];

const pinTo = (sim, sha, mode, probe = {}) => {
  sim.config.workflows[WORKFLOW] = { ...sim.config.workflows[WORKFLOW], pin_check: mode, versions: { tool: { worker: sha.slice(0, 7) }, oracle: {}, probe } };
};
const parked = (s) => s.attempts.filter((a) => a.accepted === 0 && !['pin_mismatch', 'pin_unverified', 'stale_fence'].includes(a.reason));

test('R-PIN-01: an enforce lane runs its pinned commit, not the branch head: every result proves the pin', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.repo(WORKER).commits.add(OLD);
    sim.gh.repo(WORKER).workflows.get(WORKER_FILE).inputs = [...CONTRACT, 'tool_sha'];
    pinTo(sim, OLD, 'enforce');
    startPump(sim);
    await sim.runFor(45 * MIN);
    assert.equal(sim.missing().length, 0, 'every subject has a result');
    assert.ok(sim.workerRuns.length > 0);
    for (const run of sim.workerRuns) {
      assert.equal(run.inputs.tool_sha, OLD, 'the pinned commit, resolved in full');
      assert.equal(run.head_sha, HEAD, 'the run itself is on the branch');
    }
    const s = sim.readLive();
    assert.equal(s.attempts.filter((a) => /^pin_/.test(a.reason ?? '')).length, 0);
    assert.equal(s.kv[`pump.paused:${WORKFLOW}`], undefined);
  });
});

test('R-PIN-01: an enforce lane whose worker does not take tool_sha yet is refused by GitHub, records nothing, and goes on once the worker takes it', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.repo(WORKER).commits.add(OLD);
    const wf = sim.gh.repo(WORKER).workflows.get(WORKER_FILE);
    wf.inputs = CONTRACT; // the worker as it is before its rollout change
    pinTo(sim, OLD, 'enforce');
    startPump(sim);
    await sim.runFor(20 * MIN);
    assert.equal(sim.workerRuns.length, 0, 'nothing ran');
    assert.ok(logLines(sim, /Unexpected inputs provided/).length >= 1);
    assert.equal(sim.readLive().results.length, 0, 'and nothing was filed under a pin it did not run');
    wf.inputs = [...CONTRACT, 'tool_sha'];
    await sim.runFor(HOUR);
    assert.equal(sim.missing().length, 0, 'every subject has a result once the worker takes the input');
    assert.ok(sim.workerRuns.every((r) => r.inputs.tool_sha === OLD));
  });
});

test('R-PIN-02: a label lane whose branch moved past its own pin: accepted with the pin listed unverified (self_pin_moved), no pause', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.repo(WORKER).commits.add(OLD);
    pinTo(sim, OLD, 'label'); // the worker runs its branch head and says so
    startPump(sim);
    await sim.runFor(45 * MIN);
    const s = sim.readLive();
    assert.equal(sim.missing().length, 0, 'every subject has a result');
    assert.equal(s.attempts.filter((a) => /^pin_/.test(a.reason ?? '')).length, 0, 'nothing refused for its pins');
    assert.equal(s.kv[`pump.paused:${WORKFLOW}`], undefined, 'no pause');
    assert.ok(sim.workerRuns.every((r) => !('tool_sha' in r.inputs)), 'a label lane sends no tool_sha');
  });
});

test('R-PIN-01: a label lane whose worker runs another version of a pin that is not its own: refused (pin_mismatch), the lane pauses, nothing is parked, and a pin bump brings it back', CHAOS, async () => {
  await withSim({}, async (sim) => {
    pinTo(sim, HEAD, 'label', { corpus: 'c1' });
    // The worker runs its head (its own pin holds) but another version of the probe.
    sim.worker = () => ({ item: () => ({ meta: { tools: [{ name: 'worker', version: HEAD }, { name: 'corpus', version: 'c2' }] } }) });
    startPump(sim);
    await sim.runFor(40 * MIN);
    let s = sim.readLive();
    const refused = s.attempts.filter((a) => a.reason === 'pin_mismatch');
    assert.ok(refused.length >= 1, 'refused for its pins');
    assert.equal(s.results.length, 0, 'nothing filed under a pin the worker did not run');
    assert.equal(s.kv[`pump.paused:${WORKFLOW}`]?.reason, 'pin_mismatch');
    const pause = s.kv[`pump.paused:${WORKFLOW}`];
    await sim.runFor(30 * MIN);
    const during = sim.workerRuns.filter((r) => Date.parse(r.created_at) > Date.parse(pause.since) && Date.parse(r.created_at) < Date.parse(pause.until));
    assert.deepEqual(during.map((r) => r.id), [], 'nothing dispatched while paused');
    assert.ok(logLines(sim, /refused for its version pins \(pin_mismatch\)/).length >= 1);
    assert.deepEqual(parked(sim.readLive()), [], 'no rejection that counts towards parking');

    pinTo(sim, HEAD, 'label', { corpus: 'c2' }); // the pin bumped to what the worker runs
    await sim.runFor(2 * HOUR);
    s = sim.readLive();
    assert.equal(sim.missing().length, 0, 'every subject has a result under the new pin');
    const after = s.kv[`pump.paused:${WORKFLOW}`];
    assert.ok(!after || Date.parse(after.until) <= sim.t, 'the pause ended on its own');
  });
});

test('R-PIN-01: ingest holds a lane to the pin_check of the config the pump dispatched with: an enforce lane whose worker does not prove its commit is refused (pin_unverified)', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.repo(WORKER).commits.add(OLD);
    pinTo(sim, OLD, 'enforce'); // pump/workflows.json has this lane as "label"; the pump's own config wins
    sim.worker = () => ({ item: () => ({ meta: { tools: [{ name: 'worker', version: '9.9.9' }] } }) }); // a package version only
    startPump(sim);
    await sim.runFor(40 * MIN);
    const s = sim.readLive();
    assert.ok(s.attempts.some((a) => a.reason === 'pin_unverified'));
    assert.equal(s.results.length, 0);
    assert.equal(s.kv[`pump.paused:${WORKFLOW}`]?.reason, 'pin_unverified');
  });
});
