// The events table (schema v10): append-only, one row per fact, written in the
// fact's own transaction. See state/schema-v10.sql and docs/INTERFACES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState, StateDb, SCHEMA_VERSION } from '../state/db.mjs';
import { deleteArchived, DELETE_ORDER, KEYS, PRUNE_MIN_AGE_MS, selectPrunable } from '../state/prune.mjs';
import { dueFromState } from '../pump/due.mjs';
import { buildHistory, DAY } from './lib/state-history.mjs';

const T0 = Date.parse('2026-11-25T12:00:00Z');

test('recordEvent appends rows with growing ids; listEvents reads after an id', () => {
  const db = openState(':memory:');
  const a = db.recordEvent({ type: 'pump_run_started', data: { ticks: 0 } }, T0);
  const b = db.recordEvent({ type: 'dispatch_sent', occurredAt: T0 - 5000, lane: 'live-probe', n: 3, subject: null, data: { run_id: '1' } }, T0 + 1000);
  assert.ok(b > a);
  const all = db.listEvents();
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { id: a, type: 'pump_run_started', occurred_at: new Date(T0).toISOString(), recorded_at: new Date(T0).toISOString(), lane: null, n: 1, subject: null, data: { ticks: 0 } });
  assert.equal(all[1].occurred_at, new Date(T0 - 5000).toISOString());
  assert.equal(all[1].recorded_at, new Date(T0 + 1000).toISOString());
  assert.deepEqual(db.listEvents({ sinceId: a }).map((e) => e.id), [b]);
  assert.deepEqual(db.listEvents({ limit: 1 }).map((e) => e.id), [a]);
});

test('an event id is never reused after the newest row is deleted', () => {
  const db = openState(':memory:');
  const a = db.recordEvent({ type: 'x' }, T0);
  db.raw.exec('DELETE FROM events');
  assert.ok(db.recordEvent({ type: 'x' }, T0) > a);
});

// ---- every event is written with its fact and rolls back with it ----

const MIN = 60_000;
const SHA = 'a'.repeat(40);

/** A db with one pending dispatch 'att-1' of `n` items on lane live-probe. */
function withDispatch({ n = 2, now = T0, attemptId = 'att-1', ttlMs = 30 * MIN } = {}) {
  const db = openState(':memory:');
  db.acquireSlot(attemptId, { budget: 5, ttlMs, now });
  const items = Array.from({ length: n }, (_, i) => {
    const runKey = `${String(i).repeat(64)}`.slice(0, 64);
    db.recordRunKey(runKey, { subject: `repo:${i}`, workflow: 'live-probe', fields: {}, now });
    return { run_key: runKey, subject: `repo:${i}`, fence: db.acquireLease(runKey, attemptId, { ttlMs, now }).fence };
  });
  db.createDispatch({ attemptId, shardId: 'shard-1', workflow: 'live-probe', repo: 'o/w', workflowFile: 'live-probe.yml', ref: 'main', expires: now + ttlMs, items, workflowSha: SHA, now });
  return { db, items };
}

const events = (db, type) => db.listEvents().filter((e) => type === undefined || e.type === type);
const status = (db, id = 'att-1') => db.raw.prepare('SELECT status FROM dispatches WHERE attempt_id = ?').get(id)?.status;

/** Make inserts into events fail (of one type, or all), as a full disk or a bug would. */
function breakEvents(db, type = null) {
  const when = type ? ` WHEN NEW.type = '${type}'` : '';
  db.raw.exec(`CREATE TEMP TRIGGER events_fail BEFORE INSERT ON events${when} BEGIN SELECT RAISE(ABORT, 'events insert refused'); END`);
  const lines = [];
  db.log = (l) => lines.push(l);
  return { lines, restore: () => db.raw.exec('DROP TRIGGER temp.events_fail') };
}

/** fn() inside an outer transaction that then throws: nothing it wrote may stay. */
function rolledBack(db, fn) {
  assert.throws(() => db.tx(() => { fn(); throw new Error('boom'); }), /boom/);
}

