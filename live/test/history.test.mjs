// live/history.mjs (the day file) and publishHistory in live/publish.mjs (the once-a-day rollover).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDay, DAY_SCHEMA, oldestEventMs } from '../history.mjs';
import { publishHistory, publishLive } from '../publish.mjs';
import { cacheControlFor } from '../r2.mjs';
import { REASON_CLASSES } from '../classes.mjs';
import { addEvent, addSubject, config, emptyState, WORKFLOWS } from './seed.mjs';

const DAY = 86_400_000;
const D24 = Date.parse('2026-11-24T00:00:00.000Z');
const AFTER = Date.parse('2026-11-25T00:02:31.000Z');
const w = (...p) => p.join('');
const FAKE_GH = w('gh', 'p_', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn');
const FAKE_KEY = w('-----BEGIN ', 'OPENSSH PRIVATE KEY-----');
const EMAIL = 'jane.person@realmail.org';
const VENDOR = w('open', 'ai');
const ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN', LIVE_R2_SECRET_ACCESS_KEY: 'syn-secret-xyz', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };

const accepted = (coverage, fault = null) => ({ verdict: 'accepted', outcome: 'accepted', coverage, fault });
const rejected = (reason) => ({ verdict: 'rejected', outcome: 'rejected', reason });

function deepKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}

