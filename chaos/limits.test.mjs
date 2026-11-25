// Chaos, end to end: GitHub's rate limits and the pump's own API budget
// mid-tick, and the kill switch, the pause and the slot count flipped while a
// pump run is going. Scenarios 6 and 10 of the loop red-team.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CALLS } from './lib/faults.mjs';
import { HOUR, MIN, WORKER } from './lib/sim.mjs';
import { acceptedPerKey, assertRecovered, CHAOS, healthOf, logLines, pumpOutcomes, startPump, withSim } from './lib/harness.mjs';

const resetIn = (sim, ms) => String(Math.ceil((sim.t + ms) / 1000));

// ---- 6. rate limits and budget exhaustion ----

test('6a: a secondary rate limit (429, retry-after 30 s) on a worker dispatch: the pump waits and sends it once', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: '429', times: 1, match: CALLS.workerDispatch, respond: () => ({ status: 429, headers: { 'retry-after': '30' }, body: { message: 'You have exceeded a secondary rate limit' } }) });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.equal(sim.gh.faults[0].hits, 1);
    assert.equal(sim.workerRuns.length, 3, 'one run per shard: the refused send was not counted as sent');
    assertRecovered(sim);
  });
});

test('R-CHAOS-04: a primary rate limit (403, reset in 40 minutes) hit by ingest mid-tick: health turns amber while it holds; the results that came in meanwhile still count', CHAOS, async () => {
  await withSim({}, async (sim) => {
    startPump(sim);
    await sim.runFor(2 * MIN);
    sim.gh.addFault({
      name: '403 primary', times: 1, match: (r) => CALLS.workerRun(r),
      respond: () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': resetIn(sim, 40 * MIN) }, body: { message: 'API rate limit exceeded' } }),
    });
    const seen = [];
    sim.tapWhen({ task: (t) => t.name.startsWith('watchdog'), when: (c) => c.method === 'PATCH' || (c.method === 'POST' && /\/issues$/.test(c.path)), times: 99, fn: () => seen.push(healthOf(sim, 'api-budget')) });
    await sim.runFor(45 * MIN);
    assert.ok(seen.includes('amber'), `api-budget showed amber while the pump was held (${seen.join(', ')})`);
    assert.ok(logLines(sim, /ingest: stopped for this tick by the API budget/).length >= 3);
    await sim.runFor(2 * HOUR);
    assert.equal(healthOf(sim, 'api-budget'), null, 'the item goes away once the pump is no longer held');
    // The runs had finished inside their leases, so their results count
    // (R-CHAOS-02), and ingest looks at them before the work could go out
    // again (R-CHAOS-07).
    assert.equal(sim.workerRuns.length, 3, 'nothing had to be sent again');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

test('R-CHAOS-07: a rate limit that ends mid-run: the late dispatches ingest could not look at are judged first, not throttled while their work goes out again', CHAOS, async () => {
  await withSim({}, async (sim) => {
    startPump(sim);
    await sim.runFor(2 * MIN);
    // Held to about 12:36: past the leases (12:18), ending in the middle of
    // the pump run that started at 12:33, after two of its ticks were stopped.
    sim.gh.addFault({
      name: '403 primary', times: 1, match: (r) => CALLS.workerRun(r),
      respond: () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': resetIn(sim, 34 * MIN) }, body: { message: 'API rate limit exceeded' } }),
    });
    await sim.runFor(3 * HOUR);
    assert.equal(sim.workerRuns.length, 3, 'every on-time result counted; nothing was sent again');
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

test('6b: a rate limit on the state push that outlasts the retries (6 tries): the run fails loudly, nothing sent is lost, the next run carries on', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: '429 upload', times: 6, match: CALLS.stateUpload, respond: () => ({ status: 429, headers: { 'retry-after': '20' }, body: { message: 'secondary rate limit' } }) });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.equal(pumpOutcomes(sim)[0], 'failure');
    assert.ok(logLines(sim, /nothing dispatched: the state could not be saved/).length === 1, 'nothing was sent without being saved first');
    assertRecovered(sim);
  });
});

test('R-CHAOS-14: a short GitHub outage on the state push (500s on the upload, then a 502) is ridden out by the retries: the run does not fail and nothing is saved twice', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.gh.addFault({ name: '500 upload', times: 3, match: CALLS.stateUpload, respond: () => ({ status: 500, body: { message: 'Server Error' } }) });
    sim.gh.addFault({ name: '502 rename', times: 1, match: CALLS.stateRename, respond: () => ({ status: 502, body: { message: 'Bad Gateway' } }) });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.equal(pumpOutcomes(sim)[0], 'success', 'the first run saved its state after retrying');
    assert.equal(logLines(sim, /nothing dispatched: the state could not be saved/).length, 0);
    assert.ok(logLines(sim, /retry: POST .*assets.*HTTP 500; attempt 1\/6 failed/).length >= 1, 'the retries are in the log');
    assertRecovered(sim);
  });
});

