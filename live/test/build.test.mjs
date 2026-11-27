// live/build.mjs: the public snapshot and hour files (design B).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveSnapshot, LANE_NOTES, MAX_SNAPSHOT_BYTES, MODE_REASONS, PUBLIC_EVENT_KEYS, PUBLIC_TYPES, publicName, publicSeq,
  RETRY_CALLS, retryCallLabel, SCHEMA, sideOf, toPublicEvent,
} from '../build.mjs';
import { REASON_CLASSES } from '../classes.mjs';
import { addDispatch, addEvent, addResult, addSlot, addSubject, config, emptyState, realisticState, WORKFLOWS } from './seed.mjs';

const NOW = Date.parse('2026-11-25T21:40:00.000Z');
const HOUR = 3_600_000;
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
const QUARANTINED = 'privy-corp/secret-held-server';
const REJECTED = 'rejecty-org/never-shown-server';
const TOOL_SIDE = 'toolside-org/our-limit-server';
const ACCEPTED = 'acme-labs/files-mcp';
// An independent list, not the scanner's own (vendor-names.mjs could drop a word unnoticed).
const VENDORS = [['cl', 'aude'], ['anthr', 'opic'], ['open', 'ai'], ['gem', 'ini'], ['son', 'net'], ['ha', 'iku'], ['mis', 'tral'], ['deep', 'seek'], ['co', 'pilot'], ['wind', 'surf']].map((p) => p.join(''));

function deepKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}

/** Everything a build publishes. */
const published = (out) => [out.snapshot, out.hourEvents, out.previousHourEvents];

/**
 * A state with every reason code, secret-looking strings, emails, vendor
 * names, fences, attempt ids, digests, held and quarantined results, placed
 * in every column and event field the builder could be tempted to copy. Its
 * results were recorded in the previous hour, so the current hour file would
 * name them if anything did.
 */
function hostileState() {
  const db = emptyState();
  const t = NOW - HOUR - 10 * 60_000;
  for (const id of [ACCEPTED, QUARANTINED, REJECTED, TOOL_SIDE]) addSubject(db, { id, at: t - 86_400_000 });
  addSubject(db, { id: 'vendor-key', name: VENDOR_SUBJECT, at: t - 86_400_000 });
  addSubject(db, { id: 'mail-key', name: `${EMAIL}/x`, at: t - 86_400_000 });
  const poison = { error: `${FAKE_GH} ${EMAIL} ${FAKE_KEY}`, detail: FAKE_PAT, digest: DIGEST, fence: FENCE, attempt_id: ATTEMPT, item_index: 7, run_key: RUN_KEY, holder: ATTEMPT, shard_id: SHARD, run_url: RUN_URL, app_id: APP_ID, login: LOGIN, env: { APP_PRIVATE_KEY: FAKE_KEY }, model: w('son', 'net'), held_for_disclosure: 3 };
  let k = 0;
  for (const reason of Object.keys(REASON_CLASSES)) {
    addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'live-probe', subject: REJECTED, data: { verdict: 'rejected', reason, outcome: 'rejected', ...poison } });
  }
  addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'live-probe', subject: QUARANTINED, data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined', ...poison } });
  addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'scan-static', subject: QUARANTINED, data: { verdict: 'rejected', reason: 'other_quarantine', outcome: 'quarantined', ...poison } });
  addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'scan-static', subject: TOOL_SIDE, data: { verdict: 'accepted', outcome: 'accepted', fault: 'tool', coverage: 'unassessed_tool', ...poison } });
  for (const subject of [ACCEPTED, 'vendor-key', 'mail-key']) {
    addEvent(db, { type: 'result_recorded', at: t + (k++) * 1000, lane: 'scan-static', subject, data: { verdict: 'accepted', reason: null, outcome: 'accepted', fault: null, coverage: 'assessed', ...poison } });
  }
  addResult(db, { subject: ACCEPTED, workflow: 'scan-static', at: t, runKey: RUN_KEY, digest: DIGEST });
  const tt = NOW - 5 * 60_000;
  for (const type of ['dispatch_created', 'dispatch_sent', 'dispatch_failed', 'dispatch_unconfirmed', 'dispatch_expired', 'dispatch_closed', 'pump_run_started', 'pump_run_finished', 'successor', 'registry_delta', 'breaker_changed', 'workflow_paused', 'retry', 'some_future_type']) {
    addEvent(db, { type, at: tt + (k++) * 1000, lane: 'writecheck', n: 3, subject: QUARANTINED, data: { ...poison, label: `PUT /repos/x/y/releases/assets/9?token=${FAKE_GH}`, call: RUN_URL, status: 502, attempts: 3, ok: false, action: 'dispatched', tripped: true, held: ['writecheck', `lane-${EMAIL}`], reason: 'red', summary: FAKE_GH, until: 'later', accepted: 2, not_used: 1 } });
  }
  db.raw.prepare('INSERT INTO leases (subject, holder, fence, acquired, expires) VALUES (?, ?, ?, ?, ?)').run(RUN_KEY, `${ATTEMPT} ${FAKE_GH}`, FENCE, new Date(t).toISOString(), new Date(NOW + HOUR).toISOString());
  db.raw.prepare('INSERT INTO attempts (subject, holder, fence, run_id, run_key, digest, received, accepted, reason, attempt_id, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)').run(QUARANTINED, ATTEMPT, FENCE, '1', RUN_KEY, DIGEST, new Date(t).toISOString(), 'secret_scan', ATTEMPT, 'quarantined');
  db.raw.prepare('INSERT INTO run_keys (run_key, subject, workflow, fields, first_seen) VALUES (?, ?, ?, ?, ?)').run(RUN_KEY, QUARANTINED, 'live-probe', JSON.stringify({ secret: FAKE_GH, email: EMAIL }), new Date(t).toISOString());
  addDispatch(db, { attemptId: ATTEMPT, workflow: 'live-probe', created: t, expires: t + HOUR, status: 'done', closed: t + 60_000, shardId: SHARD, runUrl: RUN_URL, error: FAKE_GH, items: [{ subject: QUARANTINED, fence: FENCE }, { subject: REJECTED, fence: FENCE }] });
  addDispatch(db, { attemptId: `${ATTEMPT}-open`, workflow: 'scan-static', created: NOW - 60_000, expires: NOW + HOUR, shardId: `${SHARD}-2`, runUrl: RUN_URL, error: FAKE_PAT, items: [{ subject: QUARANTINED, fence: FENCE }, { subject: 'vendor-key', name: VENDOR_SUBJECT, fence: FENCE }] });
  addSlot(db, { slot: 0, holder: `${ATTEMPT}-open`, at: NOW - 60_000, expires: NOW + HOUR });
  db.setKv('pump.breaker', { tripped: true, reason: 'red', held: ['live-probe', 'writecheck'], checked_at: '2026-11-25T13:00:00.000Z', summary: `${FAKE_GH} ${EMAIL}`, run_url: RUN_URL, sandbox_sha: DIGEST }, { now: NOW - 60_000 });
  db.setKv('pump.successor', { ok: false, at: new Date(t).toISOString(), error: FAKE_GH, runUrl: RUN_URL }, { now: NOW - 60_000 });
  db.setKv('pump.last_tick', { blocked: FAKE_GH, ingest: { stopped: EMAIL } }, { now: NOW - 60_000 });
  db.setKv('pump.paused:writecheck', { reason: 'run_sha_mismatch', until: '2026-11-26T00:00:00.000Z' }, { now: NOW - 60_000 });
  const cfg = config({ slots: '15' });
  cfg.switches.APP_PRIVATE_KEY = FAKE_KEY;
  cfg.switches.AGE_IDENTITY = FAKE_SK;
  cfg.history = [{ kind: 'registry-delta', last_capture_at: FAKE_GH, versions: FAKE_GH }, { kind: `x ${EMAIL}` }];
  cfg.lane_notes = { 'scan-static': `free ${FAKE_GH}`, writecheck: 'toString' };
  const retry = { call: `PUT /repos/x/y/releases/assets/9?access_token=${FAKE_GH}`, status: 502, attempt: 3, of: 6, next_at: NOW + 4000, since: NOW - 60_000, url: RUN_URL, body: FAKE_GH };
  return { db, cfg, retry };
}