/** One day (24 Nov) of results on live-probe and writecheck, and rows just outside it. */
function seededDay() {
  const db = emptyState();
  for (const id of ['a-org/one', 'b-org/two', 'c-org/three', 'd-org/four']) addSubject(db, { id, at: D24 - 3 * DAY });
  addSubject(db, { id: 'old-org/retired', at: D24 - 3 * DAY, retired: true });
  const at = (h, m = 0) => D24 + h * 3_600_000 + m * 60_000;
  // live-probe: 3 assessed (two servers), 1 subject, 2 tool, 1 infra, 1 policy, 1 unknown; 3 not used.
  addEvent(db, { type: 'result_recorded', at: at(1), lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  addEvent(db, { type: 'result_recorded', at: at(2), lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  addEvent(db, { type: 'result_recorded', at: at(3), lane: 'live-probe', subject: 'b-org/two', data: accepted('assessed') });
  addEvent(db, { type: 'result_recorded', at: at(4), lane: 'live-probe', subject: 'c-org/three', data: accepted('subject', 'subject') });
  addEvent(db, { type: 'result_recorded', at: at(5), lane: 'live-probe', subject: 'c-org/three', data: accepted('unassessed_tool', 'tool') });
  addEvent(db, { type: 'result_recorded', at: at(6), lane: 'live-probe', subject: 'd-org/four', data: accepted('unassessed_tool', 'tool') });
  addEvent(db, { type: 'result_recorded', at: at(7), lane: 'live-probe', subject: 'd-org/four', data: accepted('unassessed_infra', 'infra') });
  addEvent(db, { type: 'result_recorded', at: at(8), lane: 'live-probe', subject: 'd-org/four', data: accepted('excluded', 'policy') });
  addEvent(db, { type: 'result_recorded', at: at(9), lane: 'live-probe', subject: 'd-org/four', data: accepted('unassessed_unknown') });
  for (const reason of ['stale_fence', 'no_artifact', 'digest_mismatch']) addEvent(db, { type: 'result_recorded', at: at(10), lane: 'live-probe', subject: 'b-org/two', data: rejected(reason) });
  // writecheck: one tool result, and 5 of every class not used (20, plus a quarantine counted in integrity).
  addEvent(db, { type: 'result_recorded', at: at(11), lane: 'writecheck', subject: 'a-org/one', data: accepted('unassessed_tool', 'tool') });
  for (const reason of ['stale_fence', 'digest_mismatch', 'no_artifact', 'ingest_timeout']) {
    for (let i = 0; i < 5; i++) addEvent(db, { type: 'result_recorded', at: at(12, i), lane: 'writecheck', subject: 'b-org/two', data: rejected(reason) });
  }
  addEvent(db, { type: 'result_recorded', at: at(13), lane: 'writecheck', subject: 'c-org/three', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  // Just outside the day: never counted.
  addEvent(db, { type: 'result_recorded', at: D24 - 1000, lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  addEvent(db, { type: 'result_recorded', at: D24 + DAY, lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  addEvent(db, { type: 'dispatch_sent', at: at(1), lane: 'live-probe', n: 12 });
  return db;
}

const LANE_KEYS = ['id', 'state', 'pins', 'results', 'assessed', 'sides', 'not_used', 'classes'];

test('day file: the exact shape and the counts of a seeded day', () => {
  const db = seededDay();
  const { day, problems } = buildDay(db, { day: '2026-11-24', now: AFTER, config: config() });
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(day), ['schema', 'day', 'generated_at', 'partial', 'lanes', 'totals', 'tool_releases']);
  assert.equal(day.partial, false);
  assert.equal(day.schema, DAY_SCHEMA);
  assert.equal(day.day, '2026-11-24');
  assert.equal(day.generated_at, '2026-11-25T00:02:31.000Z');
  assert.deepEqual(day.lanes.map((l) => l.id), Object.keys(WORKFLOWS.workflows));
  for (const l of day.lanes) assert.deepEqual(Object.keys(l), LANE_KEYS);
  const lp = day.lanes.find((l) => l.id === 'live-probe');
  assert.deepEqual(lp, {
    id: 'live-probe', state: 'on', pins: ['mcp-check 116b0ca', 'mcp-surface-corpus 4c16b58'],
    results: 9, assessed: 3, sides: { subject: 1, tool: 2, infra: 1, policy: 1, unknown: 1 }, not_used: null, classes: null,
  });
  const wc = day.lanes.find((l) => l.id === 'writecheck');
  assert.deepEqual(wc, {
    id: 'writecheck', state: 'on', pins: ['mcp-writecheck-action 54d4541', 'mcp-writecheck 3af41c6', 'mcp-surface-corpus 4c16b58'],
    results: 1, assessed: 0, sides: { subject: 0, tool: 1, infra: 0, policy: 0, unknown: 0 }, not_used: 21,
    classes: { lease: 5, integrity: 6, worker_output: 5, infra: 5 },
  });
  assert.deepEqual(day.lanes.find((l) => l.id === 'scan-deep'), { id: 'scan-deep', state: 'not_built', pins: [], results: null, assessed: null, sides: null, not_used: null, classes: null });
  assert.equal(day.lanes.find((l) => l.id === 'meta-github').state, 'off');
  assert.deepEqual(day.totals, { subjects_in_seed: 4, servers_checked: 4, servers_assessed: 2 });
  assert.deepEqual(day.tool_releases, []);
  // Built more than a day after it ended (a backfill): see R-LIVE-33.
  const late = buildDay(db, { day: '2026-11-24', now: AFTER + DAY, config: config() }).day;
  assert.deepEqual(late.lanes.map((l) => l.results), day.lanes.map((l) => l.results));
  // Pure: the same state and now give the same bytes; a day not ended is refused.
  assert.equal(JSON.stringify(buildDay(db, { day: '2026-11-24', now: AFTER, config: config() }).day), JSON.stringify(day));
  assert.throws(() => buildDay(db, { day: '2026-11-25', now: AFTER, config: config() }), RangeError);
  assert.throws(() => buildDay(db, { day: '2026-11-31', now: AFTER, config: config() }), TypeError);
  db.close();
});

test('suppression: not_used is null below 5; classes are null unless every class is 5 or more', () => {
  const lane = (rows) => {
    const db = emptyState();
    rows.forEach((reason, i) => addEvent(db, { type: 'result_recorded', at: D24 + i * 60_000, lane: 'live-probe', data: rejected(reason) }));
    const l = buildDay(db, { day: '2026-11-24', now: AFTER, config: config() }).day.lanes.find((x) => x.id === 'live-probe');
    db.close();
    return { not_used: l.not_used, classes: l.classes };
  };
  const times = (reason, k) => Array(k).fill(reason);
  assert.deepEqual(lane(times('stale_fence', 4)), { not_used: null, classes: null });
  assert.deepEqual(lane(times('stale_fence', 5)), { not_used: 5, classes: null });
  assert.deepEqual(lane([...times('stale_fence', 4), ...times('digest_mismatch', 5), ...times('no_artifact', 5), ...times('ingest_timeout', 5)]), { not_used: 19, classes: null });
  assert.deepEqual(lane([...times('stale_fence', 5), ...times('digest_mismatch', 5), ...times('no_artifact', 5), ...times('ingest_timeout', 5)]),
    { not_used: 20, classes: { lease: 5, integrity: 5, worker_output: 5, infra: 5 } });
});

/** A day with three results of one batch, and one item's fate varied. */
function fateState(fate) {
  const db = emptyState();
  for (const id of ['a-org/one', 'b-org/two', 'c-org/three', 'e-org/five']) addSubject(db, { id, at: D24 - 3 * DAY });
  const t = D24 + 20 * 3_600_000;
  addEvent(db, { type: 'dispatch_sent', at: t, lane: 'live-probe', n: 3 });
  addEvent(db, { type: 'result_recorded', at: t + 60_000, lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  if (fate === 'quarantined') {
    addEvent(db, { type: 'result_recorded', at: t + 120_000, lane: 'live-probe', subject: 'b-org/two', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined' } });
  } else {
    addEvent(db, { type: 'result_recorded', at: t + 120_000, lane: 'live-probe', subject: 'b-org/two', data: rejected('stale_fence') });
    // and one extra unused item, of another batch
    addEvent(db, { type: 'dispatch_sent', at: t + 1000, lane: 'live-probe', n: 1 });
    addEvent(db, { type: 'result_recorded', at: t + 150_000, lane: 'live-probe', subject: 'e-org/five', data: rejected('no_artifact') });
  }
  addEvent(db, { type: 'result_recorded', at: t + 180_000, lane: 'live-probe', subject: 'c-org/three', data: rejected('no_artifact') });
  return db;
}

test('R-LIVE-30: a day file cannot tell one quarantined item from one rejected for its lease (and one more unused item) below the threshold: the files are byte-identical', () => {
  const files = ['quarantined', 'lease'].map((fate) => {
    const db = fateState(fate);
    const out = JSON.stringify(buildDay(db, { day: '2026-11-24', now: AFTER, config: config() }).day);
    db.close();
    return out;
  });
  assert.equal(files[0], files[1]);
  const lp = JSON.parse(files[0]).lanes.find((l) => l.id === 'live-probe');
  assert.equal(lp.not_used, null);
  assert.equal(lp.classes, null);
  assert.equal(lp.results, 1);
  // No number in it is a dispatched item count (R-LIVE-28): 3 and 4 items were sent.
  assert.ok(!/items|"n"|batch/.test(files[0]));
});

test('never public: a hostile state gives a day file with no server, reason, id or secret, and no held key; a vendor-named lane blocks it', () => {
  const db = emptyState();
  const poison = { error: `${FAKE_GH} ${EMAIL} ${FAKE_KEY}`, digest: 'd'.repeat(64), fence: 987654321, attempt_id: 'att-7f3e1c9a0b2d', run_key: 'f'.repeat(64), run_url: 'https://github.com/example-org/worker/actions/runs/424242424242', model: VENDOR, held_for_disclosure: 3 };
  addSubject(db, { id: 'privy-corp/secret-held-server', at: D24 - DAY });
  addSubject(db, { id: 'vk', name: `someone/mcp-${VENDOR}-bridge`, at: D24 - DAY });
  let k = 0;
  for (const reason of Object.keys(REASON_CLASSES)) addEvent(db, { type: 'result_recorded', at: D24 + (k++) * 1000, lane: 'live-probe', subject: 'privy-corp/secret-held-server', data: { ...rejected(reason), ...poison } });
  addEvent(db, { type: 'result_recorded', at: D24 + (k++) * 1000, lane: 'live-probe', subject: 'privy-corp/secret-held-server', data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined', ...poison } });
  addEvent(db, { type: 'result_recorded', at: D24 + (k++) * 1000, lane: 'scan-static', subject: 'vk', data: { ...accepted('assessed'), ...poison } });
  for (const type of ['dispatch_sent', 'dispatch_failed', 'workflow_paused', 'retry', 'breaker_changed', 'some_future_type']) {
    addEvent(db, { type, at: D24 + (k++) * 1000, lane: 'writecheck', n: 7, subject: 'privy-corp/secret-held-server', data: { ...poison, label: `PUT /x?token=${FAKE_GH}` } });
  }
  const cfg = config();
  cfg.workflows = structuredClone(cfg.workflows);
  cfg.workflows['live-probe'].versions.tool = { [`tool ${FAKE_GH}`]: '1', [`${VENDOR}-tool`]: '1.0', 'mcp-check': EMAIL, ok: '116b0ca' };
  cfg.workflows['live-probe'].versions.probe = { 'mcp-surface-corpus': VENDOR };
  cfg.workflows[`Bad ${EMAIL}`] = { enabled: true };
  cfg.switches.APP_PRIVATE_KEY = FAKE_KEY;
  const { day, problems } = buildDay(db, { day: '2026-11-24', now: AFTER, config: cfg });
  assert.deepEqual(problems, []);
  const text = JSON.stringify(day);
  for (const s of [FAKE_GH, FAKE_KEY, 'PRIVATE KEY', EMAIL, 'realmail', 'd'.repeat(64), '987654321', 'att-7f3e', 'f'.repeat(64), '424242424242', 'privy-corp', 'secret-held', 'bridge', 'secret_scan', 'quarantin', 'held', 'reason', 'fence', 'digest', 'run_key', 'some_future_type', 'paused', ...Object.keys(REASON_CLASSES), VENDOR]) {
    assert.ok(!text.includes(s), `day file holds ${s}`);
  }
  assert.ok(!deepKeys(day).some((x) => /held/i.test(x)));
  assert.deepEqual(day.lanes.find((l) => l.id === 'live-probe').pins, ['ok 116b0ca']);
  assert.equal(day.lanes.find((l) => l.id === 'writecheck').results, 0);
  // A lane id that names a vendor passes the id rule but not the scan: problems, so nothing is uploaded.
  cfg.workflows[`${VENDOR}-lane`] = { enabled: true };
  const blocked = buildDay(db, { day: '2026-11-24', now: AFTER, config: cfg });
  assert.ok(blocked.problems.length > 0);
  assert.ok(blocked.problems.every((p) => Object.keys(p).join() === 'rule,path' && !JSON.stringify(p).includes(VENDOR)));
  db.close();
});

test('cache policy: day files immutable, recent and index 300 s', () => {
  assert.equal(cacheControlFor('v1/history/days/2026-11-24.json'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('v1/history/recent.json'), 'public, max-age=300');
  assert.equal(cacheControlFor('v1/history/index.json'), 'public, max-age=300');
  assert.throws(() => cacheControlFor('v1/history/days/latest.json'));
});

// ---- the rollover ----

/** Events from 20 Nov 10:00 on, one accepted result a day. */
function loopState() {
  const db = emptyState();
  addSubject(db, { id: 'a-org/one', at: D24 - 10 * DAY });
  for (let t = Date.parse('2026-11-20T10:00:00Z'); t < Date.parse('2026-11-28T00:00:00Z'); t += DAY) {
    addEvent(db, { type: 'result_recorded', at: t, lane: 'live-probe', subject: 'a-org/one', data: accepted('assessed') });
  }
  return db;
}

function recorder({ fail = () => false } = {}) {
  const puts = [];
  const putter = async (key, body, o) => {
    puts.push({ key, body, cc: o?.cacheControl });
    if (fail(key)) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    return { status: 200 };
  };
  return { puts, putter };
}

const roll = (db, at, rec, extra = {}) => publishHistory({ db, putter: rec.putter, now: at, config: config(), ...extra });
/** Publish (one minute apart) until the rollover is done or fails; the results of each call. */
async function rollAll(db, at, rec, extra = {}) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const r = await roll(db, at + i * 60_000, rec, extra);
    out.push(r);
    if (!r.more) break;
  }
  return out;
}
const DAYS = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];

test('rollover: the first run backfills the covered days oldest first, two per publish, then recent, then index; once per day; then one day a day', async () => {
  const db = loopState();
  assert.equal(oldestEventMs(db), Date.parse('2026-11-20T10:00:00Z'));
  const rec = recorder();
  const calls = await rollAll(db, AFTER, rec);
  assert.deepEqual(calls.map((r) => [r.ok, r.more ?? false, r.written]), [[true, true, DAYS.slice(0, 2)], [true, true, DAYS.slice(2, 4)], [true, false, DAYS.slice(4)]]);
  // 17-19 Nov are before the loop's first event (or pruned): never built.
  assert.deepEqual(rec.puts.map((p) => p.key), [...DAYS.map((d) => `v1/history/days/${d}.json`), 'v1/history/recent.json', 'v1/history/index.json']);
  assert.deepEqual(rec.puts.map((p) => p.cc), [...DAYS.map(() => 'public, max-age=31536000, immutable'), 'public, max-age=300', 'public, max-age=300']);
  assert.deepEqual(JSON.parse(rec.puts.at(-1).body), { schema: 'isokron-loop-history-index/1', days: DAYS });
  const recent = JSON.parse(rec.puts.at(-2).body);
  assert.equal(recent.schema, 'isokron-loop-history-recent/1');
  assert.deepEqual(recent.days.map((d) => d.day), DAYS);
  assert.equal(recent.days[0].lanes.find((l) => l.id === 'live-probe').results, 1);
  assert.deepEqual(JSON.parse(rec.puts[4].body), recent.days[4], 'recent holds the day files as uploaded');
  assert.equal(db.getKv('live.history.last_day'), '2026-11-24');
  assert.equal(db.getKv('live.history.pending'), undefined);
  // Again the same day, and later that day: nothing.
  const again = recorder();
  assert.deepEqual(await roll(db, AFTER + 60_000, again), { ok: true, skipped: 'done' });
  assert.deepEqual(await roll(db, AFTER + 23 * 3_600_000, again), { ok: true, skipped: 'done' });
  assert.equal(again.puts.length, 0);
  // The next day: one day file, recent, index.
  const next = recorder();
  await roll(db, AFTER + DAY, next);
  assert.deepEqual(next.puts.map((p) => p.key), ['v1/history/days/2026-11-25.json', 'v1/history/recent.json', 'v1/history/index.json']);
  assert.equal(JSON.parse(next.puts[2].body).days.length, 6);
  assert.equal(db.getKv('live.history.last_day'), '2026-11-25');
  db.close();
});

test('rollover: a failed upload leaves last_day; the next publish goes on and never builds a stored day again', async () => {
  for (const failing of ['v1/history/days/2026-11-22.json', 'v1/history/recent.json', 'v1/history/index.json']) {
    const db = loopState();
    const first = recorder({ fail: (k) => k === failing });
    const calls = await rollAll(db, AFTER, first);
    assert.equal(calls.at(-1).ok, false);
    assert.equal(calls.at(-1).error, 'put');
    assert.equal(first.puts.at(-1).key, failing, 'stops at the failure');
    assert.equal(db.getKv('live.history.last_day'), undefined, `last_day recorded after ${failing} failed`);
    const second = recorder();
    assert.equal((await rollAll(db, AFTER + 600_000, second)).at(-1).ok, true);
    const sent = new Map();
    for (const p of [...first.puts, ...second.puts].filter((x) => x.key.includes('/days/'))) {
      if (sent.has(p.key)) assert.equal(p.body, sent.get(p.key), `${p.key} got a second body`);
      sent.set(p.key, p.body);
    }
    assert.deepEqual(second.puts.slice(-2).map((p) => p.key), ['v1/history/recent.json', 'v1/history/index.json']);
    assert.deepEqual(JSON.parse(second.puts.at(-1).body).days, DAYS);
    assert.equal(db.getKv('live.history.last_day'), '2026-11-24');
    db.close();
  }
});

test('R-LIVE-31: a day file whose PUT landed but answered an error (or whose kv record failed after it) is sent again byte-identical, never rebuilt', async () => {
  // A PUT that stores the body and then throws, as a timeout after the write would.
  const db = loopState();
  const bucket = new Map();
  const puts = [];
  let lose = 'v1/history/days/2026-11-21.json';
  const putter = async (key, body) => {
    puts.push({ key, body });
    bucket.set(key, bucket.has(key) && key.includes('/days/') && bucket.get(key) !== body ? 'SECOND BODY' : body);
    if (key === lose) { lose = null; throw Object.assign(new Error('timeout'), { status: 0 }); }
  };
  const r1 = await publishHistory({ db, putter, now: AFTER, config: config() });
  assert.equal(r1.ok, false);
  assert.equal(db.getKv('live.history.pending').day, '2026-11-21');
  // Retried hours later (a rebuild would change generated_at): the stored body again.
  await rollAll(db, AFTER + 5 * 3_600_000, { putter });
  const sends = puts.filter((p) => p.key === 'v1/history/days/2026-11-21.json');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body, sends[0].body);
  assert.ok(![...bucket.values()].includes('SECOND BODY'));
  assert.equal(db.getKv('live.history.pending'), undefined);
  assert.equal(db.getKv('live.history.last_day'), '2026-11-24');
  // A kv write that fails after a good PUT: the day stays pending and the same body goes again.
  const db2 = loopState();
  let breakOnce = true;
  const flaky = new Proxy(db2, { get: (o, k) => (k === 'setKv' ? (key, v, opt) => { if (key === 'live.history.days' && breakOnce) { breakOnce = false; throw new Error('database is locked'); } return o.setKv(key, v, opt); } : Reflect.get(o, k)) });
  const p2 = [];
  const put2 = async (key, body) => { p2.push({ key, body }); };
  assert.equal((await publishHistory({ db: flaky, putter: put2, now: AFTER, config: config() })).ok, false);
  await rollAll(flaky, AFTER + 3_600_000, { putter: put2 });
  const first = p2.filter((p) => p.key === 'v1/history/days/2026-11-20.json');
  assert.equal(first.length, 2);
  assert.equal(first[1].body, first[0].body);
  assert.deepEqual(JSON.parse(p2.at(-1).body).days, DAYS);
  db.close();
  db2.close();
});

test('R-LIVE-32: a day is built only when the events table holds all of it; the loop\'s first day is built once, marked partial', async () => {
  // Events from 20 Nov 10:00: 20 Nov is the first day (partial), 17-19 Nov are not built.
  const db = loopState();
  const rec = recorder();
  await rollAll(db, AFTER, rec);
  const files = rec.puts.filter((p) => p.key.includes('/days/')).map((p) => JSON.parse(p.body));
  assert.deepEqual(files.map((d) => [d.day, d.partial]), DAYS.map((d) => [d, d === '2026-11-20']));
  // Events from 16 Nov 10:00, as left by pruning: 17 Nov starts outside the 8 days kept, so it is not built
  // even though it holds events; 18 Nov on are whole.
  const db2 = emptyState();
  for (let t = Date.parse('2026-11-16T10:00:00Z'); t < AFTER; t += 6 * 3_600_000) addEvent(db2, { type: 'pump_run_started', at: t });
  const rec2 = recorder();
  await rollAll(db2, AFTER, rec2);
  const days2 = rec2.puts.filter((p) => p.key.includes('/days/')).map((p) => JSON.parse(p.body));
  assert.deepEqual(days2.map((d) => d.day), ['2026-11-18', '2026-11-19', ...DAYS]);
  assert.ok(days2.every((d) => d.partial === false));
  // A day whose start is after the oldest event but which is not the first day: never partial.
  assert.equal(buildDay(db2, { day: '2026-11-24', now: AFTER, config: config() }).day.partial, false);
  // No events at all: nothing is built.
  const db3 = emptyState();
  const rec3 = recorder();
  await rollAll(db3, AFTER, rec3);
  assert.equal(rec3.puts.filter((p) => p.key.includes('/days/')).length, 0);
  for (const d of [db, db2, db3]) d.close();
});

test('R-LIVE-33: a day built more than a day after it ended has lane state and pins null; the first build in its window uses the config', () => {
  const db = seededDay();
  const fresh = buildDay(db, { day: '2026-11-24', now: Date.parse('2026-11-25T23:59:59Z'), config: config() }).day;
  assert.equal(fresh.lanes.find((l) => l.id === 'live-probe').state, 'on');
  assert.deepEqual(fresh.lanes.find((l) => l.id === 'live-probe').pins, ['mcp-check 116b0ca', 'mcp-surface-corpus 4c16b58']);
  const late = buildDay(db, { day: '2026-11-24', now: Date.parse('2026-11-26T00:00:00Z'), config: config() }).day;
  assert.ok(late.lanes.every((l) => l.state === null && l.pins === null));
  assert.equal(late.lanes.find((l) => l.id === 'live-probe').results, 9);
  assert.equal(late.lanes.find((l) => l.id === 'scan-deep').results, null, 'a lane not built has no numbers either way');
  db.close();
});

test('R-LIVE-34: a blocked day is kept once in live.history.blocked and not built again; backfill builds at most two days per publish', async () => {
  const db = loopState();
  db.setKv('live.history.days', ['2026-11-21', '2026-11-23'], { now: AFTER });
  const rec = recorder();
  const calls = await rollAll(db, AFTER, rec);
  assert.deepEqual(calls.map((r) => r.written), [['2026-11-20', '2026-11-22'], ['2026-11-24']]);
  assert.deepEqual(JSON.parse(rec.puts.at(-1).body).days, DAYS);
  // Blocked: a vendor-named lane in the config. The recent upload fails once, so the rollover runs again.
  const db2 = loopState();
  const cfg = config();
  cfg.workflows = { ...cfg.workflows, [`${VENDOR}-lane`]: { enabled: true } };
  const lines = [];
  let failRecent = true;
  const rec2 = recorder({ fail: (k) => { if (k === 'v1/history/recent.json' && failRecent) { failRecent = false; return true; } return false; } });
  const builds = [];
  const counting = (d, o) => { builds.push(o.day); return buildDay(d, o); };
  const r1 = await rollAll(db2, AFTER + DAY * 3, rec2, { config: cfg, log: (l) => lines.push(l), buildDay: counting, oldestEventMs });
  assert.equal(r1.at(-1).error, 'put');
  const r2 = await rollAll(db2, AFTER + DAY * 3 + 600_000, rec2, { config: cfg, buildDay: counting, oldestEventMs });
  assert.equal(r2.at(-1).ok, true);
  assert.ok(r1.slice(0, -1).every((r) => r.blocked.length <= 2));
  assert.equal(rec2.puts.filter((p) => p.key.includes('/days/')).length, 0);
  const blocked = db2.getKv('live.history.blocked').map((b) => b.day);
  assert.deepEqual(blocked, [...new Set(blocked)], 'each blocked day once');
  assert.deepEqual(builds, [...new Set(builds)], 'a blocked day is not built again');
  assert.equal(blocked.at(-1), '2026-11-27');
  assert.ok(lines.some((l) => /blocked by the scan: rule /.test(l)) && !lines.join().includes(VENDOR));
  db.close();
  db2.close();
});

test('publishLive: the history goes after the pointer; switch off makes no call; inside a transaction nothing; a hang is cut at the deadline with the snapshot kept', async () => {
  const good = async () => ({ snapshot: { schema: 'isokron-loop-live/1', seq: 42, generated_at: '2026-11-25T00:02:31.000Z', recent: [] }, hourEvents: [], problems: [] });
  const db = loopState();
  const puts = [];
  const put = async (key) => { puts.push(key); return { status: 200 }; };
  const r = await publishLive({ db, build: good, put, env: ENV, now: () => AFTER, config: config(), deadlineMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.history.ok, true);
  const ptr = puts.indexOf('v1/latest.json');
  // At most two day files per publish: the first two days of the backfill, no recent or index yet.
  assert.deepEqual(puts.slice(ptr + 1), ['v1/history/days/2026-11-20.json', 'v1/history/days/2026-11-21.json'], puts.join(' '));
  assert.equal(r.history.more, true);
  // Off: no build, no call, no kv.
  for (const v of [undefined, 'false', 'TRUE', '1']) {
    const db2 = loopState();
    let calls = 0;
    const out = await publishLive({ db: db2, build: good, put: async () => { calls += 1; }, env: { ...ENV, LANE_LIVE_SNAPSHOT_ENABLED: v }, now: () => AFTER, config: config() });
    assert.deepEqual(out, { ok: false, skipped: 'off' });
    assert.equal(calls, 0);
    assert.equal(db2.getKv('live.history.last_day'), undefined);
    db2.close();
  }
  // history: false (or the snapshot failing) writes no history.
  const db3 = loopState();
  const p3 = [];
  await publishLive({ db: db3, build: good, put: async (k) => { p3.push(k); }, env: ENV, now: () => AFTER, config: config(), history: false });
  assert.ok(!p3.some((k) => k.startsWith('v1/history/')));
  // Inside a transaction publishHistory builds nothing.
  const rec = recorder();
  const inTx = new Proxy(db3, { get: (o, k) => (k === 'inTx' ? true : Reflect.get(o, k)) });
  assert.deepEqual(await roll(inTx, AFTER, rec), { ok: false, skipped: 'in_tx' });
  assert.equal(rec.puts.length, 0);
  // A history upload that hangs: the call returns at the deadline, the snapshot's good record stays, last_day is not set.
  const db4 = loopState();
  const hang = (key, _b, o) => (key.startsWith('v1/history/') ? new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) : Promise.resolve({ status: 200 }));
  const t0 = Date.now();
  const cut = await publishLive({ db: db4, build: good, put: hang, env: ENV, config: config(), now: () => AFTER, deadlineMs: 80 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(cut.ok, true);
  assert.equal(cut.history.ok, false);
  assert.equal(db4.getKv('live.last_upload').ok, true);
  assert.equal(db4.getKv('live.history.last_day'), undefined);
  for (const d of [db, db3, db4]) d.close();
});

test('publishLive every 60 s across midnight: the rollover runs once per day, only after a good snapshot upload', async () => {
  const good = async (_db, { now }) => ({ snapshot: { schema: 'isokron-loop-live/1', seq: Math.floor(now / 1000), generated_at: new Date(now).toISOString(), recent: [] }, hourEvents: [], problems: [] });
  const db = loopState();
  db.setKv('live.history.last_day', '2026-11-23', { now: AFTER - DAY });
  db.setKv('live.history.days', ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'], { now: AFTER - DAY });
  const puts = [];
  let failSnap = false;
  const put = async (key) => {
    puts.push(key);
    if (failSnap && key.startsWith('v1/snap/')) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    return { status: 200 };
  };
  const midnight = Date.parse('2026-11-25T00:00:00Z');
  for (let t = midnight - 5 * 60_000; t < midnight + 30 * 60_000; t += 60_000) {
    failSnap = t < midnight + 3 * 60_000; // the first post-midnight snapshots fail
    const before = puts.length;
    const r = await publishLive({ db, build: good, put, env: ENV, now: () => t, config: config(), deadlineMs: 5000 });
    const hist = puts.slice(before).filter((k) => k.startsWith('v1/history/'));
    if (failSnap) assert.deepEqual(hist, [], `history after a failed snapshot at ${new Date(t).toISOString()}`);
    if (t === midnight + 3 * 60_000) {
      assert.equal(r.ok, true);
      assert.deepEqual(hist, ['v1/history/days/2026-11-24.json', 'v1/history/recent.json', 'v1/history/index.json']);
    }
  }
  assert.equal(puts.filter((k) => k.startsWith('v1/history/days/')).length, 1);
  assert.equal(puts.filter((k) => k === 'v1/history/index.json').length, 1);
  assert.equal(db.getKv('live.history.last_day'), '2026-11-24');
  db.close();
});
