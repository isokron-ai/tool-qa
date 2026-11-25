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
  assert.throws(() => db.recordEvent({ type: '' }, T0), TypeError);
  assert.throws(() => db.recordEvent({ type: 'x', n: -1 }, T0), TypeError);
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

/** Make every insert into events fail, as a full disk or a bug would. */
function breakEvents(db) {
  db.raw.exec("CREATE TEMP TRIGGER events_fail BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'events insert refused'); END");
  return () => db.raw.exec('DROP TRIGGER temp.events_fail');
}

/** fn() inside an outer transaction that then throws: nothing it wrote may stay. */
function rolledBack(db, fn) {
  assert.throws(() => db.tx(() => { fn(); throw new Error('boom'); }), /boom/);
}

test('dispatch_created is written with the dispatch and rolls back with it', () => {
  const { db } = withDispatch({ n: 3 });
  assert.deepEqual(events(db).map((e) => [e.type, e.lane, e.n, e.data]), [['dispatch_created', 'live-probe', 3, { shard_id: 'shard-1', items: 3 }]]);
  const l = db.acquireLease('k2', 'att-2', { ttlMs: MIN, now: T0 });
  const make = () => db.createDispatch({ attemptId: 'att-2', shardId: 's2', workflow: 'live-probe', repo: 'o/w', workflowFile: 'f.yml', ref: 'main', expires: T0 + MIN, items: [{ run_key: 'k2', subject: 'repo:9', fence: l.fence }], now: T0 });
  rolledBack(db, make);
  const restore = breakEvents(db);
  assert.throws(make, /events insert refused/);
  restore();
  assert.equal(status(db, 'att-2'), undefined, 'no dispatch without its event');
  assert.equal(events(db).length, 1);
});

test('dispatch_sent is written with markDispatched (now in its own transaction), once', () => {
  const { db } = withDispatch();
  const restore = breakEvents(db);
  assert.throws(() => db.markDispatched('att-1', { runId: 42, runUrl: 'https://github.test/run/42', now: T0 + 1000 }), /events insert refused/);
  restore();
  assert.equal(status(db), 'pending', 'the dispatch is not marked sent without its event');
  rolledBack(db, () => db.markDispatched('att-1', { runId: 42, now: T0 + 1000 }));
  assert.equal(status(db), 'pending');
  assert.equal(db.markDispatched('att-1', { runId: 42, runUrl: 'https://github.test/run/42', now: T0 + 1000 }), true);
  assert.equal(db.markDispatched('att-1', { runId: 43, now: T0 + 2000 }), false);
  const sent = events(db, 'dispatch_sent');
  assert.deepEqual(sent.map((e) => [e.lane, e.n, e.data, e.occurred_at]), [['live-probe', 2, { run_id: '42', run_url: 'https://github.test/run/42' }, new Date(T0 + 1000).toISOString()]]);
});

test('dispatch_failed is written with failDispatch and rolls back with it; a dispatch not pending writes nothing', () => {
  const { db, items } = withDispatch();
  const restore = breakEvents(db);
  assert.throws(() => db.failDispatch('att-1', { error: 'HTTP 422', status: 422, now: T0 + 1000 }), /events insert refused/);
  restore();
  assert.equal(status(db), 'pending');
  assert.equal(db.getLease(items[0].run_key).holder, 'att-1', 'leases are not released without the event');
  rolledBack(db, () => db.failDispatch('att-1', { error: 'x', now: T0 + 1000 }));
  assert.equal(status(db), 'pending');
  assert.equal(db.failDispatch('att-1', { error: 'HTTP 422', status: 422, now: T0 + 1000 }), true);
  assert.equal(db.failDispatch('att-1', { error: 'again', now: T0 + 2000 }), false);
  assert.deepEqual(events(db, 'dispatch_failed').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { status: 422, withdrawn: false }]]);

  const w = withDispatch();
  w.db.failDispatch('att-1', { error: 'not sent: the run deadline passed', withdrawn: true, now: T0 + 1000 });
  assert.deepEqual(events(w.db, 'dispatch_failed').map((e) => e.data), [{ status: null, withdrawn: true }]);
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
});

test('dispatch_expired is written per reaped dispatch and rolls back with the reap', () => {
  const { db } = withDispatch({ n: 3 });
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const later = T0 + 31 * MIN;
  const restore = breakEvents(db);
  assert.throws(() => db.reapExpiredDispatches({ now: later }), /events insert refused/);
  restore();
  assert.equal(status(db), 'dispatched');
  rolledBack(db, () => db.reapExpiredDispatches({ now: later }));
  assert.equal(status(db), 'dispatched');
  assert.equal(db.reapExpiredDispatches({ now: later }).length, 1);
  assert.equal(db.reapExpiredDispatches({ now: later + MIN }).length, 0);
  assert.deepEqual(events(db, 'dispatch_expired').map((e) => [e.lane, e.n, e.data]), [['live-probe', 3, { count: 3 }]]);
});

test('dispatch_closed is written with closeDispatch and rolls back with it; closing twice writes one', () => {
  const { db } = withDispatch();
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const restore = breakEvents(db);
  assert.throws(() => db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }), /events insert refused/);
  restore();
  assert.equal(status(db), 'dispatched');
  rolledBack(db, () => db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }));
  assert.equal(status(db), 'dispatched');
  assert.equal(db.closeDispatch('att-1', { reason: 'run_completed', now: T0 + MIN }), true);
  assert.equal(db.closeDispatch('att-1', { reason: 'again', now: T0 + 2 * MIN }), false);
  assert.deepEqual(events(db, 'dispatch_closed').map((e) => [e.lane, e.n, e.data]), [['live-probe', 2, { close_reason: 'run_completed' }]]);
});