/**
 * With every event insert failing, call() still writes its fact (checked by
 * factDone) and returns as usual; no event, the failure counted and logged once.
 */
function factKeptWithoutEvent(db, call, factDone, type) {
  const before = db.listEvents().length;
  const { lines, restore } = breakEvents(db);
  call();
  restore();
  factDone();
  assert.equal(db.listEvents().length, before, 'no event');
  const f = db.getKv('events.insert_failures');
  assert.equal(f.count, 1);
  assert.equal(f.last_type, type);
  assert.ok(Date.parse(f.last_at) > 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^state: event ${type} not recorded \\(events insert refused\\); its fact is kept$`));
}

test('a failing event insert is counted and logged and never thrown; recordEvent returns null', () => {
  const db = openState(':memory:');
  const lines = [];
  db.log = (l) => lines.push(l);
  assert.equal(db.recordEvent({ type: '' }, T0), null);
  assert.equal(db.recordEvent({ type: 'x', n: -1 }, T0), null);
  assert.equal(db.recordEvent(() => { throw new Error('lookup failed'); }, T0), null);
  assert.deepEqual(db.getKv('events.insert_failures'), { count: 3, last_at: new Date(T0).toISOString(), last_type: null });
  assert.equal(lines.length, 3);
  assert.equal(db.listEvents().length, 0);
  db.log = () => { throw new Error('log down'); };
  assert.equal(db.recordEvent({ type: '' }, T0), null, 'a log that throws changes nothing');
  assert.equal(db.inTx, false);
});

test('dispatch_created is written with the dispatch and rolls back with it; a failed event keeps the dispatch', () => {
  const { db } = withDispatch({ n: 3 });
  assert.deepEqual(events(db).map((e) => [e.type, e.lane, e.n, e.data]), [['dispatch_created', 'live-probe', 3, { shard_id: 'shard-1', items: 3 }]]);
  const l = db.acquireLease('k2', 'att-2', { ttlMs: MIN, now: T0 });
  const make = () => db.createDispatch({ attemptId: 'att-2', shardId: 's2', workflow: 'live-probe', repo: 'o/w', workflowFile: 'f.yml', ref: 'main', expires: T0 + MIN, items: [{ run_key: 'k2', subject: 'repo:9', fence: l.fence }], now: T0 });
  rolledBack(db, make);
  assert.equal(status(db, 'att-2'), undefined);
  assert.equal(events(db).length, 1);
  factKeptWithoutEvent(db, make, () => assert.equal(status(db, 'att-2'), 'pending'), 'dispatch_created');
});

test('dispatch_sent is written with markDispatched (now in its own transaction), once', () => {
  const { db } = withDispatch();
  rolledBack(db, () => db.markDispatched('att-1', { runId: 42, now: T0 + 1000 }));
  assert.equal(status(db), 'pending');
  assert.equal(events(db, 'dispatch_sent').length, 0);
  assert.equal(db.markDispatched('att-1', { runId: 42, runUrl: 'https://github.test/run/42', now: T0 + 1000 }), true);
  assert.equal(db.markDispatched('att-1', { runId: 43, now: T0 + 2000 }), false);
  const sent = events(db, 'dispatch_sent');
  assert.deepEqual(sent.map((e) => [e.lane, e.n, e.data, e.occurred_at]), [['live-probe', 2, { run_id: '42', run_url: 'https://github.test/run/42' }, new Date(T0 + 1000).toISOString()]]);

  const w = withDispatch();
  factKeptWithoutEvent(w.db, () => assert.equal(w.db.markDispatched('att-1', { runId: 42, now: T0 + 1000 }), true), () => assert.equal(status(w.db), 'dispatched'), 'dispatch_sent');
});

test('setDispatchRun writes dispatch_sent (correlated by run name) for a pending dispatch only', () => {
  const { db } = withDispatch();
  rolledBack(db, () => db.setDispatchRun('att-1', { runId: 7, now: T0 + 1000 }));
  assert.equal(status(db), 'pending');
  assert.equal(db.setDispatchRun('att-1', { runId: 7, runUrl: 'https://github.test/run/7', correlatedBy: 'run-name', now: T0 + 1000 }), true);
  assert.equal(db.setDispatchRun('att-1', { runId: 8, now: T0 + 2000 }), false);
  assert.deepEqual(events(db, 'dispatch_sent').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { run_id: '7', run_url: 'https://github.test/run/7', correlated_by: 'run-name' }]]);
  // Marked sent without a run id: its dispatch_sent is from markDispatched, not again here.
  const w = withDispatch();
  w.db.markDispatched('att-1', { runId: null, now: T0 });
  assert.equal(w.db.setDispatchRun('att-1', { runId: 9, now: T0 + 1000 }), true);
  assert.deepEqual(events(w.db, 'dispatch_sent').map((e) => e.data), [{ run_id: null, run_url: null }]);
});

test('dispatch_failed is written with failDispatch and rolls back with it; a dispatch not pending writes nothing', () => {
  const { db, items } = withDispatch();
  rolledBack(db, () => db.failDispatch('att-1', { error: 'x', now: T0 + 1000 }));
  assert.equal(status(db), 'pending');
  assert.equal(db.getLease(items[0].run_key).holder, 'att-1');
  assert.equal(db.failDispatch('att-1', { error: 'HTTP 422', status: 422, now: T0 + 1000 }), true);
  assert.equal(db.failDispatch('att-1', { error: 'again', now: T0 + 2000 }), false);
  assert.deepEqual(events(db, 'dispatch_failed').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { status: 422, withdrawn: false }]]);

  const w = withDispatch();
  w.db.failDispatch('att-1', { error: 'not sent: the run deadline passed', withdrawn: true, now: T0 + 1000 });
  assert.deepEqual(events(w.db, 'dispatch_failed').map((e) => e.data), [{ status: null, withdrawn: true }]);

  const k = withDispatch();
  factKeptWithoutEvent(k.db, () => k.db.failDispatch('att-1', { error: 'HTTP 422', status: 422, now: T0 + 1000 }), () => {
    assert.equal(status(k.db), 'failed');
    assert.equal(k.db.getLease(k.items[0].run_key).holder, null, 'leases released all the same');
  }, 'dispatch_failed');
});

test('dispatch_unconfirmed is written for a pending dispatch only, and rolls back with its transaction', () => {
  const { db } = withDispatch();
  rolledBack(db, () => db.noteUnconfirmedDispatch('att-1', { status: 502, now: T0 + 1000 }));
  assert.equal(events(db, 'dispatch_unconfirmed').length, 0);
  assert.equal(db.noteUnconfirmedDispatch('att-1', { status: 502, now: T0 + 1000 }), true);
  assert.equal(status(db), 'pending', 'the dispatch itself is unchanged');
  assert.deepEqual(events(db, 'dispatch_unconfirmed').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { status: 502 }]]);
  db.markDispatched('att-1', { runId: 1, now: T0 + 2000 });
  assert.equal(db.noteUnconfirmedDispatch('att-1', { status: 0, now: T0 + 3000 }), false);
  assert.equal(db.noteUnconfirmedDispatch('nope', { now: T0 }), false);
  assert.equal(events(db, 'dispatch_unconfirmed').length, 1);
  const w = withDispatch();
  factKeptWithoutEvent(w.db, () => assert.equal(w.db.noteUnconfirmedDispatch('att-1', { status: 502, now: T0 }), true), () => assert.equal(status(w.db), 'pending'), 'dispatch_unconfirmed');
});

test('dispatch_expired is written per reaped dispatch and rolls back with the reap', () => {
  const { db } = withDispatch({ n: 3 });
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const later = T0 + 31 * MIN;
  rolledBack(db, () => db.reapExpiredDispatches({ now: later }));
  assert.equal(status(db), 'dispatched');
  assert.equal(db.reapExpiredDispatches({ now: later }).length, 1);
  assert.equal(db.reapExpiredDispatches({ now: later + MIN }).length, 0);
  assert.deepEqual(events(db, 'dispatch_expired').map((e) => [e.lane, e.n, e.data]), [['live-probe', 3, {}]]);
  const w = withDispatch();
  factKeptWithoutEvent(w.db, () => assert.equal(w.db.reapExpiredDispatches({ now: later }).length, 1), () => assert.equal(status(w.db), 'expired'), 'dispatch_expired');
});

test('dispatch_closed is written with closeDispatch and rolls back with it; closing twice writes one', () => {
  const { db } = withDispatch();
  db.markDispatched('att-1', { runId: 1, now: T0 });
  rolledBack(db, () => db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }));
  assert.equal(status(db), 'dispatched');
  assert.equal(db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }), true);
  assert.equal(db.closeDispatch('att-1', { reason: 'again', now: T0 + 2 * MIN }), false);
  assert.deepEqual(events(db, 'dispatch_closed').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { close_reason: 'run_completed' }]]);
  const w = withDispatch();
  factKeptWithoutEvent(w.db, () => assert.equal(w.db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }), true), () => assert.equal(status(w.db), 'done'), 'dispatch_closed');
});

test('result_recorded is written with each fresh result, never for a duplicate; the last result also writes dispatch_closed results_in', () => {
  const { db, items } = withDispatch();
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const rec = (i, over = {}, d = db, its = items) => d.recordResult({ run_key: its[i].run_key, attempt_id: 'att-1', fence: its[i].fence, outcome: 'accepted', verdict: 'accepted', fault: null, coverage: 'assessed', now: T0 + MIN, ...over });

  rolledBack(db, () => rec(0));
  assert.equal(db.listAttempts('repo:0').length, 0);
  assert.equal(events(db, 'result_recorded').length, 0);

  assert.equal(rec(0).accepted, true);
  assert.equal(rec(0).duplicate, true);
  assert.equal(rec(1, { outcome: 'rejected', verdict: 'rejected', reason: 'no_artifact' }).accepted, false);
  assert.equal(rec(1, { outcome: 'rejected', verdict: 'rejected', reason: 'no_artifact' }).duplicate, true);
  assert.deepEqual(events(db, 'result_recorded').map((e) => [e.lane, e.n, e.subject, e.data]), [
    ['live-probe', 1, 'repo:0', { verdict: 'accepted', reason: null, outcome: 'accepted', fault: null, coverage: 'assessed' }],
    ['live-probe', 1, 'repo:1', { verdict: 'rejected', reason: 'no_artifact', outcome: 'rejected', fault: null, coverage: null }],
  ]);
  assert.deepEqual(events(db, 'dispatch_closed').map((e) => e.data), [{ close_reason: 'results_in' }]);
  assert.deepEqual(events(db).map((e) => e.type), ['dispatch_created', 'dispatch_sent', 'result_recorded', 'result_recorded', 'dispatch_closed']);

  const w = withDispatch();
  w.db.markDispatched('att-1', { runId: 1, now: T0 });
  factKeptWithoutEvent(w.db, () => assert.equal(rec(0, {}, w.db, w.items).accepted, true), () => assert.equal(w.db.getResult(w.items[0].run_key).attempt_id, 'att-1'), 'result_recorded');
});

test('an event goes when its fact fails after it was written (the results insert of recordResult)', () => {
  const { db, items } = withDispatch();
  db.markDispatched('att-1', { runId: 1, now: T0 });
  db.raw.exec("CREATE TEMP TRIGGER results_fail BEFORE INSERT ON results BEGIN SELECT RAISE(ABORT, 'results insert refused'); END");
  assert.throws(() => db.recordResult({ run_key: items[0].run_key, attempt_id: 'att-1', fence: items[0].fence, outcome: 'accepted', verdict: 'accepted', now: T0 + MIN }), /results insert refused/);
  assert.equal(db.listAttempts('repo:0').length, 0);
  assert.equal(events(db, 'result_recorded').length, 0, 'the event written before the failure rolled back with the fact');
});

test('event data is bounded: reasons, run URLs and held lane names are cut to 200 characters', () => {
  const { db, items } = withDispatch();
  const long = 'x'.repeat(500);
  db.markDispatched('att-1', { runId: 1, runUrl: `https://github.test/${long}`, now: T0 });
  db.recordResult({ run_key: items[0].run_key, attempt_id: 'att-1', fence: items[0].fence, outcome: 'rejected', verdict: 'rejected', reason: long, now: T0 + MIN });
  db.noteBreaker('pump.breaker', { tripped: true, reason: long, held: [long] }, { now: T0 });
  db.closeDispatch('att-1', { reason: long, now: T0 + 2 * MIN });
  assert.equal(events(db, 'dispatch_sent')[0].data.run_url.length, 200);
  assert.equal(events(db, 'result_recorded')[0].data.reason.length, 200);
  const b = events(db, 'breaker_changed')[0].data;
  assert.equal(b.reason.length, 200);
  assert.equal(b.held[0].length, 200);
  assert.equal(events(db, 'dispatch_closed')[0].data.close_reason.length, 200);
  assert.equal(db.getKv('pump.breaker').reason.length, 500, 'the kv record itself is unchanged');
});

