// Fake states for the live snapshot tests and fixtures. Everything here is
// made up: server names, ids, times. Facts are written with plain SQL and
// events straight into the events table, so the tests describe exactly the
// rows they mean, whatever the store's own methods add.

import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';

// A frozen copy of pump/workflows.json, so a pin bump does not change the fixtures.
export const WORKFLOWS = JSON.parse(readFileSync(new URL('./fixtures/workflows.json', import.meta.url), 'utf8'));

/** A small deterministic random source (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString();

export function emptyState() {
  const db = openState(':memory:');
  db.raw.exec('DELETE FROM events');
  return db;
}

/** Append an event row as the pump would. */
export function addEvent(db, { type, at, recordedAt = at, lane = null, n = 1, subject = null, data = {} }) {
  if (Array.isArray(db.events)) { db.events.push({ type, at, recordedAt, lane, n, subject, data }); return; }
  db.raw.prepare('INSERT INTO events (type, occurred_at, recorded_at, lane, n, subject, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(type, iso(at), iso(recordedAt), lane, n, subject, JSON.stringify(data));
}

export function addSubject(db, { id, name = id, tier = 4, source = 'seed-v3', at, retired = false }) {
  db.raw.prepare(`INSERT INTO subjects (id, kind, source, first_seen, last_seen, tier, name, retired_at) VALUES (?, 'github', ?, ?, ?, ?, ?, ?)`)
    .run(id, source, iso(at), iso(at), tier, name, retired ? iso(at) : null);
}

export function addResult(db, { subject, workflow, at, coverage = 'assessed', fault = null, runKey, digest = null }) {
  db.raw.prepare(`INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, digest, accepted_at, measured_at, fault, coverage, assessed_at)
    VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?)`)
    .run(runKey, subject, workflow, `att-${runKey.slice(0, 8)}`, 1, digest, iso(at), iso(at), fault, coverage, coverage === 'assessed' ? iso(at) : null);
}

/** A dispatch with its items; status 'dispatched' and live unless told otherwise. */
export function addDispatch(db, { attemptId, workflow, created, expires, status = 'dispatched', items, shardId = `shard-${attemptId}`, runUrl = null, error = null, closed = null }) {
  db.raw.prepare(`INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status, run_id, run_url, error, closed)
    VALUES (?, ?, ?, 'example-org/worker', 'w.yml', 'main', ?, ?, ?, '1234567', ?, ?, ?)`)
    .run(attemptId, shardId, workflow, iso(created), iso(expires), status, runUrl, error, closed === null ? null : iso(closed));
  items.forEach((it, i) => {
    db.raw.prepare('INSERT INTO dispatch_items (attempt_id, run_key, subject, workflow, fence, item_index, subject_name, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attemptId, it.runKey ?? `${attemptId}-rk-${i}`, it.subject, workflow, it.fence ?? 1, i, it.name ?? it.subject, it.resolved ? iso(created) : null);
  });
}

export function addSlot(db, { slot, holder, at, expires }) {
  db.raw.prepare('INSERT INTO slot_ledger (slot, holder_run, acquired, expires) VALUES (?, ?, ?, ?)').run(slot, holder, iso(at), iso(expires));
}

export function config({ slots = '2', loop = 'true', pauseUntil = '', publish = '', workflows = WORKFLOWS.workflows, history } = {}) {
  return {
    ...WORKFLOWS,
    workflows,
    switches: { LOOP_ENABLED: loop, LOOP_PAUSE_UNTIL: pauseUntil, LOOP_SLOTS: slots, RESULTS_PUBLISH_ENABLED: publish },
    history: history ?? [
      { kind: 'registry-delta', last_capture_at: '2026-11-25T21:31:02.000Z', versions: 37 },
      { kind: 'registry-full', last_capture_at: '2026-11-25T12:46:00.000Z', registry_size: 73655 },
      { kind: 'packages', last_capture_at: '2026-11-25T03:12:40.000Z' },
      { kind: 'popularity', last_capture_at: '2026-11-23T04:05:11.000Z' },
    ],
  };
}

const OWNERS = ['acme-labs', 'northwind-io', 'contoso-dev', 'fabrikam', 'tailspin-tools', 'globex-oss', 'initech', 'umbrella-data', 'hooli-xyz', 'piedpiper-net', 'vandelay-ind', 'wayne-ent'];
const REPOS = ['mcp-server-weather', 'files-mcp', 'mcp-postgres', 'calendar-mcp-server', 'mcp-git-tools', 'notes-mcp', 'mcp-redis-bridge', 'kanban-mcp', 'mcp-search-lite', 'mcp-time', 'docs-mcp-server', 'mcp-shell-guard'];

/** n made-up subjects: {key, name, tier}. */
export function subjectsFor(count, rand) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const owner = OWNERS[i % OWNERS.length];
    const repo = REPOS[Math.floor(i / OWNERS.length) % REPOS.length] + (i >= OWNERS.length * REPOS.length ? `-${i}` : '');
    out.push({ key: `${owner}/${repo}`, name: `${owner}/${repo}`, tier: i < 6 ? 0 : 1 + Math.floor(rand() * 4) });
  }
  return out;
}

