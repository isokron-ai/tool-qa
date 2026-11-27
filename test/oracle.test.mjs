// Oracle disagreement (loop upgrade #7): state/oracle.mjs, the state store's
// disagreement record, and the facts ingest reads out of a bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { openState, SCHEMA_VERSION } from '../state/db.mjs';
import { deriveDisagreements, foldDisagreement, oracleFacts, oracleFactsFromFiles, ORACLE_BUDGET_MAX, ORACLE_MAX_UNCHANGED, ORACLE_UNVERSIONED_WINDOW_MS } from '../state/oracle.mjs';
import { computeDue, dueFromState, gapBoostCap, NO_HOOKS, oracleBoost, runKey, runKeyFields } from '../pump/due.mjs';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const DAY = 86_400_000;
const tiers = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const H1 = sha('tools-1');
export const H2 = sha('tools-2');

export const staticFacts = (hash = H1, count = 3, over = {}) => ({ lane: 'scan-static', tool_list_sha256: hash, tool_count: count, complete: true, ...over });
export const liveFacts = (over = {}) => ({ lane: 'live-probe', tool_list_sha256: H1, tool_count: 3, sdk: [], conformance_failed: 0, worker: [], ...over });
/** deriveDisagreements over facts read at the same time (the unversioned window, R-ORD-16, needs an observation time). */
const dd = (a) => deriveDisagreements(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v && typeof v === 'object' ? { at: T0, ...v } : v])));
const sdk = (client, over = {}) => ({ client, outcome: 'listed', tool_count: 3, catalog_vs_reader: 'same', ...over });

test('R-ORD-01: the kinds: a different count is tool_count, an SDK client with other definitions schema, a failed client protocol, a worker class its kind', () => {
  assert.deepEqual(dd({ static: staticFacts(H1, 3), live: liveFacts() }).kinds, []);
  assert.deepEqual(dd({ static: staticFacts(H2, 2), live: liveFacts() }).kinds, [{ kind: 'tool_count', oracles: ['live', 'reader'] }]);
  const d = dd({
    live: liveFacts({
      sdk: [sdk('ts1'), sdk('py', { catalog_vs_reader: 'different' }), sdk('go', { tool_count: 4 }), sdk('ts2', { outcome: 'list_failed', tool_count: null }),
        sdk('old', { catalog_vs_reader: 'same_but_annotation_defaults' }), sdk('slow', { outcome: 'timeout', tool_count: null })],
      worker: [{ class: 'D7', kind: null, oracles: ['lint', 'conformance'], attribution: null }, { class: 'D4', kind: null, oracles: [], attribution: null }, { class: 'X9', kind: null, oracles: [], attribution: null }],
    }),
  });
  assert.deepEqual(d.kinds.map((k) => `${k.kind}:${k.oracles.join('+')}`), [
    'conformance:conformance+lint', 'protocol:live+sdk:ts2', 'schema:reader+sdk:py', 'schema:worker', 'tool_count:live+sdk:go',
  ]);
  assert.match(d.signature, /^[0-9a-f]{64}$/);
  // Only one lane, or no hash on a side: nothing to compare.
  assert.deepEqual(dd({ static: staticFacts(H2) }).kinds, []);
  // Counts moving does not change the signature; the kinds and oracles do.
  const a = dd({ static: staticFacts(H2, 2), live: liveFacts() });
  const b = dd({ static: staticFacts(H2, 5), live: liveFacts({ tool_count: 9 }) });
  assert.equal(a.signature, b.signature);
});

test('R-ORD-01: oracleFacts reads the two lanes, bounds what it keeps and returns null for a lane or result without facts', () => {
  assert.equal(oracleFacts('meta-github', () => null, null), null);
  assert.equal(oracleFacts('scan-static', () => null, { status: 'skipped' }), null);
  assert.equal(oracleFacts('scan-static', () => null, { status: 'graded', catalog_hash: 'nope' }), null);
  assert.deepEqual(oracleFacts('scan-static', () => null, { status: 'graded', catalog_hash: H1, tool_count: 3 }), staticFacts(H1, 3, { complete: false }), 'no list read: not complete');
  const list = (over) => ({ status: 'graded', catalog_hash: H1, tool_count: 3, list: { fidelity: 'exact', approximate: false, tools_left_out: 0, unresolved_names: 0, registration_not_seen: 0, ...over } });
  assert.equal(oracleFacts('scan-static', () => null, list({})).complete, true);
  for (const bad of [{ approximate: true }, { fidelity: 'names' }, { tools_left_out: 1 }, { unresolved_names: 2 }, { registration_not_seen: 1 }, { listing_truncated: true }]) assert.equal(oracleFacts('scan-static', () => null, list(bad)).complete, false, JSON.stringify(bad));
  assert.equal(oracleFacts('live-probe', () => null, null), null);
  const many = Array.from({ length: 40 }, (_, i) => ({ client: `c${i}`, outcome: 'listed', tool_count: 1, catalog_vs_reader: 'same', junk: 'x'.repeat(1000) }));
  const f = oracleFacts('live-probe', (k) => ({ tool_list_sha256: H1, tool_count: 3, sdk_client_results: many, conformance_checks: [{ status: 'fail', scored: true }, { status: 'fail', scored: false }, { status: 'pass' }] })[k] ?? null);
  assert.equal(f.sdk.length, 16);
  assert.equal(f.conformance_failed, 1);
  assert.ok(!JSON.stringify(f).includes('xxxx'), 'free text of an entry is not kept');
});

