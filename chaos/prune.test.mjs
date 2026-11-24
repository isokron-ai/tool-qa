// Chaos, end to end: pruning closed history out of the live state (loop
// upgrade #14, pump/prune.mjs) while the loop runs, and the gzipped state
// asset next to snapshots from before it.
//
// The sim lets a row leave the state only when an archive the pump staged,
// and the upload step stored, holds it (chaos/lib/sim.mjs checkForward); a
// result may never leave. The prune age is cut to two hours and the late
// window to one, so hours of virtual time cover many prune passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotNames } from './lib/faults.mjs';
import { HOUR, MIN, START, TOOLQA, WORKFLOW, openWith } from './lib/sim.mjs';
import { assertRecovered, CHAOS, healthOf, logLines, startPump, withSim } from './lib/harness.mjs';
import { decodeState } from '../scripts/state-asset.mjs';
import { ABANDON_MS } from '../pump/prune.mjs';

const PRUNE = { prune: { minAgeMs: 2 * HOUR }, lateMs: HOUR };
const CLOSED = new Set(['done', 'failed', 'expired']);

/** A new tool version every `every` until `until`: every run_key moves, so there is always closed work to prune. */
function bumpTools(sim, { every = HOUR, until }) {
  let v = 1;
  const bump = () => {
    v += 1;
    const wf = sim.config.workflows[WORKFLOW];
    wf.versions = { ...wf.versions, tool: { 'mcp-check': `chaos${String(v).padStart(2, '0')}` } };
    if (sim.t + every < until) sim.after(every, bump, 'tool bump');
  };
  sim.after(every, bump, 'tool bump');
}

/** Every attempt row ever seen in a state version, keyed by id. */
function attemptsEverSeen(sim) {
  const m = new Map();
  for (const v of sim.stateVersions) for (const a of v.s?.attempts ?? []) m.set(a.id, a);
  return m;
}

const archivedRows = (sim, table) => sim.archives.flatMap((a) => a.rows.filter((r) => r.table === table).map((r) => ({ ...r.row, cutoff: a.meta.cutoff })));

test('prune during in-flight work: rows leave only through an archive that reads back, open work is never touched, and the loop ends clean', CHAOS, async () => {
  await withSim(PRUNE, async (sim) => {
    bumpTools(sim, { until: START + 7 * HOUR });
    startPump(sim);
    await sim.runFor(10 * HOUR);
    const deleted = logLines(sim, /prune: deleted \d+ rows/);
    assert.ok(deleted.length >= 2, `several delete passes (${deleted.length})`);
    assert.ok(sim.archives.length >= 2);
    // Only closed dispatches older than the cutoff were ever archived.
    const ds = archivedRows(sim, 'dispatches');
    assert.ok(ds.length >= 5);
    for (const d of ds) {
      assert.ok(CLOSED.has(d.status), `${d.attempt_id} was ${d.status}`);
      assert.ok(d.closed < d.cutoff, `${d.attempt_id} closed ${d.closed}, after the cutoff ${d.cutoff}`);
    }
    // Nothing a worker uploaded and ingest recorded was lost: every attempt
    // ever seen is in the live state or in an archive.
    const live = sim.readLive();
    const liveIds = new Set(live.attempts.map((a) => a.id));
    const archivedIds = new Set(archivedRows(sim, 'attempts').map((a) => a.id));
    for (const [id, a] of attemptsEverSeen(sim)) assert.ok(liveIds.has(id) || archivedIds.has(id), `attempt ${id} (${a.attempt_id}) is kept somewhere`);
    // The live state holds recent history only.
    assert.ok(live.attempts.length < attemptsEverSeen(sim).size / 2, `${live.attempts.length} of ${attemptsEverSeen(sim).size} attempts left`);
    const old = live.dispatches.filter((d) => CLOSED.has(d.status) && Date.parse(d.closed) < sim.t - 3 * HOUR);
    assert.deepEqual(old, [], 'no closed dispatch older than the prune age and two runs is left');
    // The size metric and the last prune result are in the state, and the health item is green.
    assert.ok(live.kv['state.size']?.bytes > 0);
    assert.ok(['pruned', 'staged', 'waiting', 'nothing', 'idle'].includes(live.kv['state.prune.last']?.status), JSON.stringify(live.kv['state.prune.last']));
    assert.equal(healthOf(sim, 'state-size'), 'green');
    assertRecovered(sim);
  });
});

