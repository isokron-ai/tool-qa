// Schema v8: subjects keyed by GitHub's numeric repository id (loop upgrade
// #15). The migration from a live-shaped v7 state, and the identity writes of
// the state store (applyIdentityLookup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState, StateDb, SCHEMA_VERSION } from '../state/db.mjs';
import { dueFromState } from '../pump/due.mjs';
import { buildHistory, DAY, T0, tiers as TIERS } from './lib/state-history.mjs';

const TABLES = ['counters', 'subjects', 'runs', 'leases', 'slot_ledger', 'attempts', 'run_keys', 'dispatches', 'dispatch_items', 'results', 'kv'];
const node = (id, name, createdAt = '2025-03-01T00:00:00Z') => ({ databaseId: id, id: `R_test${id}`, nameWithOwner: name, createdAt });
const ok = (id, name, createdAt) => ({ status: 'ok', node: node(id, name, createdAt), via: 'name' });

/** Take a state built by this code back to exactly what schema v7 had. */
function downgradeToV7(db) {
  db.raw.exec(`
    DROP TABLE lead_subjects;
    DROP TABLE leads;
    DROP TABLE events;
    DROP TABLE oracle_facts;
    DROP TABLE oracle_disagreements;
    DROP INDEX subjects_repo_id;
    DROP TABLE subject_events;
    ALTER TABLE dispatch_items DROP COLUMN subject_name;
    ${['name', 'repo_id', 'node_id', 'repo_created_at', 'id_status', 'id_checked_at', 'gone_at', 'alias_of'].map((c) => `ALTER TABLE subjects DROP COLUMN ${c};`).join('\n')}
    PRAGMA user_version = 7;
  `);
}