test('R-ORD-03: foldDisagreement: open, unchanged re-checks settle it, a change starts over, agreement clears it, a new one reopens', () => {
  const sig = (s) => ({ kinds: [{ kind: 'tool_set', oracles: [] }], signature: s });
  let row = null;
  const step = (now, over = {}) => { const r = foldDisagreement(row, now, over); row = r.status === null ? null : { ...r, signature: now.signature ?? row?.signature }; return r; };
  assert.deepEqual(step({ kinds: [], signature: null }), { status: null, unchanged_rechecks: 0, reason: null });
  assert.equal(step(sig('a')).status, 'open');
  for (let i = 1; i < ORACLE_MAX_UNCHANGED; i++) assert.deepEqual([step(sig('a')).status, row.unchanged_rechecks], ['open', i]);
  assert.deepEqual(step(sig('a')), { status: 'settled', unchanged_rechecks: ORACLE_MAX_UNCHANGED, reason: 'unchanged_rechecks' });
  assert.equal(step(sig('a')).status, 'settled', 'settled stays settled while it is unchanged');
  assert.deepEqual([step(sig('b')).status, row.unchanged_rechecks], ['open', 0]);
  assert.deepEqual(step({ kinds: [], signature: null }), { status: 'cleared', unchanged_rechecks: 0, reason: 'oracles_agree' });
  assert.equal(step({ kinds: [], signature: null }).status, 'cleared');
  assert.equal(step(sig('b')).status, 'open', 'a cleared one reopens when the oracles disagree again');
  assert.equal(foldDisagreement({ status: 'open', signature: 'a', unchanged_rechecks: 0 }, sig('a'), { maxUnchanged: 1 }).status, 'settled');
});

let seq = 0;
/** Record an accepted result of `workflow` for `subject` carrying oracle facts, through the real lease, dispatch and result path. */
export function accept(db, subject, workflow, oracle, now, extra = {}, fields = {}) {
  const key = sha(`run-${++seq}`);
  const att = `att-${seq}`;
  const lease = db.acquireLease(key, att, { ttlMs: DAY, now });
  db.recordRunKey(key, { subject, workflow, fields: { n: seq, ...fields }, now });
  db.createDispatch({ attemptId: att, shardId: 's', workflow, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: key, subject, fence: lease.fence }], now });
  return db.recordResult({ run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', ...(oracle ? { oracle } : {}), ...extra, now: now + 1 });
}
/** One check cycle: both oracle lanes report. */
export function cycle(db, subject, t, st, lv = liveFacts(), fields = {}) {
  accept(db, subject, 'scan-static', st, t, {}, fields);
  accept(db, subject, 'live-probe', lv, t + 1, {}, fields);
}
export function seed(db, ids, tier = 1) {
  for (const id of ids) db.setSubjectVersion({ id, kind: 'repo', source: 'test', tier, sha: 'a'.repeat(40), now: T0 - 10 * DAY });
}

test('R-ORD-03: the store derives one record per subject from the latest facts of both lanes; settles after the same disagreement survives the re-checks; clears on agreement', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a']);
  let t = T0;
  accept(db, 'repo:a', 'scan-static', staticFacts(H2, 2), t += 1000);
  assert.deepEqual(db.listOracleDisagreements(), [], 'one lane alone has nothing to disagree with');
  accept(db, 'repo:a', 'live-probe', liveFacts(), t += 1000);
  let [row] = db.listOracleDisagreements();
  assert.deepEqual([row.subject, row.status, row.unchanged_rechecks, row.kinds], ['repo:a', 'open', 0, [{ kind: 'tool_count', oracles: ['live', 'reader'] }]]);
  const opened = row.opened_at;
  for (let i = 1; i <= ORACLE_MAX_UNCHANGED; i++) cycle(db, 'repo:a', t += 1000, staticFacts(H2, 2));
  [row] = db.listOracleDisagreements();
  assert.deepEqual([row.status, row.reason, row.opened_at], ['settled', 'unchanged_rechecks', opened]);
  assert.deepEqual(db.listOracleDisagreements({ status: 'open' }), []);
  // The reader is fixed: the oracles agree, the record clears and keeps its history.
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 3), t += 1000);
  [row] = db.listOracleDisagreements();
  assert.deepEqual([row.status, row.reason], ['cleared', 'oracles_agree']);
  assert.ok(row.cleared_at);
  const clearedAt = row.cleared_at;
  assert.ok(clearedAt);
  // It comes back open when they disagree again, as a new episode.
  accept(db, 'repo:a', 'scan-static', staticFacts(H2, 4), t += 1000);
  [row] = db.listOracleDisagreements();
  // Opened (1) + 5 cycles + this reopening are 7 in the budget window: settled by the budget (R-ORD-13).
  assert.deepEqual([row.status, row.reason, row.cleared_at, row.kinds[0].kind], ['settled', 'recheck_budget', null, 'tool_count']);
  assert.ok(row.opened_at > opened);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM oracle_facts').get().n, 2);
  db.close();
});