test('workflow_paused is written with the pause, in one transaction; mismatches below the limit write none', () => {
  const mk = () => {
    const db = openState(':memory:');
    const note = (i) => db.noteShaMismatch('live-probe', { sha: `${i}`.repeat(40), created: T0 + i * 10 * MIN, now: T0 + i * 10 * MIN });
    note(1);
    note(2);
    return { db, note };
  };
  const { db, note } = mk();
  assert.equal(events(db).length, 0);
  rolledBack(db, () => note(3));
  assert.equal(db.getKv('pump.paused:live-probe'), undefined);
  assert.equal(db.getKv('pump.sha_mismatch:live-probe').count, 2);
  assert.equal(note(3).paused, true);
  const until = db.getKv('pump.paused:live-probe').until;
  assert.deepEqual(events(db).map((e) => [e.type, e.lane, e.data]), [['workflow_paused', 'live-probe', { until }]]);
  assert.equal(db.getKv('pump.sha_mismatch:live-probe'), undefined);
  const w = mk();
  factKeptWithoutEvent(w.db, () => assert.equal(w.note(3).paused, true), () => {
    assert.ok(w.db.getKv('pump.paused:live-probe'));
    assert.equal(w.db.getKv('pump.sha_mismatch:live-probe'), undefined);
  }, 'workflow_paused');
});