const NEVER = () => [
  FAKE_GH, FAKE_PAT, FAKE_SK, FAKE_KEY, 'PRIVATE KEY', EMAIL, 'realmail', LOGIN, DIGEST, String(FENCE), ATTEMPT, SHARD, RUN_URL, '424242424242', RUN_KEY, APP_ID,
  QUARANTINED, REJECTED, TOOL_SIDE, VENDOR_SUBJECT, 'secret_scan', 'other_quarantine', 'quarantin', 'held', 'item_index', 'run_key', 'attempt_id',
  'fence', 'holder', 'digest', 'shard', 'run_url', 'run_id', 'summary', 'sandbox_sha', '/repos/', 'access_token', 'APP_PRIVATE', 'AGE_IDENTITY', 'some_future_type', 'until',
  '"red"', 'paused', 'not_used":1', 'rejected', '"reason"', ...Object.keys(REASON_CLASSES), ...VENDORS,
];

test('allowlist: a state seeded with every never-public thing produces output with none of them, and no key named held*', () => {
  const { db, cfg, retry } = hostileState();
  for (const now of [NOW, Date.parse('2026-11-25T21:02:00.000Z')]) {
    const out = buildLiveSnapshot(db, { now, config: cfg, retry, version: 'deadbee' });
    const text = JSON.stringify(published(out)).toLowerCase();
    for (const bad of NEVER()) assert.ok(!text.includes(String(bad).toLowerCase()), `the output contains ${JSON.stringify(bad)}`);
    assert.deepEqual(deepKeys(published(out)).filter((x) => /^held/i.test(x)), [], 'no key named held*');
    assert.deepEqual(out.problems, [], 'nothing left for the scans to find');
  }
  const out = buildLiveSnapshot(db, { now: NOW, config: cfg, retry });
  // Named: only the accepted, assessed results, a plain name or no name at all.
  assert.deepEqual(out.hourEvents.filter((e) => e.type === 'result').map((e) => e.subject ?? null), [ACCEPTED, null, null]);
});

test('allowlist: every public event has only the public keys and types; the snapshot has exactly its fields', () => {
  const { db, cfg, retry } = hostileState();
  const { snapshot, hourEvents, previousHourEvents } = buildLiveSnapshot(db, { now: Date.parse('2026-11-25T21:02:00.000Z'), config: cfg, retry });
  for (const e of [...hourEvents, ...previousHourEvents, ...snapshot.recent]) {
    assert.ok(PUBLIC_TYPES.includes(e.type), e.type);
    for (const k of Object.keys(e)) assert.ok(PUBLIC_EVENT_KEYS.includes(k), `event key ${k}`);
  }
  assert.deepEqual(Object.keys(snapshot), ['schema', 'seq', 'generated_at', 'version', 'mode', 'mode_reason', 'pump', 'retry', 'breaker', 'lanes', 'history', 'edges', 'publish', 'counts', 'now_checking', 'just_checked', 'recent', 'coverage']);
  assert.deepEqual(Object.keys(snapshot.pump), ['run_started_at', 'tick_at', 'tick_s', 'runs_24h', 'successor', 'slots', 'registry_delta']);
  assert.deepEqual(Object.keys(snapshot.pump.slots), ['budget', 'open', 'max', 'ramp']);
  assert.deepEqual(Object.keys(snapshot.pump.registry_delta), ['at', 'w24h']);
  assert.deepEqual(snapshot.retry, { call: 'state_asset', status: 502, attempt: 3, of: 6, next_at: '2026-11-25T21:40:04.000Z', since: '2026-11-25T21:39:00.000Z' });
  assert.deepEqual(Object.keys(snapshot.breaker), ['state', 'checked_at', 'lanes']);
  for (const l of snapshot.lanes) assert.deepEqual(Object.keys(l), ['id', 'state', 'tool', 'pin', 'note', 'w1h', 'w24h', 'spark24', 'fault', 'ring', 'ring_daily', 't0_w24h']);
  for (const l of snapshot.lanes.filter((x) => x.ring)) {
    assert.deepEqual(Object.keys(l.ring), ['accepted']);
    assert.deepEqual(Object.keys(l.ring_daily), ['not_used', 'lease', 'integrity', 'worker_output', 'infra']);
  }
  for (const h of snapshot.history) assert.ok(Object.keys(h).every((k) => ['kind', 'state', 'last_capture_at', 'versions', 'registry_size', 'full_at'].includes(k)));
  for (const e of snapshot.edges) assert.deepEqual(Object.keys(e), ['from', 'to', 'w1h', 'w24h', 'w7d']);
  assert.deepEqual(Object.keys(snapshot.counts), ['subjects_in_seed', 'checked', 'assessed']);
  for (const c of snapshot.now_checking) assert.deepEqual(Object.keys(c), ['lane', 'batches_out', 'since_oldest']);
  assert.deepEqual(Object.keys(snapshot.just_checked), ['hour', 'results']);
  for (const j of snapshot.just_checked.results) assert.deepEqual(Object.keys(j), ['subject', 'lane', 'side']);
  assert.ok(snapshot.recent.every((e) => e.type !== 'result' && !('subject' in e)), 'recent names no server');
  assert.deepEqual(snapshot.publish, { state: 'off' });
  assert.equal(snapshot.schema, SCHEMA);
});

test('the builder reads only the allowed tables, never a batch\'s items, and never a digest, fence, holder or error column', () => {
  const { db, cfg, retry } = hostileState();
  const seen = [];
  const raw = { prepare: (sql) => { seen.push(sql); return db.raw.prepare(sql); } };
  buildLiveSnapshot({ raw }, { now: Date.parse('2026-11-25T21:02:00.000Z'), config: cfg, retry });
  assert.ok(seen.length > 5);
  const allowed = new Set(['events', 'results', 'dispatches', 'slot_ledger', 'subjects', 'kv', 'sqlite_master']);
  for (const sql of seen) {
    assert.ok(!/\b(?:attempts|leases|run_keys|dispatch_items|oracle_facts|oracle_disagreements|subject_events|counters|runs)\b/i.test(sql), sql);
    assert.ok(!/\b(?:digest|fence|holder|holder_run|error|run_url|shard_id|fields|subject_name)\b/i.test(sql), sql);
    assert.ok(!/select\s+\*/i.test(sql), sql);
    for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) assert.ok(allowed.has(m[1]), `${m[1]} in ${sql}`);
  }
});