test('R-ORD-04: a disagreement is about our tool: it never writes the result fault or coverage, and server-side evidence opens nothing', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a', 'repo:b']);
  let t = T0;
  accept(db, 'repo:a', 'scan-static', staticFacts(H2, 2), t += 1000, { fault: null, coverage: 'assessed' });
  accept(db, 'repo:a', 'live-probe', liveFacts(), t += 1000, { fault: null, coverage: 'assessed' });
  assert.equal(db.listOracleDisagreements({ status: 'open' }).length, 1);
  for (const r of db.listResults().filter((x) => x.subject === 'repo:a')) assert.deepEqual([r.fault, r.coverage], [null, 'assessed']);
  // A worker entry that says the server is wrong, and a failed conformance check with every client agreeing, open nothing.
  accept(db, 'repo:b', 'scan-static', staticFacts(H1, 3), t += 1000);
  accept(db, 'repo:b', 'live-probe', liveFacts({ conformance_failed: 2, worker: [{ class: 'D4', kind: 'schema', oracles: ['sdk:ts1', 'reader'], attribution: 'server' }], sdk: [sdk('ts1')] }), t += 1000);
  assert.deepEqual(db.listOracleDisagreements().filter((r) => r.subject === 'repo:b'), []);
  const d = deriveDisagreements({ static: staticFacts(H1, 3), live: liveFacts({ conformance_failed: 2, worker: [{ class: 'D4', kind: 'schema', oracles: [], attribution: 'server' }] }) });
  assert.deepEqual([d.kinds, d.server_side, d.signature], [[], ['conformance_fail', 'schema'], null]);
  // The lint-against-conformance lead of the worker is a disagreement (about our lint), and the check failure is not counted twice.
  const lead = deriveDisagreements({ live: liveFacts({ conformance_failed: 1, worker: [{ class: 'D7', kind: null, oracles: ['lint', 'conformance'], attribution: null }] }) });
  assert.deepEqual([lead.kinds.length, lead.server_side], [1, []]);
  db.close();
});

test('R-ORD-07: ingest reads the facts out of the bundle files, never throws on bad input, and a rejected or fact-less result notes nothing', () => {
  const ndjson = (rows) => Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'));
  const live = new Map([
    ['observations/protocol.ndjson', ndjson([{ field: 'tool_count', value: 3 }, { field: 'tool_list_sha256', value: H1 }, { field: 'sdk_client_results', value: [sdk('ts1', { catalog_vs_reader: 'different' })] }, { field: 'conformance_checks', value: [{ status: 'fail', scored: true }] }])],
  ]);
  const f = oracleFactsFromFiles('live-probe', live);
  assert.deepEqual([f.tool_list_sha256, f.tool_count, f.sdk[0].catalog_vs_reader, f.conformance_failed], [H1, 3, 'different', 1]);
  const st = new Map([['results/scan-static.json', Buffer.from(JSON.stringify({ status: 'graded', catalog_hash: H2, tool_count: 4 }))]]);
  assert.deepEqual(oracleFactsFromFiles('scan-static', st), staticFacts(H2, 4, { complete: false }));
  assert.equal(oracleFactsFromFiles('meta-github', live), null);
  assert.equal(oracleFactsFromFiles('scan-static', new Map([['results/scan-static.json', Buffer.from('{not json')]])), null);
  assert.equal(oracleFactsFromFiles('live-probe', new Map([['observations/x.ndjson', Buffer.from('not json\n{"field":')]])), null);
  assert.equal(oracleFactsFromFiles('live-probe', null), null);

  const db = openState(':memory:');
  seed(db, ['repo:a']);
  accept(db, 'repo:a', 'scan-static', null, T0 + 1000);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM oracle_facts').get().n, 0);
  // A rejected result (verdict rejected) never writes facts.
  const key = sha('rej');
  const lease = db.acquireLease(key, 'att-rej', { ttlMs: DAY, now: T0 });
  db.recordRunKey(key, { subject: 'repo:a', workflow: 'live-probe', fields: { n: 0 }, now: T0 });
  db.createDispatch({ attemptId: 'att-rej', shardId: 's', workflow: 'live-probe', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: T0 + DAY, items: [{ run_key: key, subject: 'repo:a', fence: lease.fence }], now: T0 });
  db.recordResult({ run_key: key, attempt_id: 'att-rej', fence: lease.fence, verdict: 'rejected', outcome: 'rejected', oracle: liveFacts(), now: T0 + 5 });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM oracle_facts').get().n, 0);
  db.close();
});

