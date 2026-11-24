// Pruning closed history out of the state (state/prune.mjs, loop upgrade #14).
//
// The main property: everything the loop decides from the state reads the
// same before and after a prune, at any time from then on. Weeks of seeded
// history (test/lib/state-history.mjs) are pruned and compared, reader by
// reader: the due list, parking, the retry budget and backoff, the late-result
// query, getAttempt of every dispatch left, fencing of every item left,
// in-flight work, slots, results and ever_assessed, the fence counter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../state/db.mjs';
import { dueFromState, loadDueInputs } from '../pump/due.mjs';
import {
  ARCHIVE_ROWS, DELETE_ORDER, KEYS, PRUNE_MIN_AGE_MS, buildArchive, deleteArchived, maybeVacuum, pruneFloorMs, readArchive, selectPrunable, stateSize,
} from '../state/prune.mjs';
import { readTar, writeTar } from '../worker-kit/tar.mjs';
import { gzipSync } from 'node:zlib';
import { DAY, HOUR, MIN, buildHistory, tiers } from './lib/state-history.mjs';

const LATE_MS = 6 * HOUR;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'state-prune-'));
}

/** Two identical copies of a built history: { a, b, now, config, dir }. */
function twin(opts) {
  const dir = tmp();
  const fa = join(dir, 'a.sqlite');
  const built = buildHistory({ ...opts, file: fa });
  built.db.close();
  copyFileSync(fa, join(dir, 'b.sqlite'));
  return { a: openState(fa), b: openState(join(dir, 'b.sqlite')), now: built.now, config: built.config, dir };
}

const all = (db, sql, ...p) => db.raw.prepare(sql).all(...p).map((r) => ({ ...r }));

/** Every run_key the state mentions anywhere. */
function runKeysOf(db) {
  const keys = new Set();
  for (const sql of ['SELECT run_key AS k FROM run_keys', 'SELECT run_key AS k FROM results', 'SELECT run_key AS k FROM attempts WHERE run_key IS NOT NULL', 'SELECT subject AS k FROM leases', 'SELECT run_key AS k FROM dispatch_items']) {
    for (const r of all(db, sql)) keys.add(r.k);
  }
  return [...keys].sort();
}

/** What the loop reads from the state at `now`, for the given run_keys and dispatches. */
function observe(db, { now, config, keys, dispatches }) {
  const o = {};
  o.fence = all(db, "SELECT value FROM counters WHERE name = 'fence'")[0].value;
  o.due = dueFromState(db, { now, tiers: config.tiers, workflows: config.workflows });
  const inputs = loadDueInputs(db, { now, tiers: config.tiers, workflows: config.workflows });
  o.lastResults = [...inputs.lastResults.entries()].sort();
  o.parked = [...inputs.parked].sort();
  o.inFlight = [...inputs.inFlight].sort();
  o.rejected1 = db.rejectedRunKeys(1);
  o.rejected3 = db.rejectedRunKeys(3);
  o.waiting = db.retryLaterWaiting({ now, baseMs: 30 * MIN, maxMs: 6 * HOUR }).sort();
  o.perKey = keys.map((k) => ({
    k, rejected: db.rejectedCount(k), retries: db.retryLaterCount(k), throttled: db.retryThrottled(k), result: db.getResult(k) ?? null,
  }));
  o.awaiting = db.dispatchesAwaitingResults({ now, lateMs: LATE_MS }).map((d) => ({ d, a: db.getAttempt(d.attempt_id) }));
  o.open = db.openDispatches({ now });
  o.slots = db.openSlots();
  o.results = db.listResults();
  o.subjects = db.listSubjects();
  o.paused = db.pausedWorkflows({ now });
  o.dispatches = dispatches.map((id) => {
    const a = db.getAttempt(id);
    return { id, a, fences: a.items.map((it) => db.checkFence(it.run_key, it.fence, { holder: id, now })) };
  });
  o.kv = all(db, "SELECT key, value FROM kv WHERE key NOT LIKE 'ingest.failures:%' ORDER BY key");
  // Ingest failure counters of every dispatch left (collect.mjs gives an item up after a few).
  o.failures = dispatches.flatMap((id) => db.getAttempt(id).items.map((it) => ({ id, index: it.index, f: db.ingestFailures(id, it.index) })));
  o.failureRows = all(db, "SELECT key, value, updated FROM kv WHERE key LIKE 'ingest.failures:%' ORDER BY key")
    .filter((r) => dispatches.some((id) => r.key.startsWith(`ingest.failures:${id}:`)));
  return o;
}