test('the pump notes write their kv record and event together, and the kv record reads as before', () => {
  const cases = [
    ['notePumpRun', (db) => db.notePumpRun('finished', { ticks: 4, dispatched: 2, lastRun: { ticks: 4, dispatched: 2 } }, { now: T0 }), 'pump.last_run', { ticks: 4, dispatched: 2 }, ['pump_run_finished', { ticks: 4, dispatched: 2 }]],
    ['noteSuccessor', (db) => db.noteSuccessor({ ok: false, error: 'POST returned HTTP 502', at: 'x' }, { now: T0 }), 'pump.successor', { ok: false, error: 'POST returned HTTP 502', at: 'x' }, ['successor', { ok: false, run_id: null, status: 502 }]],
    ['noteRegistryDelta', (db) => db.noteRegistryDelta('pump.registry_delta', { action: 'dispatched', at: 'x' }, { now: T0 }), 'pump.registry_delta', { action: 'dispatched', at: 'x' }, ['registry_delta', { action: 'dispatched' }]],
    ['noteBreaker', (db) => db.noteBreaker('pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe'], at: 'x' }, { now: T0 }), 'pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe'], at: 'x' }, ['breaker_changed', { tripped: true, reason: 'stale', held: ['live-probe'] }]],
  ];
  for (const [name, call, key, value, [type, data]] of cases) {
    const db = openState(':memory:');
    rolledBack(db, () => call(db));
    assert.equal(db.getKv(key), undefined, name);
    assert.equal(db.listEvents().length, 0, name);
    call(db);
    assert.deepEqual(db.getKv(key), value, name);
    assert.deepEqual(events(db, type).map((e) => e.data), [data], name);
    const w = openState(':memory:');
    factKeptWithoutEvent(w, () => call(w), () => assert.deepEqual(w.getKv(key), value, name), type);
  }
  const db = openState(':memory:');
  db.notePumpRun('started', { occurredAt: T0 - 5000 }, { now: T0 });
  const started = events(db, 'pump_run_started');
  assert.deepEqual(started.map((e) => [e.occurred_at, e.data]), [[new Date(T0 - 5000).toISOString(), { ticks: 0, dispatched: 0 }]]);
  const w = openState(':memory:');
  factKeptWithoutEvent(w, () => w.notePumpRun('started', {}, { now: T0 }), () => {}, 'pump_run_started');
  db.noteSuccessor({ ok: true, at: 'y', runId: 77 }, { now: T0 });
  assert.deepEqual(events(db, 'successor').at(-1).data, { ok: true, run_id: 77, status: null });
  for (const action of ['fresh', 'running', 'spaced']) db.noteRegistryDelta('pump.registry_delta', { action, at: 'z' }, { now: T0 });
  assert.equal(db.getKv('pump.registry_delta').action, 'spaced', 'the record is still written');
  assert.equal(events(db, 'registry_delta').length, 0, 'only dispatched or failed is an event');
  assert.throws(() => db.notePumpRun('paused', {}, { now: T0 }), TypeError);
});