test('R-ORD-08: the v9 migration of a v8 state keeps every row and changes no priority; the due list reads a state from before v9', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a', 'repo:b']);
  const wf = { 'live-probe': { enabled: true, repo: 'o/r', file: 'f.yml', ref: 'main', versions: { tool: { 'mcp-check': '1' } }, image_digest: null, settings_state: 'default' } };
  const due = dueFromState(db, { tiers, workflows: wf, now: T0 });
  for (const d of due) accept(db, d.subject, d.workflow, null, T0 + 1000);
  const before = db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  const dueBefore = dueFromState(db, { tiers, workflows: wf, now: T0 + 40 * DAY }).map((d) => [d.subject, d.reasons, d.priority]);
  db.raw.exec('DROP TABLE lead_subjects; DROP TABLE leads; DROP TABLE events; DROP TABLE oracle_facts; DROP TABLE oracle_disagreements; PRAGMA user_version = 8');
  const v8 = db;
  assert.equal(v8.schemaVersion(), 8);
  assert.deepEqual(dueFromState(v8, { tiers, workflows: wf, now: T0 + 40 * DAY }).map((d) => [d.subject, d.reasons, d.priority]), dueBefore, 'a v8 state is read as before');
  assert.equal(v8.migrate(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 11);
  assert.equal(v8.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, before);
  assert.deepEqual(dueFromState(v8, { tiers, workflows: wf, now: T0 + 40 * DAY }).map((d) => [d.subject, d.reasons, d.priority]), dueBefore, 'nothing became due or moved');
  assert.deepEqual(v8.listOracleDisagreements(), []);
  assert.equal(v8.migrate(), SCHEMA_VERSION);
});

const wfOf = (name = 'live-probe', over = {}) => ({
  enabled: true, repo: 'o/r', file: `${name}.yml`, ref: 'main', versions: { tool: { 'mcp-check': '1' } }, image_digest: null, settings_state: 'default', ...over,
});
const workflows = { 'live-probe': wfOf('live-probe'), 'scan-static': wfOf('scan-static'), 'meta-github': wfOf('meta-github') };
const openRow = { status: 'open', kinds: [{ kind: 'tool_set', oracles: ['live', 'reader'] }] };

test('R-ORD-02: the oracle boost is its share of the tier weight, taken after the coverage-gap boost from the same cap, so both together stay under the next tier up', () => {
  assert.equal(tiers.priority.oracle_disagreement_share, 0.25);
  const ctx = (tier, over = {}) => ({ tiers, tier, oracle: openRow, gapBoost: 0, ...over });
  assert.equal(oracleBoost({}, 'live-probe', ctx('T0')), 25);
  assert.equal(oracleBoost({}, 'live-probe', ctx('T1')), 15);
  assert.equal(oracleBoost({}, 'live-probe', ctx('T2')), 10);
  // The coverage gap has the first claim: what is left of the cap (T1: 39 - 30) is all the oracle boost can add.
  assert.equal(gapBoostCap(tiers, 'T1'), 39);
  assert.equal(oracleBoost({}, 'live-probe', ctx('T1', { gapBoost: 30 })), 9);
  assert.equal(oracleBoost({}, 'live-probe', ctx('T1', { gapBoost: 39 })), 0);
  assert.equal(oracleBoost({}, 'live-probe', ctx('T1', { gapBoost: 45 })), 0, 'never negative');
  // Only an open record, and only the oracle lanes.
  for (const bad of [{ oracle: null }, { oracle: { ...openRow, status: 'settled' } }, { oracle: { ...openRow, status: 'cleared' } }]) assert.equal(oracleBoost({}, 'live-probe', ctx('T1', bad)), 0);
  assert.equal(oracleBoost({}, 'meta-github', ctx('T1')), 0);
  // For every adjacent tier and any shares, both boosts together keep a pair strictly below a bare pair of the tier above.
  const names = Object.keys(tiers.weights).sort((a, b) => tiers.weights[b] - tiers.weights[a]);
  for (const share of [0.25, 0.5, 1, 5]) {
    const t = { ...tiers, priority: { ...tiers.priority, oracle_disagreement_share: share } };
    for (let i = 1; i < names.length; i++) {
      for (const gap of [0, 1, tiers.weights[names[i]] * 0.5, 1000]) {
        const total = Math.min(gap, gapBoostCap(t, names[i])) + oracleBoost({}, 'live-probe', { tiers: t, tier: names[i], oracle: openRow, gapBoost: Math.min(gap, gapBoostCap(t, names[i])) });
        assert.ok(t.weights[names[i]] + total < t.weights[names[i - 1]], `${names[i]} gap ${gap} share ${share}: ${total}`);
      }
    }
  }
  // End to end through computeDue: a never-assessed (gap-boosted) T1 pair with an open disagreement stays under a bare T0 pair.
  const subjects = [{ id: 'a', tier: 1, sha: 'a'.repeat(40) }, { id: 't0', tier: 0, sha: 'b'.repeat(40) }];
  const due = computeDue({
    now: T0, subjects, workflows: { 'live-probe': workflows['live-probe'] }, tiers, lastResults: new Map(), resultKeys: new Set(), inFlight: new Set(), parked: new Set(),
    oracle: new Map([['a', openRow]]), hooks: NO_HOOKS,
  });
  const a = due.find((d) => d.subject === 'a');
  const bare = computeDue({ now: T0, subjects: [subjects[0]], workflows: { 'live-probe': workflows['live-probe'] }, tiers, lastResults: new Map(), resultKeys: new Set(), inFlight: new Set(), parked: new Set(), hooks: NO_HOOKS })[0];
  assert.equal(a.priority - bare.priority, 9, 'the gap boost took 30 of the 39; the oracle boost got the remaining 9');
  assert.deepEqual(a.oracle, ['tool_set']);
  assert.equal(bare.oracle, undefined);
});

