// Chaos, end to end: the state asset damaged, replaced under the pump, from
// newer code, or missing; restores from a snapshot racing the pump. Scenarios
// 5 and 9 of the loop red-team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CALLS, corrupt, operatorRestore } from './lib/faults.mjs';
import { HOUR, MIN, TOOLQA } from './lib/sim.mjs';
import { assertRecovered, CHAOS, healthOf, logLines, pumpOutcomes, startPump, withSim } from './lib/harness.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const call = (name) => (c) => CALLS[name]({ method: c.method, path: c.path, host: c.url.origin, query: c.url.searchParams });

/** Run until the first hourly snapshot exists (12:41) and the loop has settled. */
async function warmUp(sim) {
  startPump(sim);
  await sim.runFor(45 * MIN);
  assert.equal(sim.missing().length, 0, 'every subject has its first result');
  assert.ok((sim.gh.release(TOOLQA, 'state-snapshots')?.assets ?? []).some((a) => a.name.startsWith('state-')), 'a snapshot exists');
}

// ---- 5. a damaged, foreign or missing state asset ----

for (const how of ['truncate', 'garbage', 'wrongRecipient']) {
  test(`5: a state asset that is ${how === 'truncate' ? 'cut short' : how === 'garbage' ? 'garbage' : 'encrypted to the wrong recipient'}: the pump never writes over it, stops loudly (red), and a restore brings the loop back`, CHAOS, async () => {
    await withSim({}, async (sim) => {
      await warmUp(sim);
      corrupt(sim, how);
      const bad = sim.liveAsset();
      const badBytes = sha(sim.gh.assetBytes(bad.id));
      const from = sim.t;
      await sim.runFor(HOUR);
      assert.equal(sim.liveAsset().id, bad.id, 'the damaged asset is still the live one: nothing was pushed over it');
      assert.equal(sha(sim.gh.assetBytes(bad.id)), badBytes);
      const runs = pumpOutcomes(sim, from);
      assert.ok(runs.filter((r) => r === 'failure').length >= 1, `the pump runs fail (${runs.join(', ')})`);
      assert.ok(runs.every((r) => ['failure', 'cancelled'].includes(r)), `no pump run succeeds on it (${runs.join(', ')})`);
      assert.equal(healthOf(sim, 'run:pump'), 'red');
      assert.equal(healthOf(sim), 'red');
      operatorRestore(sim);
      await sim.runFor(3 * HOUR);
      assert.ok(logLines(sim, /operator: restored state-/).length === 1);
      assertRecovered(sim, { allowOrphans: true });
    });
  });
}

test('R-CHAOS-03: a pump that cannot read its state cancels the successor it dispatched: a few failing runs an hour, not one a minute', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    corrupt(sim, 'garbage');
    const from = sim.t;
    await sim.runFor(HOUR);
    const runs = pumpOutcomes(sim, from);
    // The schedule (:00, :30) and the watchdog (no pump started for 20 minutes)
    // restart it; each failing run takes back its successor.
    assert.ok(runs.length <= 8, `${runs.length} pump runs in an hour: ${runs.join(', ')}`);
    assert.ok(logLines(sim, /pump: cancelled the successor run/).length >= 2);
    assert.equal(healthOf(sim), 'red');
  });
});

test('R-CHAOS-03: a passing GitHub error while pulling the state does not cancel the successor: the chain goes on', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    sim.gh.addFault({ name: 'download 502', times: 3, match: CALLS.stateDownload, respond: () => ({ status: 502, body: { message: 'Bad Gateway' } }) });
    sim.cronOn.pump = false;
    sim.cronOn.watchdog = false;
    await sim.runFor(30 * MIN);
    assert.ok(logLines(sim, /pump: cannot start: GitHub GET/).length === 1, 'one run could not pull');
    assert.equal(logLines(sim, /cancelled the successor/).length, 0);
    const failed = sim.pumpRuns.find((r) => r.conclusion === 'failure');
    const next = sim.pumpRuns.find((r) => r.id === failed?.successor?.runId);
    assert.equal(next?.conclusion, 'success', 'its successor ran and succeeded');
    sim.cronOn.pump = true;
    sim.cronOn.watchdog = true;
    await sim.runFor(HOUR);
    assertRecovered(sim);
  });
});

test('5d: the state replaced between the pump\'s pull and its push: the push is refused, the other write is kept, the run fails loudly', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    let victim = null;
    sim.tapWhen({
      when: call('stateDownload'),
      fn: (c) => {
        victim = c.task.run;
        sim.foreignWrite((db) => db.setKv('chaos.foreign', { by: 'a second writer' }, { now: sim.t }));
      },
    });
    await sim.runFor(30 * MIN);
    assert.ok(victim, 'a pump run pulled, then another write landed');
    assert.equal(victim.conclusion, 'failure', 'the run whose state went stale fails');
    assert.ok(logLines(sim, /remote state changed since it was pulled/).length >= 1);
    await sim.runFor(HOUR);
    assert.deepEqual(sim.readLive().kv['chaos.foreign'], { by: 'a second writer' }, 'the other write survives every later push');
    assertRecovered(sim);
  });
});

