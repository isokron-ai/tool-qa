// live/build.mjs: the public snapshot and the public events.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveSnapshot, MAX_SNAPSHOT_BYTES, MODE_REASONS, PUBLIC_EVENT_KEYS, PUBLIC_TYPES, publicName, publicSeq,
  RETRY_CALLS, retryCallLabel, SCHEMA, toPublicEvent,
} from '../build.mjs';
import { REASON_CLASSES } from '../classes.mjs';
import { VENDOR_WORDS } from '../vendor-names.mjs';
import { addDispatch, addEvent, addResult, addSlot, addSubject, config, emptyState, realisticState, WORKFLOWS } from './seed.mjs';

const NOW = Date.parse('2026-11-25T21:40:00.000Z');
const w = (...p) => p.join('');
const FAKE_GH = w('gh', 'p_', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn');
const FAKE_PAT = w('github', '_pat_', '1'.repeat(22), '_', 'a'.repeat(59));
const FAKE_SK = w('sk', '-', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const FAKE_KEY = w('-----BEGIN ', 'OPENSSH PRIVATE KEY-----');
const EMAIL = 'jane.person@realmail.org';
const LOGIN = 'octo-person-login';
const DIGEST = 'd'.repeat(63) + 'e';
const FENCE = 987654321;
const ATTEMPT = 'att-7f3e1c9a0b2d';
const SHARD = 'shard-55aa66bb';
const RUN_URL = 'https://github.com/example-org/worker/actions/runs/424242424242';
const RUN_KEY = 'f'.repeat(63) + '1';
const APP_ID = 'app-installation-31337';
const VENDOR_SUBJECT = w('someone/mcp-', 'open', 'ai', '-bridge');
const HELD_SECRET_SUBJECT = 'privy-corp/secret-held-server';
const REJECTED_SUBJECT = 'rejecty-org/never-shown-server';

function deepKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}

/**
 * A state with every reason code, secret-looking strings, emails, vendor
 * names, fences, attempt ids, digests, held and quarantined results, placed
 * in every column and event field the builder could be tempted to copy.
 */
function hostileState() {
  const db = emptyState();
  const t = NOW - 30 * 60_000;
  addSubject(db, { id: 'acme-labs/files-mcp', at: t - 86_400_000 });
  addSubject(db, { id: HELD_SECRET_SUBJECT, at: t - 86_400_000 });
  addSubject(db, { id: REJECTED_SUBJECT, at: t - 86_400_000 });
  addSubject(db, { id: 'vendor-key', name: VENDOR_SUBJECT, at: t - 86_400_000 });
  addSubject(db, { id: 'mail-key', name: `${EMAIL}/x`, at: t - 86_400_000 });
  const poison = { error: `${FAKE_GH} ${EMAIL} ${FAKE_KEY}`, detail: FAKE_PAT, digest: DIGEST, fence: FENCE, attempt_id: ATTEMPT, item_index: 7, run_key: RUN_KEY, holder: ATTEMPT, shard_id: SHARD, run_url: RUN_URL, app_id: APP_ID, login: LOGIN, env: { APP_PRIVATE_KEY: FAKE_KEY }, model: w('son', 'net'), held_for_disclosure: 3 };
  // Every reason code, rejected, on a closed batch.
  let k = 0;
  for (const reason of Object.keys(REASON_CLASSES)) {
    addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'live-probe', subject: REJECTED_SUBJECT, data: { verdict: 'rejected', reason, outcome: 'rejected', ...poison } });
  }
  // Quarantines and a held result.
  addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'live-probe', subject: HELD_SECRET_SUBJECT, data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined', ...poison } });
  addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'scan-static', subject: HELD_SECRET_SUBJECT, data: { verdict: 'rejected', reason: 'other_quarantine', outcome: 'quarantined', ...poison } });
  // Accepted results, one of a vendor-named server and one with an email for a name.
  for (const subject of ['acme-labs/files-mcp', 'vendor-key', 'mail-key']) {
    addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'scan-static', subject, data: { verdict: 'accepted', reason: null, outcome: 'accepted', fault: 'tool', coverage: 'unassessed_tool', ...poison } });
  }
  addResult(db, { subject: 'acme-labs/files-mcp', workflow: 'scan-static', at: t, runKey: RUN_KEY, digest: DIGEST });
  // Every other internal event type, poisoned.
  for (const type of ['dispatch_created', 'dispatch_sent', 'dispatch_failed', 'dispatch_unconfirmed', 'dispatch_expired', 'dispatch_closed', 'pump_run_started', 'pump_run_finished', 'successor', 'registry_delta', 'breaker_changed', 'workflow_paused', 'retry', 'some_future_type']) {
    addEvent(db, { type, at: t + (k++) * 1000, lane: 'writecheck', n: 3, data: { ...poison, label: `PUT /repos/x/y/releases/assets/9?token=${FAKE_GH}`, call: RUN_URL, status: 502, attempts: 3, ok: false, action: 'dispatched', tripped: true, held: ['writecheck', `lane-${EMAIL}`], reason: 'red', summary: FAKE_GH, until: 'later' } });
  }
  // Leases, attempts and run_keys full of poison: never read.
  db.raw.prepare('INSERT INTO leases (subject, holder, fence, acquired, expires) VALUES (?, ?, ?, ?, ?)').run(RUN_KEY, `${ATTEMPT} ${FAKE_GH}`, FENCE, new Date(t).toISOString(), new Date(NOW + 3_600_000).toISOString());
  db.raw.prepare('INSERT INTO attempts (subject, holder, fence, run_id, run_key, digest, received, accepted, reason, attempt_id, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)').run(HELD_SECRET_SUBJECT, ATTEMPT, FENCE, '1', RUN_KEY, DIGEST, new Date(t).toISOString(), 'secret_scan', ATTEMPT, 'quarantined');
  db.raw.prepare('INSERT INTO run_keys (run_key, subject, workflow, fields, first_seen) VALUES (?, ?, ?, ?, ?)').run(RUN_KEY, HELD_SECRET_SUBJECT, 'live-probe', JSON.stringify({ secret: FAKE_GH, email: EMAIL }), new Date(t).toISOString());
  // A closed batch holding the held and rejected servers; an open one with a clean server.
  addDispatch(db, { attemptId: ATTEMPT, workflow: 'live-probe', created: t, expires: t + 3_600_000, status: 'done', shardId: SHARD, runUrl: RUN_URL, error: FAKE_GH, items: [{ subject: HELD_SECRET_SUBJECT, fence: FENCE }, { subject: REJECTED_SUBJECT, fence: FENCE }] });
  addDispatch(db, { attemptId: `${ATTEMPT}-open`, workflow: 'scan-static', created: NOW - 60_000, expires: NOW + 3_600_000, shardId: `${SHARD}-2`, runUrl: RUN_URL, error: FAKE_PAT, items: [{ subject: 'acme-labs/files-mcp', fence: FENCE }, { subject: 'vendor-key', name: VENDOR_SUBJECT, fence: FENCE }] });
  addSlot(db, { slot: 0, holder: `${ATTEMPT}-open`, at: NOW - 60_000, expires: NOW + 3_600_000 });
  db.setKv('pump.breaker', { tripped: true, reason: 'red', held: ['live-probe', 'writecheck'], checked_at: '2026-11-25T13:00:00.000Z', summary: `${FAKE_GH} ${EMAIL}`, run_url: RUN_URL, sandbox_sha: DIGEST }, { now: NOW - 60_000 });
  db.setKv('pump.successor', { ok: false, at: new Date(t).toISOString(), error: FAKE_GH, runUrl: RUN_URL }, { now: NOW - 60_000 });
  db.setKv('pump.last_tick', { blocked: FAKE_GH, ingest: { stopped: EMAIL } }, { now: NOW - 60_000 });
  db.setKv(`ingest.failures:${ATTEMPT}:0`, { count: 2, error: FAKE_GH }, { now: NOW - 60_000 });
  const cfg = config({ slots: '15' });
  cfg.switches.APP_PRIVATE_KEY = FAKE_KEY;
  cfg.switches.AGE_IDENTITY = FAKE_SK;
  cfg.history = [{ kind: 'registry-delta', last_capture_at: FAKE_GH, versions: FAKE_GH }, { kind: `x ${EMAIL}` }];
  const retry = { call: `PUT /repos/x/y/releases/assets/9?access_token=${FAKE_GH}`, status: 502, attempt: 3, of: 6, next_at: NOW + 4000, since: NOW - 60_000, url: RUN_URL, body: FAKE_GH };
  return { db, cfg, retry };
}