test('6c: the hourly dispatch budget spent by earlier runs: nothing is sent, health is amber, and the loop carries on when the hour rolls over', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // Earlier runs used the whole dispatch family (300 calls an hour), kept in the state.
    sim.foreignWrite((db) => {
      const calls = Array.from({ length: 300 }, (_, i) => sim.t - 10 * MIN + i * 1000);
      db.setKv('pump.api_budget', { at: sim.t, calls: { total: calls, families: { dispatch: calls } }, blocked: {} }, { now: sim.t });
    });
    startPump(sim);
    await sim.runFor(25 * MIN);
    assert.equal(sim.workerRuns.length, 0, 'nothing is sent past the hourly budget');
    assert.ok(logLines(sim, /dispatch: hourly budget of 300 calls is used/).length >= 1);
    assert.equal(healthOf(sim, 'api-budget'), 'amber');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim);
  });
});

// ---- 10. kill switch and pause flipped mid-run ----

test('10a: LOOP_ENABLED turned off mid-run: the running pump finishes its run, nothing starts after it, and it all resumes when turned on', CHAOS, async () => {
  await withSim({ subjects: 10 }, async (sim) => {
    sim.worker = (ctx) => (ctx.n >= 3 ? {} : { durationMs: 8 * MIN });
    startPump(sim);
    await sim.runFor(14 * MIN); // the second pump run is going
    const going = sim.pumpGroup.running;
    sim.setVar('LOOP_ENABLED', 'false');
    const off = sim.t;
    await sim.runFor(HOUR);
    assert.equal(going.conclusion, 'success', 'the run that was going finished normally (OPERATIONS.md: running jobs keep going)');
    const ended = Date.parse(going.updated_at);
    const after = sim.workerRuns.filter((r) => Date.parse(r.created_at) > ended);
    assert.equal(after.length, 0, 'no worker was dispatched after that run ended');
    const later = sim.pumpRuns.filter((r) => Date.parse(r.created_at) >= off && r.guard);
    assert.ok(later.length >= 1 && later.every((r) => r.guard.reason === 'disabled' && r.conclusion === 'success'), 'later runs stop at the guard, green');
    assert.ok(!sim.pumpRuns.some((r) => r.guard?.reason === 'disabled' && r.successor), 'and dispatch no successor');
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim);
  });
});

test('10b: LOOP_PAUSE_UNTIL set mid-run: the loop stops after the running pump and resumes on its own when the time passes', CHAOS, async () => {
  await withSim({}, async (sim) => {
    startPump(sim);
    await sim.runFor(14 * MIN);
    sim.setVar('LOOP_PAUSE_UNTIL', new Date(sim.t + 50 * MIN).toISOString());
    await sim.runFor(45 * MIN);
    const paused = sim.pumpRuns.filter((r) => r.guard?.reason === 'paused');
    assert.ok(paused.length >= 1, 'runs during the pause stop at the guard');
    await sim.runFor(2 * HOUR); // nobody touches the switch again
    assert.ok(sim.pumpRuns.some((r) => r.guard?.proceed && Date.parse(r.created_at) > sim.start + 64 * MIN), 'the schedule started the pump again after the pause');
    assertRecovered(sim);
  });
});

test('10c: LOOP_SLOTS set to 0 mid-run: housekeeping only, no successor, the pump shows off; slots back and the loop resumes', CHAOS, async () => {
  await withSim({}, async (sim) => {
    startPump(sim);
    await sim.runFor(14 * MIN);
    sim.setVar('LOOP_SLOTS', '0');
    await sim.runFor(HOUR);
    const zero = sim.pumpRuns.filter((r) => r.guard?.proceed && r.guard.slots === 0);
    assert.ok(zero.length >= 1 && zero.every((r) => !r.successor), 'housekeeping runs dispatch no successor');
    assert.equal(healthOf(sim, 'pump'), 'off');
    sim.setVar('LOOP_SLOTS', '3');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim);
  });
});

test('10d: the pump lane switched off mid-run, with results still to come: they wait in their runs and are judged once the lane is back', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.worker = () => ({ durationMs: 12 * MIN });
    startPump(sim);
    await sim.runFor(3 * MIN);
    sim.setVar('LANE_PUMP_ENABLED', 'false');
    await sim.runFor(40 * MIN);
    assert.equal(sim.readLive().results.length, 0, 'nothing judged while the lane is off');
    sim.setVar('LANE_PUMP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    for (const n of acceptedPerKey(sim).values()) assert.equal(n, 1);
    assertRecovered(sim);
  });
});

test('10e: a worker dispatched just before the kill switch flips is still judged when the loop is back', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.worker = () => ({ durationMs: 5 * MIN });
    startPump(sim);
    sim.tapWhen({ when: (c) => c.method === 'POST' && c.path.startsWith(`/repos/${WORKER}/actions/workflows/`), fn: () => sim.setVar('LOOP_ENABLED', 'false') });
    await sim.runFor(HOUR);
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim);
  });
});
