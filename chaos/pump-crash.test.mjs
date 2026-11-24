// Chaos, end to end: the pump dying at the worst moments, a broken successor
// chain, and duplicate dispatches. Scenarios 1, 3 and 4 of the loop red-team
// (chaos/lib/sim.mjs has the model; chaos/lib/harness.mjs the helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CALLS } from './lib/faults.mjs';
import { HOUR, MIN, TOOLQA, WORKER } from './lib/sim.mjs';
import { acceptedPerKey, assertRecovered, CHAOS, healthOf, logLines, pumpOutcomes, startPump, withSim } from './lib/harness.mjs';

const call = (name) => (c) => CALLS[name]({ method: c.method, path: c.path, host: c.url.origin, query: c.url.searchParams });

// ---- 1. the pump killed mid-run ----

test('1a: a pump killed right after a worker dispatch, before the state push: its run is found by name and judged once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.killWhen({ name: 'after the first worker dispatch', when: call('workerDispatch') });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const first = sim.workerRuns[0];
    const s = sim.readLive();
    const d = s.dispatches.find((x) => x.attempt_id === first.inputs.attempt_id);
    assert.equal(d.status, 'done', 'the dispatch the dead pump sent was judged, not lost');
    assert.equal(String(d.run_id), String(first.id), 'correlated with its run by the run name');
    assert.ok(logLines(sim, /found its run \d+ by run name/).length >= 1);
    // The shards it had saved but never sent expired and their work went out again.
    assert.ok(s.dispatches.filter((x) => x.close_reason === 'lease_expired').length >= 1);
    assert.equal(sim.orphanRuns().length, 0, 'no worker run the state does not know');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

test('1b: a pump killed right after its pre-send state push: the pending dispatches expire and the work is sent again', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.killWhen({ name: 'after the pre-send push', when: call('stateRename') });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const s = sim.readLive();
    const never = s.dispatches.filter((d) => d.run_id === null);
    assert.ok(never.length >= 1, 'saved but never sent');
    assert.ok(never.every((d) => d.status === 'expired'), 'they hold their slots only until their leases end');
    assert.equal(pumpOutcomes(sim)[0], 'failure', 'the killed run shows as failed');
    assertRecovered(sim);
  });
});

test('1c: a pump killed right after a state push, whose successor GitHub dropped: the watchdog restarts the chain', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.cronOn.pump = false; // only the watchdog can restart it
    sim.gh.addFault({ name: 'dropped successor', mode: 'swallow', times: 1, match: CALLS.successorDispatch, respond: () => ({ status: 204 }) });
    sim.killWhen({ name: 'after a state push', when: call('stateRename') });
    startPump(sim);
    await sim.runFor(21 * MIN);
    assert.equal(sim.pumpRuns.length, 1, 'the chain is broken: no successor, no schedule');
    assert.equal(pumpOutcomes(sim)[0], 'failure');
    await sim.runFor(5 * MIN);
    assert.ok(sim.pumpRuns.length >= 2, 'the watchdog dispatched a pump (no pump started for 20 minutes)');
    assert.ok(logLines(sim, /watchdog: dispatched pump\.yml/).length >= 1);
    await sim.runFor(2 * HOUR);
    sim.cronOn.pump = true;
    assertRecovered(sim);
  });
});

test('1d: a pump killed after judging results but before pushing them: the next run judges them again, once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.killWhen({ name: 'after ingest, before the push', when: (c) => c.task.sawArtifact === true && call('stateRelease')(c) });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.ok(sim.killRules[0].hits === 1, 'the kill happened');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1, 'each result counted once');
    assertRecovered(sim);
  });
});

// ---- 3. a dropped successor ----

test('3a: a successor dispatch that fails turns the health issue red at once; the watchdog restarts the chain and it recovers', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.cronOn.pump = false;
    // 502 on every try: the successor retries a server error (a duplicate only replaces the pending run).
    sim.gh.addFault({ name: 'successor 502', times: 4, match: CALLS.successorDispatch, respond: () => ({ status: 502, body: { message: 'Bad Gateway' } }) });
    startPump(sim);
    await sim.runFor(5 * MIN);
    assert.equal(healthOf(sim, 'pump-successor'), 'red', 'the successor reports its own failure to the health issue');
    assert.equal(healthOf(sim), 'red');
    await sim.runFor(50 * MIN);
    assert.ok(logLines(sim, /watchdog: dispatched pump\.yml/).length >= 1, 'the watchdog restarted the chain');
    await sim.runFor(HOUR);
    sim.cronOn.pump = true;
    assertRecovered(sim);
  });
});

test('3b: a successor GitHub accepted but never started: amber once no pump started for 20 minutes, then the watchdog restarts it', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.cronOn.pump = false;
    sim.gh.addFault({ name: 'dropped successor', mode: 'swallow', times: 1, match: CALLS.successorDispatch, respond: () => ({ status: 204 }) });
    startPump(sim);
    const seen = [];
    sim.tapWhen({ task: (t) => t.name.startsWith('watchdog'), when: (c) => c.method === 'PATCH' && /\/issues\/\d+$/.test(c.path), times: 99, fn: () => seen.push(healthOf(sim, 'pump')) });
    await sim.runFor(HOUR);
    assert.ok(seen.includes('amber') || seen.includes('red'), `the pump item turned amber or red (${seen.join(', ')})`);
    assert.ok(logLines(sim, /watchdog: dispatched pump\.yml/).length >= 1);
    await sim.runFor(HOUR);
    sim.cronOn.pump = true;
    assertRecovered(sim);
  });
});