test('result_recorded is written with each fresh result, never for a duplicate; the last result also writes dispatch_closed results_in', () => {
  const { db, items } = withDispatch();
  db.markDispatched('att-1', { runId: 1, now: T0 });
  const rec = (i, over = {}) => db.recordResult({ run_key: items[i].run_key, attempt_id: 'att-1', fence: items[i].fence, outcome: 'accepted', verdict: 'accepted', fault: null, coverage: 'assessed', now: T0 + MIN, ...over });

  const restore = breakEvents(db);
  assert.throws(() => rec(0), /events insert refused/);
  restore();
  assert.equal(db.listAttempts('repo:0').length, 0, 'no attempt without its event');
  assert.equal(db.getResult(items[0].run_key), undefined);
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
});

test('workflow_paused is written with the pause, in one transaction; mismatches below the limit write none', () => {
  const db = openState(':memory:');
  const note = (i) => db.noteShaMismatch('live-probe', { sha: `${i}`.repeat(40), created: T0 + i * 10 * MIN, now: T0 + i * 10 * MIN });
  note(1);
  note(2);
  assert.equal(events(db).length, 0);
  const before = db.getKv('pump.sha_mismatch:live-probe');
  const restore = breakEvents(db);
  assert.throws(() => note(3), /events insert refused/);
  restore();
  assert.equal(db.getKv('pump.paused:live-probe'), undefined, 'no pause without its event');
  assert.deepEqual(db.getKv('pump.sha_mismatch:live-probe'), before, 'the count is kept');
  rolledBack(db, () => note(3));
  assert.equal(db.getKv('pump.paused:live-probe'), undefined);
  assert.equal(note(3).paused, true);
  const until = db.getKv('pump.paused:live-probe').until;
  assert.deepEqual(events(db).map((e) => [e.type, e.lane, e.data]), [['workflow_paused', 'live-probe', { until }]]);
  assert.equal(db.getKv('pump.sha_mismatch:live-probe'), undefined);
});

test('the pump notes write their kv record and event together, and the kv record reads as before', () => {
  const db = openState(':memory:');
  const cases = [
    ['notePumpRun', () => db.notePumpRun('finished', { ticks: 4, dispatched: 2, lastRun: { ticks: 4, dispatched: 2 } }, { now: T0 }), 'pump.last_run', { ticks: 4, dispatched: 2 }, ['pump_run_finished', { ticks: 4, dispatched: 2 }]],
    ['noteSuccessor', () => db.noteSuccessor({ ok: false, error: 'POST returned HTTP 502', at: 'x' }, { now: T0 }), 'pump.successor', { ok: false, error: 'POST returned HTTP 502', at: 'x' }, ['successor', { ok: false, run_id: null, status: 502 }]],
    ['noteRegistryDelta', () => db.noteRegistryDelta('pump.registry_delta', { action: 'dispatched', at: 'x' }, { now: T0 }), 'pump.registry_delta', { action: 'dispatched', at: 'x' }, ['registry_delta', { action: 'dispatched' }]],
    ['noteBreaker', () => db.noteBreaker('pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe'], at: 'x' }, { now: T0 }), 'pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe'], at: 'x' }, ['breaker_changed', { tripped: true, reason: 'stale', held: ['live-probe'] }]],
  ];
  for (const [name, call, key, value, [type, data]] of cases) {
    const restore = breakEvents(db);
    assert.throws(call, /events insert refused/, name);
    restore();
    assert.equal(db.getKv(key), undefined, `${name}: no kv record without its event`);
    rolledBack(db, call);
    assert.equal(db.getKv(key), undefined, name);
    call();
    assert.deepEqual(db.getKv(key), value, name);
    assert.deepEqual(events(db, type).map((e) => e.data), [data], name);
  }
  db.notePumpRun('started', { occurredAt: T0 - 5000 }, { now: T0 });
  const started = events(db, 'pump_run_started');
  assert.deepEqual(started.map((e) => [e.occurred_at, e.data]), [[new Date(T0 - 5000).toISOString(), { ticks: 0, dispatched: 0 }]]);
  db.noteSuccessor({ ok: true, at: 'y', runId: 77 }, { now: T0 });
  assert.deepEqual(events(db, 'successor').at(-1).data, { ok: true, run_id: 77, status: null });
  for (const action of ['fresh', 'running', 'spaced']) db.noteRegistryDelta('pump.registry_delta', { action, at: 'z' }, { now: T0 });
  assert.equal(db.getKv('pump.registry_delta').action, 'spaced', 'the record is still written');
  assert.equal(events(db, 'registry_delta').length, 1, 'only dispatched or failed is an event');
  assert.throws(() => db.notePumpRun('paused', {}, { now: T0 }), TypeError);
});

// ---- migration 9 -> 10 ----

test('the v10 migration of a real-shaped v9 state keeps every row and the due list; old code refuses a v10 state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v10-'));
  try {
    const file = join(dir, 'state.sqlite');
    const built = buildHistory({ seed: 11, days: 14, subjects: 8, file });
    assert.ok(built.db.listEvents({ limit: 1 }).length === 1, 'the history writes events');
    built.db.raw.exec("DROP TABLE events; DELETE FROM sqlite_sequence WHERE name = 'events'; PRAGMA user_version = 9;");
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
    assert.equal(SCHEMA_VERSION, 10);
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