test('size: under 20 KB at 15 slots with full lists and 60-character names; over it, recent and just_checked shrink first', () => {
  const db = emptyState();
  const cfg = config({ slots: '15' });
  const long = (i) => `${'o'.repeat(27)}${String(i).padStart(2, '0')}/${'r'.repeat(28)}${String(i).padStart(2, '0')}`;
  assert.equal(long(1).length, 60);
  for (let i = 0; i < 60; i++) addSubject(db, { id: long(i), at: NOW - 86_400_000, tier: i % 5 });
  for (let d = 0; d < 15; d++) {
    const items = Array.from({ length: 4 }, (_, j) => ({ subject: long(d * 4 + j) }));
    addDispatch(db, { attemptId: `a-${d}`, workflow: ['scan-static', 'live-probe', 'writecheck'][d % 3], created: NOW - (d + 1) * 60_000, expires: NOW + HOUR, items });
    addSlot(db, { slot: d, holder: `a-${d}`, at: NOW - 60_000, expires: NOW + HOUR });
  }
  for (let i = 0; i < 400; i++) {
    const lane = ['scan-static', 'live-probe', 'writecheck'][i % 3];
    addEvent(db, { type: 'result_recorded', at: NOW - i * 150_000, lane, subject: long(i % 60), data: { verdict: 'accepted', outcome: 'accepted', fault: 'subject', coverage: 'subject' } });
    addEvent(db, { type: 'retry', at: NOW - i * 200_000 + 1, data: { label: 'state_asset', status: 503, attempts: 2 } });
  }
  db.setKv('pump.breaker', { tripped: true, held: [], checked_at: '2026-11-25T01:00:00.000Z' }, { now: NOW });
  const retry = { call: 'state_asset', status: 503, attempt: 6, of: 6, next_at: NOW + 1000, since: NOW - 600_000 };
  const out = buildLiveSnapshot(db, { now: NOW, config: cfg, retry, version: 'a'.repeat(40) });
  assert.equal(out.snapshot.recent.length, 20);
  assert.equal(out.snapshot.just_checked.results.length, 20);
  assert.ok(out.snapshot.just_checked.results.every((x) => x.subject.length === 60));
  const bytes = Buffer.byteLength(JSON.stringify(out.snapshot), 'utf8');
  assert.ok(bytes < MAX_SNAPSHOT_BYTES, `${bytes} bytes`);
  assert.deepEqual(out.problems, []);
  // Forty more lanes push it over: the lists give way before the snapshot fails.
  const wf = structuredClone(cfg.workflows);
  for (let i = 0; i < 40; i++) wf[`extra-lane-${i}`] = { ...wf['scan-static'] };
  const big = buildLiveSnapshot(db, { now: NOW, config: { ...cfg, workflows: wf }, retry });
  assert.ok(big.snapshot.recent.length < 20, 'recent shrank');
  const bigBytes = Buffer.byteLength(JSON.stringify(big.snapshot), 'utf8');
  assert.ok(bigBytes < MAX_SNAPSHOT_BYTES ? big.problems.length === 0 : big.problems.some((p) => p.rule === 'size'));
});

