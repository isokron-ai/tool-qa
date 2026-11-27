// The backfill filler (pump/backfill.mjs, design audit A1): free worker slots
// the due list leaves go to the frame's oldest results. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { runTick } from '../tick.mjs';
import { computeDue, loadDueInputs, runKey, runKeyFields } from '../due.mjs';
import { BACKFILL_BAND, backfillCandidates, backfillEnabled, backfillFor, minAgeHours } from '../backfill.mjs';
import { fakeClock } from '../../test/lib/fake-api.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const wf = (over = {}) => ({
  enabled: true, repo: 'isokron-ai/mcp-check', file: 'live-probe.yml', ref: 'main',
  shard_size: 2, setup_minutes: 4, minutes_per_subject: 2, slots_max: 12,
  versions: { tool: { 'mcp-check': '1.0.0' }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default', ...over,
});

/** Subjects with a known sha: {id: tier}. */
function setup(subjects, workflows = { 'live-probe': wf() }) {
  const c = fakeClock(Date.parse('2026-11-28T00:00:00Z'));
  const db = openState(':memory:');
  let i = 0;
  for (const [id, tier] of Object.entries(subjects)) {
    // First seen (and changed) a month ago, so a backdated result is not behind a change event.
    db.setSubjectVersion({ id, kind: 'github', source: 'seed-v1', tier, sha: (++i).toString(16).padStart(40, '0'), now: c.t - 30 * DAY });
  }
  let n = 0;
  return { c, db, config: { tiers, workflows }, newId: () => `att-${String(++n).padStart(3, '0')}` };
}

/** An accepted result for every pair due now, as if it ran `ageMs` ago (optionally only some subjects). */
function resultsFor(db, config, { now, ageMs, only = null, outcome = 'ok', coverage = 'assessed' }) {
  for (const d of computeDue(loadDueInputs(db, { now, tiers: config.tiers, workflows: config.workflows }))) {
    if (only && !only.includes(d.subject)) continue;
    db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: now - ageMs });
    db.raw.prepare("INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, ?, ?, 'old', 1, ?, ?, ?)")
      .run(d.run_key, d.subject, d.workflow, outcome, new Date(now - ageMs).toISOString(), coverage);
  }
}

function recorder() {
  const calls = [];
  return {
    calls,
    async dispatch(req) { calls.push(req); return { runId: 1000 + calls.length, runUrl: null, workflowSha: 'f'.repeat(40), correlatedBy: 'response' }; },
    async resolveRef() { return 'f'.repeat(40); },
  };
}

const sentItems = (d) => d.calls.flatMap((r) => JSON.parse(r.inputs.items).map((i) => i.subject));

test('R-FILL-01: with nothing due, free slots go to the frame\'s oldest results; switched off they sat idle', async () => {
  const subjects = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`org/r${i}`, 3]));
  const { c, db, config, newId } = setup(subjects);
  resultsFor(db, config, { now: c.t, ageMs: 3 * DAY });
  // Off (the 27 Nov loop): due 0, nothing sent.
  const off = recorder();
  let s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: off, newId });
  assert.deepEqual([s.due, s.dispatched, off.calls.length], [0, 0, 0]);
  // On: both slots taken, two shards of two.
  const on = recorder();
  s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: on, newId, backfill: true });
  assert.equal(s.due, 0);
  assert.equal(s.backfill, 4);
  assert.equal(s.dispatched, 2);
  assert.equal(sentItems(on).length, 4);
  // The invariant: every slot is busy, or nothing a run could refresh is left.
  const left = backfillCandidates(loadDueInputs(db, { now: c.t, tiers, workflows: config.workflows }));
  assert.ok(db.openSlots().length === 2 || left.length === 0);
  // And with room to spare, nothing eligible is left behind.
  const wide = recorder();
  s = await runTick({ db, now: c.now, config, workerSlots: 12, dispatcher: wide, newId, backfill: true });
  assert.equal(s.backfill, 2);
  assert.equal(backfillCandidates(loadDueInputs(db, { now: c.t, tiers, workflows: config.workflows })).length, 0, 'every eligible pair is in flight');
  db.close();
});