test('R-LIVE-01: noteShaMismatch sets the pause and removes the count in one transaction: neither write happens without the other', () => {
  const db = openState(':memory:');
  const note = (i) => db.noteShaMismatch('live-probe', { sha: `${i}`.repeat(40), created: T0 + i * 10 * MIN, now: T0 + i * 10 * MIN });
  note(1);
  note(2);
  db.raw.exec("CREATE TEMP TRIGGER count_delete_fails BEFORE DELETE ON kv WHEN OLD.key = 'pump.sha_mismatch:live-probe' BEGIN SELECT RAISE(ABORT, 'kv delete refused'); END");
  assert.throws(() => note(3), /kv delete refused/);
  assert.equal(db.getKv('pump.paused:live-probe'), undefined, 'no pause without the count removed (two separate writes left a pause here)');
  assert.equal(db.getKv('pump.sha_mismatch:live-probe').count, 2, 'the count is as it was');
  assert.equal(db.listEvents().length, 0);
  db.raw.exec('DROP TRIGGER temp.count_delete_fails');
  assert.equal(note(3).paused, true);
  assert.ok(db.getKv('pump.paused:live-probe'));
  assert.equal(db.getKv('pump.sha_mismatch:live-probe'), undefined);
});

// ---- events on or off: everything else is the same ----