test('5e: a state written by newer code (schema ahead of this code): the pump refuses it, writes nothing, and fails loudly', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    sim.foreignWrite((db) => db.raw.exec('PRAGMA user_version = 99'));
    const live = sim.liveAsset();
    const before = sha(sim.gh.assetBytes(live.id));
    const from = sim.t;
    await sim.runFor(HOUR);
    assert.equal(sim.liveAsset().id, live.id);
    assert.equal(sha(sim.gh.assetBytes(live.id)), before, 'the newer state is left exactly as it was');
    assert.ok(logLines(sim, /state schema version 99 is newer than this code/).length >= 1);
    assert.ok(pumpOutcomes(sim, from).every((r) => ['failure', 'cancelled'].includes(r)));
    assert.equal(healthOf(sim), 'red');
  });
});

test('R-CHAOS-01: a state asset that vanished while snapshots exist: the pump refuses to start from empty and fails loudly; a restore brings it back', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    const fenceBefore = sim.readLive().fence;
    sim.deleteState();
    await sim.runFor(HOUR);
    assert.equal(sim.liveAsset(), null, 'no empty state was pushed in its place');
    assert.ok(logLines(sim, /the state asset is missing, but \d+ snapshot\(s\) of it are on the "state-snapshots" release/).length >= 1);
    assert.equal(healthOf(sim, 'run:pump'), 'red');
    assert.equal(healthOf(sim), 'red');
    operatorRestore(sim);
    await sim.runFor(3 * HOUR);
    assert.ok(sim.readLive().fence >= fenceBefore, 'the fence counter did not go back to 0');
    assertRecovered(sim, { allowOrphans: true });
  });
});

// ---- 9. restores racing the pump ----

test('9a: a restore while the loop runs is refused, and again while a pump run is still going; once idle it is applied', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    const r1 = await sim.restore();
    assert.match(r1.error?.message ?? '', /refusing --apply: the loop is running/);
    sim.setVar('LOOP_ENABLED', 'false');
    const r2 = await sim.restore();
    assert.match(r2.error?.message ?? '', /refusing --apply: pump\.yml has \d+ queued or running run/);
    await sim.runFor(20 * MIN);
    const r3 = await sim.restore();
    assert.equal(r3.error, undefined, r3.error?.message);
    assert.equal(r3.report.applied, true);
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim, { allowOrphans: true });
  });
});

test('9b: a pump run that pulled before a restore cannot push after it: the restored state stays until the next run builds on it', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    // The drill's look at pump.yml runs lags behind GitHub: it sees none.
    sim.gh.addFault({ name: 'run list lags', times: 99, match: (r) => r.method === 'GET' && /\/pump\.yml\/runs$/.test(r.path) && r.query.get('status') !== null, respond: () => ({ body: { total_count: 0, workflow_runs: [] } }) });
    const running = sim.pumpGroup.running;
    assert.ok(running && running.status === 'in_progress', 'a pump run is going');
    sim.setVar('LOOP_ENABLED', 'false');
    const r = await sim.restore();
    assert.equal(r.report?.applied, true, r.error?.message);
    const restored = sim.liveAsset();
    const restoredSha = sha(sim.gh.assetBytes(restored.id));
    assert.equal(restoredSha, r.report.sha256, 'the live state is the snapshot');
    sim.gh.clearFaults();
    await sim.runFor(20 * MIN);
    assert.equal(running.conclusion, 'failure', 'the run that pulled before the restore fails');
    assert.ok(logLines(sim, /remote state changed since it was pulled/).length >= 1, 'its push was refused');
    assert.equal(sha(sim.gh.assetBytes(sim.liveAsset().id)), restoredSha, 'nothing was written over the restored state while the loop was off');
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim, { allowOrphans: true });
  });
});

test('R-CHAOS-06: a damaged live asset that kept its label: the restore drill checks the bytes, not the label, and puts the snapshot back', CHAOS, async () => {
  await withSim({}, async (sim) => {
    await warmUp(sim);
    // Right after the 12:41 snapshot and before the pump's next push, the live
    // bytes rot while the asset keeps its sha256 label: the newest snapshot's.
    const snap = (sim.gh.release(TOOLQA, 'state-snapshots').assets.filter((a) => a.name.startsWith('state-')).sort((a, b) => (a.name < b.name ? 1 : -1)))[0];
    const live = sim.liveAsset();
    if (live.label !== snap.label) {
      // The pump pushed after the snapshot: take one now, with nothing in flight.
      sim.setVar('LOOP_ENABLED', 'false');
      await sim.runFor(15 * MIN);
      sim.setVar('LOOP_ENABLED', 'true');
      sim.startSnapshot();
      await sim.runFor(MIN);
    }
    assert.equal(sim.liveAsset().label, (sim.gh.release(TOOLQA, 'state-snapshots').assets.filter((a) => a.name.startsWith('state-')).sort((a, b) => (a.name < b.name ? 1 : -1)))[0].label);
    corrupt(sim, 'truncate');
    assert.ok(sim.readLive().unreadable, 'the live state no longer reads');
    await sim.runFor(20 * MIN);
    operatorRestore(sim);
    await sim.runFor(3 * HOUR);
    assert.ok(logLines(sim, /operator: restored state-.*\(applied true\)/).length === 1, 'the drill put the snapshot back');
    assertRecovered(sim, { allowOrphans: true });
  });
});