test('prune with late results: runs that finish after their lease are judged, recorded, then archived, never lost', CHAOS, async () => {
  await withSim(PRUNE, async (sim) => {
    sim.worker = (ctx) => (ctx.n % 3 === 1 ? { durationMs: 40 * MIN } : {}); // the lease is 17.5 minutes
    bumpTools(sim, { until: START + 6 * HOUR });
    startPump(sim);
    await sim.runFor(10 * HOUR);
    const late = sim.workerRuns.filter((r, i) => i % 3 === 1 && Date.parse(r.created_at) < sim.t - 4 * HOUR).map((r) => r.inputs.attempt_id);
    assert.ok(late.length >= 2, `late runs (${late.length})`);
    const seen = [...attemptsEverSeen(sim).values()];
    const archived = archivedRows(sim, 'attempts');
    for (const id of late) {
      const recorded = seen.filter((a) => a.attempt_id === id);
      assert.ok(recorded.length >= 1, `the late run ${id} was judged and recorded`);
      assert.ok(recorded.every((a) => a.accepted === 0), 'a late result is never accepted');
      assert.ok(archived.some((a) => a.attempt_id === id), `and later archived, not dropped (${id})`);
    }
    assert.ok(logLines(sim, /prune: deleted \d+ rows/).length >= 2);
    assertRecovered(sim);
  });
});

test('prune, then restore an older snapshot: the rows come back, are pruned again, and the loop recovers', CHAOS, async () => {
  await withSim(PRUNE, async (sim) => {
    bumpTools(sim, { until: START + 9 * HOUR });
    startPump(sim);
    await sim.runFor(6 * HOUR);
    const passes = logLines(sim, /prune: deleted \d+ rows/).length;
    assert.ok(passes >= 1);
    const names = snapshotNames(sim);
    assert.ok(names.length >= 4);
    const older = names[2]; // from before the last prune passes
    sim.setVar('LOOP_ENABLED', 'false');
    await sim.runFor(20 * MIN);
    const r = await sim.restore({ name: older });
    assert.equal(r.report?.applied, true, r.error?.message);
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(5 * HOUR);
    assert.ok(logLines(sim, /prune: deleted \d+ rows/).length > passes, 'pruning went on after the restore');
    assertRecovered(sim, { allowOrphans: true });
  });
});

test('prune with a row budget: each pass stops at the budget, later passes carry on, and nothing is lost', CHAOS, async () => {
  await withSim({ ...PRUNE, prune: { minAgeMs: 2 * HOUR, maxRows: 12 } }, async (sim) => {
    bumpTools(sim, { until: START + 7 * HOUR });
    startPump(sim);
    await sim.runFor(10 * HOUR);
    assert.ok(sim.archives.length >= 4);
    for (const a of sim.archives) assert.ok(a.rows.length <= 12, `${a.name} holds ${a.rows.length} rows`);
    assert.ok(logLines(sim, /stopped at the rows budget/).length >= 1);
    const live = new Set(sim.readLive().attempts.map((a) => a.id));
    const archived = new Set(archivedRows(sim, 'attempts').map((a) => a.id));
    for (const id of attemptsEverSeen(sim).keys()) assert.ok(live.has(id) || archived.has(id));
    assertRecovered(sim);
  });
});