test('an hour file over 256 KB is replaced by its counts', () => {
  const db = emptyState();
  for (let i = 0; i < 2600; i++) addEvent(db, { type: 'dispatch_sent', at: NOW - 30 * 60_000 + i * 500, lane: 'live-probe', n: 10 });
  const { hourEvents, snapshot, problems } = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(hourEvents, [{ seq: publicSeq(NOW, 1), type: 'hour_counts', occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:00.000Z', lane: null, n: 2600, counts: { batch_sent: 2600 } }]);
  assert.deepEqual(problems, []);
  assert.ok(snapshot.recent.every((e) => e.type !== 'hour_counts'));
  const small = buildLiveSnapshot(db, { now: NOW, config: config(), maxHourBytes: 10_000_000 });
  assert.equal(small.hourEvents.length, 2600);
});

test('quarantine rule: a quarantined result emits nothing and counts only in the next day\'s ring_daily, every class null unless all are 5 or more', () => {
  const day = Date.UTC(2026, 10, 25);
  const build = (yesterday, today, others = 0) => {
    const db = emptyState();
    addSubject(db, { id: ACCEPTED, at: day - 3 * 86_400_000 });
    const q = (at) => addEvent(db, { type: 'result_recorded', at, lane: 'live-probe', subject: ACCEPTED, data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
    for (let i = 0; i < yesterday; i++) q(day - HOUR * (i + 1));
    for (let i = 0; i < today; i++) q(NOW - 60_000 * (i + 1));
    for (const reason of ['stale_fence', 'no_artifact', 'ingest_timeout']) for (let i = 0; i < others; i++) addEvent(db, { type: 'result_recorded', at: day - 60_000 * (i + 1), lane: 'live-probe', data: { verdict: 'rejected', reason } });
    return buildLiveSnapshot(db, { now: NOW, config: config() });
  };
  const nulls = { lease: null, integrity: null, worker_output: null, infra: null };
  for (const [y, t, o, want] of [
    [0, 0, 0, { not_used: null, ...nulls }], [4, 0, 0, { not_used: null, ...nulls }], [4, 9, 0, { not_used: null, ...nulls }],
    [5, 0, 0, { not_used: 5, ...nulls }], [7, 2, 0, { not_used: 7, ...nulls }], [6, 0, 4, { not_used: 18, ...nulls }],
    [6, 0, 5, { not_used: 21, lease: 5, integrity: 6, worker_output: 5, infra: 5 }],
  ]) {
    const { snapshot, hourEvents } = build(y, t, o);
    assert.deepEqual(snapshot.lanes.find((l) => l.id === 'live-probe').ring_daily, want, `${y} yesterday, ${t} today, ${o} of each other class`);
    assert.deepEqual(hourEvents, [], 'no public event of any kind');
    assert.deepEqual(snapshot.recent, []);
    for (const l of snapshot.lanes.filter((x) => x.ring)) assert.deepEqual(l.ring, { accepted: 0 }, l.id);
    assert.equal(snapshot.counts.checked.w24h, 0);
    assert.ok(!/quarantin/i.test(JSON.stringify(snapshot)), 'no key or word names a quarantine');
  }
});

test('R-LIVE-20: ring_daily is the previous complete UTC day, and never moves while a day runs', () => {
  const db = emptyState();
  const day = Date.UTC(2026, 10, 25);
  const rej = (at, reason) => addEvent(db, { type: 'result_recorded', at, lane: 'live-probe', data: { verdict: 'rejected', reason } });
  for (const reason of ['stale_fence', 'digest_mismatch', 'no_artifact', 'ingest_timeout']) for (let i = 0; i < 6; i++) rej(day - 7_200_000 * (i + 1), reason);
  const daily = (now) => buildLiveSnapshot(db, { now, config: config() }).snapshot.lanes.find((l) => l.id === 'live-probe').ring_daily;
  const want = { not_used: 24, lease: 6, integrity: 6, worker_output: 6, infra: 6 };
  assert.deepEqual(daily(NOW), want);
  for (let i = 0; i < 6; i++) rej(NOW - 60_000 * (i + 1), 'stale_fence');
  assert.deepEqual(daily(NOW), want, 'today\'s do not show until the day is over');
  assert.deepEqual(daily(day + 86_400_000 + 60_000), { not_used: 6, lease: null, integrity: null, worker_output: null, infra: null });
});

test('R-LIVE-21: public seq numbers leave no gap where a result was not published; the snapshot seq is not an event id', () => {
  const mk = (withHidden) => {
    const db = emptyState();
    const at = (i) => NOW - 600_000 + i * 1000;
    addEvent(db, { type: 'dispatch_sent', at: at(0), lane: 'live-probe', n: 2 });
    if (withHidden) addEvent(db, { type: 'result_recorded', at: at(1), lane: 'live-probe', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
    addEvent(db, { type: 'dispatch_closed', at: at(2), lane: 'live-probe', n: 2 });
    return buildLiveSnapshot(db, { now: NOW, config: config() });
  };
  const a = mk(false);
  const b = mk(true);
  assert.deepEqual(b.hourEvents, a.hourEvents);
  assert.deepEqual(b.snapshot, a.snapshot);
  assert.deepEqual(b.hourEvents.map((e) => e.seq), [publicSeq(NOW, 1), publicSeq(NOW, 2)]);
  assert.equal(b.snapshot.seq, Math.floor(NOW / 1000));
});

test('R-LIVE-22: now_checking is counts per lane: batches out and the oldest start; no server is named', () => {
  const db = emptyState();
  for (const id of ['a-org/one', 'b-org/two', 'c-org/three']) addSubject(db, { id, at: NOW - 86_400_000 });
  addDispatch(db, { attemptId: 'x1', workflow: 'live-probe', created: NOW - 300_000, expires: NOW + HOUR, items: [{ subject: 'a-org/one', resolved: true }, { subject: 'b-org/two' }, { subject: 'c-org/three' }] });
  addDispatch(db, { attemptId: 'x4', workflow: 'live-probe', created: NOW - 100_000, expires: NOW + HOUR, items: [{ subject: 'a-org/one' }] });
  addDispatch(db, { attemptId: 'x2', workflow: 'live-probe', created: NOW - 200_000, expires: NOW + HOUR, status: 'done', items: [{ subject: 'a-org/one' }] });
  addDispatch(db, { attemptId: 'x3', workflow: 'writecheck', created: NOW - 200_000, expires: NOW - 1, items: [{ subject: 'b-org/two' }] });
  const { snapshot } = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(snapshot.now_checking, [{ lane: 'live-probe', batches_out: 2, since_oldest: new Date(NOW - 300_000).toISOString() }]);
  assert.ok(!/-org\//.test(JSON.stringify(snapshot)));
});

test('R-LIVE-23: a server name that names a vendor, holds a secret, is over 60 characters or not a plain owner/name is left out', () => {
  assert.equal(publicName(ACCEPTED), ACCEPTED);
  assert.equal(publicName(`${'a'.repeat(29)}/${'b'.repeat(30)}`).length, 60);
  for (const bad of [VENDOR_SUBJECT, `${EMAIL}/x`, 'no-slash', 'a/b/c', `x/${FAKE_GH}`, '', null, 42, `${'a'.repeat(30)}/${'b'.repeat(30)}`,
    './x', 'x/..', '.hidden/repo', 'owner/.repo', 'ownér/repo', 'owner/re po', w('x/', 'cl', 'ine'), w('x/', 'gem', 'ma-mcp')]) assert.equal(publicName(bad), null, String(bad));
  const db = emptyState();
  addSubject(db, { id: 'v', name: VENDOR_SUBJECT, at: NOW - 86_400_000 });
  addEvent(db, { type: 'result_recorded', at: NOW - HOUR, lane: 'writecheck', subject: 'v', data: { verdict: 'accepted', coverage: 'assessed' } });
  const out = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.snapshot.just_checked.results, [{ subject: null, lane: 'writecheck', side: 'assessed' }]);
  assert.ok(!('subject' in out.hourEvents[0]));
});

test('R-LIVE-24: a retry call label comes from the fixed list; raw "METHOD /path" labels are mapped, never copied; the mode says which call', () => {
  assert.deepEqual([...RETRY_CALLS], ['github_api', 'state_asset', 'app_token']);
  for (const c of RETRY_CALLS) assert.equal(retryCallLabel(c), c);
  assert.equal(retryCallLabel('POST /repos/isokron-ai/tool-qa/releases/123/assets'), 'state_asset');
  assert.equal(retryCallLabel('POST /app/installations/77/access_tokens'), 'app_token');
  assert.equal(retryCallLabel('POST /repos/o/r/actions/workflows/w.yml/dispatches'), 'github_api');
  for (const raw of [RUN_URL, `GET /x?token=${FAKE_GH}`, 'anything else', null, 7]) assert.equal(retryCallLabel(raw), 'github_api');
  const e = toPublicEvent({ id: 1, type: 'retry', occurred_at: '2026-11-25T21:00:00.123Z', recorded_at: '2026-11-25T21:00:01.000Z', lane: null, n: 1, data: JSON.stringify({ label: 'state_asset', status: 502, attempts: 3, gave_up: false }) });
  assert.deepEqual(e, { seq: null, type: 'retry', occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:01.000Z', lane: null, n: 3, label: 'state_asset', status: 502, state: 'retrying' });
  const db = emptyState();
  const reason = (call) => buildLiveSnapshot(db, { now: NOW, config: config(), retry: { call, status: 502, attempt: 2, of: 6 } }).snapshot.mode_reason;
  assert.equal(reason('github_api'), 'retrying: a GitHub call');
  assert.equal(reason('state_asset'), 'retrying: saving the loop state');
  assert.equal(reason('app_token'), 'retrying: getting an access token');
});

/** An observer's view: every snapshot (but its time and seq) and every hour file, one build per tick. */
function observe(db, from, to, cfg = config()) {
  const seen = [];
  for (let t = from; t <= to; t += 150_000) {
    const out = buildLiveSnapshot(db, { now: t, config: cfg });
    const { generated_at: _g, seq: _s, ...rest } = out.snapshot;
    seen.push({ t, snapshot: rest, hour: out.hourEvents, previous: out.previousHourEvents, problems: out.problems });
  }
  return seen;
}

/**
 * One batch of three on live-probe in the 20:00 hour: a-org/one accepted,
 * b-org/two `fate` (quarantined, rejected for its lease, or accepted),
 * c-org/three rejected; `classes` rejections of each class earlier that day.
 */
function batchState(fate, { classes = 0 } = {}) {
  const db = emptyState();
  const names = ['a-org/one', 'b-org/two', 'c-org/three'];
  for (const id of names) addSubject(db, { id, at: NOW - 3 * 86_400_000 });
  const t = Date.parse('2026-11-25T20:30:00.000Z');
  for (const reason of ['stale_fence', 'digest_mismatch', 'no_artifact', 'ingest_timeout']) {
    for (let i = 0; i < classes; i++) addEvent(db, { type: 'result_recorded', at: Date.UTC(2026, 10, 25, 9, i), lane: 'live-probe', data: { verdict: 'rejected', reason } });
  }
  addDispatch(db, { attemptId: 'b1', workflow: 'live-probe', created: t, expires: t + 180_000 + 1, items: names.map((subject) => ({ subject })) });
  addEvent(db, { type: 'dispatch_sent', at: t + 1000, lane: 'live-probe', n: 3 });
  addEvent(db, { type: 'result_recorded', at: t + 60_000, lane: 'live-probe', subject: names[0], data: { verdict: 'accepted', outcome: 'accepted', coverage: 'assessed' } });
  const second = { quarantined: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' }, lease: { verdict: 'rejected', reason: 'stale_fence', outcome: 'rejected' }, accepted: { verdict: 'accepted', outcome: 'accepted', coverage: 'assessed' } }[fate];
  addEvent(db, { type: 'result_recorded', at: t + 120_000, lane: 'live-probe', subject: names[1], data: second });
  addEvent(db, { type: 'result_recorded', at: t + 180_000, lane: 'live-probe', subject: names[2], data: { verdict: 'rejected', reason: 'no_artifact', outcome: 'rejected' } });
  addEvent(db, { type: 'dispatch_closed', at: t + 180_000, lane: 'live-probe', n: 3 });
  return db;
}

test('R-LIVE-25: an observer of every snapshot and hour file cannot tell a quarantined item from one rejected for its lease, except in the next day\'s ring_daily at 5 or more', () => {
  const from = Date.parse('2026-11-25T20:25:00.000Z');
  const to = Date.parse('2026-11-26T00:10:00.000Z');
  for (const classes of [0, 5]) {
    const q = observe(batchState('quarantined', { classes }), from, to);
    const l = observe(batchState('lease', { classes }), from, to);
    assert.equal(q.length, l.length);
    const blank = (x) => JSON.stringify({ ...x, snapshot: { ...x.snapshot, lanes: x.snapshot.lanes.map((y) => ({ ...y, ring_daily: null })) } });
    for (let i = 0; i < q.length; i++) {
      assert.equal(blank(q[i]), blank(l[i]), `tick ${new Date(q[i].t).toISOString()}`);
      const qd = q[i].snapshot.lanes.find((y) => y.id === 'live-probe').ring_daily;
      const ld = l[i].snapshot.lanes.find((y) => y.id === 'live-probe').ring_daily;
      if (classes === 0 || q[i].t < Date.UTC(2026, 10, 26)) assert.deepEqual(qd, ld, 'identical below 5 and before the day ends');
      else {
        assert.deepEqual(qd, { not_used: 22, lease: 5, integrity: 6, worker_output: 6, infra: 5 });
        assert.deepEqual(ld, { not_used: 22, lease: 6, integrity: 5, worker_output: 6, infra: 5 });
      }
    }
    // No server that was not used is ever named, live or later.
    const text = JSON.stringify(q);
    assert.ok(!text.includes('b-org/two') && !text.includes('c-org/three'));
    assert.ok(text.includes('a-org/one'), 'the accepted one is named, in the next hour');
  }
  // An accepted second item is named, but only from the next hour on.
  const a = observe(batchState('accepted'), from, to);
  const firstNamed = a.find((x) => JSON.stringify(x).includes('b-org/two'));
  assert.equal(new Date(firstNamed.t).toISOString(), '2026-11-25T21:00:00.000Z');
});

test('R-LIVE-26: a named result is published only in the next hour\'s file, sorted by name, its times cut to the hour; the previous hour file is rebuilt for 300 s', () => {
  const db = emptyState();
  for (const id of ['zeta-org/z', 'alpha-org/a', 'mid-org/m']) addSubject(db, { id, at: NOW - 86_400_000 });
  const res = (at, subject) => addEvent(db, { type: 'result_recorded', at, lane: 'scan-static', subject, data: { verdict: 'accepted', coverage: 'assessed' } });
  res(Date.parse('2026-11-25T20:10:00.000Z'), 'zeta-org/z');
  res(Date.parse('2026-11-25T20:40:00.000Z'), 'alpha-org/a');
  addEvent(db, { type: 'pump_run_started', at: Date.parse('2026-11-25T20:59:30.000Z') });
  res(Date.parse('2026-11-25T20:59:55.000Z'), 'mid-org/m');
  const at = (iso) => buildLiveSnapshot(db, { now: Date.parse(iso), config: config() });
  const lastTick = at('2026-11-25T20:59:56.000Z');
  // Written after the last tick of the hour, before it ended.
  addEvent(db, { type: 'pump_run_finished', at: Date.parse('2026-11-25T20:59:58.000Z') });
  assert.ok(!JSON.stringify(published(lastTick)).includes('-org/'), 'nothing named in the hour it happened');
  assert.deepEqual(lastTick.hourEvents.map((e) => e.label), ['started']);
  const early = at('2026-11-25T21:02:00.000Z');
  assert.deepEqual(early.hourEvents.map((e) => [e.subject, e.occurred_at, e.recorded_at]), [
    ['alpha-org/a', '2026-11-25T20:00:00.000Z', '2026-11-25T20:00:00.000Z'],
    ['mid-org/m', '2026-11-25T20:00:00.000Z', '2026-11-25T20:00:00.000Z'],
    ['zeta-org/z', '2026-11-25T20:00:00.000Z', '2026-11-25T20:00:00.000Z'],
  ]);
  assert.deepEqual(early.snapshot.just_checked, { hour: '2026-11-25T20:00:00.000Z', results: [
    { subject: 'alpha-org/a', lane: 'scan-static', side: 'assessed' }, { subject: 'mid-org/m', lane: 'scan-static', side: 'assessed' }, { subject: 'zeta-org/z', lane: 'scan-static', side: 'assessed' },
  ] });
  // The 20:00 file, final, with the event of its last seconds.
  const h20 = Date.parse('2026-11-25T20:00:00Z');
  assert.deepEqual(early.previousHourEvents.map((e) => [e.seq, e.label]), [[publicSeq(h20, 1), 'started'], [publicSeq(h20, 2), 'finished']]);
  assert.equal(at('2026-11-25T21:04:59.000Z').previousHourEvents.length, 2);
  assert.equal(at('2026-11-25T21:05:00.000Z').previousHourEvents, null);
  // The 21:00 file keeps its numbering as the hour fills.
  addEvent(db, { type: 'pump_run_started', at: Date.parse('2026-11-25T21:10:00.000Z') });
  const later = at('2026-11-25T21:20:00.000Z');
  assert.deepEqual(later.hourEvents.slice(0, 3), early.hourEvents);
  assert.equal(later.hourEvents[3].seq, publicSeq(Date.parse('2026-11-25T21:00:00Z'), 4));
  assert.ok(later.snapshot.recent.every((e) => e.type !== 'result'));
});

test('R-LIVE-27: only assessed and subject-side results carry a server name, anywhere', () => {
  const db = emptyState();
  const sides = [['assessed', null, 'assessed'], ['subject', 'subject', 'subject'], ['unassessed_tool', 'tool', 'tool'], ['unassessed_infra', 'infra', 'infra'], ['excluded', 'policy', 'policy'], ['unassessed_unknown', 'unknown', 'unknown'], ['subject', 'tool', 'conflict']];
  for (const [coverage, fault, tag] of sides) {
    addSubject(db, { id: `${tag}-org/server`, at: NOW - 86_400_000 });
    addEvent(db, { type: 'result_recorded', at: NOW - HOUR - 60_000, lane: 'writecheck', subject: `${tag}-org/server`, data: { verdict: 'accepted', outcome: 'accepted', coverage, fault } });
  }
  const out = buildLiveSnapshot(db, { now: NOW, config: config() });
  const text = JSON.stringify(published(out));
  for (const tag of ['tool', 'infra', 'policy', 'unknown', 'conflict']) assert.ok(!text.includes(`${tag}-org/`), tag);
  assert.deepEqual(out.snapshot.just_checked.results.map((x) => x.subject), ['assessed-org/server', 'subject-org/server']);
  assert.deepEqual(out.hourEvents.map((e) => e.subject), ['assessed-org/server', 'subject-org/server']);
  const wc = out.snapshot.lanes.find((l) => l.id === 'writecheck');
  assert.equal(wc.ring.accepted, 7, 'every one still counts, per lane');
  assert.deepEqual(wc.fault, { subject: 1, tool: 1, infra: 1, policy: 1, unknown: 2 });
  const { db: live, now, cfg } = realisticState();
  const f = buildLiveSnapshot(live, { now, config: cfg });
  for (const e of [...f.hourEvents.filter((x) => x.type === 'result'), ...f.snapshot.just_checked.results]) assert.ok(['assessed', 'subject'].includes(e.side), JSON.stringify(e));
});

test('sideOf: coverage wins; a fault side that disagrees with it is unknown, never the server\'s', () => {
  assert.equal(sideOf(null, 'assessed'), 'assessed');
  assert.equal(sideOf('tool', 'assessed'), 'assessed');
  assert.equal(sideOf('subject', 'subject'), 'subject');
  assert.equal(sideOf('tool', 'subject'), 'unknown');
  assert.equal(sideOf('subject', 'unassessed_tool'), 'unknown');
  assert.equal(sideOf(null, 'unassessed_tool'), 'tool');
  assert.equal(sideOf(null, 'excluded'), 'policy');
  assert.equal(sideOf('infra', null), 'infra');
  assert.equal(sideOf(null, null), 'unknown');
  assert.equal(sideOf('weird', 'odd'), 'unknown');
});

test('toPublicEvent maps each internal type to its public shape, and nothing else', () => {
  const base = { id: 9, occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:02.000Z', lane: 'live-probe', n: 10, subject: 'k' };
  const lanes = Object.keys(WORKFLOWS.workflows);
  const pub = (type, data, extra = {}) => toPublicEvent({ ...base, type, data: JSON.stringify(data), ...extra }, { lanes, subjectName: ACCEPTED });
  const head = { seq: null, occurred_at: base.occurred_at, recorded_at: base.recorded_at, lane: 'live-probe', n: 10 };
  const one = { ...head, n: 1 };
  assert.deepEqual(pub('dispatch_sent', { run_id: '1', run_url: RUN_URL }), { ...one, type: 'batch_sent' });
  assert.deepEqual(pub('dispatch_failed', { status: 502 }), { ...one, type: 'batch_not_sent', label: 'GitHub error' });
  assert.deepEqual(pub('dispatch_failed', { status: 422 }), { ...one, type: 'batch_not_sent', label: 'refused' });
  assert.deepEqual(pub('dispatch_failed', { withdrawn: true }), { ...one, type: 'batch_not_sent', label: 'withdrawn' });
  assert.deepEqual(pub('dispatch_unconfirmed', { status: 504 }), { ...one, type: 'batch_not_sent', label: 'GitHub error' });
  assert.deepEqual(pub('dispatch_closed', { close_reason: 'results_in', accepted: 3 }), { ...one, type: 'batch_closed' });
  assert.deepEqual(pub('dispatch_expired', {}), { ...one, type: 'batch_expired' });
  const hour = { occurred_at: '2026-11-25T21:00:00.000Z', recorded_at: '2026-11-25T21:00:00.000Z' };
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted', coverage: 'assessed' }), { ...head, ...hour, n: 1, type: 'result', subject: ACCEPTED, side: 'assessed' });
  assert.deepEqual(pub('result_recorded', { verdict: 'accepted', fault: 'subject', coverage: 'subject' }).side, 'subject');
  for (const d of [{ verdict: 'accepted', coverage: 'excluded' }, { verdict: 'accepted' }, { verdict: 'rejected', reason: 'stale_fence' }, { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' }, { verdict: 'accepted', reason: 'secret_scan' }]) {
    assert.equal(pub('result_recorded', d), null, JSON.stringify(d));
  }
  const loop = { lane: null, n: 1 };
  assert.deepEqual(pub('pump_run_started', { ticks: 0 }, loop), { ...head, ...loop, type: 'pump_run', label: 'started' });
  assert.deepEqual(pub('pump_run_finished', { ticks: 4 }, loop), { ...head, ...loop, type: 'pump_run', label: 'finished' });
  assert.deepEqual(pub('successor', { ok: true, run_id: '5' }, loop), { ...head, ...loop, type: 'pump_run', label: 'successor', state: 'ok' });
  assert.deepEqual(pub('successor', { ok: false, status: 502 }, loop), { ...head, ...loop, type: 'pump_run', label: 'successor', status: 502, state: 'failed' });
  assert.deepEqual(pub('registry_delta', { action: 'dispatched' }, loop), { ...head, ...loop, type: 'history_triggered', state: 'dispatched' });
  assert.equal(pub('registry_delta', { action: 'fresh' }, loop), null);
  assert.deepEqual(pub('breaker_changed', { tripped: true, reason: 'red', held: ['writecheck', 'live-probe', 'nope'] }, loop), { ...head, ...loop, type: 'sandbox_check', state: 'waiting_sandbox_check', lanes: ['live-probe', 'writecheck'] });
  assert.deepEqual(pub('breaker_changed', { tripped: false, held: [] }, loop), { ...head, ...loop, type: 'sandbox_check', state: 'closed', lanes: [] });
  for (const t of ['dispatch_created', 'workflow_paused', 'something_new']) assert.equal(pub(t, {}), null, t);
  assert.equal(toPublicEvent({ ...base, type: 'dispatch_sent', occurred_at: 'yesterday', data: '{}' }), null, 'an unreadable time drops the event');
  assert.equal(toPublicEvent({ ...base, type: 'dispatch_sent', lane: 'not-a-lane', data: '{}' }, { lanes }).lane, null, 'an unknown lane is left out');
  assert.equal(toPublicEvent({ ...base, type: 'dispatch_sent', occurred_at: '2026-11-25T21:00:00.987654Z', data: '{}' }).occurred_at, '2026-11-25T21:00:00.000Z');
});

test('lane states and notes: on, off, not_built (from config), waiting for the sandbox check; notes only from fixed wordings', () => {
  const db = emptyState();
  const lanesOf = (cfg) => Object.fromEntries(buildLiveSnapshot(db, { now: NOW, config: cfg }).snapshot.lanes.map((l) => [l.id, [l.state, l.note]]));
  assert.deepEqual(lanesOf(config()), {
    'scan-static': ['on', null], 'live-probe': ['on', null], 'scan-deep': ['not_built', 'not built yet'], 'build-probe': ['not_built', 'not built yet'],
    writecheck: ['on', null], 'meta-github': ['off', 'off'], 'meta-registry': ['off', 'off'], 'release-diff': ['off', 'off'],
  });
  const cfg = config();
  cfg.lane_notes = { 'live-probe': 're_sweep', writecheck: 'npm_pypi_only', 'meta-github': 'switching_on', 'scan-static': `free text ${FAKE_GH}`, 'release-diff': 'toString', 'meta-registry': null };
  cfg.not_built_lanes = ['scan-deep'];
  const n = lanesOf(cfg);
  assert.deepEqual(n['live-probe'], ['on', LANE_NOTES.re_sweep]);
  assert.deepEqual(n.writecheck, ['on', LANE_NOTES.npm_pypi_only]);
  assert.deepEqual(n['meta-github'], ['off', 'built, switching on next']);
  assert.deepEqual(n['scan-static'], ['on', null], 'free text is never copied');
  assert.deepEqual(n['release-diff'], ['off', 'off']);
  assert.deepEqual(n['meta-registry'], ['off', null]);
  assert.deepEqual(n['build-probe'], ['off', 'off'], 'built once the config says so');
  db.setKv('pump.breaker', { tripped: true, reason: 'stale', held: ['live-probe', 'writecheck'], checked_at: '2026-11-24T06:00:00.000Z' }, { now: NOW });
  const snap = buildLiveSnapshot(db, { now: NOW, config: config() }).snapshot;
  assert.deepEqual(snap.lanes.filter((l) => l.state === 'waiting_sandbox_check').map((l) => l.id), ['live-probe', 'writecheck']);
  assert.deepEqual(snap.breaker, { state: 'waiting_sandbox_check', checked_at: '2026-11-24T06:00:00.000Z', lanes: ['live-probe', 'writecheck'] });
  assert.equal(snap.mode, 'live', 'scan-static still scans');
  const nb = snap.lanes.find((l) => l.id === 'scan-deep');
  assert.deepEqual(nb, { id: 'scan-deep', state: 'not_built', tool: null, pin: null, note: 'not built yet', w1h: null, w24h: null, spark24: null, fault: null, ring: null, ring_daily: null, t0_w24h: null });
  assert.ok(!snap.edges.some((e) => e.to === 'scan-deep'));
});

test('modes: off, paused, retrying, idle (slots 0 or every lane off), waiting for the sandbox self-test, live', () => {
  const db = emptyState();
  const mode = (opts, retry = null, edit = null) => {
    const cfg = config(opts);
    if (edit) edit(cfg);
    const s = buildLiveSnapshot(db, { now: NOW, config: cfg, retry }).snapshot;
    return [s.mode, s.mode_reason];
  };
  const open = { call: 'github_api', status: 502, attempt: 2, of: 6, next_at: NOW + 1000, since: NOW - 5000 };
  assert.deepEqual(mode({ loop: 'false' }), ['off', MODE_REASONS.off]);
  assert.deepEqual(mode({ loop: 'TRUE' }), ['off', MODE_REASONS.off]);
  assert.deepEqual(mode({ pauseUntil: '2026-11-26T00:00:00Z' }), ['paused', 'loop paused by us']);
  assert.deepEqual(mode({ pauseUntil: 'not a time' }), ['paused', 'loop paused by us']);
  assert.deepEqual(mode({ pauseUntil: '2026-11-25T00:00:00Z' }), ['live', 'scanning live']);
  assert.deepEqual(mode({ slots: '0' }), ['idle', 'scanning paused by us']);
  assert.deepEqual(mode({ slots: 'junk' }), ['idle', 'scanning paused by us']);
  assert.deepEqual(mode({}, open), ['retrying', 'retrying: a GitHub call']);
  assert.deepEqual(mode({}, { ...open, gave_up: true }), ['live', 'scanning live']);
  assert.deepEqual(mode({}, { ...open, attempt: 9 }), ['live', 'scanning live']);
  const allOff = (cfg) => { cfg.workflows = structuredClone(cfg.workflows); for (const wf of Object.values(cfg.workflows)) wf.enabled = false; };
  assert.deepEqual(mode({}, null, allOff), ['idle', 'every scanning lane is off']);
  db.setKv('pump.breaker', { tripped: true, checked_at: '2026-11-24T06:00:00.000Z' }, { now: NOW });
  const onlyUntrusted = (cfg) => { cfg.workflows = structuredClone(cfg.workflows); cfg.workflows['scan-static'].enabled = false; };
  assert.deepEqual(mode({}, null, onlyUntrusted), ['waiting', 'waiting for the sandbox self-test']);
  assert.equal(buildLiveSnapshot(db, { now: NOW, config: config({ slots: '40' }) }).snapshot.pump.slots.budget, 15);
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
  const bySeq = new Map(one.hourEvents.map((e) => [e.seq, e]));
  for (const e of one.snapshot.recent.filter((x) => bySeq.has(x.seq))) assert.deepEqual(e, bySeq.get(e.seq));
  const seqs = one.snapshot.recent.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => y - x), 'newest first');
  assert.throws(() => buildLiveSnapshot(a.db, { now: 'nope', config: a.cfg }), TypeError);
});

test('counts and edges follow the events: accepted results and batches sent', () => {
  const db = emptyState();
  addSubject(db, { id: 'a-org/one', at: NOW - 86_400_000, tier: 0 });
  addSubject(db, { id: 'b-org/two', at: NOW - 86_400_000, tier: 2, retired: true });
  addSubject(db, { id: 'c-org/three', at: NOW - 86_400_000, tier: 2 });
  addEvent(db, { type: 'dispatch_sent', at: NOW - 30 * 60_000, lane: 'writecheck', n: 3 });
  addEvent(db, { type: 'dispatch_sent', at: NOW - 3 * 86_400_000, lane: 'writecheck', n: 5 });
  addEvent(db, { type: 'result_recorded', at: NOW - 2 * HOUR, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'accepted', fault: 'infra', coverage: 'unassessed_infra' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 20 * 60_000, lane: 'writecheck', subject: 'a-org/one', data: { verdict: 'accepted', coverage: 'assessed' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 19 * 60_000, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'rejected', reason: 'ingest_timeout' } });
  addEvent(db, { type: 'result_recorded', at: NOW - 18 * 60_000, lane: 'writecheck', subject: 'c-org/three', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  addEvent(db, { type: 'dispatch_closed', at: NOW - 18 * 60_000, lane: 'writecheck', n: 3 });
  addEvent(db, { type: 'result_recorded', at: NOW - 4 * HOUR, lane: 'writecheck', subject: 'b-org/two', data: { verdict: 'accepted', coverage: 'assessed' } });
  addEvent(db, { type: 'dispatch_expired', at: NOW - 3 * HOUR, lane: 'writecheck', n: 2 });
  addEvent(db, { type: 'registry_delta', at: NOW - 10 * 60_000, data: { action: 'dispatched' } });
  addEvent(db, { type: 'registry_delta', at: NOW - 9 * 60_000, data: { action: 'failed' } });
  addResult(db, { subject: 'a-org/one', workflow: 'writecheck', at: NOW - 20 * 60_000, runKey: '1'.repeat(64) });
  const { snapshot, hourEvents } = buildLiveSnapshot(db, { now: NOW, config: config() });
  const wc = snapshot.lanes.find((l) => l.id === 'writecheck');
  assert.deepEqual([wc.w1h, wc.w24h, wc.t0_w24h], [1, 3, 1]);
  assert.deepEqual(wc.ring, { accepted: 3 });
  assert.deepEqual(wc.fault, { subject: 0, tool: 0, infra: 1, policy: 0, unknown: 0 });
  assert.equal(wc.spark24.reduce((x, y) => x + y, 0), 3);
  assert.equal(wc.spark24[23], 1);
  const edge = (from, to) => snapshot.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('pump', 'writecheck'), { from: 'pump', to: 'writecheck', w1h: 1, w24h: 1, w7d: 2 });
  assert.deepEqual(edge('writecheck', 'ingest'), { from: 'writecheck', to: 'ingest', w1h: 1, w24h: 3, w7d: 3 });
  assert.deepEqual(edge('pump', 'history'), { from: 'pump', to: 'history', w1h: 1, w24h: 1, w7d: 1 });
  assert.deepEqual(snapshot.pump.registry_delta, { at: new Date(NOW - 10 * 60_000).toISOString(), w24h: 1 });
  assert.deepEqual(snapshot.counts, { subjects_in_seed: 2, checked: { w24h: 2, w7d: 2, all: 1 }, assessed: { w24h: 2, all: 1 } });
  assert.deepEqual(hourEvents.map((e) => [e.type, e.n]), [['batch_sent', 1], ['batch_closed', 1], ['history_triggered', 1], ['history_triggered', 1]]);
});

test('with the store\'s own event writers: sent, accepted, rejected and quarantined results come out as the plan says', async () => {
  const { openState } = await import('../../state/db.mjs');
  const db = openState(':memory:');
  const t = NOW - HOUR - 10 * 60_000;
  const names = ['a-org/one', 'b-org/two', 'c-org/three'];
  for (const id of names) db.setSubjectVersion({ id, kind: 'github', source: 'seed-v3', tier: 1, name: id, now: t });
  const items = names.map((subject, i) => {
    const runKey = String(i + 1).repeat(64);
    const l = db.acquireLease(runKey, 'att-1', { ttlMs: 3_600_000, now: t });
    return { run_key: runKey, subject, subject_name: subject, fence: l.fence };
  });
  db.createDispatch({ attemptId: 'att-1', shardId: 's-1', workflow: 'live-probe', repo: 'example-org/worker', workflowFile: 'w.yml', ref: 'main', expires: t + 3_600_000, items, now: t });
  db.markDispatched('att-1', { runId: 77, runUrl: RUN_URL, now: t + 1000 });
  db.recordResult({ run_key: items[0].run_key, attempt_id: 'att-1', fence: items[0].fence, verdict: 'accepted', outcome: 'accepted', fault: null, coverage: 'assessed', digest: DIGEST, now: t + 60_000 });
  db.recordResult({ run_key: items[1].run_key, attempt_id: 'att-1', fence: items[1].fence, verdict: 'rejected', outcome: 'quarantined', reason: 'secret_scan', now: t + 61_000 });
  db.recordResult({ run_key: items[2].run_key, attempt_id: 'att-1', fence: items[2].fence, verdict: 'rejected', outcome: 'rejected', reason: 'digest_mismatch', now: t + 62_000 });
  const prev = buildLiveSnapshot(db, { now: t + 63_000, config: config() });
  assert.deepEqual(prev.hourEvents.map((e) => [e.type, e.lane, e.n]), [['batch_sent', 'live-probe', 1], ['batch_closed', 'live-probe', 1]]);
  const { snapshot, hourEvents, problems } = buildLiveSnapshot(db, { now: NOW, config: config() });
  assert.deepEqual(problems, []);
  assert.deepEqual(hourEvents.map((e) => [e.type, e.subject, e.side]), [['result', 'a-org/one', 'assessed']]);
  const text = JSON.stringify([snapshot, hourEvents, prev]);
  assert.ok(!text.includes('b-org/two') && !text.includes('c-org/three'));
  assert.deepEqual(snapshot.lanes.find((l) => l.id === 'live-probe').ring, { accepted: 1 });
});

/**
 * Sixteen batches on writecheck on 24 Nov, thirteen results accepted. `extra`
 * puts that many more items, all not used, into the last batch: with none,
 * every batch has one item and three are not used.
 */
function sixteenBatches(extra) {
  const db = emptyState();
  const day = Date.UTC(2026, 10, 24);
  for (let b = 0; b < 16; b++) {
    const t = day + (b + 1) * HOUR;
    const id = `s${String(b).padStart(2, '0')}-org/server`;
    addSubject(db, { id, at: day - 86_400_000 });
    addEvent(db, { type: 'dispatch_sent', at: t, lane: 'writecheck', n: 1 + (b === 15 ? extra : 0) });
    const accepted = b < 13;
    addEvent(db, { type: 'result_recorded', at: t + 60_000, lane: 'writecheck', subject: id, data: accepted ? { verdict: 'accepted', outcome: 'accepted', coverage: 'assessed' } : { verdict: 'rejected', reason: 'stale_fence', outcome: 'rejected' } });
    for (let k = 0; b === 15 && k < extra; k++) addEvent(db, { type: 'result_recorded', at: t + 60_000, lane: 'writecheck', data: { verdict: 'rejected', reason: 'retry_later', outcome: 'rejected' } });
    addEvent(db, { type: 'dispatch_closed', at: t + 120_000, lane: 'writecheck', n: 1 + (b === 15 ? extra : 0) });
  }
  return db;
}

test('R-LIVE-28: dispatched work is public only as batch counts, so items minus accepted results never reproduces a suppressed not_used', () => {
  // 16 single-item batches with 3 not used, and the same 16 batches with 4 not used (one batch of two):
  // both suppressed (below 5), and every snapshot and hour file is the same.
  const from = Date.parse('2026-11-24T00:30:00.000Z');
  const to = Date.parse('2026-11-25T00:20:00.000Z');
  const three = observe(sixteenBatches(0), from, to, config());
  const four = observe(sixteenBatches(1), from, to, config());
  assert.equal(three.length, four.length);
  for (let i = 0; i < three.length; i++) assert.equal(JSON.stringify(three[i]), JSON.stringify(four[i]), new Date(three[i].t).toISOString());
  const last = three.at(-1).snapshot.lanes.find((l) => l.id === 'writecheck');
  assert.equal(last.ring_daily.not_used, null);
  // No public number is an item count: every batch event says n 1, and no field names items.
  for (const x of three) {
    for (const e of [...x.hour, ...(x.previous ?? []), ...x.snapshot.recent]) if (e.type.startsWith('batch_')) assert.equal(e.n, 1);
    assert.ok(!/items/.test(JSON.stringify(x.snapshot)), 'no items field');
  }
  // With five not used, the total shows: the suppression is what hides three or four.
  const five = observe(sixteenBatches(2), to, to, config());
  assert.equal(five[0].snapshot.lanes.find((l) => l.id === 'writecheck').ring_daily.not_used, 5);
});

test('R-LIVE-29: the pump step is not given LOOP_ENABLED, so its absence reads as on: LOOP_SLOTS=0 is idle "scanning paused by us", never "loop switched off by us"', () => {
  const now = Date.parse('2026-11-26T00:50:53.000Z');
  const db = emptyState();
  const cfg = config({ slots: '0' });
  delete cfg.switches.LOOP_ENABLED;
  delete cfg.switches.LOOP_PAUSE_UNTIL;
  const { snapshot } = buildLiveSnapshot(db, { now, config: cfg });
  assert.equal(snapshot.mode, 'idle');
  assert.equal(snapshot.mode_reason, 'scanning paused by us');
  const off = config({ slots: '0', loop: 'false' });
  assert.equal(buildLiveSnapshot(db, { now, config: off }).snapshot.mode, 'off');
});