const NEVER = () => [
  FAKE_GH, FAKE_PAT, FAKE_SK, FAKE_KEY, 'PRIVATE KEY', EMAIL, 'realmail', LOGIN, DIGEST, String(FENCE), ATTEMPT, SHARD, RUN_URL, '424242424242', RUN_KEY, APP_ID,
  HELD_SECRET_SUBJECT, REJECTED_SUBJECT, VENDOR_SUBJECT, 'secret_scan', 'other_quarantine', 'quarantined"', 'held_for_disclosure', 'item_index', 'run_key', 'attempt_id',
  'fence', 'holder', 'digest', 'shard', 'run_url', 'run_id', 'summary', 'sandbox_sha', '/repos/', 'access_token', 'APP_PRIVATE', 'AGE_IDENTITY', 'some_future_type', 'until', '"red"',
  ...Object.keys(REASON_CLASSES), ...VENDOR_WORDS,
];

test('allowlist: a state seeded with every never-public thing produces output with none of them, and no key named held*', () => {
  const { db, cfg, retry } = hostileState();
  const out = buildLiveSnapshot(db, { now: NOW, config: cfg, retry, version: 'deadbee' });
  const text = JSON.stringify({ snapshot: out.snapshot, hourEvents: out.hourEvents }).toLowerCase();
  for (const bad of NEVER()) assert.ok(!text.includes(String(bad).toLowerCase()), `the output contains ${JSON.stringify(bad)}`);
  const keys = deepKeys(out.snapshot).concat(deepKeys(out.hourEvents));
  assert.deepEqual(keys.filter((x) => /^held/i.test(x)), [], 'no key named held*');
  // The rejections are there, as classes only.
  const rejected = out.hourEvents.filter((e) => e.type === 'rejected');
  assert.equal(rejected.length, Object.keys(REASON_CLASSES).length);
  assert.ok(rejected.every((e) => !('subject' in e)), 'a rejection never names the server');
  // The vendor- and email-named servers lose their name, not their result.
  const results = out.hourEvents.filter((e) => e.type === 'result');
  assert.deepEqual(results.map((e) => e.subject ?? null), ['acme-labs/files-mcp', null, null]);
  assert.deepEqual(out.problems, [], 'nothing left for the scans to find');
});