function counts(raw) {
  return Object.fromEntries(TABLES.map((t) => [t, raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
}

const dueView = (due) => due.map((d) => `${d.subject} ${d.workflow} ${d.run_key} ${d.reasons.join(',')}`);

test('R-SUBJ-01: the v8 migration of a live-shaped v7 state keeps every row, names every subject by its key, and makes nothing due that was not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v8-'));
  try {
    const file = join(dir, 'state.sqlite');
    const built = buildHistory({ seed: 7, days: 21, subjects: 12, file });
    downgradeToV7(built.db);
    built.db.close();

    const v7 = new StateDb(file); // opened, not migrated
    assert.equal(v7.schemaVersion(), 7);
    const before = counts(v7.raw);
    assert.ok(before.results > 10 && before.dispatch_items > 10 && before.attempts > 10, JSON.stringify(before));
    const fence = v7.raw.prepare("SELECT value FROM counters WHERE name = 'fence'").get().value;
    // The due list v7 code computes, at several moments.
    const moments = [built.now, built.now + DAY, built.now + 10 * DAY, built.now + 40 * DAY];
    const dueBefore = moments.map((now) => dueView(dueFromState(v7, { now, ...built.config })));
    const keysBefore = v7.raw.prepare('SELECT run_key FROM results ORDER BY run_key').all().map((r) => r.run_key);

    assert.equal(v7.migrate(), 11);
    assert.equal(SCHEMA_VERSION, 11);
    assert.deepEqual(counts(v7.raw), before, 'no row lost or added');
    assert.equal(v7.raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(v7.raw.prepare("SELECT value FROM counters WHERE name = 'fence'").get().value, fence);
    for (const s of v7.listSubjects()) {
      assert.equal(s.name, s.id, 'a subject from before v8 is named by its key');
      assert.deepEqual([s.repo_id, s.node_id, s.id_status, s.gone_at, s.alias_of], [null, null, null, null, null]);
    }
    assert.equal(v7.raw.prepare('SELECT COUNT(*) AS n FROM dispatch_items WHERE subject_name IS NOT NULL').get().n, 0);
    assert.deepEqual(v7.raw.prepare('SELECT run_key FROM results ORDER BY run_key').all().map((r) => r.run_key), keysBefore, 'no run_key moved');
    const dueAfter = moments.map((now) => dueView(dueFromState(v7, { now, ...built.config })));
    assert.deepEqual(dueAfter, dueBefore, 'the due list is the same before and after: nothing became due again');

    // Idempotent: migrating again (or reopening) changes nothing.
    assert.equal(v7.migrate(), SCHEMA_VERSION);
    v7.close();
    const again = openState(file);
    assert.deepEqual(counts(again.raw), before);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-SUBJ-01: the v8 CHECKs pass on migrated rows and refuse bad ids and statuses; one subject per repository id', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'a/one', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.setSubjectVersion({ id: 'a/two', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  assert.equal(db.getSubject('a/one').name, 'a/one', 'a new subject is named by its key');
  assert.throws(() => db.raw.prepare("UPDATE subjects SET repo_id = 0 WHERE id = 'a/one'").run(), /CHECK/);
  assert.throws(() => db.raw.prepare("UPDATE subjects SET id_status = 'maybe' WHERE id = 'a/one'").run(), /CHECK/);
  assert.throws(() => db.recordSubjectEvent({ subject: 'a/one', kind: 'teleported', now: T0 }), /CHECK/);
  db.raw.prepare("UPDATE subjects SET repo_id = 5 WHERE id = 'a/one'").run();
  assert.throws(() => db.raw.prepare("UPDATE subjects SET repo_id = 5 WHERE id = 'a/two'").run(), /UNIQUE/);
  db.close();
});

test('R-SUBJ-02: a lookup binds the id; a later rename or transfer moves only the name, never the key, and is recorded', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/server', kind: 'github', source: 'seed-v1', tier: 2, now: T0 });
  assert.deepEqual(db.applyIdentityLookup('acme/server', ok(42, 'acme/server'), { now: T0 }).map((e) => e.kind), ['id_bound']);
  let s = db.getSubject('acme/server');
  assert.deepEqual([s.repo_id, s.node_id, s.repo_created_at, s.id_status, s.name], [42, 'R_test42', '2025-03-01T00:00:00Z', 'ok', 'acme/server']);

  assert.deepEqual(db.applyIdentityLookup('acme/server', { ...ok(42, 'acme/server-mcp'), via: 'id' }, { now: T0 + 1 }).map((e) => e.kind), ['renamed']);
  assert.deepEqual(db.applyIdentityLookup('acme/server', { ...ok(42, 'newco/server-mcp'), via: 'id' }, { now: T0 + 2 }).map((e) => e.kind), ['transferred']);
  s = db.getSubject('acme/server');
  assert.equal(s.id, 'acme/server', 'the key never moves');
  assert.equal(s.name, 'newco/server-mcp');
  const ev = db.listSubjectEvents('acme/server');
  assert.deepEqual(ev.map((e) => [e.kind, e.old_name, e.new_name, e.repo_id]), [
    ['id_bound', 'acme/server', 'acme/server', 42],
    ['renamed', 'acme/server', 'acme/server-mcp', 42],
    ['transferred', 'acme/server-mcp', 'newco/server-mcp', 42],
  ]);
  // A stale seed name bound for the first time records the bind and the rename together.
  db.setSubjectVersion({ id: 'old/name', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  assert.deepEqual(db.applyIdentityLookup('old/name', ok(43, 'new/name'), { now: T0 }).map((e) => e.kind), ['id_bound', 'transferred']);
  db.close();
});

test('R-SUBJ-02: getAttempt and the dispatch keep the name the worker was sent; the result is recorded under the key after a rename', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/server', kind: 'github', source: 'seed-v1', tier: 2, now: T0 });
  db.applyIdentityLookup('acme/server', ok(42, 'acme/server'), { now: T0 });
  const key = 'c'.repeat(64);
  const l = db.acquireLease(key, 'att-1', { ttlMs: 3_600_000, now: T0 });
  db.createDispatch({
    attemptId: 'att-1', shardId: 's-1', workflow: 'scan-static', repo: 'isokron-ai/mcp-check', workflowFile: 'scan-static.yml', ref: 'main',
    expires: T0 + 3_600_000, items: [{ run_key: key, subject: 'acme/server', subject_name: 'acme/server', fence: l.fence }], now: T0,
  });
  db.applyIdentityLookup('acme/server', { ...ok(42, 'acme/renamed'), via: 'id' }, { now: T0 + 60_000 });
  const item = db.getAttempt('att-1').items[0];
  assert.deepEqual([item.subject, item.subject_name, item.repo_id, item.name], ['acme/server', 'acme/server', 42, 'acme/renamed']);
  const r = db.recordResult({ run_key: key, attempt_id: 'att-1', fence: l.fence, verdict: 'accepted', outcome: 'accepted', now: T0 + 120_000 });
  assert.equal(r.accepted, true);
  assert.equal(db.getResult(key).subject, 'acme/server');
  db.close();
});

test('R-SUBJ-03: not found is a subject-fault skip, recorded once, kept with its id, and undone when the repository is back', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/server', kind: 'github', source: 'seed-v1', tier: 2, now: T0 });
  db.applyIdentityLookup('acme/server', ok(42, 'acme/server'), { now: T0 });
  for (const t of [T0 + 1, T0 + 2]) db.applyIdentityLookup('acme/server', { status: 'not_found', via: 'id' }, { now: t });
  let s = db.getSubject('acme/server');
  assert.deepEqual([s.id_status, s.gone_at, s.repo_id], ['not_found', new Date(T0 + 1).toISOString(), 42]);
  const nf = db.listSubjectEvents('acme/server').filter((e) => e.kind === 'not_found');
  assert.equal(nf.length, 1);
  assert.deepEqual(nf[0].detail.skip, { reason: 'repo_not_visible', fault: 'subject' });
  // An error meanwhile does not clear it.
  db.applyIdentityLookup('acme/server', { status: 'error', via: 'id' }, { now: T0 + 3 });
  assert.equal(db.getSubject('acme/server').id_status, 'not_found');
  db.applyIdentityLookup('acme/server', { ...ok(42, 'acme/server'), via: 'id' }, { now: T0 + 4 });
  s = db.getSubject('acme/server');
  assert.deepEqual([s.id_status, s.gone_at], ['ok', null]);
  assert.deepEqual(db.listSubjectEvents('acme/server').map((e) => e.kind), ['id_bound', 'not_found', 'found_again']);
  // A name that never resolved: not found too, without an id.
  db.setSubjectVersion({ id: 'gone/never', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.applyIdentityLookup('gone/never', { status: 'not_found', via: 'name' }, { now: T0 });
  assert.deepEqual([db.getSubject('gone/never').id_status, db.getSubject('gone/never').repo_id], ['not_found', null]);
  db.close();
});

test('R-SUBJ-06: an id already bound with another creation time, or a bound id answering another one, is refused: nothing bound, renamed or merged', () => {
  const db = openState(':memory:');
  for (const id of ['acme/a', 'acme/b']) db.setSubjectVersion({ id, kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.applyIdentityLookup('acme/a', ok(7, 'acme/a', '2025-01-01T00:00:00Z'), { now: T0 });
  // acme/b's name answers id 7, created at another time: id reused.
  assert.deepEqual(db.applyIdentityLookup('acme/b', ok(7, 'acme/b', '2026-06-01T00:00:00Z'), { now: T0 }).map((e) => e.kind), ['id_conflict']);
  let b = db.getSubject('acme/b');
  assert.deepEqual([b.repo_id, b.id_status, b.alias_of, b.retired_at, b.name], [null, 'conflict', null, null, 'acme/b']);
  assert.equal(db.getSubjectByRepoId(7).id, 'acme/a');
  // acme/a's own id now answers another creation time and name.
  assert.deepEqual(db.applyIdentityLookup('acme/a', { ...ok(7, 'evil/a', '2026-06-01T00:00:00Z'), via: 'id' }, { now: T0 + 1 }).map((e) => e.kind), ['id_conflict']);
  assert.deepEqual(db.applyIdentityLookup('acme/a', { ...ok(8, 'acme/a', '2025-01-01T00:00:00Z'), via: 'id' }, { now: T0 + 2 }).map((e) => e.kind), [], 'recorded once');
  const a = db.getSubject('acme/a');
  assert.deepEqual([a.repo_id, a.name, a.id_status], [7, 'acme/a', 'conflict']);
  // A malformed answer is an error, never a bind.
  b = db.applyIdentityLookup('acme/b', { status: 'ok', node: { databaseId: -1, id: 'x', nameWithOwner: 'acme/b', createdAt: 'x' }, via: 'name' }, { now: T0 + 3 });
  assert.deepEqual(b, []);
  assert.equal(db.getSubject('acme/b').repo_id, null);
  db.close();
});

test('R-SUBJ-07: two subjects that turn out to be one repository are merged into the one with the history; it is active if either was', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/old', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.recordAttempt({ subject: 'acme/old', holder: 'h', fence: 1, now: T0 }); // its history
  db.applyIdentityLookup('acme/old', ok(9, 'acme/old'), { now: T0 });
  db.retireSubjects({ sourcePrefix: 'seed-v', keep: [], now: T0 + 1 }); // a rebuilt seed lists only the new name...
  db.setSubjectVersion({ id: 'acme/new', kind: 'github', source: 'seed-v2', tier: 2, now: T0 + 1 }); // ...as a new subject
  const ev = db.applyIdentityLookup('acme/new', ok(9, 'acme/new'), { now: T0 + 2 });
  assert.deepEqual(ev.map((e) => [e.subject, e.kind]), [['acme/new', 'merged'], ['acme/old', 'renamed']]);
  const old = db.getSubject('acme/old');
  const neu = db.getSubject('acme/new');
  assert.deepEqual([old.retired_at, old.tier, old.name, old.repo_id], [null, 2, 'acme/new', 9]);
  assert.deepEqual([neu.alias_of, neu.id_status, neu.repo_id], ['acme/old', 'duplicate', null]);
  assert.ok(neu.retired_at);
  assert.deepEqual(db.identityCandidates({ now: T0 + 3, retryMs: {} }).byName.map((s) => s.id), [], 'a merged subject is not looked up again');
  db.close();
});

test('R-SUBJ-08: identityCandidates waits by the last outcome and skips retired, merged and non-GitHub subjects', () => {
  const db = openState(':memory:');
  for (const [id, kind] of [['a/new', 'github'], ['a/bound', 'github'], ['a/err', 'github'], ['npm:pkg', 'npm'], ['a/retired', 'github']]) {
    db.setSubjectVersion({ id, kind, source: 'seed-v1', tier: 3, now: T0 });
  }
  db.applyIdentityLookup('a/bound', ok(1, 'a/bound'), { now: T0 });
  db.applyIdentityLookup('a/err', { status: 'error', via: 'name' }, { now: T0 });
  db.retireSubjects({ sourcePrefix: 'seed-v', keep: ['a/new', 'a/bound', 'a/err', 'npm:pkg'], now: T0 });
  const retryMs = { none: 0, ok: DAY, error: 3_600_000, not_found: DAY, conflict: DAY };
  let c = db.identityCandidates({ now: T0 + 60_000, retryMs });
  assert.deepEqual([c.byName.map((s) => s.id), c.byId.map((s) => s.id)], [['a/new'], []]);
  c = db.identityCandidates({ now: T0 + 2 * 3_600_000, retryMs });
  assert.deepEqual([c.byName.map((s) => s.id), c.byId.map((s) => s.id)], [['a/new', 'a/err'], []]);
  c = db.identityCandidates({ now: T0 + DAY, retryMs });
  assert.deepEqual(c.byId.map((s) => s.id), ['a/bound']);
  db.close();
});

test('R-SUBJ-11: the newcomer bound first: the binding moves to the subject with the history, which stays due on its own run_keys; the newcomer becomes its alias', () => {
  const db = openState(':memory:');
  // The rebuilt seed added acme/aa-new (the new name); acme/zz-old has the results.
  db.setSubjectVersion({ id: 'acme/zz-old', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.setSubjectVersion({ id: 'acme/aa-new', kind: 'github', source: 'seed-v2', tier: 2, now: T0 + DAY });
  const key = 'd'.repeat(64);
  const l = db.acquireLease(key, 'att-1', { ttlMs: 3_600_000, now: T0 });
  db.createDispatch({
    attemptId: 'att-1', shardId: 's-1', workflow: 'scan-static', repo: 'isokron-ai/mcp-check', workflowFile: 'scan-static.yml', ref: 'main',
    expires: T0 + 3_600_000, items: [{ run_key: key, subject: 'acme/zz-old', fence: l.fence }], now: T0,
  });
  db.recordResult({ run_key: key, attempt_id: 'att-1', fence: l.fence, verdict: 'accepted', outcome: 'accepted', now: T0 + 1 });
  // Something already aliased to the newcomer follows the binding.
  db.setSubjectVersion({ id: 'acme/older-alias', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.raw.prepare("UPDATE subjects SET alias_of = 'acme/aa-new', retired_at = ? WHERE id = 'acme/older-alias'").run(new Date(T0).toISOString());

  assert.deepEqual(db.applyIdentityLookup('acme/aa-new', ok(9, 'acme/aa-new'), { now: T0 + 2 * DAY }).map((e) => e.kind), ['id_bound']);
  const ev = db.applyIdentityLookup('acme/zz-old', ok(9, 'acme/aa-new'), { now: T0 + 2 * DAY + 1 });
  assert.deepEqual(ev.map((e) => [e.subject, e.kind]), [['acme/aa-new', 'merged'], ['acme/zz-old', 'id_bound'], ['acme/zz-old', 'renamed']]);
  const old = db.getSubject('acme/zz-old');
  const neu = db.getSubject('acme/aa-new');
  assert.deepEqual([old.repo_id, old.node_id, old.repo_created_at, old.name, old.id_status, old.retired_at, old.tier], [9, 'R_test9', '2025-03-01T00:00:00Z', 'acme/aa-new', 'ok', null, 2]);
  assert.deepEqual([neu.repo_id, neu.node_id, neu.alias_of, neu.id_status], [null, null, 'acme/zz-old', 'duplicate']);
  assert.ok(neu.retired_at);
  assert.equal(db.getSubject('acme/older-alias').alias_of, 'acme/zz-old');
  assert.equal(db.getSubjectByRepoId(9).id, 'acme/zz-old');
  // Neither is first_sight: the newcomer is out, the survivor keeps its result.
  const wf = { 'scan-static': { enabled: true, runs_untrusted: false, versions: { tool: { 'mcp-check': '1' }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default' } };
  const due = dueFromState(db, { now: T0 + 2 * DAY + 2, tiers: TIERS, workflows: wf });
  assert.ok(!due.some((d) => d.subject === 'acme/aa-new'));
  // R-SUBJ-11 (the due filter on alias_of is pinned too): an alias that is somehow not retired is still not due.
  db.raw.prepare("UPDATE subjects SET retired_at = NULL WHERE id = 'acme/aa-new'").run();
  assert.ok(!dueFromState(db, { now: T0 + 2 * DAY + 3, tiers: TIERS, workflows: wf }).some((d) => d.subject === 'acme/aa-new'));
  db.close();
});

test('R-SUBJ-12: a first binding to a repository created after the subject was first seen (a newcomer squatting on its old name) is refused as id_conflict', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/server', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  const ev = db.applyIdentityLookup('acme/server', ok(77, 'acme/server', new Date(T0 + DAY).toISOString()), { now: T0 + 2 * DAY });
  assert.deepEqual(ev.map((e) => e.kind), ['id_conflict']);
  assert.equal(ev[0].detail.reason, 'created_after_first_seen');
  const s = db.getSubject('acme/server');
  assert.deepEqual([s.repo_id, s.id_status, s.name], [null, 'conflict', 'acme/server']);
  // A repository created before the subject was first seen binds.
  db.setSubjectVersion({ id: 'acme/fine', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  assert.deepEqual(db.applyIdentityLookup('acme/fine', ok(78, 'acme/fine', new Date(T0 - DAY).toISOString()), { now: T0 }).map((e) => e.kind), ['id_bound']);
  db.close();
});

test('R-SUBJ-15: the merge refuses to move a binding to a survivor first seen before the repository was created (squatter on the move branch)', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/zz-old', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.recordAttempt({ subject: 'acme/zz-old', holder: 'h', fence: 1, now: T0 }); // history: it would survive
  db.setSubjectVersion({ id: 'acme/aa-new', kind: 'github', source: 'seed-v2', tier: 3, now: T0 + 5 * DAY });
  const created = new Date(T0 + 2 * DAY).toISOString(); // after zz-old was first seen, before aa-new was
  assert.deepEqual(db.applyIdentityLookup('acme/aa-new', ok(9, 'acme/aa-new', created), { now: T0 + 6 * DAY }).map((e) => e.kind), ['id_bound']);
  const ev = db.applyIdentityLookup('acme/zz-old', ok(9, 'acme/aa-new', created), { now: T0 + 6 * DAY + 1 });
  assert.deepEqual(ev.map((e) => [e.subject, e.kind, e.detail.reason]), [['acme/zz-old', 'id_conflict', 'created_after_first_seen']]);
  assert.deepEqual([db.getSubject('acme/zz-old').repo_id, db.getSubject('acme/zz-old').id_status], [null, 'conflict']);
  assert.deepEqual([db.getSubject('acme/aa-new').repo_id, db.getSubject('acme/aa-new').alias_of], [9, null], 'nothing moved or merged');
  db.close();
});

test('R-SUBJ-15: with no history on either side the subject first seen earlier survives, even when the other was bound first', () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/zz-first', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db.setSubjectVersion({ id: 'acme/aa-later', kind: 'github', source: 'seed-v2', tier: 3, now: T0 + DAY });
  db.applyIdentityLookup('acme/aa-later', ok(9, 'acme/aa-later'), { now: T0 + 2 * DAY });
  const ev = db.applyIdentityLookup('acme/zz-first', ok(9, 'acme/aa-later'), { now: T0 + 2 * DAY + 1 });
  assert.deepEqual(ev.map((e) => [e.subject, e.kind]), [['acme/aa-later', 'merged'], ['acme/zz-first', 'id_bound'], ['acme/zz-first', 'renamed']]);
  assert.equal(db.getSubjectByRepoId(9).id, 'acme/zz-first');
  assert.equal(db.getSubject('acme/aa-later').alias_of, 'acme/zz-first');
  // And the other way round: the one first seen earlier, bound first, stays.
  const db2 = openState(':memory:');
  db2.setSubjectVersion({ id: 'acme/zz-first', kind: 'github', source: 'seed-v1', tier: 3, now: T0 });
  db2.setSubjectVersion({ id: 'acme/aa-later', kind: 'github', source: 'seed-v2', tier: 3, now: T0 + DAY });
  db2.applyIdentityLookup('acme/zz-first', ok(9, 'acme/zz-first'), { now: T0 + 2 * DAY });
  db2.applyIdentityLookup('acme/aa-later', ok(9, 'acme/zz-first'), { now: T0 + 2 * DAY + 1 });
  assert.equal(db2.getSubjectByRepoId(9).id, 'acme/zz-first');
  assert.equal(db2.getSubject('acme/aa-later').alias_of, 'acme/zz-first');
  db.close();
  db2.close();
});