test('R-ORD-06: an open disagreement makes its oracle-lane pairs due again sooner than the tier max age, and not when settled, cleared or on another lane', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a', 'repo:b', 'repo:c'], 2);
  let t = T0;
  for (const s of ['repo:a', 'repo:b', 'repo:c']) {
    for (const lane of ['scan-static', 'live-probe', 'meta-github']) {
      const d = dueFromState(db, { tiers, workflows, now: t }).find((x) => x.subject === s && x.workflow === lane);
      assert.ok(d, `${s} ${lane} is due first`);
      const key = d.run_key;
      const att = `att-${s}-${lane}`;
      const lease = db.acquireLease(key, att, { ttlMs: DAY, now: t });
      db.recordRunKey(key, { subject: s, workflow: lane, fields: d.fields, now: t });
      db.createDispatch({ attemptId: att, shardId: 's', workflow: lane, repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: t + DAY, items: [{ run_key: key, subject: s, fence: lease.fence }], now: t });
      const oracle = lane === 'scan-static' ? staticFacts(H1, s === 'repo:c' ? 3 : 2) : lane === 'live-probe' ? liveFacts() : null;
      db.recordResult({ run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', ...(oracle ? { oracle } : {}), now: t + 1 });
    }
    t += 10;
  }
  assert.deepEqual(db.listOracleDisagreements({ status: 'open' }).map((r) => r.subject), ['repo:a', 'repo:b']);
  // Settle repo:b: the same disagreement survived the allowed re-checks.
  for (let i = 0; i < ORACLE_MAX_UNCHANGED; i++) cycle(db, 'repo:b', t += 10, staticFacts(H1, 2), liveFacts(), { sha: 'a'.repeat(40) });
  assert.deepEqual(db.listOracleDisagreements().map((r) => [r.subject, r.status]), [['repo:a', 'open'], ['repo:b', 'settled']]);
  // T2 scan-static max age is 14 days. After 2 days only the open one is due, by oracle_recheck; the meta lane is never.
  const view = (now) => dueFromState(db, { tiers, workflows, now }).map((d) => `${d.subject} ${d.workflow} ${d.reasons.join(',')}`);
  assert.deepEqual(view(T0 + 12 * 3600_000), [], 'not before oracle_recheck_days');
  const day2 = view(T0 + 2 * DAY);
  assert.deepEqual(day2.filter((x) => x.includes('oracle_recheck')).sort(), ['repo:a live-probe oracle_recheck', 'repo:a scan-static oracle_recheck']);
  assert.ok(!day2.some((x) => x.startsWith('repo:c') || x.startsWith('repo:b') || x.includes('meta-github')), day2.join('|'));
  // Its priority is the tier weight, the age, the reason's 15 and the boost's 4: together 19, the T2 cap (R-ORD-14).
  const a = dueFromState(db, { tiers, workflows, now: T0 + 2 * DAY }).find((d) => d.subject === 'repo:a' && d.workflow === 'scan-static');
  const age = Math.min(tiers.priority.age_max, ((T0 + 2 * DAY) - (T0 + 1)) / DAY * tiers.priority.age_per_day);
  assert.ok(Math.abs(a.priority - (40 + 15 + age + 4)) < 0.01, String(a.priority));
  // Once the reader is fixed the record clears and the re-checks stop.
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 3), T0 + 3 * DAY);
  assert.deepEqual(view(T0 + 3 * DAY + 2 * DAY).filter((x) => x.startsWith('repo:a') && x.includes('oracle_recheck')), []);
  db.close();
});