test('allowlist: every public event has only the public keys and types; the snapshot has exactly its fields', () => {
  const { db, cfg, retry } = hostileState();
  const { snapshot, hourEvents } = buildLiveSnapshot(db, { now: NOW, config: cfg, retry });
  for (const e of [...hourEvents, ...snapshot.recent]) {
    assert.ok(PUBLIC_TYPES.includes(e.type), e.type);
    for (const k of Object.keys(e)) assert.ok(PUBLIC_EVENT_KEYS.includes(k), `event key ${k}`);
    assert.ok(!('published_at' in e), 'the uploader adds published_at');
  }
  assert.deepEqual(Object.keys(snapshot), ['schema', 'seq', 'generated_at', 'version', 'mode', 'mode_reason', 'pump', 'retry', 'breaker', 'lanes', 'history', 'edges', 'publish', 'counts', 'now_checking', 'recent']);
  assert.deepEqual(Object.keys(snapshot.pump), ['run_started_at', 'tick_at', 'tick_s', 'runs_24h', 'successor', 'slots']);
  assert.deepEqual(Object.keys(snapshot.pump.slots), ['budget', 'open', 'max', 'ramp']);
  assert.deepEqual(snapshot.retry, { call: 'state_asset', status: 502, attempt: 3, of: 6, next_at: new Date(NOW + 4000).toISOString(), since: new Date(NOW - 60_000).toISOString() });
  assert.deepEqual(Object.keys(snapshot.breaker), ['state', 'checked_at', 'lanes']);
  for (const l of snapshot.lanes) assert.deepEqual(Object.keys(l), ['id', 'state', 'tool', 'pin', 'w1h', 'w24h', 'spark24', 'fault', 'ring', 't0_w24h']);
  for (const h of snapshot.history) assert.ok(Object.keys(h).every((k) => ['kind', 'state', 'last_capture_at', 'versions', 'registry_size'].includes(k)));
  assert.deepEqual(snapshot.history.map((h) => h.kind), ['registry-delta', 'registry-full', 'packages', 'popularity']);
  assert.equal(snapshot.history[0].versions, null);
  for (const e of snapshot.edges) assert.deepEqual(Object.keys(e), ['from', 'to', 'w1h', 'w24h', 'w7d']);
  assert.deepEqual(Object.keys(snapshot.counts), ['subjects_in_seed', 'checked', 'assessed', 'quarantined_daily']);
  for (const c of snapshot.now_checking) assert.deepEqual(Object.keys(c), ['subject', 'lane', 'since']);
  assert.deepEqual(snapshot.publish, { state: 'off' });
  assert.equal(snapshot.schema, SCHEMA);
});

test('the builder reads only the allowed tables and never a digest, fence, holder or error column', () => {
  const { db, cfg, retry } = hostileState();
  const seen = [];
  const raw = { prepare: (sql) => { seen.push(sql); return db.raw.prepare(sql); } };
  buildLiveSnapshot({ raw }, { now: NOW, config: cfg, retry });
  assert.ok(seen.length > 5);
  const allowed = new Set(['events', 'results', 'dispatches', 'dispatch_items', 'slot_ledger', 'subjects', 'kv', 'sqlite_master']);
  for (const sql of seen) {
    assert.ok(!/\b(?:attempts|leases|run_keys|oracle_facts|oracle_disagreements|subject_events|counters|runs)\b/i.test(sql), sql);
    assert.ok(!/\b(?:digest|fence|holder|holder_run|error|run_url|shard_id|fields)\b/i.test(sql), sql);
    assert.ok(!/select\s+\*/i.test(sql), sql);
    for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) assert.ok(allowed.has(m[1]), `${m[1]} in ${sql}`);
  }
});