// ---- 4. duplicate dispatches and deliveries ----

test('4a: a worker dispatch GitHub carried out twice: two runs of one shard, judged once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: 'duplicate', mode: 'duplicate', times: 3, match: CALLS.workerDispatch });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.equal(sim.workerRuns.length, 6, 'each shard ran twice');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim, { extraRuns: 3 });
  });
});

test('4b: duplicate runs and no run id in the answer: ingest finds one run by name and judges it once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: 'duplicate, 204', mode: 'duplicate', times: 3, match: CALLS.workerDispatch });
    // GitHub answers 204 without run details: the pump has to correlate by name.
    const orig = sim.gh.repoRoute.bind(sim.gh);
    sim.gh.repoRoute = (req, r, rest) => {
      const out = orig(req, r, rest);
      if (req.method === 'POST' && r.fullName === WORKER && /\/dispatches$/.test(rest)) return { status: 204 };
      return out;
    };
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const s = sim.readLive();
    for (const d of s.dispatches) {
      const twins = sim.workerRuns.filter((r) => r.inputs.attempt_id === d.attempt_id).map((r) => String(r.id));
      assert.equal(twins.length, 2, 'two runs carry the shard name');
      assert.ok(twins.includes(String(d.run_id)), 'the dispatch was matched to one of them by name');
      assert.equal(d.close_reason, 'results_in');
    }
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim, { extraRuns: 3 });
  });
});

test('R-CHAOS-05: a dispatch answered 502 after GitHub started the run stays pending: the run is judged, the slot stays counted', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: '502 after the run started', mode: 'lie', times: 1, match: CALLS.workerDispatch });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const first = sim.workerRuns[0];
    const s = sim.readLive();
    const d = s.dispatches.find((x) => x.attempt_id === first.inputs.attempt_id);
    assert.equal(d.status, 'done', 'the run GitHub started anyway was found and judged');
    assert.equal(d.close_reason, 'results_in');
    assert.ok(logLines(sim, /may or may not have started a run/).length === 1);
    assert.ok(sim.maxInProgress <= 3, `never more worker runs than slots (${sim.maxInProgress})`);
    assertRecovered(sim);
  });
});

test('4c: two pump runs at once (the concurrency group broken): one writer wins, nothing is sent twice', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // The first pre-send push stalls (503), so both runs reserve the same work
    // from the same state, with the same fences, before either has saved it.
    sim.gh.addFault({ name: 'upload 503', times: 1, match: CALLS.stateUpload, respond: () => ({ status: 503, body: { message: 'Service Unavailable' } }) });
    const a = sim.gh.createRun(TOOLQA, 'pump.yml', { event: 'workflow_dispatch' });
    const b = sim.gh.createRun(TOOLQA, 'pump.yml', { event: 'workflow_dispatch' });
    sim.pumpRuns.push(a, b);
    sim.startPumpUngrouped(a);
    sim.startPumpUngrouped(b);
    await sim.runFor(3 * HOUR);
    assert.ok(logLines(sim, /nothing dispatched: the state could not be saved/).length >= 1, 'the run that could not save first sent nothing');
    assert.ok(logLines(sim, /remote state changed since it was pulled/).length >= 1, 'and its later pushes were refused by the stale-writer check');
    const first = sim.workerRuns.filter((r) => Date.parse(r.created_at) < sim.start + 5 * MIN);
    assert.equal(first.length, 3, 'each shard was sent once, by the winner');
    assert.ok(pumpOutcomes(sim).slice(0, 2).includes('failure'), 'the loser fails, so the health issue shows it');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

test('R-CHAOS-08: a server error on the branch re-read right before sending: nothing was sent, so the dispatch is freed at once and the work goes out on the next tick', CHAOS, async () => {
  await withSim({}, async (sim) => {
    let reads = 0;
    // The tick reads the branch once to reserve, then again before each send:
    // fail every try (4) of the first re-read.
    sim.gh.addFault({ name: 'branch 502', times: 4, match: (r) => CALLS.branch(r) && ++reads >= 2, respond: () => ({ status: 502, body: { message: 'Bad Gateway' } }) });
    startPump(sim);
    await sim.runFor(5 * MIN);
    const s = sim.readLive();
    const first = s.dispatches.find((d) => d.run_id === null);
    assert.ok(first, 'a dispatch that was never sent');
    assert.equal(first.status, 'failed', 'closed at once, not left pending until its lease ends');
    assert.equal(logLines(sim, /may or may not have started a run/).length, 0);
    assert.equal(sim.workerRuns.length, 3, 'its work went out again on the next tick');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim);
  });
});