test('R-ORD-09: a cleared record keeps its cleared_at and kinds while results go on agreeing', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a']);
  let t = T0;
  accept(db, 'repo:a', 'scan-static', staticFacts(H2, 2), t += 1000);
  accept(db, 'repo:a', 'live-probe', liveFacts(), t += 1000);
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 3), t += 1000);
  const [cleared] = db.listOracleDisagreements();
  assert.equal(cleared.status, 'cleared');
  assert.deepEqual(cleared.kinds, [{ kind: 'tool_count', oracles: ['live', 'reader'] }], 'the cleared episode keeps what it was');
  for (let i = 0; i < 3; i++) accept(db, 'repo:a', i % 2 ? 'live-probe' : 'scan-static', i % 2 ? liveFacts() : staticFacts(H1, 3), t += 1000);
  const [later] = db.listOracleDisagreements();
  assert.deepEqual([later.cleared_at, later.updated_at, later.kinds], [cleared.cleared_at, cleared.updated_at, cleared.kinds]);
  db.close();
});

test('R-ORD-11: hashes are not compared across lanes: the reader derives its list from source, so a different hash alone says nothing; across lanes only a complete reader count is compared', () => {
  // Same count, different hash (derived or approximate source reading): nothing.
  assert.deepEqual(dd({ static: staticFacts(H2, 3), live: liveFacts() }).kinds, []);
  assert.deepEqual(dd({ static: staticFacts(H2, 3, { complete: false }), live: liveFacts() }).kinds, []);
  // A different count from a reader that did not see every tool (names only, left out, approximate) says nothing either.
  assert.deepEqual(dd({ static: staticFacts(H1, 2, { complete: false }), live: liveFacts() }).kinds, []);
  assert.deepEqual(dd({ static: staticFacts(H1, 2), live: liveFacts() }).kinds, [{ kind: 'tool_count', oracles: ['live', 'reader'] }]);
  // A lane without a hash or count is no reason for a kind.
  assert.deepEqual(dd({ static: staticFacts(H1, null), live: liveFacts() }).kinds, []);
  assert.deepEqual(dd({ static: staticFacts(H1, 2), live: liveFacts({ tool_count: null }) }).kinds, []);
});

test('R-ORD-12: lanes are compared only on one subject version; a lane of an older version is stale, and dropped when a newer result of it has no facts', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a']);
  const A = { sha: 'a'.repeat(40) };
  const B = { sha: 'b'.repeat(40) };
  let t = T0;
  const note = (lane, facts, fields) => accept(db, 'repo:a', lane, facts, t += 1000, {}, fields);
  note('scan-static', staticFacts(H1, 2), A);
  // A new release seen by live-probe against the reader's old facts is no disagreement.
  note('live-probe', liveFacts(), B);
  assert.deepEqual(db.listOracleDisagreements(), []);
  // The reader catches up, still disagreeing on the same version: now it is one.
  note('scan-static', staticFacts(H1, 2), B);
  assert.deepEqual(db.listOracleDisagreements().map((r) => r.status), ['open']);
  // A newer release: the live-probe result has no facts. Its old facts are dropped, the reader's are stale: nothing is left to disagree.
  note('live-probe', null, { sha: 'c'.repeat(40) });
  assert.deepEqual(db.raw.prepare('SELECT workflow FROM oracle_facts ORDER BY workflow').all().map((r) => r.workflow), ['scan-static']);
  assert.deepEqual(db.listOracleDisagreements().map((r) => [r.status, r.reason]), [['cleared', 'oracles_agree']]);
  // A result without facts for the same version keeps the lane's facts.
  note('scan-static', staticFacts(H1, 2), { sha: 'c'.repeat(40) });
  note('live-probe', null, { sha: 'c'.repeat(40) });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM oracle_facts').get().n, 1);
  db.close();
});

test('R-ORD-13: a re-check is a check cycle (every lane reported), not a lane result; a rolling budget settles a server that keeps flapping', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a', 'repo:f']);
  let t = T0;
  cycle(db, 'repo:a', t += 1000, staticFacts(H1, 2));
  assert.equal(db.listOracleDisagreements()[0].unchanged_rechecks, 0);
  // Two reader results and no live-probe result are not a cycle.
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 2), t += 1000);
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 2), t += 1000);
  assert.equal(db.listOracleDisagreements()[0].unchanged_rechecks, 0);
  accept(db, 'repo:a', 'live-probe', liveFacts(), t += 1000);
  assert.equal(db.listOracleDisagreements()[0].unchanged_rechecks, 1);
  for (let i = 0; i < ORACLE_MAX_UNCHANGED - 2; i++) cycle(db, 'repo:a', t += 1000, staticFacts(H1, 2));
  assert.deepEqual([db.listOracleDisagreements()[0].status, db.listOracleDisagreements()[0].unchanged_rechecks], ['open', ORACLE_MAX_UNCHANGED - 1]);
  cycle(db, 'repo:a', t += 1000, staticFacts(H1, 2));
  assert.deepEqual(db.listOracleDisagreements()[0].status, 'settled');
  // A server that alternates between disagreeing and agreeing never resets the budget by clearing.
  const statuses = [];
  for (let i = 0; i < 16; i++) {
    cycle(db, 'repo:f', t += 1000, staticFacts(H1, i % 2 === 0 ? 2 : 3));
    statuses.push(db.listOracleDisagreements().find((r) => r.subject === 'repo:f').status);
  }
  assert.ok(statuses.includes('settled'), statuses.join());
  const f = db.listOracleDisagreements().find((r) => r.subject === 'repo:f');
  assert.equal(JSON.parse(db.raw.prepare('SELECT recheck_log FROM oracle_disagreements WHERE subject = ?').get('repo:f').recheck_log).length <= ORACLE_BUDGET_MAX + 1, true, 'the log is bounded by the budget');
  assert.deepEqual(db.listOracleDisagreements({ status: 'open' }).map((r) => r.subject), []);
  assert.ok(['recheck_budget', 'oracles_agree'].includes(f.reason), f.reason);
  // The window rolls: 31 days on, a disagreement that opens is counted afresh.
  t += 31 * DAY;
  cycle(db, 'repo:f', t, staticFacts(H1, 3));
  cycle(db, 'repo:f', t += 1000, staticFacts(H1, 2));
  assert.equal(db.listOracleDisagreements().find((r) => r.subject === 'repo:f').status, 'open');
  db.close();
});