test('size: under 20 KB at 15 slots with full lists and long names', () => {
  const db = emptyState();
  const cfg = config({ slots: '15' });
  const long = (i) => `${'o'.repeat(38)}${String(i).padStart(2, '0')}/${'r'.repeat(58)}${String(i).padStart(2, '0')}`;
  for (let i = 0; i < 60; i++) addSubject(db, { id: long(i), at: NOW - 86_400_000, tier: i % 5 });
  for (let d = 0; d < 15; d++) {
    const items = Array.from({ length: 4 }, (_, j) => ({ subject: long(d * 4 + j) }));
    addDispatch(db, { attemptId: `a-${d}`, workflow: ['scan-static', 'live-probe', 'writecheck'][d % 3], created: NOW - (d + 1) * 60_000, expires: NOW + 3_600_000, items });
    addSlot(db, { slot: d, holder: `a-${d}`, at: NOW - 60_000, expires: NOW + 3_600_000 });
  }
  for (let i = 0; i < 400; i++) {
    const lane = ['scan-static', 'live-probe', 'writecheck'][i % 3];
    addEvent(db, { type: 'result_recorded', at: NOW - i * 200_000, lane, subject: long(i % 60), data: { verdict: 'accepted', outcome: 'accepted', fault: 'subject', coverage: 'subject' } });
  }
  db.setKv('pump.breaker', { tripped: true, held: [], checked_at: '2026-11-25T01:00:00.000Z' }, { now: NOW });
  const retry = { call: 'state_asset', status: 503, attempt: 6, of: 6, next_at: NOW + 1000, since: NOW - 600_000 };
  const { snapshot, problems } = buildLiveSnapshot(db, { now: NOW, config: cfg, retry, version: 'a'.repeat(40) });
  assert.equal(snapshot.now_checking.length, 20);
  assert.equal(snapshot.recent.length, 20);
  assert.ok(snapshot.recent.every((e) => e.subject?.length === 101));
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  assert.ok(bytes < MAX_SNAPSHOT_BYTES, `${bytes} bytes`);
  assert.deepEqual(problems, []);
});