test('R-FILL-02: backfill ranks below every due pair: it tops up a partial due shard, and takes no slot a due shard needs', async () => {
  const { c, db, config, newId } = setup({ 'old/a': 3, 'old/b': 3, 'old/c': 3, 'new/x': 3, 'new/y': 3, 'new/z': 3 });
  resultsFor(db, config, { now: c.t, ageMs: 10 * DAY, only: ['old/a', 'old/b', 'old/c'] });
  // new/* have no result: due as first_sight (3 items: two shards of 2, the second partial).
  const inputs = loadDueInputs(db, { now: c.t, tiers, workflows: config.workflows });
  const due = computeDue(inputs);
  const cands = backfillCandidates(inputs, { exclude: new Set(due.map((d) => `${d.subject}\u0000${d.workflow}`)) });
  assert.ok(Math.max(...cands.map((x) => x.priority)) < Math.min(...due.map((x) => x.priority)), 'below every due pair');
  assert.ok(cands.every((x) => x.priority < tiers.weights.T0 + 100 - BACKFILL_BAND + 1));
  // Two free slots, both needed by due: only the partial due shard is topped up.
  let fill = backfillFor({ candidates: cands, due, workflows: config.workflows, freeSlots: 2 });
  assert.equal(fill.length, 1);
  // One free slot for two due shards: still no new shard, only the top-up.
  fill = backfillFor({ candidates: cands, due, workflows: config.workflows, freeSlots: 1 });
  assert.equal(fill.length, 1);
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId, backfill: true });
  assert.equal(s.dispatched, 2);
  const first = JSON.parse(d.calls[0].inputs.items).map((i) => i.subject);
  assert.ok(first.every((x) => x.startsWith('new/')), 'the first shard is due work only');
  assert.equal(sentItems(d).filter((x) => x.startsWith('new/')).length, 3, 'every due item went out');
  db.close();
});

test('R-FILL-03: a pair is not backfilled under its tier\'s floor; the oldest go first, by tier weight plus age', () => {
  assert.deepEqual(['T0', 'T1', 'T2', 'T3', 'T4'].map((t) => minAgeHours(tiers, t)), [6, 12, 24, 48, 96]);
  const { c, db, config } = setup({ 'org/fresh': 3, 'org/older': 3, 'org/oldest': 3, 'org/t1': 1 });
  const now = c.t;
  resultsFor(db, config, { now, ageMs: 47 * HOUR, only: ['org/fresh'] });
  resultsFor(db, config, { now, ageMs: 3 * DAY, only: ['org/older'] });
  resultsFor(db, config, { now, ageMs: 9 * DAY, only: ['org/oldest'] });
  resultsFor(db, config, { now, ageMs: 13 * HOUR, only: ['org/t1'] });
  const c1 = backfillCandidates(loadDueInputs(db, { now, tiers, workflows: config.workflows }));
  // T1 weight 60 + 0.5 day beats T3 weight 20 + 9 days; under its 48 h floor org/fresh is left out.
  assert.deepEqual(c1.map((x) => x.subject), ['org/t1', 'org/oldest', 'org/older']);
  assert.ok(c1.every((x) => x.reasons.join() === 'backfill'));
  db.close();
});

