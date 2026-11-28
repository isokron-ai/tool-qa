// Leads in the state store (schema v12, StateDb.noteLeads) and their rules
// (state/leads.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { openState, SCHEMA_VERSION } from '../state/db.mjs';
import { dueFromState } from '../pump/due.mjs';
import {
  CLEAN_RECHECKS_TO_CLOSE, filingDecision, flakeStats, leadsMode, loadRouting, pushLog, repoFor, RECHECK_MAX_ATTEMPTS,
} from '../state/leads.mjs';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tiers = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8'));

/** A lead as state/fingerprint.mjs leadFailures() gives it. */
export const lead = (n = 1, over = {}) => ({
  fingerprint: sha(`fp-${n}`).slice(0, 12), tool: 'mcp-check', lane: 'scan-static', component: 'static', oracle: 'scan-static', class: 'no_tools_found',
  idiom: 'none/repo:python', layout: 'server_json:1;via:github', signature: `class=no_tools_found;detail=-;error=-;list_error=-;http=-;fault=tool;retryable=false;n=${n}`,
  partial: false, fault: 'tool', versions: ['1.3.1'], ...over,
});

let seq = 0;
/** An accepted result of `workflow` for `subject` from worker run `runId`, through the real lease, dispatch and result path. */
export function accept(db, { subject = 'acme/a', workflow = 'scan-static', runId = 100 + seq, failures = [], coverage = null, now = T0, completedAt = null } = {}) {
  const key = sha(`run-${++seq}`);
  const att = `att-${seq}`;
  const lease = db.acquireLease(key, att, { ttlMs: DAY, now });
  db.recordRunKey(key, { subject, workflow, fields: { n: seq }, now });
  db.createDispatch({ attemptId: att, shardId: 's', workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: key, subject, fence: lease.fence }], now });
  if (runId !== null) db.setDispatchRun(att, { runId, runUrl: null, correlatedBy: 'test', now });
  const cov = coverage ?? (failures?.length ? 'unassessed_tool' : 'assessed');
  return db.recordResult({
    run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: cov === 'assessed' ? null : 'tool', coverage: cov,
    ...(failures === null ? {} : { failures }), ...(completedAt ? { completedAt } : {}), now: now + 1,
  });
}
const seed = (db, ids, tier = 1) => { for (const id of ids) db.setSubjectVersion({ id, kind: 'repo', source: 'test', tier, sha: 'a'.repeat(40), now: T0 - 10 * DAY }); };
const one = (db, fp) => db.listLeads().find((l) => l.fingerprint === fp);

test('R-LEAD-02: the v12 migration of a v11 state keeps every row and the due list; it adds empty leads tables', () => {
  const db = openState(':memory:');
  seed(db, ['acme/a', 'acme/b']);
  const wf = { 'scan-static': { enabled: true, repo: 'o/r', file: 'f.yml', ref: 'main', versions: { tool: { 'mcp-check': '1' } }, image_digest: null, settings_state: 'default' } };
  for (const d of dueFromState(db, { tiers, workflows: wf, now: T0 })) accept(db, { subject: d.subject, failures: null });
  const dueBefore = dueFromState(db, { tiers, workflows: wf, now: T0 + 40 * DAY }).map((d) => [d.subject, d.reasons, d.priority]);
  const results = db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  db.raw.exec('DROP TABLE write_backends; DROP TABLE lead_subjects; DROP TABLE leads; ALTER TABLE results DROP COLUMN skip_codes; PRAGMA user_version = 11');
  assert.equal(db.schemaVersion(), 11);
  assert.equal(db.migrate(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 14);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, results);
  assert.deepEqual(dueFromState(db, { tiers, workflows: wf, now: T0 + 40 * DAY }).map((d) => [d.subject, d.reasons, d.priority]), dueBefore);
  assert.deepEqual(db.listLeads(), []);
  assert.equal(db.migrate(), SCHEMA_VERSION, 'a second migrate is a no-op');
});

test('R-LEAD-03: with the pipeline off (no failures passed) nothing is kept; the switch is off unless exactly dry-run, recheck or true', () => {
  const db = openState(':memory:');
  accept(db, { failures: null, coverage: 'unassessed_tool' });
  assert.deepEqual(db.listLeads(), []);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM lead_subjects').get().n, 0);
  for (const v of [undefined, '', 'false', 'TRUE', '1', 'on', 'yes', 'dry_run']) assert.equal(leadsMode({ LANE_LEADS_ENABLED: v }), 'off', String(v));
  assert.equal(leadsMode({ LANE_LEADS_ENABLED: 'dry-run' }), 'dry-run');
  assert.equal(leadsMode({ LANE_LEADS_ENABLED: 'recheck' }), 'recheck');
  assert.equal(leadsMode({ LANE_LEADS_ENABLED: 'true' }), 'on');
});

