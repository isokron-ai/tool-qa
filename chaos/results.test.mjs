// Chaos, end to end: results that come late, out of order, or with a worker's
// clock far off. Scenarios 2, 7 and 8 of the loop red-team.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CALLS } from './lib/faults.mjs';
import { HOUR, MIN, WORKER } from './lib/sim.mjs';
import { acceptedPerKey, assertRecovered, CHAOS, healthOf, logLines, startPump, withSim } from './lib/harness.mjs';

const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- 2. worker artifacts later than the lease ----

test('2a: a run that finishes after its lease was reaped and re-dispatched: its late result is stored once, as stale, and never counted', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.worker = (ctx) => (ctx.n === 0 ? { durationMs: 40 * MIN } : {}); // the lease is 17.5 minutes
    startPump(sim);
    await sim.runFor(3 * HOUR);
    const slow = sim.workerRuns[0].inputs.attempt_id;
    const s = sim.readLive();
    const late = s.attempts.filter((a) => a.attempt_id === slow);
    assert.equal(late.length, 2, 'both items of the late run were stored as attempts');
    assert.ok(late.every((a) => a.accepted === 0 && a.reason === 'stale_fence'), JSON.stringify(late));
    assert.equal(s.dispatches.find((d) => d.attempt_id === slow).close_reason, 'lease_expired');
    for (const [k, n] of acceptedPerKey(sim)) assert.equal(n, 1, `${k.slice(0, 12)} accepted once`);
    assertRecovered(sim);
  });
});

test('R-CHAOS-02: a run that finished before its lease ran out, judged only after: accepted, not rejected as lease_expired', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // Lease 17.5 minutes from dispatch at 12:00:30. The run ends at 12:16:45:
    // after the pump's 12:16:20 tick and before the lease ends at 12:18:00, so
    // the next tick (12:18:50) reaps the dispatch before ingest looks at it.
    sim.worker = (ctx) => (ctx.n === 0 ? { durationMs: 16 * MIN } : {});
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const first = sim.workerRuns[0];
    const s = sim.readLive();
    const d = s.dispatches.find((x) => x.attempt_id === first.inputs.attempt_id);
    assert.ok(Date.parse(first.updated_at) < Date.parse(d.expires), 'the run finished inside its lease');
    assert.equal(d.status, 'expired', 'and the pump reaped it before judging it');
    const mine = s.attempts.filter((a) => a.attempt_id === first.inputs.attempt_id);
    assert.deepEqual(mine.map((a) => a.accepted), [1, 1], `its results were accepted: ${JSON.stringify(mine)}`);
    assert.equal(sim.workerRuns.length, 3, 'nothing was sent again');
    assertRecovered(sim);
  });
});

test('R-CHAOS-02: a dispatch reaped in a run\'s last minutes, when ingest does not run: its work is held, and the on-time result counts on the next tick', CHAOS, async () => {
  await withSim({ shardSize: 3 }, async (sim) => {
    // Lease 19 minutes from 12:00:30, to 12:19:30. The first run ends at
    // 12:19:15, just after the 12:18:50 tick; the next tick (12:21:20) is in
    // the run's last two minutes, where it reaps but does not ingest.
    sim.worker = (ctx) => (ctx.n === 0 ? { durationMs: 18.5 * MIN } : {});
    startPump(sim);
    await sim.runFor(2 * HOUR);
    const first = sim.workerRuns[0];
    const s = sim.readLive();
    assert.equal(s.dispatches.find((x) => x.attempt_id === first.inputs.attempt_id).status, 'expired');
    assert.ok(s.attempts.filter((a) => a.attempt_id === first.inputs.attempt_id).every((a) => a.accepted === 1), 'its results count');
    assert.equal(sim.workerRuns.length, 2, 'its work was not sent again');
    assertRecovered(sim);
  });
});

test('2b: a run that finishes after its lease but before the work went out again: stored once as lease_expired, the work redone', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // All slots busy with held runs, so the expired work cannot be re-leased
    // when the late result comes in.
    sim.worker = (ctx) => (ctx.n === 0 ? { durationMs: 19 * MIN } : ctx.n < 3 ? { durationMs: 30 * MIN } : {});
    startPump(sim);
    await sim.runFor(3 * HOUR);
    const slow = sim.workerRuns[0].inputs.attempt_id;
    const s = sim.readLive();
    const late = s.attempts.filter((a) => a.attempt_id === slow);
    assert.ok(late.length === 2 && late.every((a) => a.accepted === 0), JSON.stringify(late));
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    // A run past its lease still holds its runner while its slot is free again,
    // so for a while more worker runs go than LOOP_SLOTS (by design: a slot
    // expires with its lease; a worker's job timeout must fit inside it).
    assert.equal(sim.maxInProgress, 6);
    assertRecovered(sim, { extraRuns: 3 });
  });
});

// ---- 7. out of order ----