test('R-FILL-04: never backfilled: in flight, parked or in a retry backoff, held for a late judgment, skips_only inside its wait, a sample cell, a disabled or paused lane, a retired or gone subject', async () => {
  const subs = { 'a/inflight': 3, 'a/parked': 3, 'a/held': 3, 'a/skips': 3, 'a/retired': 3, 'a/gone': 3, 'a/ok': 3 };
  const workflows = { 'live-probe': wf(), writecheck: wf({ file: 'corpus.yml' }), 'meta-github': wf({ enabled: false, file: 'meta-github.yml' }) };
  const { c, db, newId } = setup(subs, workflows);
  const now = c.t;
  resultsFor(db, { tiers, workflows }, { now, ageMs: 5 * DAY });
  // Old results on the sample cell (writecheck, T3) and the disabled lane too, as a lane switched off later leaves them.
  for (const name of ['writecheck', 'meta-github']) {
    const s = db.getSubject('a/ok');
    const fields = runKeyFields(s, name, workflows[name]);
    const k = runKey(fields);
    db.recordRunKey(k, { subject: 'a/ok', workflow: name, fields, now: now - 5 * DAY });
    db.raw.prepare("INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, 'a/ok', ?, 'old', 1, 'ok', ?, 'assessed')").run(k, name, new Date(now - 5 * DAY).toISOString());
  }
  // The 4th skips_only in a row waits 1 x 2^3 = 8 days (R-SUB-08).
  db.raw.prepare("UPDATE results SET outcome = 'skips_only', skips_streak = 4 WHERE subject = 'a/skips'").run();
  db.raw.prepare("UPDATE subjects SET retired_at = ? WHERE id = 'a/retired'").run(new Date(now).toISOString());
  db.raw.prepare("UPDATE subjects SET gone_at = ? WHERE id = 'a/gone'").run(new Date(now).toISOString());
  const inputs = loadDueInputs(db, { now, tiers, workflows });
  const key = (id) => backfillCandidates(inputs).find((x) => x.subject === id).run_key;
  // loadDueInputs fills these from the state: open dispatches, rejected run_keys and retry backoffs.
  inputs.inFlight.add('a/inflight\u0000live-probe');
  inputs.parked.add(key('a/parked'));
  const got = backfillCandidates(inputs, { holdRunKeys: new Set([key('a/held')]) });
  // writecheck is a sample cell for T3 and meta-github is disabled: only live-probe of a/ok.
  assert.deepEqual(got.map((x) => `${x.subject} ${x.workflow}`), ['a/ok live-probe']);
  // A lane paused for its pins gets nothing through the tick.
  db.pausePinRefused('live-probe', { reason: 'pin_mismatch', now });
  const s = await runTick({ db, now: c.now, config: { tiers, workflows }, workerSlots: 8, dispatcher: recorder(), newId, backfill: true });
  assert.deepEqual([s.backfill, s.dispatched], [0, 0]);
  db.close();
});

test('R-FILL-05: the filler is off unless LANE_BACKFILL_ENABLED is exactly "true"', () => {
  assert.equal(backfillEnabled({}), false);
  assert.equal(backfillEnabled({ LANE_BACKFILL_ENABLED: '' }), false);
  assert.equal(backfillEnabled({ LANE_BACKFILL_ENABLED: 'True' }), false);
  assert.equal(backfillEnabled({ LANE_BACKFILL_ENABLED: 'true' }), true);
  const run = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8');
  assert.match(run, /backfill: backfillEnabled\(env\)/);
  const yml = readFileSync(new URL('../../.github/workflows/pump.yml', import.meta.url), 'utf8');
  assert.match(yml, /LANE_BACKFILL_ENABLED: \$\{\{ vars\.LANE_BACKFILL_ENABLED \}\}/);
});

test('R-FILL-06: a lane\'s slots_max and the slots already open bound the filler', async () => {
  const subjects = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`org/r${i}`, 3]));
  const { c, db, config, newId } = setup(subjects, { 'live-probe': wf({ slots_max: 2 }) });
  resultsFor(db, config, { now: c.t, ageMs: 3 * DAY });
  const d = recorder();
  let s = await runTick({ db, now: c.now, config, workerSlots: 5, dispatcher: d, newId, backfill: true });
  assert.deepEqual([s.backfill, s.dispatched], [4, 2], 'slots_max 2: two shards of two');
  // Both lane slots are open now: nothing more for this lane.
  s = await runTick({ db, now: c.now, config, workerSlots: 5, dispatcher: recorder(), newId, backfill: true });
  assert.equal(s.backfill, 0);
  // Open slots held by another lane count against the free ones.
  const fill = backfillFor({ candidates: backfillCandidates(loadDueInputs(db, { now: c.t, tiers, workflows: { x: wf({ slots_max: 9 }) } })), due: [], workflows: { x: wf({ slots_max: 9 }) }, freeSlots: 5 - 4 });
  assert.ok(fill.length <= 2);
  db.close();
});