test('R-ORD-14: the oracle_recheck reason is charged to the same cap as the boosts, so a boosted pair never reaches a bare pair of the tier above', () => {
  const wf = wfOf('scan-static');
  const row = { status: 'open', kinds: [{ kind: 'tool_count', oracles: ['live', 'reader'] }] };
  const priorityOf = (tier, { oracle, gap = 0 }) => {
    const s = { id: 'x', tier, sha: 'a'.repeat(40), artifact_digest: null };
    const last = { run_key: runKey(runKeyFields(s, 'scan-static', wf)), accepted_at: new Date(T0 - 2 * DAY).toISOString(), fields: {} };
    const [d] = computeDue({
      now: T0, subjects: [s], workflows: { 'scan-static': wf }, tiers, lastResults: new Map([['x\u0000scan-static', last]]), resultKeys: new Set([last.run_key]),
      inFlight: new Set(), parked: new Set(), oracle: oracle ? new Map([['x', row]]) : new Map(), hooks: { ...NO_HOOKS, coverageGap: () => gap },
    });
    return d?.priority;
  };
  const age = 2 * tiers.priority.age_per_day;
  const names = Object.keys(tiers.weights).sort((a, b) => tiers.weights[b] - tiers.weights[a]);
  for (let i = 1; i < names.length; i++) {
    const tier = Number(names[i].slice(1));
    for (const gap of [0, 5, 1000]) {
      const p = priorityOf(tier, { oracle: true, gap: Math.min(gap, gapBoostCap(tiers, names[i])) });
      assert.ok(p !== undefined, `${names[i]} is due by oracle_recheck`);
      assert.ok(p < tiers.weights[names[i - 1]] + age, `${names[i]} gap ${gap}: ${p} stays under the bare ${names[i - 1]} pair (${tiers.weights[names[i - 1]] + age})`);
    }
  }
  // T3: 20 + 15 (reason) + 5 (boost) would be 40 and tie the T2 weight; with the reason charged to the cap it is 20 + 19.
  assert.equal(priorityOf(3, { oracle: true }) - age, 20 + 19);
});

const HOUR = 3_600_000;

test('R-ORD-16: facts of a subject with no sha and no digest are compared across lanes only when observed within the window; a months-old scan against a fresh live list is no disagreement', () => {
  assert.equal(ORACLE_UNVERSIONED_WINDOW_MS, 12 * HOUR);
  const at = (o, ms) => ({ ...o, version: null, at: ms });
  const near = deriveDisagreements({ static: at(staticFacts(H1, 2), T0), live: at(liveFacts(), T0 + ORACLE_UNVERSIONED_WINDOW_MS) });
  assert.deepEqual(near.kinds, [{ kind: 'tool_count', oracles: ['live', 'reader'] }], 'at the edge of the window they are compared');
  const far = deriveDisagreements({ static: at(staticFacts(H1, 2), T0 - 90 * DAY), live: at(liveFacts(), T0) });
  assert.deepEqual(far.kinds, [], 'a 90-day-old scan is not compared with a fresh live list');
  assert.deepEqual(deriveDisagreements({ static: at(staticFacts(H1, 2), T0 + ORACLE_UNVERSIONED_WINDOW_MS + 1), live: at(liveFacts(), T0) }).kinds, [], 'either lane may be the older one');
  assert.deepEqual(deriveDisagreements({ static: { ...staticFacts(H1, 2), version: null }, live: { ...liveFacts(), version: null } }).kinds, [], 'no observation time: not shown to be close');
  // A pinned version is unchanged by the window: the same sha is the same version however far apart.
  const pinned = (o, ms) => ({ ...o, version: 'a'.repeat(40), at: ms });
  assert.equal(deriveDisagreements({ static: pinned(staticFacts(H1, 2), T0 - 90 * DAY), live: pinned(liveFacts(), T0) }).kinds.length, 1);
  // The live lane's own comparisons (SDK clients) do not need the reader and still count when the scan is old.
  const own = deriveDisagreements({ static: at(staticFacts(H1, 3), T0 - 90 * DAY), live: at(liveFacts({ sdk: [sdk('ts', { tool_count: 5 })] }), T0) });
  assert.deepEqual(own.kinds, [{ kind: 'tool_count', oracles: ['live', 'sdk:ts'] }]);
  // The store: the lanes' observation times decide, for a subject with no version.
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'repo:u', kind: 'repo', source: 'test', tier: 1, sha: null, now: T0 - 10 * DAY });
  accept(db, 'repo:u', 'scan-static', staticFacts(H1, 2), T0 - 90 * DAY);
  accept(db, 'repo:u', 'live-probe', liveFacts(), T0);
  assert.deepEqual(db.listOracleDisagreements(), [], 'old scan, fresh live: nothing opens');
  accept(db, 'repo:u', 'scan-static', staticFacts(H1, 2), T0 + HOUR);
  assert.deepEqual(db.listOracleDisagreements().map((r) => r.status), ['open'], 'a fresh scan within the window is compared');
  db.close();
});