test('7: attempt 2 finishes before attempt 1: attempt 2 counts, attempt 1 is stale, each result counted once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.worker = (ctx) => (ctx.n === 0 ? { hold: true } : {});
    startPump(sim);
    await sim.runFor(40 * MIN);
    const first = sim.workerRuns[0];
    const second = sim.workerRuns.find((r) => r !== first && JSON.parse(r.inputs.items)[0].run_key === JSON.parse(first.inputs.items)[0].run_key);
    assert.ok(second, 'the work of attempt 1 went out again as attempt 2');
    assert.equal(second.status, 'completed', 'and attempt 2 has finished');
    sim.releaseWorker(first); // attempt 1 finishes now, last
    await sim.runFor(2 * HOUR);
    const s = sim.readLive();
    const byAttempt = (id) => s.attempts.filter((a) => a.attempt_id === id);
    assert.ok(byAttempt(second.inputs.attempt_id).every((a) => a.accepted === 1));
    assert.ok(byAttempt(first.inputs.attempt_id).every((a) => a.accepted === 0 && a.reason === 'stale_fence'));
    const firstFence = JSON.parse(first.inputs.items)[0].fence;
    const secondFence = JSON.parse(second.inputs.items)[0].fence;
    assert.ok(secondFence > firstFence, 'the second attempt holds the newer fence');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

// ---- 8. clock skew ----

for (const [name, skew] of [['in the future (+3 days)', 3 * 24 * HOUR], ['in the past (-400 days)', -400 * 24 * HOUR]]) {
  test(`8: a worker whose clock says ${name}: its times are kept as claims only; the result counts at the pump's time and is not due again early`, CHAOS, async () => {
    await withSim({}, async (sim) => {
      sim.worker = () => ({ item: () => ({ meta: { started_at: isoS(sim.t + skew), finished_at: isoS(sim.t + skew + MIN) } }) });
      startPump(sim);
      await sim.runFor(3 * HOUR);
      const s = sim.readLive();
      for (const r of s.results) {
        const at = Date.parse(r.accepted_at);
        assert.ok(at >= sim.start && at <= sim.t, `accepted_at ${r.accepted_at} is the pump's own time`);
      }
      assert.equal(sim.workerRuns.length, 3, 'no subject became due again');
      assertRecovered(sim);
    });
  });
}

test('8c: the pump runner\'s clock 90 s ahead of GitHub, with no run id in the dispatch answer: runs are still found by name', CHAOS, async () => {
  await withSim({ pumpSkewMs: 90_000 }, async (sim) => {
    const orig = sim.gh.repoRoute.bind(sim.gh);
    sim.gh.repoRoute = (req, r, rest) => {
      const out = orig(req, r, rest);
      if (req.method === 'POST' && r.fullName === WORKER && /\/dispatches$/.test(rest)) return { status: 204 };
      return out;
    };
    // The dispatcher's own short poll misses them, so ingest has to find them.
    sim.gh.addFault({ name: 'poll misses', times: 12, match: (r) => CALLS.workerRuns(r) && r.query.get('per_page') === '30', respond: () => ({ body: { total_count: 0, workflow_runs: [] } }) });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.ok(logLines(sim, /found its run \d+ by run name/).length >= 3);
    assertRecovered(sim);
  });
});

// ---- loop upgrade 20: a keep-forever file that cannot be written ----

test('R-RET-26: one item\'s keep-forever file fails to write while the others succeed: every result is still judged and recorded, and a gap marker is sealed so the prune keeps that run\'s full bundles', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // Per item the pump seals its full bundle, then its keep-forever file: call 2 is the first item's keep file.
    sim.sealFault = (n) => n === 2;
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.equal(sim.missing().length, 0, 'every subject still has its result');
    assert.ok((sim.keepGaps ?? []).length >= 1, `a gap marker was sealed: ${JSON.stringify(sim.keepGaps)}`);
    assert.ok(sim.keepGaps.every((n) => /^keep-gap-.+\.tar\.age$/.test(n)));
    for (const [k, n] of acceptedPerKey(sim)) assert.equal(n, 1, `${k.slice(0, 12)} accepted once`);
    assertRecovered(sim);
  });
});

test('R-WD-14: a keep-forever file that fails with its gap marker artifact lost turns keep-markers red in the health issue; with the marker uploaded it stays green', CHAOS, async () => {
  for (const [lost, expect] of [[false, 'green'], [true, 'red']]) {
    await withSim({}, async (sim) => {
      sim.sealFault = (n) => n === 2;
      sim.markerUpload = !lost;
      startPump(sim);
      await sim.runFor(3 * HOUR);
      assert.ok((sim.keepGaps ?? []).length >= 1, 'a gap marker was sealed');
      assert.equal(healthOf(sim, 'keep-markers'), expect, `marker ${lost ? 'lost' : 'uploaded'}`);
      assert.equal(sim.missing().length, 0, 'every subject still has its result');
    });
  }
});