const LANES = { 'scan-static': { n: 25, every: 40 }, 'live-probe': { n: 10, every: 25 }, writecheck: { n: 10, every: 120 } };
const SIDES = [['assessed', null, 70], ['subject', 'subject', 10], ['unassessed_tool', 'tool', 6], ['unassessed_infra', 'infra', 4], ['excluded', 'policy', 5], ['unassessed_unknown', 'unknown', 5]];
const REJECTS = ['lease_expired', 'retry_later', 'no_artifact', 'digest_mismatch', 'ingest_timeout', 'stale_fence', 'retry_throttled'];

function pickSide(rand, lane) {
  if (lane === 'writecheck' && rand() < 0.6) return ['unassessed_unknown', 'unknown'];
  let x = rand() * 100;
  for (const [cov, fault, w] of SIDES) { if ((x -= w) < 0) return [cov, fault]; }
  return ['assessed', null];
}

/**
 * A realistic state: the pump running back to back for two days on three
 * lanes at LOOP_SLOTS=2, with results, some rejections, a few quarantines,
 * registry deltas and retries.
 * @returns {{db, now: number, cfg: object}}
 */
export function realisticState({ now = Date.parse('2026-11-25T21:40:00.000Z'), seed = 7, days = 2, slots = '2', openBatches = true, quarantinedYesterday = 6, batchesUntil = now, retries = [], tickAt = now - 30_000 } = {}) {
  const rand = rng(seed);
  const real = emptyState();
  // Events are written in time order at the end, as the pump would have written them.
  const buffered = [];
  const db = new Proxy(real, { get: (o, k) => (k === 'events' ? buffered : Reflect.get(o, k)) });
  const subs = subjectsFor(140, rand);
  const start = now - days * 86_400_000;
  for (const s of subs) addSubject(db, { id: s.key, name: s.name, tier: s.tier, at: start - 86_400_000 });
  let rk = 0;
  const runKey = () => (rk++).toString(16).padStart(64, '0');

  // Pump runs back to back, ~10.5 min each.
  // With LOOP_SLOTS=0 (from batchesUntil on, when slots is '0') a run does one
  // housekeeping tick and starts no successor; the half-hourly schedule starts the next.
  const idleFrom = slots === '0' ? batchesUntil : Infinity;
  for (let t = start; t < now;) {
    const idle = t >= idleFrom;
    addEvent(db, { type: 'pump_run_started', at: t, data: { ticks: 0 } });
    if (!idle) addEvent(db, { type: 'successor', at: t + 4_000, data: { ok: true, run_id: '9100000001' } });
    const len = idle ? 70_000 : 620_000;
    if (t + len < now) addEvent(db, { type: 'pump_run_finished', at: t + len, data: { ticks: idle ? 1 : 4, dispatched: idle ? 0 : 1 } });
    t = idle ? Math.floor(t / 1_800_000) * 1_800_000 + 1_800_000 + 41_000 : t + 630_000;
  }
  // Registry deltas every ~45 min.
  for (let t = start + 300_000; t < now; t += 45 * 60_000) addEvent(db, { type: 'registry_delta', at: t, data: { action: 'dispatched' } });
  // A short GitHub incident: state push retries.
  addEvent(db, { type: 'retry', at: now - 5 * 3_600_000, data: { label: 'state_asset', status: 502, attempts: 3, gave_up: false } });
  for (const r of retries) addEvent(db, { type: 'retry', at: r.at, data: { label: r.label, status: r.status, attempts: r.attempts, gave_up: r.gave_up ?? false } });
  addEvent(db, { type: 'breaker_changed', at: start + 60_000, data: { tripped: false, reason: null, held: [] } });

  // Batches and their results.
  let si = 0;
  let qLeft = quarantinedYesterday;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  for (const [lane, { n, every }] of Object.entries(LANES)) {
    for (let t = start + every * 30_000; t < batchesUntil - 50 * 60_000; t += every * 60_000) {
      const attemptId = `${lane}-${t}`;
      addEvent(db, { type: 'dispatch_created', at: t, lane, n, data: { shard_id: `shard-${t}`, items: n } });
      addEvent(db, { type: 'dispatch_sent', at: t + 2_000, lane, n, data: { run_id: '9200000001', run_url: 'https://github.com/example-org/worker/actions/runs/9200000001' } });
      const batch = Array.from({ length: n }, () => subs[si++ % subs.length]);
      if (rand() < 0.03) {
        addDispatch(real, { attemptId, workflow: lane, created: t, expires: t + 40 * 60_000, status: 'expired', closed: t + 40 * 60_000, items: batch.map((x) => ({ subject: x.key, name: x.name })) });
        addEvent(db, { type: 'dispatch_expired', at: t + 40 * 60_000, lane, n, data: { count: n } });
        continue;
      }
      // Now and then a worker run ends early and its last items are lost.
      const lost = rand() < 0.05 ? 1 + Math.floor(rand() * 3) : 0;
      for (let i = 0; i < n - lost; i++) {
        const s = batch[i];
        const at = t + (12 + i) * 60_000;
        const inYesterday = at >= dayStart - 86_400_000 && at < dayStart;
        if (qLeft > 0 && inYesterday && rand() < 0.05) {
          qLeft--;
          addEvent(db, { type: 'result_recorded', at, lane, subject: s.key, data: { verdict: 'rejected', reason: 'secret_scan', outcome: 'quarantined', fault: null, coverage: null } });
          continue;
        }
        if (rand() < 0.06) {
          const reason = REJECTS[Math.floor(rand() * REJECTS.length)];
          addEvent(db, { type: 'result_recorded', at, lane, subject: s.key, data: { verdict: 'rejected', reason, outcome: 'rejected', fault: null, coverage: null } });
          continue;
        }
        const [coverage, fault] = pickSide(rand, lane);
        addEvent(db, { type: 'result_recorded', at, lane, subject: s.key, data: { verdict: 'accepted', reason: null, outcome: 'accepted', fault, coverage } });
        addResult(db, { subject: s.key, workflow: lane, at, coverage, fault, runKey: runKey() });
      }
      const closed = t + (12 + n - lost - 1) * 60_000 + (lost ? 30_000 : 0);
      addDispatch(real, { attemptId, workflow: lane, created: t, expires: t + 60 * 60_000, status: 'done', closed, items: batch.map((x) => ({ subject: x.key, name: x.name, resolved: true })) });
      addEvent(db, { type: 'dispatch_closed', at: closed, lane, n, data: { close_reason: lost ? 'run_completed' : 'results_in' } });
    }
  }

  // Batches still out, and their slots.
  if (openBatches) {
    const out = [['live-probe', 10, now - 9 * 60_000], ['scan-static', 25, now - 4 * 60_000]];
    out.forEach(([lane, n, created], k) => {
      const items = [];
      for (let i = 0; i < n; i++) { const s = subs[si++ % subs.length]; items.push({ subject: s.key, name: s.name }); }
      const attemptId = `open-${k}`;
      addDispatch(db, { attemptId, workflow: lane, created, expires: created + 40 * 60_000, items });
      addEvent(db, { type: 'dispatch_sent', at: created + 2_000, lane, n, data: { run_id: '9300000001' } });
      addSlot(db, { slot: k, holder: attemptId, at: created, expires: created + 40 * 60_000 });
    });
  }

  buffered.map((e, i) => [e, i]).sort((a, b) => a[0].recordedAt - b[0].recordedAt || a[1] - b[1]).forEach(([e]) => addEvent(real, e));
  db.setKv('pump.last_tick', { due: 12, dispatched: 0 }, { now: tickAt });
  db.setKv('pump.breaker', { tripped: false, reason: null, held: [], checked_at: '2026-11-25T13:52:10.000Z', summary: 'sandbox conformance passed' }, { now: now - 30_000 });
  db.setKv('pump.registry_delta', { action: 'fresh', captureAt: '2026-11-25T21:31:02.000Z' }, { now: now - 30_000 });
  return { db: real, now, cfg: config({ slots }) };
}