test('R-ORD-17: a late result of an older version does not overwrite or drop the lane\'s newer facts', () => {
  const db = openState(':memory:');
  seed(db, ['repo:a']);
  const A = { sha: 'a'.repeat(40) };
  const B = { sha: 'b'.repeat(40) };
  let t = T0;
  const facts = (lane) => JSON.parse(db.raw.prepare('SELECT facts FROM oracle_facts WHERE subject = ? AND workflow = ?').get('repo:a', lane).facts);
  accept(db, 'repo:a', 'scan-static', staticFacts(H1, 3), t += 1000, {}, B);
  accept(db, 'repo:a', 'live-probe', liveFacts({ tool_count: 5 }), t += 1000, {}, B);
  assert.deepEqual(db.listOracleDisagreements().map((r) => r.status), ['open']);
  const before = JSON.stringify(db.listOracleDisagreements());
  // A result of version A that finished before the stored ones, judged late.
  const late = (lane, f) => accept(db, 'repo:a', lane, f, t += 1000, { completedAt: T0 - HOUR }, A);
  late('live-probe', liveFacts({ tool_count: 3 }));
  assert.deepEqual([facts('live-probe').version, facts('live-probe').tool_count], ['b'.repeat(40), 5], 'the newer live facts stay');
  late('scan-static', null);
  assert.equal(facts('scan-static').version, 'b'.repeat(40), 'a late result with no facts does not drop the newer lane facts');
  late('live-probe', null);
  assert.equal(facts('live-probe').version, 'b'.repeat(40));
  assert.equal(JSON.stringify(db.listOracleDisagreements()), before, 'the record is not touched either');
  // An in-order result of a newer version still replaces them.
  accept(db, 'repo:a', 'live-probe', liveFacts({ tool_count: 3 }), t += 1000, {}, { sha: 'c'.repeat(40) });
  assert.equal(facts('live-probe').version, 'c'.repeat(40));
  db.close();
});

test('R-ORD-18: a settled record keeps the reason it settled for; recheck_budget is not rewritten to unchanged_rechecks', () => {
  assert.deepEqual(foldDisagreement({ status: 'settled', signature: 'x', unchanged_rechecks: 2, reason: 'recheck_budget' }, { kinds: [{}], signature: 'x' }),
    { status: 'settled', unchanged_rechecks: 2, reason: 'recheck_budget' });
  assert.equal(foldDisagreement({ status: 'settled', signature: 'x', unchanged_rechecks: 5, reason: 'unchanged_rechecks' }, { kinds: [{}], signature: 'x' }).reason, 'unchanged_rechecks');
  assert.equal(foldDisagreement({ status: 'settled', signature: 'x', unchanged_rechecks: 5, reason: null }, { kinds: [{}], signature: 'x' }).reason, 'unchanged_rechecks', 'an old row with no reason gets the default');
  // Through the store: settle by the budget, then go on with unchanged results.
  const db = openState(':memory:');
  seed(db, ['repo:f']);
  let t = T0;
  for (let i = 0; i < 16 && !db.listOracleDisagreements().some((r) => r.reason === 'recheck_budget'); i++) cycle(db, 'repo:f', t += 1000, staticFacts(H1, i % 2 === 0 ? 2 : 3));
  // Land on a disagreement that is settled by the budget.
  cycle(db, 'repo:f', t += 1000, staticFacts(H1, 2));
  cycle(db, 'repo:f', t += 1000, staticFacts(H1, 2));
  const row = () => db.listOracleDisagreements()[0];
  assert.deepEqual([row().status, row().reason], ['settled', 'recheck_budget']);
  for (let i = 0; i < 3; i++) cycle(db, 'repo:f', t += 1000, staticFacts(H1, 2));
  assert.deepEqual([row().status, row().reason], ['settled', 'recheck_budget'], 'unchanged results do not overwrite the reason');
  db.close();
});