test('R-LEAD-04: a lead opens on first sight and is reproduced only when its subject and lane show it again from another worker run', () => {
  const db = openState(':memory:');
  const L = lead(1);
  accept(db, { failures: [L], runId: 500, now: T0 });
  let row = one(db, L.fingerprint);
  assert.deepEqual([row.status, row.sightings, row.reproduced_at, row.repo, row.recheck_subject, row.recheck_lane], ['open', 1, null, 'isokron-ai/mcp-check', 'acme/a', 'scan-static']);
  // Another subject in another run: not a re-run of the same pair.
  accept(db, { subject: 'acme/b', failures: [L], runId: 501, now: T0 + HOUR });
  assert.equal(one(db, L.fingerprint).reproduced_at, null);
  // The same pair again, in the same worker run (a duplicate report of it): not a re-run either.
  db.raw.prepare('UPDATE lead_subjects SET last_checked = ? WHERE subject = ?').run(new Date(T0).toISOString(), 'acme/a');
  accept(db, { failures: [L], runId: 500, now: T0 + 2 * HOUR });
  assert.equal(one(db, L.fingerprint).reproduced_at, null);
  // A re-run of the same pair on another runner shows it again.
  accept(db, { failures: [L], runId: 502, now: T0 + 3 * HOUR });
  row = one(db, L.fingerprint);
  assert.equal(row.reproduced_run_id, 502);
  assert.equal(row.sightings, 4);
  const pairs = db.leadSubjects(L.fingerprint);
  assert.deepEqual(pairs.map((p) => [p.subject, p.current, p.seen]), [['acme/a', 1, 3], ['acme/b', 1, 1]]);
});

test('R-LEAD-05: only an assessed result is a clean re-check; three with no subject carrying it close the lead; it reopens (to filed with an issue) when it comes back', () => {
  const db = openState(':memory:');
  const L = lead(2);
  let t = T0;
  accept(db, { failures: [L], runId: 1, now: t });
  accept(db, { subject: 'acme/b', failures: [L], runId: 2, now: (t += HOUR) });
  // A result that skipped a stage says nothing: not clean.
  accept(db, { failures: [], coverage: 'unassessed_infra', runId: 3, now: (t += HOUR) });
  assert.equal(one(db, L.fingerprint).clean_rechecks, 0);
  assert.equal(db.leadSubjects(L.fingerprint)[0].current, 1);
  // Clean on acme/a three times, but acme/b still carries it: open.
  for (let r = 4; r < 4 + CLEAN_RECHECKS_TO_CLOSE; r++) accept(db, { failures: [], runId: r, now: (t += HOUR) });
  assert.equal(one(db, L.fingerprint).status, 'open');
  assert.equal(one(db, L.fingerprint).clean_rechecks, CLEAN_RECHECKS_TO_CLOSE);
  // acme/b clean as well: no subject carries it, and there are enough clean re-checks.
  accept(db, { subject: 'acme/b', failures: [], runId: 20, now: (t += HOUR) });
  let row = one(db, L.fingerprint);
  assert.deepEqual([row.status, row.close_reason, row.needs_sync], ['closed', 'clean_rechecks', 0]);
  // It comes back: reopened, clean count starts over.
  db.raw.prepare("UPDATE leads SET issue_number = 7, issue_state = 'closed' WHERE fingerprint = ?").run(L.fingerprint);
  accept(db, { failures: [L], runId: 21, now: (t += HOUR) });
  row = one(db, L.fingerprint);
  assert.deepEqual([row.status, row.reopened, row.clean_rechecks, row.needs_sync, row.closed_at], ['filed', 1, 0, 1, null]);
});

test('R-LEAD-05: a filed lead that closes asks for its issue to be closed; one closed with no issue asks for nothing', () => {
  const db = openState(':memory:');
  const L = lead(3);
  accept(db, { failures: [L], runId: 1, now: T0 });
  db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = 9, issue_state = 'open' WHERE fingerprint = ?").run(L.fingerprint);
  for (let r = 2; r < 2 + CLEAN_RECHECKS_TO_CLOSE; r++) accept(db, { failures: [], runId: r, now: T0 + r * HOUR });
  const row = one(db, L.fingerprint);
  assert.deepEqual([row.status, row.needs_sync], ['closed', 1]);
});

test('R-LEAD-06: a late result (observed before the pair\'s newest) changes no lead', () => {
  const db = openState(':memory:');
  const L = lead(4);
  accept(db, { failures: [L], runId: 1, now: T0 + 5 * HOUR });
  const before = JSON.stringify([db.listLeads(), db.leadSubjects(L.fingerprint)]);
  // Its run completed long before the newest result of the pair was observed.
  accept(db, { failures: [], runId: 2, now: T0 + 6 * HOUR, completedAt: T0 });
  assert.equal(JSON.stringify([db.listLeads(), db.leadSubjects(L.fingerprint)]), before);
});