function pruneAll(db, cutoff) {
  const sel = selectPrunable(db, { cutoff, maxRows: 1e9 });
  const { tar } = buildArchive({ rows: sel.rows, meta: { cutoff: sel.cutoff } });
  const back = readArchive(tar);
  const out = deleteArchived(db, { rows: back.rows, cutoff: sel.cutoff });
  return { sel, out };
}

for (const seed of [1, 2, 3, 4]) {
  for (const [label, ageMs] of [['7 days', PRUNE_MIN_AGE_MS], ['the floor (late window + 1 h)', pruneFloorMs(LATE_MS)]]) {
    test(`prune keeps everything the loop reads: seed ${seed}, cutoff ${label}`, () => {
      const { a, b, now, config, dir } = twin({ seed, days: 21 });
      try {
        const keys = runKeysOf(a);
        const { sel, out } = pruneAll(b, now - ageMs);
        assert.ok(sel.total > 100, `something to prune (${sel.total})`);
        assert.equal(out.total, sel.total, 'every selected row was deleted');
        assert.equal(sel.stopped, null);
        const left = all(b, 'SELECT attempt_id FROM dispatches ORDER BY attempt_id').map((r) => r.attempt_id);
        for (const at of [now, now + HOUR, now + 3 * DAY]) {
          assert.deepEqual(observe(b, { now: at, config, keys, dispatches: left }), observe(a, { now: at, config, keys, dispatches: left }), `the same at +${(at - now) / HOUR} h`);
        }
        // Never touched.
        for (const t of ['results', 'subjects', 'counters', 'runs']) {
          assert.deepEqual(all(b, `SELECT * FROM ${t} ORDER BY rowid`), all(a, `SELECT * FROM ${t} ORDER BY rowid`), t);
        }
        assert.ok(stateSize(b).rows.attempts < stateSize(a).rows.attempts);
      } finally {
        a.close();
        b.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('after a prune the loop carries on the same: dispatching, fencing and recording give the same answers', () => {
  const { a, b, now, config, dir } = twin({ seed: 7, days: 18 });
  try {
    pruneAll(b, now - PRUNE_MIN_AGE_MS);
    const maxFence = all(a, 'SELECT MAX(fence) AS f FROM leases')[0].f;
    const step = (db, t) => {
      db.reapExpiredDispatches({ now: t });
      const due = dueFromState(db, { now: t, tiers: config.tiers, workflows: config.workflows }).slice(0, 4);
      const out = [];
      for (const d of due) {
        const l = db.acquireLease(d.run_key, `next-${t}`, { ttlMs: 30 * MIN, now: t });
        out.push(l);
        if (!l.acquired) continue;
        db.createDispatch({ attemptId: `next-${t}-${d.run_key.slice(0, 6)}`, shardId: 's', workflow: d.workflow, repo: 'o/r', workflowFile: 'w.yml', ref: 'main', expires: new Date(t + 30 * MIN).toISOString(), items: [{ run_key: d.run_key, subject: d.subject, fence: l.fence }], now: t });
        out.push(db.recordResult({ run_key: d.run_key, attempt_id: `next-${t}-${d.run_key.slice(0, 6)}`, fence: l.fence, verdict: 'accepted', outcome: 'accepted', coverage: 'assessed', now: t + MIN }));
      }
      return out;
    };
    for (const t of [now + HOUR, now + 5 * HOUR, now + 2 * DAY]) assert.deepEqual(step(b, t), step(a, t));
    // A run_key whose lease row was pruned gets a fence above every fence ever issued.
    const gone = all(a, 'SELECT subject FROM leases').map((r) => r.subject).find((k) => !b.getLease(k));
    assert.ok(gone, 'some lease was pruned');
    const l = b.acquireLease(gone, 'later', { ttlMs: MIN, now: now + 3 * DAY });
    assert.ok(l.acquired && l.fence > maxFence);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight work is never pruned, whatever the cutoff; late work is kept by any cutoff the pump may use', () => {
  const dir = tmp();
  try {
    const built = buildHistory({ seed: 11, days: 10, file: join(dir, 'a.sqlite') });
    const { now } = built;
    built.db.close();
    copyFileSync(join(dir, 'a.sqlite'), join(dir, 'b.sqlite'));
    const look = (db, list) => list.map((d) => {
      const a = db.getAttempt(d.attempt_id);
      return { a, leases: a.items.map((it) => db.getLease(it.run_key)), fences: a.items.map((it) => db.checkFence(it.run_key, it.fence, { holder: d.attempt_id, now })) };
    });
    // Open dispatches: even a cutoff in the future (the pump never uses one) leaves them.
    const a = openState(join(dir, 'a.sqlite'));
    const open = a.openDispatches({ now: 0 });
    assert.ok(open.length > 0, 'the history ends with work in flight');
    const openSlots = a.openSlots();
    const before = look(a, open);
    pruneAll(a, now + DAY);
    assert.deepEqual(look(a, open), before);
    assert.deepEqual(a.openSlots(), openSlots);
    a.close();
    // Late work: the closest cutoff the pump allows (the late window plus an hour).
    const b = openState(join(dir, 'b.sqlite'));
    const late = b.dispatchesAwaitingResults({ now, lateMs: LATE_MS }).filter((d) => d.status === 'expired');
    const lateBefore = look(b, late);
    pruneAll(b, now - pruneFloorMs(LATE_MS));
    assert.deepEqual(look(b, late), lateBefore);
    assert.deepEqual(b.dispatchesAwaitingResults({ now, lateMs: LATE_MS }).map((d) => d.attempt_id).sort(), late.map((d) => d.attempt_id).concat(b.openDispatches({ now: 0 }).map((d) => d.attempt_id)).sort());
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteArchived deletes only archived rows that are unchanged and still meet their rule', () => {
  const { db, now } = buildHistory({ seed: 5, days: 14 });
  try {
    const cutoff = now - PRUNE_MIN_AGE_MS;
    const sel = selectPrunable(db, { cutoff });
    assert.ok(sel.counts.leases > 2 && sel.counts.run_keys > 2 && sel.counts.attempts > 2);
    // Nothing changed by the dry run.
    assert.equal(stateSize(db).rows.attempts, all(db, 'SELECT COUNT(*) AS n FROM attempts')[0].n);
    const leases = sel.rows.filter((r) => r.table === 'leases').map((r) => r.row);
    const keysOnly = sel.rows.filter((r) => r.table === 'run_keys').map((r) => r.row);
    // 1. A lease taken again after staging: changed, so kept.
    const retaken = leases[0].subject;
    db.acquireLease(retaken, 'again', { ttlMs: HOUR, now });
    // 2. A run_key that comes due again (a new dispatch names it): unchanged but no longer eligible.
    const reused = keysOnly.find((k) => k.run_key !== retaken);
    const l = db.acquireLease(reused.run_key, 'reuse', { ttlMs: HOUR, now });
    db.createDispatch({ attemptId: 'reuse', shardId: 's', workflow: reused.workflow, repo: 'o/r', workflowFile: 'w.yml', ref: 'main', expires: new Date(now + HOUR).toISOString(), items: [{ run_key: reused.run_key, subject: reused.subject, fence: l.fence }], now });
    // 3. An archived attempt edited by hand: kept.
    const att = sel.rows.find((r) => r.table === 'attempts').row;
    db.raw.prepare('UPDATE attempts SET digest = ? WHERE id = ?').run('edited', att.id);
    // 4. A row not in the archive is never deleted, even if it meets the rule.
    const partial = sel.rows.filter((r) => !(r.table === 'slot_ledger' && r.row.id === sel.rows.find((x) => x.table === 'slot_ledger').row.id));
    const out = deleteArchived(db, { rows: partial, cutoff: sel.cutoff });
    assert.ok(db.getLease(retaken), 'the re-taken lease stays');
    assert.ok(db.getRunKey(reused.run_key), 'the run_key due again stays');
    assert.equal(db.raw.prepare('SELECT digest FROM attempts WHERE id = ?').get(att.id).digest, 'edited');
    const slotId = sel.rows.find((x) => x.table === 'slot_ledger').row.id;
    assert.ok(db.raw.prepare('SELECT 1 FROM slot_ledger WHERE id = ?').get(slotId), 'the row left out of the archive stays');
    assert.ok(out.kept.leases >= 1 && out.kept.run_keys >= 1 && out.kept.attempts >= 1);
    assert.equal(out.total + Object.values(out.kept).reduce((x, y) => x + y, 0), partial.length);
    // Deleting the same archive again deletes nothing more.
    assert.equal(deleteArchived(db, { rows: partial, cutoff: sel.cutoff }).total, 0);
  } finally {
    db.close();
  }
});

test('a dispatch goes only with all its items: one item changed keeps the dispatch and the item', () => {
  const { db, now } = buildHistory({ seed: 6, days: 12 });
  try {
    const sel = selectPrunable(db, { cutoff: now - PRUNE_MIN_AGE_MS });
    const d = sel.rows.find((r) => r.table === 'dispatches').row;
    const item = sel.rows.find((r) => r.table === 'dispatch_items' && r.row.attempt_id === d.attempt_id).row;
    db.raw.prepare('UPDATE dispatch_items SET resolved = ? WHERE attempt_id = ? AND run_key = ?').run('2000-01-01T00:00:00.000Z', item.attempt_id, item.run_key);
    deleteArchived(db, { rows: sel.rows, cutoff: sel.cutoff });
    assert.ok(db.getDispatch(d.attempt_id), 'the dispatch stays');
    assert.equal(db.getDispatch(d.attempt_id).items.length, 1, 'with only the changed item');
  } finally {
    db.close();
  }
});

test('the row budget and the time budget stop a pass early; later passes finish the job the same way', () => {
  const dir = tmp();
  try {
    const built = buildHistory({ seed: 9, days: 16, file: join(dir, 'a.sqlite') });
    const { now } = built;
    built.db.close();
    copyFileSync(join(dir, 'a.sqlite'), join(dir, 'b.sqlite'));
    const a = openState(join(dir, 'a.sqlite'));
    const b = openState(join(dir, 'b.sqlite'));
    const cutoff = now - PRUNE_MIN_AGE_MS;
    pruneAll(a, cutoff);
    let passes = 0;
    for (;;) {
      const sel = selectPrunable(b, { cutoff, maxRows: 97 });
      assert.ok(sel.total <= 97);
      if (sel.total === 0) break;
      passes += 1;
      if (sel.stopped) assert.equal(sel.stopped, 'rows');
      deleteArchived(b, { rows: readArchive(buildArchive({ rows: sel.rows }).tar).rows, cutoff: sel.cutoff });
      assert.ok(passes < 500);
    }
    assert.ok(passes > 3, `several passes (${passes})`);
    for (const t of DELETE_ORDER) assert.deepEqual(all(b, `SELECT * FROM ${t} ORDER BY rowid`), all(a, `SELECT * FROM ${t} ORDER BY rowid`), t);
    // The time budget: a clock past its deadline after the first look.
    let tick = 0;
    const timed = selectPrunable(openState(join(dir, 'a.sqlite')), { cutoff: now, deadline: 1, clock: () => tick++ });
    assert.equal(timed.stopped, 'time');
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an archive reads back whole or not at all', () => {
  const rows = [{ table: 'attempts', row: { id: 1, run_key: 'k' } }, { table: 'kv', row: { key: 'ingest.failures:a:0', value: '{}', updated: 'x' } }];
  const { tar, meta } = buildArchive({ rows, meta: { cutoff: '2026-01-01T00:00:00.000Z', staged_id: 'abc' } });
  const back = readArchive(tar);
  assert.deepEqual(back.rows, rows);
  assert.equal(back.meta.staged_id, 'abc');
  assert.equal(meta.counts.attempts, 1);
  // Rows swapped for others with the same count: the sha256 catches it.
  const entries = readTar(tar);
  const forged = writeTar(entries.map((e) => (e.path === ARCHIVE_ROWS ? { path: e.path, data: gzipSync(Buffer.from('{"table":"attempts","row":{"id":2}}\n{"table":"attempts","row":{"id":3}}\n')) } : e)));
  assert.throws(() => readArchive(forged), /sha256/);
  // A row of a table the archive may not hold is refused before anything is deleted.
  const db = openState(':memory:');
  assert.throws(() => deleteArchived(db, { rows: [{ table: 'results', row: { run_key: 'x' } }], cutoff: Date.now() }), /unknown table/);
  // Too big once decompressed.
  assert.throws(() => readArchive(tar, { maxBytes: 10 }), /decompress|larger|bytes/);
  db.close();
});

test('every table a prune touches names its key columns, and results, subjects and counters are never among them', () => {
  assert.deepEqual(Object.keys(KEYS).sort(), [...DELETE_ORDER].sort());
  for (const t of ['results', 'subjects', 'counters', 'runs']) assert.ok(!DELETE_ORDER.includes(t));
});

test('VACUUM after a prune gives the space back; stateSize reports pages and rows', () => {
  const dir = tmp();
  try {
    const file = join(dir, 's.sqlite');
    const { db, now } = buildHistory({ seed: 3, days: 20, file });
    const before = stateSize(db);
    assert.equal(before.bytes, statSync(file).size);
    pruneAll(db, now - PRUNE_MIN_AGE_MS);
    const mid = stateSize(db);
    assert.equal(mid.bytes, before.bytes, 'deleting rows frees pages but does not shrink the file');
    assert.ok(mid.free_pages > 0);
    assert.equal(maybeVacuum(db, { minFreeShare: 0.99 }).vacuumed, false, 'not worth it below the share');
    const v = maybeVacuum(db, { minFreeBytes: 0 });
    assert.equal(v.vacuumed, true);
    assert.ok(v.bytes < before.bytes);
    assert.equal(stateSize(db).free_pages, 0);
    assert.equal(maybeVacuum(db, { minFreeBytes: 0 }).vacuumed, false, 'nothing to win the second time');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-PRUNE-02: the newest attempt and slot row always stay, so their ids are never handed out again', () => {
  const { db, now } = buildHistory({ seed: 12, days: 12 });
  try {
    const maxAttempt = db.raw.prepare('SELECT MAX(id) AS m FROM attempts').get().m;
    const maxSlot = db.raw.prepare('SELECT MAX(id) AS m FROM slot_ledger').get().m;
    // A loop idle for weeks: everything is old, the newest rows too.
    const { sel } = pruneAll(db, now + 30 * DAY);
    assert.ok(sel.counts.attempts > 10);
    assert.ok(db.raw.prepare('SELECT 1 FROM attempts WHERE id = ?').get(maxAttempt), 'the newest attempt stays');
    assert.ok(db.raw.prepare('SELECT 1 FROM slot_ledger WHERE id = ?').get(maxSlot), 'the newest slot row stays');
    const archivedIds = new Set(sel.rows.filter((r) => r.table === 'attempts').map((r) => r.row.id));
    const fresh = db.recordResult({ run_key: 'e'.repeat(64), attempt_id: 'nobody', fence: 1, verdict: 'rejected', outcome: 'rejected', now: now + 31 * DAY });
    assert.ok(fresh.id > maxAttempt && !archivedIds.has(fresh.id), `a new attempt gets a new id (${fresh.id})`);
    const slot = db.acquireSlot('later', { budget: 15, ttlMs: MIN, now: now + 31 * DAY });
    assert.notEqual(slot, null);
    assert.ok(db.raw.prepare('SELECT MAX(id) AS m FROM slot_ledger').get().m > maxSlot);
  } finally {
    db.close();
  }
});

/**
 * A dispatch that straddles the cutoff: created, one item reported and an
 * ingest failure noted before it; closed after it. Plus an older dispatch
 * wholly before the cutoff, and a newer attempt so none of these is the
 * highest id. Returns { db, now, cutoff, straddle, old }.
 */
function straddleState() {
  const db = openState(':memory:');
  const T = Date.parse('2026-10-01T00:00:00Z');
  const cutoff = T + 2 * DAY;
  const send = (attemptId, keys, at) => {
    const items = keys.map((k) => ({ run_key: k, subject: `s-${k[0]}`, fence: db.acquireLease(k, attemptId, { ttlMs: 30 * DAY, now: at }).fence }));
    db.acquireSlot(attemptId, { budget: 15, ttlMs: 30 * DAY, now: at });
    for (const it of items) db.recordRunKey(it.run_key, { subject: it.subject, workflow: 'scan-static', fields: { k: it.run_key }, now: at });
    db.createDispatch({ attemptId, shardId: attemptId, workflow: 'scan-static', repo: 'o/r', workflowFile: 'w.yml', ref: 'main', expires: new Date(at + 30 * DAY).toISOString(), items, now: at });
    db.markDispatched(attemptId, { runId: '1' });
    return items;
  };
  const [k1, k2, k3, k4, k5] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(64));
  // Wholly before the cutoff.
  const old = send('old', [k1], T);
  db.noteIngestFailure('old', 0, { error: 'x', now: T + MIN });
  db.recordResult({ run_key: k1, attempt_id: 'old', fence: old[0].fence, verdict: 'accepted', outcome: 'accepted', now: T + 2 * MIN });
  // Straddles it: item 0 reports and item 1 fails to ingest before the cutoff; it closes after.
  const st = send('straddle', [k2, k3], T + HOUR);
  db.recordResult({ run_key: k2, attempt_id: 'straddle', fence: st[0].fence, verdict: 'accepted', outcome: 'accepted', now: T + HOUR + 10 * MIN });
  db.noteIngestFailure('straddle', 1, { error: 'judge crashed', now: T + HOUR + 11 * MIN });
  // A newer attempt and slot, so the straddling rows are not the highest ids.
  const nw = send('newer', [k4], cutoff + HOUR);
  db.recordResult({ run_key: k4, attempt_id: 'newer', fence: nw[0].fence, verdict: 'accepted', outcome: 'accepted', now: cutoff + 2 * HOUR });
  db.closeDispatch('straddle', { reason: 'run_completed', now: cutoff + 3 * HOUR });
  send('newest', [k5], cutoff + 4 * HOUR);
  return { db, now: cutoff + 7 * DAY, cutoff, straddleAttempt: db.listAttempts('s-b')[0] };
}

test('R-PRUNE-04: an attempt received before the cutoff stays while its dispatch closed after it, even when it is not the highest id', () => {
  const { db, now, cutoff, straddleAttempt } = straddleState();
  try {
    assert.ok(straddleAttempt.received < new Date(cutoff).toISOString(), 'received before the cutoff');
    assert.ok(straddleAttempt.id < db.raw.prepare('SELECT MAX(id) AS m FROM attempts').get().m, 'and not the highest id');
    const keys = runKeysOf(db);
    const left = ['newer', 'newest', 'straddle'];
    const before = observe(db, { now, config: { tiers, workflows: {} }, keys, dispatches: left });
    const { sel } = pruneAll(db, cutoff);
    assert.deepEqual(sel.rows.filter((r) => r.table === 'dispatches').map((r) => r.row.attempt_id), ['old'], 'only the dispatch closed before the cutoff goes');
    assert.ok(db.raw.prepare('SELECT 1 FROM attempts WHERE id = ?').get(straddleAttempt.id), 'the straddling attempt stays');
    assert.equal(db.getAttempt('straddle').items[0].outcome, 'accepted', 'getAttempt still sees its outcome');
    // A repeat of that result is still a duplicate, not a second acceptance.
    const again = db.recordResult({ run_key: 'b'.repeat(64), attempt_id: 'straddle', fence: straddleAttempt.fence, verdict: 'accepted', outcome: 'accepted', now });
    assert.equal(again.duplicate, true);
    assert.deepEqual(observe(db, { now, config: { tiers, workflows: {} }, keys, dispatches: left }), before);
    assert.equal(db.getDispatch('old'), undefined);
  } finally {
    db.close();
  }
});

test('R-PRUNE-04: ingest failure counters stay with a dispatch that straddles the cutoff and go with one that does not', () => {
  const { db, now, cutoff } = straddleState();
  try {
    const failed = db.ingestFailures('straddle', 1);
    assert.equal(failed.count, 1);
    assert.ok(failed.last < new Date(cutoff).toISOString(), 'noted before the cutoff');
    const { sel } = pruneAll(db, cutoff);
    assert.deepEqual(sel.rows.filter((r) => r.table === 'kv').map((r) => r.row.key), ['ingest.failures:old:0'], 'only the old dispatch\'s counter is archived');
    assert.deepEqual(db.ingestFailures('straddle', 1), failed, 'the straddling dispatch keeps its counter');
    assert.deepEqual(db.ingestFailures('old', 0), { count: 0 });
  } finally {
    db.close();
  }
});