test('a staged archive that never reaches the artifact store: nothing is deleted, it is given up after six hours (amber), then staged again and pruned', CHAOS, async () => {
  await withSim(PRUNE, async (sim) => {
    bumpTools(sim, { until: START + 14 * HOUR });
    sim.archiveUpload = false;
    startPump(sim);
    await sim.runFor(3 * HOUR);
    assert.ok(logLines(sim, /prune: staged/).length >= 1, 'an archive was staged');
    assert.equal(logLines(sim, /prune: deleted/).length, 0);
    await sim.runFor(ABANDON_MS + HOUR);
    assert.equal(logLines(sim, /prune: deleted/).length, 0, 'nothing is deleted while its archive is missing');
    assert.ok(logLines(sim, /prune: gave up the staged archive/).length >= 1);
    // The rows are all still there.
    const live = new Set(sim.readLive().attempts.map((a) => a.id));
    for (const id of attemptsEverSeen(sim).keys()) assert.ok(live.has(id));
    sim.archiveUpload = true;
    await sim.runFor(7 * HOUR);
    assert.ok(logLines(sim, /prune: deleted \d+ rows/).length >= 1, 'pruning resumes once archives are stored');
    assert.equal(healthOf(sim, 'state-size'), 'green');
    assertRecovered(sim);
  });
});

test('compression: a snapshot from before compression and gzipped ones mix: each restores, and the pump reads both forms', CHAOS, async () => {
  await withSim({}, async (sim) => {
    // The seeded state is the plain form. Snapshot it before any pump run.
    sim.startSnapshot();
    await sim.runFor(MIN);
    const plainSnap = snapshotNames(sim)[0];
    assert.ok(plainSnap);
    const head = (bytes) => openWith(sim.identity, bytes).subarray(0, 2);
    const snapBytes = (name) => sim.gh.assetBytes(sim.gh.release(TOOLQA, 'state-snapshots').assets.find((a) => a.name === name).id);
    assert.notDeepEqual([...head(snapBytes(plainSnap))], [0x1f, 0x8b], 'the first snapshot is the plain database');
    startPump(sim);
    await sim.runFor(2 * HOUR);
    assert.deepEqual([...head(sim.gh.assetBytes(sim.liveAsset().id))], [0x1f, 0x8b], 'the pump pushed the gzipped form');
    const gzSnap = snapshotNames(sim)[0];
    assert.deepEqual([...head(snapBytes(gzSnap))], [0x1f, 0x8b], 'and the newest snapshot is gzipped too');
    assert.ok(logLines(sim, /pulled state\.sqlite \(\d+ bytes encrypted, sha256/).length >= 1, 'the first run read the plain form');
    assert.ok(logLines(sim, /pulled state\.sqlite \(\d+ bytes encrypted, gzip of \d+/).length >= 1, 'later runs read the gzipped form');
    // Restore the plain snapshot over the gzipped live state: the loop reads it and goes on.
    sim.setVar('LOOP_ENABLED', 'false');
    await sim.runFor(20 * MIN);
    const r = await sim.restore({ name: plainSnap });
    assert.equal(r.report?.applied, true, r.error?.message);
    assert.equal(r.report.compressed, false);
    assert.ok(decodeState(openWith(sim.identity, sim.gh.assetBytes(sim.liveAsset().id))).compressed === false);
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assert.deepEqual([...head(sim.gh.assetBytes(sim.liveAsset().id))], [0x1f, 0x8b], 'pushed back gzipped');
    // And a gzipped snapshot restores too.
    sim.setVar('LOOP_ENABLED', 'false');
    await sim.runFor(20 * MIN);
    const r2 = await sim.restore({ name: snapshotNames(sim)[1] });
    assert.equal(r2.report?.applied, true, r2.error?.message);
    assert.equal(r2.report.compressed, true);
    sim.setVar('LOOP_ENABLED', 'true');
    await sim.runFor(2 * HOUR);
    assertRecovered(sim, { allowOrphans: true });
  });
});