test('R-LEAD-08: a clean re-check of the re-check pair moves the re-check to another pair that still carries it; after the attempts it stops', () => {
  const db = openState(':memory:');
  const L = lead(5);
  let t = T0;
  accept(db, { subject: 'acme/a', failures: [L], runId: 1, now: t });
  accept(db, { subject: 'acme/b', failures: [L], runId: 2, now: (t += HOUR) });
  accept(db, { subject: 'acme/a', failures: [], runId: 3, now: (t += HOUR) });
  let row = one(db, L.fingerprint);
  assert.deepEqual([row.recheck_subject, row.recheck_attempts], ['acme/b', 1]);
  accept(db, { subject: 'acme/b', failures: [], runId: 4, now: (t += HOUR) });
  row = one(db, L.fingerprint);
  assert.deepEqual([row.recheck_subject, row.recheck_attempts, row.reproduced_at], [null, 2, null]);
  assert.ok(RECHECK_MAX_ATTEMPTS >= 2);
});

test('R-LEAD-09: the rules: an infra lead waits 3 days and must still be happening; a flaky one is filed at 10% or more over 14 days; a reproduced one at once', () => {
  const base = { status: 'open', issue_number: null, fault: 'tool', first_seen: new Date(T0).toISOString(), last_seen: new Date(T0).toISOString(), sightings: 2, reproduced_at: null, recheck_subject: 'a', recheck_attempts: 0 };
  const now = new Date(T0 + HOUR).toISOString();
  assert.deepEqual(filingDecision(base, { now }), { file: false, reason: 'recheck_pending' });
  assert.deepEqual(filingDecision({ ...base, reproduced_at: now }, { now }), { file: true, reason: 'reproduced' });
  assert.equal(filingDecision({ ...base, status: 'filed' }, { now }), null);
  assert.deepEqual(filingDecision({ ...base, recheck_subject: null, recheck_attempts: RECHECK_MAX_ATTEMPTS }, { now }), { file: false, reason: 'not_reproduced' });
  const infra = { ...base, fault: 'infra' };
  assert.equal(filingDecision(infra, { now }).reason, 'infra_under_3_days');
  const later = new Date(T0 + 3 * DAY + HOUR).toISOString();
  assert.equal(filingDecision(infra, { now: later }).reason, 'infra_not_recent');
  assert.deepEqual(filingDecision({ ...infra, last_seen: later }, { now: later }), { file: true, reason: 'infra_3_days' });
  // Flaky: it went away and came back on the same pair.
  const iso = (h) => new Date(T0 + h * HOUR).toISOString();
  const low = [{ log: [[iso(0), 1], [iso(1), 0], ...Array.from({ length: 20 }, (_, i) => [iso(2 + i), 0]), [iso(30), 1]] }];
  const st = flakeStats(low, iso(40));
  assert.equal(st.flaky, true);
  assert.ok(st.rate < 0.10, String(st.rate));
  assert.deepEqual(filingDecision({ ...base, reproduced_at: iso(30) }, { pairs: low, now: iso(40) }), { file: false, reason: 'flake_under_10pct' });
  const high = [{ log: [[iso(0), 1], [iso(1), 0], [iso(2), 1], [iso(3), 0]] }];
  assert.deepEqual(filingDecision(base, { pairs: high, now: iso(40) }), { file: true, reason: 'flake_rate' });
  // Old entries fall out of the window.
  assert.equal(flakeStats(high, new Date(T0 + 15 * DAY).toISOString()).total, 0);
  assert.equal(pushLog([], iso(0), true).length, 1);
});

test('R-LEAD-10: a lead goes to one of our repositories: by lane and component, by lane, else the default; never anywhere else', () => {
  const r = loadRouting();
  assert.equal(repoFor({ lane: 'live-probe', component: 'start' }), 'isokron-ai/mcp-surface-corpus');
  assert.equal(repoFor({ lane: 'live-probe', component: 'resolve' }), 'isokron-ai/mcp-check');
  assert.equal(repoFor({ lane: 'writecheck', component: 'install' }), 'isokron-ai/mcp-writecheck-action');
  assert.equal(repoFor({ lane: '<other>', component: 'x' }), r.default);
  assert.equal(repoFor({ lane: 'scan-static', component: 'static' }, { ...r, lanes: { 'scan-static': 'someone/else' } }), r.default, 'a route outside repos is refused');
  for (const repo of r.repos) assert.match(repo, /^isokron-ai\/[a-z0-9-]+$/);
});