test('quarantine rule: quarantined results emit nothing and count only in quarantined_daily, null below 5', () => {
  const day = Date.UTC(2026, 10, 25);
  const build = (yesterday, today) => {
    const db = emptyState();
    addSubject(db, { id: 'acme-labs/files-mcp', at: day - 3 * 86_400_000 });
    for (let i = 0; i < yesterday; i++) addEvent(db, { type: 'result_recorded', at: day - 3_600_000 * (i + 1), lane: 'live-probe', subject: 'acme-labs/files-mcp', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
    for (let i = 0; i < today; i++) addEvent(db, { type: 'result_recorded', at: NOW - 60_000 * (i + 1), lane: 'live-probe', subject: 'acme-labs/files-mcp', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
    return buildLiveSnapshot(db, { now: NOW, config: config() });
  };
  for (const [y, t, want] of [[0, 0, null], [4, 0, null], [4, 9, null], [5, 0, 5], [7, 2, 7]]) {
    const { snapshot, hourEvents } = build(y, t);
    assert.equal(snapshot.counts.quarantined_daily, want, `${y} yesterday, ${t} today`);
    assert.deepEqual(hourEvents, [], 'no public event of any kind');
    assert.deepEqual(snapshot.recent, []);
    for (const l of snapshot.lanes.filter((x) => x.ring)) assert.deepEqual(Object.values(l.ring), [0, 0, 0, 0, 0], l.id);
    for (const e of snapshot.edges) assert.equal(e.w7d, 0, `${e.from}->${e.to}`);
    assert.equal(snapshot.counts.checked.w24h, 0);
  }
});

test('R-LIVE-20: quarantined_daily is the previous complete UTC day, so it never moves while a day runs', () => {
  const db = emptyState();
  const day = Date.UTC(2026, 10, 25);
  for (let i = 0; i < 6; i++) addEvent(db, { type: 'result_recorded', at: day - 7_200_000 * (i + 1), lane: 'live-probe', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  const before = buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot.counts.quarantined_daily;
  for (let i = 0; i < 6; i++) addEvent(db, { type: 'result_recorded', at: NOW - 60_000 * (i + 1), lane: 'live-probe', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  const after = buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot.counts.quarantined_daily;
  assert.equal(before, 6);
  assert.equal(after, 6, 'today\'s quarantines do not show until the day is over');
  assert.equal(buildLiveSnapshot(db, { now: day + 86_400_000 + 60_000, config: config() }).snapshot.counts.quarantined_daily, 6);
});

test('R-LIVE-21: public seq numbers leave no gap where a quarantine was recorded; the snapshot seq is not an event id', () => {
  const mk = (withQuarantine) => {
    const db = emptyState();
    addSubject(db, { id: 'acme-labs/files-mcp', at: NOW - 86_400_000 });
    const at = (i) => NOW - 600_000 + i * 1000;
    addEvent(db, { type: 'result_recorded', at: at(0), lane: 'live-probe', subject: 'acme-labs/files-mcp', data: { verdict: 'accepted', coverage: 'assessed' } });
    if (withQuarantine) addEvent(db, { type: 'result_recorded', at: at(1), lane: 'live-probe', subject: 'acme-labs/files-mcp', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
    addEvent(db, { type: 'result_recorded', at: at(2), lane: 'live-probe', subject: 'acme-labs/files-mcp', data: { verdict: 'accepted', coverage: 'assessed' } });
    return buildLiveSnapshot(db, { now: NOW, config: config() });
  };
  const a = mk(false);
  const b = mk(true);
  assert.deepEqual(b.hourEvents, a.hourEvents, 'the same public events, the same seqs');
  assert.deepEqual(b.snapshot, a.snapshot, 'the whole snapshot is the same');
  const seqs = b.hourEvents.map((e) => e.seq);
  assert.deepEqual(seqs, [publicSeq(NOW, 1), publicSeq(NOW, 2)]);
  assert.equal(b.snapshot.seq, Math.floor(NOW / 1000));
});

test('R-LIVE-22: now_checking keeps every server of a batch until the batch closes, so none can be seen to drop out', () => {
  const db = emptyState();
  for (const id of ['a-org/one', 'b-org/two', 'c-org/three']) addSubject(db, { id, at: NOW - 86_400_000 });
  addDispatch(db, { attemptId: 'x1', workflow: 'live-probe', created: NOW - 300_000, expires: NOW + 3_600_000, items: [{ subject: 'a-org/one', resolved: true }, { subject: 'b-org/two', resolved: true }, { subject: 'c-org/three' }] });
  addDispatch(db, { attemptId: 'x2', workflow: 'live-probe', created: NOW - 200_000, expires: NOW + 3_600_000, status: 'done', items: [{ subject: 'a-org/one' }] });
  addDispatch(db, { attemptId: 'x3', workflow: 'live-probe', created: NOW - 200_000, expires: NOW - 1, items: [{ subject: 'b-org/two' }] });
  const { snapshot } = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(snapshot.now_checking.map((x) => x.subject), ['a-org/one', 'b-org/two', 'c-org/three']);
  assert.ok(snapshot.now_checking.every((x) => x.since === new Date(NOW - 300_000).toISOString()));
});

test('R-LIVE-23: a server name that names a vendor, holds a secret or is not owner/name is left out, and blocks nothing', () => {
  assert.equal(publicName('acme-labs/files-mcp'), 'acme-labs/files-mcp');
  for (const bad of [VENDOR_SUBJECT, `${EMAIL}/x`, 'no-slash', 'a/b/c', `x/${FAKE_GH}`, '', null, 42]) assert.equal(publicName(bad), null, String(bad));
  const db = emptyState();
  addSubject(db, { id: 'v', name: VENDOR_SUBJECT, at: NOW - 86_400_000 });
  addDispatch(db, { attemptId: 'x', workflow: 'writecheck', created: NOW - 1000, expires: NOW + 60_000, items: [{ subject: 'v', name: VENDOR_SUBJECT }] });
  addEvent(db, { type: 'result_recorded', at: NOW - 500, lane: 'writecheck', subject: 'v', data: { verdict: 'accepted', coverage: 'assessed' } });
  const out = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.snapshot.now_checking, [{ subject: null, lane: 'writecheck', since: new Date(NOW - 1000).toISOString() }]);
  assert.equal(out.hourEvents[0].type, 'result');
  assert.ok(!('subject' in out.hourEvents[0]));
});

test('R-LIVE-24: a retry call label comes from the fixed list; raw "METHOD /path" labels are mapped, never copied', () => {
  assert.deepEqual([...RETRY_CALLS], ['github_api', 'state_asset', 'app_token']);
  for (const c of RETRY_CALLS) assert.equal(retryCallLabel(c), c);
  assert.equal(retryCallLabel('POST /repos/isokron-ai/tool-qa/releases/123/assets'), 'state_asset');
  assert.equal(retryCallLabel('POST /app/installations/77/access_tokens'), 'app_token');
  assert.equal(retryCallLabel('POST /repos/o/r/actions/workflows/w.yml/dispatches'), 'github_api');
  for (const raw of [RUN_URL, `GET /x?token=${FAKE_GH}`, 'anything else', null, 7]) assert.equal(retryCallLabel(raw), 'github_api');
  const e = toPublicEvent({ id: 1, type: 'retry', occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:01.000Z', lane: null, n: 1, data: JSON.stringify({ label: 'state_asset', status: 502, attempts: 3, gave_up: false }) });
  assert.deepEqual(e, { seq: null, type: 'retry', occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:01.000Z', lane: null, n: 3, label: 'state_asset', status: 502, state: 'retrying' });
});

test('toPublicEvent maps each internal type to its public shape, and nothing else', () => {
  const base = { id: 9, occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:02.000Z', lane: 'live-probe', n: 10, subject: 'k' };
  const lanes = Object.keys(WORKFLOWS.workflows);
  const pub = (type, data, extra = {}) => toPublicEvent({ ...base, type, data: JSON.stringify(data), ...extra }, { lanes, subjectName: 'acme-labs/files-mcp' });
  const head = { seq: null, occurred_at: base.occurred_at, recorded_at: base.recorded_at, lane: 'live-probe', n: 10 };
  assert.deepEqual(pub('dispatch_sent', { run_id: '1', run_url: RUN_URL }), { ...head, type: 'batch_sent' });
  assert.deepEqual(pub('dispatch_failed', { status: 502 }), { ...head, type: 'batch_not_sent', label: 'GitHub error' });
  assert.deepEqual(pub('dispatch_failed', { status: 422 }), { ...head, type: 'batch_not_sent', label: 'refused' });
  assert.deepEqual(pub('dispatch_failed', { withdrawn: true }), { ...head, type: 'batch_not_sent', label: 'withdrawn' });
  assert.deepEqual(pub('dispatch_unconfirmed', { status: 504 }), { ...head, type: 'batch_not_sent', label: 'GitHub error' });
  assert.deepEqual(pub('dispatch_expired', { count: 1 }), { ...head, type: 'batch_expired' });
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted', coverage: 'assessed' }, { n: 1 }), { ...head, n: 1, type: 'result', subject: 'acme-labs/files-mcp', side: 'assessed' });
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted', fault: 'subject', coverage: 'subject' }, { n: 1 }), { ...head, n: 1, type: 'result', subject: 'acme-labs/files-mcp', side: 'subject' });
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted', fault: null, coverage: 'excluded' }, { n: 1 }), { ...head, n: 1, type: 'result', subject: 'acme-labs/files-mcp', side: 'policy' });
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted' }, { n: 1 }).side, 'unknown');
  assert.deepEqual(pub('result_recorded', { verdict: 'rejected', reason: 'stale_fence' }, { n: 1 }), { ...head, n: 1, type: 'rejected', class: 'lease' });
  assert.deepEqual(pub('result_recorded', { verdict: 'rejected', reason: 'brand_new' }, { n: 1 }).class, 'worker_output');
  assert.equal(pub('result_recorded', { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' }), null);
  assert.equal(pub('result_recorded', { verdict: 'accepted', reason: 'secret_scan' }), null);
  assert.equal(pub('result_recorded', { verdict: 'rejected', reason: 'x', outcome: 'quarantined' }), null);
  const loop = { lane: null, n: 1 };
  assert.deepEqual(pub('pump_run_started', { ticks: 0 }, loop), { ...head, ...loop, type: 'pump_run', label: 'started' });
  assert.deepEqual(pub('pump_run_finished', { ticks: 4 }, loop), { ...head, ...loop, type: 'pump_run', label: 'finished' });
  assert.deepEqual(pub('successor', { ok: true, run_id: '5' }, loop), { ...head, ...loop, type: 'pump_run', label: 'successor', state: 'ok' });
  assert.deepEqual(pub('successor', { ok: false, status: 502 }, loop), { ...head, ...loop, type: 'pump_run', label: 'successor', status: 502, state: 'failed' });
  assert.deepEqual(pub('registry_delta', { action: 'dispatched' }, loop), { ...head, ...loop, type: 'history_triggered', state: 'dispatched' });
  assert.equal(pub('registry_delta', { action: 'fresh' }, loop), null);
  assert.deepEqual(pub('breaker_changed', { tripped: true, reason: 'red', held: ['writecheck', 'live-probe', 'nope'] }, loop), { ...head, ...loop, type: 'sandbox_check', state: 'held', lanes: ['live-probe', 'writecheck'] });
  assert.deepEqual(pub('breaker_changed', { tripped: false, held: [] }, loop), { ...head, ...loop, type: 'sandbox_check', state: 'closed', lanes: [] });
  assert.deepEqual(pub('workflow_paused', { until: 'x' }, { n: 1 }), { ...head, n: 1, type: 'lane_paused' });
  for (const t of ['dispatch_created', 'dispatch_closed', 'something_new']) assert.equal(pub(t, {}), null, t);
  assert.equal(toPublicEvent({ ...base, type: 'dispatch_sent', occurred_at: 'yesterday', data: '{}' }), null, 'an unreadable time drops the event');
  assert.equal(toPublicEvent({ ...base, type: 'dispatch_sent', lane: 'not-a-lane', data: '{}' }, { lanes }).lane, null, 'an unknown lane is left out');
});

test('lane states: on, off, not_built, and held while the breaker holds the lanes that run third-party code', () => {
  const db = emptyState();
  const states = (snap) => Object.fromEntries(snap.lanes.map((l) => [l.id, l.state]));
  let snap = buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot;
  assert.deepEqual(states(snap), { 'scan-static': 'on', 'live-probe': 'on', 'scan-deep': 'not_built', 'build-probe': 'not_built', writecheck: 'on', 'meta-github': 'off', 'meta-registry': 'off', 'release-diff': 'off' });
  assert.equal(snap.breaker, null);
  const nb = snap.lanes.find((l) => l.id === 'scan-deep');
  assert.deepEqual(nb, { id: 'scan-deep', state: 'not_built', tool: null, pin: null, w1h: null, w24h: null, spark24: null, fault: null, ring: null, t0_w24h: null });
  assert.ok(!snap.edges.some((e) => e.to === 'scan-deep' || e.from === 'build-probe'), 'not built: no edges');
  assert.deepEqual(snap.lanes.find((l) => l.id === 'live-probe').spark24.length, 24);
  db.setKv('pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe', 'writecheck'], checked_at: '2026-11-24T06:00:00.000Z' }, { now: NOW });
  snap = buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot;
  assert.deepEqual(states(snap), { 'scan-static': 'on', 'live-probe': 'held', 'scan-deep': 'not_built', 'build-probe': 'not_built', writecheck: 'held', 'meta-github': 'off', 'meta-registry': 'off', 'release-diff': 'off' });
  assert.deepEqual(snap.breaker, { state: 'held', checked_at: '2026-11-24T06:00:00.000Z', lanes: ['live-probe', 'writecheck'] });
  db.setKv('pump.breaker', { tripped: false, held: [], checked_at: '2026-11-25T06:00:00.000Z' }, { now: NOW });
  assert.equal(buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot.breaker.state, 'closed');
  const wf = structuredClone(WORKFLOWS.workflows);
  wf['meta-github'].enabled = true;
  wf.writecheck.enabled = false;
  snap = buildLiveSnapshot(db, { now: NOW, config: config({ workflows: wf }) }).snapshot;
  assert.equal(states(snap)['meta-github'], 'on');
  assert.equal(states(snap).writecheck, 'off');
});

test('modes: off, paused, retrying, idle with "scanning paused by us", live', () => {
  const db = emptyState();
  const mode = (opts, retry = null) => { const s = buildLiveSnapshot(db, { now: NOW, config: config(opts), retry }).snapshot; return [s.mode, s.mode_reason]; };
  const open = { call: 'github_api', status: 502, attempt: 2, of: 6, next_at: NOW + 1000, since: NOW - 5000 };
  assert.deepEqual(mode({ loop: 'false' }), ['off', MODE_REASONS.off]);
  assert.deepEqual(mode({ loop: 'TRUE' }), ['off', MODE_REASONS.off]);
  assert.deepEqual(mode({ pauseUntil: '2026-11-26T00:00:00Z' }), ['paused', 'loop paused by us']);
  assert.deepEqual(mode({ pauseUntil: 'not a time' }), ['paused', 'loop paused by us']);
  assert.deepEqual(mode({ pauseUntil: '2026-11-25T00:00:00Z' }), ['live', 'scanning live']);
  assert.deepEqual(mode({ slots: '0' }), ['idle', 'scanning paused by us']);
  assert.deepEqual(mode({ slots: 'junk' }), ['idle', 'scanning paused by us']);
  assert.deepEqual(mode({}, open), ['retrying', 'retrying a GitHub call']);
  assert.deepEqual(mode({}, { ...open, gave_up: true }), ['live', 'scanning live']);
  assert.deepEqual(mode({}, { ...open, attempt: 9 }), ['live', 'scanning live'], 'an attempt past `of` is not a retry block');
  const s = buildLiveSnapshot(db, { now: NOW, config: config({ slots: '40' }) }).snapshot;
  assert.equal(s.pump.slots.budget, 15);
  assert.ok(!JSON.stringify(s).includes('LOOP_SLOTS'));
});

test('scans block: a planted secret or vendor name reaching the output makes problems non-empty, naming rule and path only', () => {
  const db = emptyState();
  const wf = structuredClone(WORKFLOWS.workflows);
  const aws = w('AK', 'IA', 'QWERTYUIOPASDFGH');
  wf['scan-static'].versions.tool = { 'mcp-check': aws };
  const vendorLane = w('open', 'ai', '-probe');
  wf[vendorLane] = { ...wf['meta-github'] };
  const out = buildLiveSnapshot(db, { now: NOW, config: config({ workflows: wf }) });
  const got = out.problems.map((p) => `${p.rule} ${p.path}`);
  assert.ok(got.includes('aws-access-key-id $.lanes[0].pin'), got.join(', '));
  assert.ok(got.includes(`vendor-name $.lanes[${Object.keys(wf).indexOf(vendorLane)}].id`), got.join(', '));
  const text = JSON.stringify(out.problems);
  assert.ok(!text.includes(aws) && !text.toLowerCase().includes(vendorLane));
  for (const p of out.problems) assert.deepEqual(Object.keys(p).sort(), ['path', 'rule']);
});

test('deterministic: the same state and clock give the same bytes; epoch ms, Date and ISO clocks agree', () => {
  const a = realisticState();
  const b = realisticState();
  const one = buildLiveSnapshot(a.db, { now: a.now, config: a.cfg, version: 'abc1234' });
  const two = buildLiveSnapshot(a.db, { now: new Date(a.now), config: a.cfg, version: 'abc1234' });
  const three = buildLiveSnapshot(b.db, { now: new Date(b.now).toISOString(), config: b.cfg, version: 'abc1234' });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(JSON.stringify(one), JSON.stringify(three));
  assert.ok(one.snapshot.recent.length === 20 && one.hourEvents.length > 0);
  // recent are this hour's last events, with the same seqs as the hour file.
  const bySeq = new Map(one.hourEvents.map((e) => [e.seq, e]));
  for (const e of one.snapshot.recent.filter((x) => bySeq.has(x.seq))) assert.deepEqual(e, bySeq.get(e.seq));
  const seqs = one.snapshot.recent.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => y - x), 'newest first');
  assert.throws(() => buildLiveSnapshot(a.db, { now: 'nope', config: a.cfg }), TypeError);
});

test('counts and edges follow the events: results, rejections and batches per lane and window', () => {
  const db = emptyState();
  addSubject(db, { id: 'a-org/one', at: NOW - 86_400_000, tier: 0 });
  addSubject(db, { id: 'b-org/two', at: NOW - 86_400_000, tier: 2, retired: true });
  addEvent(db, { type: 'dispatch_sent', at: NOW - 30 * 60_000, lane: 'writecheck', n: 2 });
  addEvent(db, { type: 'dispatch_sent', at: NOW - 3 * 86_400_000, lane: 'writecheck', n: 5 });
  addEvent(db, { type: 'result_recorded', at: NOW - 20 * 60_000, lane: 'writecheck', subject: 'a-org/one', data: { verdict: 'accepted', coverage: 'assessed' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 2 * 3_600_000, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'accepted', fault: 'infra', coverage: 'unassessed_infra' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 19 * 60_000, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'rejected', reason: 'ingest_timeout' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 18 * 60_000, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  addEvent(db, { type: 'registry_delta', at: NOW - 10 * 60_000, data: { action: 'dispatched' } });
  addEvent(db, { type: 'registry_delta', at: NOW - 9 * 60_000, data: { action: 'failed' } });
  addResult(db, { subject: 'a-org/one', workflow: 'writecheck', at: NOW - 20 * 60_000, runKey: '1'.repeat(64) });
  const { snapshot } = buildLiveSnapshot(db, { now: NOW, config: config() });
  const wc = snapshot.lanes.find((l) => l.id === 'writecheck');
  assert.deepEqual([wc.w1h, wc.w24h, wc.t0_w24h], [1, 2, 1]);
  assert.deepEqual(wc.ring, { accepted: 2, lease: 0, integrity: 0, worker_output: 0, infra: 1 });
  assert.deepEqual(wc.fault, { subject: 0, tool: 0, infra: 1, policy: 0, unknown: 0 });
  assert.equal(wc.spark24.reduce((x, y) => x + y, 0), 2);
  assert.equal(wc.spark24[23], 1);
  const edge = (from, to) => snapshot.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('pump', 'writecheck'), { from: 'pump', to: 'writecheck', w1h: 2, w24h: 2, w7d: 7 });
  assert.deepEqual(edge('writecheck', 'ingest'), { from: 'writecheck', to: 'ingest', w1h: 2, w24h: 3, w7d: 3 });
  assert.deepEqual(edge('pump', 'history'), { from: 'pump', to: 'history', w1h: 1, w24h: 1, w7d: 1 });
  assert.deepEqual(snapshot.counts, { subjects_in_seed: 1, checked: { w24h: 2, w7d: 2, all: 1 }, assessed: { w24h: 1, all: 1 }, quarantined_daily: null });
});