test('the same history with events recorded and with recordEvent a no-op leaves every other table byte for byte the same', () => {
  const dumpOthers = (db) => {
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'events' ORDER BY name").all().map((r) => r.name);
    return Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => Object.entries(r)))]));
  };
  const on = buildHistory({ seed: 5, days: 10, subjects: 6 });
  assert.ok(on.db.listEvents({ limit: 1 }).length === 1);
  const real = StateDb.prototype.recordEvent;
  let off;
  StateDb.prototype.recordEvent = function noEvent() { return null; };
  try {
    off = buildHistory({ seed: 5, days: 10, subjects: 6 });
  } finally {
    StateDb.prototype.recordEvent = real;
  }
  assert.equal(off.db.raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.deepEqual(dumpOthers(off.db), dumpOthers(on.db));
  assert.equal(on.db.getKv('events.insert_failures'), undefined);
  on.db.close();
  off.db.close();
});

// ---- migration 9 -> 10 ----

test('the v10 migration of a real-shaped v9 state keeps every row and the due list; old code refuses a v10 state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v10-'));
  try {
    const file = join(dir, 'state.sqlite');
    const built = buildHistory({ seed: 11, days: 14, subjects: 8, file });
    assert.ok(built.db.listEvents({ limit: 1 }).length === 1, 'the history writes events');
    built.db.raw.exec("DROP TABLE lead_subjects; DROP TABLE leads; DROP TABLE discovery_keys; DROP TABLE events; DELETE FROM sqlite_sequence WHERE name = 'events'; PRAGMA user_version = 9;");
    built.db.close();

    const v9 = new StateDb(file);
    assert.equal(v9.schemaVersion(), 9);
    const tables = v9.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const counts = (raw) => Object.fromEntries(tables.map((t) => [t, raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    const dump = (raw) => Object.fromEntries(tables.map((t) => [t, raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
    const before = dump(v9.raw);
    const at = [built.now, built.now + 10 * DAY];
    const due = (db) => at.map((now) => dueFromState(db, { now, ...built.config }).map((d) => `${d.subject} ${d.workflow} ${d.run_key} ${d.reasons.join(',')}`));
    const dueBefore = due(v9);
    assert.ok(counts(v9.raw).results > 5, JSON.stringify(counts(v9.raw)));

    assert.equal(v9.migrate(), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 12);
    assert.deepEqual(dump(v9.raw), before, 'no row of any older table changed');
    assert.deepEqual(due(v9), dueBefore);
    assert.equal(v9.raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0, 'no events are made up for the past');
    assert.equal(v9.raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const idx = v9.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx, ['events_time', 'events_type']);
    assert.equal(v9.recordEvent({ type: 'pump_run_started' }, built.now), 1);
    assert.equal(v9.migrate(), SCHEMA_VERSION, 'migrating again changes nothing');
    v9.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => v9.migrate(), /newer than this code/, 'code that predates a schema refuses it (deploy order: the first new pump migrates)');
    v9.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- prune ----

test('prune: events go after the cutoff plus a day (8 days at the default), the newest always stays, and only as archived', () => {
  assert.equal(DELETE_ORDER.at(-1), 'events');
  assert.deepEqual(KEYS.events, ['id']);
  assert.equal(PRUNE_MIN_AGE_MS, 7 * DAY);
  const db = openState(':memory:');
  const now = T0 + 30 * DAY;
  const cutoff = now - PRUNE_MIN_AGE_MS;
  const ages = [20, 9, 8.01, 7.99, 7.5, 1];
  for (const d of ages) db.recordEvent({ type: 'dispatch_sent', occurredAt: now - d * DAY, lane: 'live-probe' }, now - d * DAY);
  const sel = selectPrunable(db, { cutoff });
  assert.deepEqual(sel.rows.filter((r) => r.table === 'events').map((r) => r.row.id), [1, 2, 3], 'older than 8 days only');
  assert.equal(sel.counts.events, 3);
  assert.equal(db.listEvents().length, ages.length, 'selecting deletes nothing');
  // An archived row that changed since is kept.
  db.raw.exec("UPDATE events SET data = '{\"x\":1}' WHERE id = 3");
  const out = deleteArchived(db, { rows: sel.rows, cutoff });
  assert.equal(out.deleted.events, 2);
  assert.equal(out.kept.events, 1);
  assert.deepEqual(db.listEvents().map((e) => e.id), [3, 4, 5, 6]);

  // The newest event stays however old, so the max id (the live seq) never goes back.
  const old = openState(':memory:');
  for (let i = 0; i < 3; i++) old.recordEvent({ type: 'x', occurredAt: now - 30 * DAY }, now - 30 * DAY);
  const s2 = selectPrunable(old, { cutoff });
  assert.deepEqual(s2.rows.map((r) => r.row.id), [1, 2]);
  deleteArchived(old, { rows: s2.rows, cutoff });
  assert.deepEqual(old.listEvents().map((e) => e.id), [3]);
  assert.equal(old.recordEvent({ type: 'x' }, now), 4);
});