test('R-LEAD-13: reproduced means a re-run after a run that carried it; a flap after clean runs is not, and a reopened lead with no issue is re-checked again', () => {
  const db = openState(':memory:');
  const L = lead(6);
  let t = T0;
  accept(db, { failures: [L], runId: 1, now: t });
  for (let r = 2; r < 2 + CLEAN_RECHECKS_TO_CLOSE; r++) accept(db, { failures: [], runId: r, now: (t += HOUR) });
  let row = one(db, L.fingerprint);
  assert.equal(row.status, 'closed');
  // It comes back once: reopened, not reproduced (nothing carried it since run 1 but this run), and re-checked from this pair.
  accept(db, { failures: [L], runId: 10, now: (t += HOUR) });
  row = one(db, L.fingerprint);
  assert.deepEqual([row.status, row.reproduced_at, row.recheck_attempts, row.recheck_subject], ['open', null, 0, 'acme/a']);
  // The re-check shows it again from another run: now reproduced.
  accept(db, { failures: [L], runId: 11, now: (t += HOUR) });
  assert.equal(one(db, L.fingerprint).reproduced_run_id, 11);

  // A lead reproduced before it closed loses that on reopen when it has no issue.
  const M = lead(7);
  accept(db, { subject: 'acme/m', failures: [M], runId: 20, now: (t += HOUR) });
  accept(db, { subject: 'acme/m', failures: [M], runId: 21, now: (t += HOUR) });
  assert.ok(one(db, M.fingerprint).reproduced_at);
  for (let r = 22; r < 22 + CLEAN_RECHECKS_TO_CLOSE; r++) accept(db, { subject: 'acme/m', failures: [], runId: r, now: (t += HOUR) });
  accept(db, { subject: 'acme/m', failures: [M], runId: 30, now: (t += HOUR) });
  row = one(db, M.fingerprint);
  assert.deepEqual([row.status, row.reproduced_at], ['open', null]);
  assert.equal(filingDecision(row, { pairs: [], now: new Date(t).toISOString() }).file, false);
});

test('R-LEAD-21: a pair whose latest result fails at the same stage with another cause no longer carries the old lead (it is no clean re-check); a skip at another stage changes nothing', () => {
  const db = openState(':memory:');
  const A = lead(60, { component: 'start', signature: 'class=timeout_start;detail=start_env_limited' });
  const B = lead(61, { component: 'start', signature: 'class=timeout_start;detail=start_dependency_drift' });
  const C = lead(62, { component: 'resolve', signature: 'class=no_runnable_artifact;detail=no_package' });
  accept(db, { failures: [A], runId: 1, now: T0 });
  accept(db, { failures: [C], runId: 2, now: T0 + HOUR });
  let pa = db.leadSubjects(A.fingerprint)[0];
  assert.equal(pa.current, 1, 'a failure at another stage (resolve) says nothing about start');
  accept(db, { failures: [B], runId: 3, now: T0 + 2 * HOUR });
  pa = db.leadSubjects(A.fingerprint)[0];
  assert.deepEqual([pa.current, pa.clean], [0, 0], 'replaced at the same stage: not current, not clean');
  assert.equal(db.listLeads().find((l) => l.fingerprint === A.fingerprint).clean_rechecks, 0);
  assert.equal(db.leadSubjects(B.fingerprint)[0].current, 1);
});

test('R-LEAD-36: a lead that cannot be folded never costs its result: the fold rolls back alone, is counted in kv leads.fold_failures and logged', () => {
  const db = openState(':memory:');
  const lines = [];
  db.log = (l) => lines.push(l);
  const bad = lead(90, { class: null }); // NOT NULL on leads.class
  const r = accept(db, { failures: [lead(91), bad], runId: 1, now: T0 });
  assert.equal(r.accepted, true, 'the result is accepted');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, 1, 'and recorded');
  assert.deepEqual(db.listLeads(), [], 'the whole fold rolled back, the good lead with it (it is folded with the next result)');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM lead_subjects').get().n, 0);
  assert.equal(db.getKv('leads.fold_failures').count, 1);
  assert.ok(lines.some((l) => /could not be folded \(the result is kept\)/.test(l)));
  // The next good result folds as usual.
  accept(db, { failures: [lead(91)], runId: 2, now: T0 + HOUR });
  assert.equal(db.listLeads().length, 1);
});

test('R-LEAD-47: a fold failure is logged and noted by its error name only: no message, which could quote a value, reaches the public pump log or the health issue', () => {
  const db = openState(':memory:');
  const lines = [];
  db.log = (l) => lines.push(l);
  accept(db, { failures: [lead(92, { class: null })], runId: 1, now: T0 });
  const ff = db.getKv('leads.fold_failures');
  assert.match(ff.last_error, /^[A-Za-z]+( [A-Z_]+)?$/, ff.last_error);
  for (const text of [ff.last_error, ...lines]) assert.ok(!/NOT NULL|leads\.class|constraint/i.test(text), text);
});
