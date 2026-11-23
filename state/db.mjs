// tool-qa state store v0 on node:sqlite (Node 22.13+; no flag needed).
//
// The pump is the only writer. The file is a single SQLite database
// (rollback journal, no WAL) so it can be shipped as one Release asset by
// scripts/state-asset.mjs.
//
// Leases and fencing: acquireLease() hands out a fence token drawn from one
// counter that only grows. A write is accepted only when it carries the fence
// of the subject's current, live, unreleased lease. A holder that stalled past
// expiry and lost its lease to a newer holder is rejected as `stale_fence`; its
// result is still stored in `attempts`, marked rejected, and never overwrites.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;
export const MAX_SLOTS = 15;

const MIGRATIONS = [
  { version: 1, sql: () => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8') },
  { version: 2, sql: () => readFileSync(new URL('./schema-v2.sql', import.meta.url), 'utf8') },
];

/** Thrown by withFence() when the caller's fence is not the current live lease. */
export class StaleFenceError extends Error {
  constructor(subject, fence, reason) {
    super(`write for ${subject} with fence ${fence} rejected: ${reason}`);
    this.name = 'StaleFenceError';
    this.subject = subject;
    this.fence = fence;
    this.reason = reason;
  }
}

function toMs(now) {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string') return Date.parse(now);
  return Number(now);
}

function iso(now) {
  const ms = toMs(now);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid time: ${now}`);
  return new Date(ms).toISOString();
}

function checkTtl(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`ttlMs must be a positive whole number of milliseconds, got ${ttlMs}`);
  }
}

function plain(row) {
  return row ? { ...row } : undefined;
}

export class StateDb {
  constructor(path) {
    this.raw = new DatabaseSync(path);
    this.inTx = false;
    this.raw.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  }

  /** Run fn inside one IMMEDIATE transaction (nested calls join the outer one). */
  tx(fn) {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  schemaVersion() {
    return this.raw.prepare('PRAGMA user_version').get().user_version;
  }

  migrate() {
    const current = this.schemaVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(`state schema version ${current} is newer than this code (${SCHEMA_VERSION})`);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.raw.exec(m.sql());
        if (m.version === 1) this.raw.prepare("INSERT INTO counters (name, value) VALUES ('fence', 0)").run();
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
    return this.schemaVersion();
  }

  close() {
    this.raw.close();
  }

  // ---- leases ----

  getLease(subject) {
    return plain(this.raw.prepare('SELECT * FROM leases WHERE subject = ?').get(subject));
  }

  nextFence() {
    return this.tx(() => {
      this.raw.prepare("UPDATE counters SET value = value + 1 WHERE name = 'fence'").run();
      return this.raw.prepare("SELECT value FROM counters WHERE name = 'fence'").get().value;
    });
  }

  /**
   * Take the lease on a subject if it is free (never leased, released or expired).
   * @returns {{acquired: true, fence: number, expires: string} |
   *           {acquired: false, holder: string, fence: number, expires: string}}
   */
  acquireLease(subject, holder, { ttlMs, now } = {}) {
    checkTtl(ttlMs);
    if (!holder) throw new TypeError('holder is required');
    const nowIso = iso(now);
    return this.tx(() => {
      const cur = this.getLease(subject);
      if (cur && cur.holder !== null && cur.expires > nowIso) {
        return { acquired: false, holder: cur.holder, fence: cur.fence, expires: cur.expires };
      }
      const fence = this.nextFence();
      const expires = iso(toMs(now) + ttlMs);
      this.raw.prepare(`
        INSERT INTO leases (subject, holder, fence, acquired, expires, released)
        VALUES ($subject, $holder, $fence, $acquired, $expires, NULL)
        ON CONFLICT (subject) DO UPDATE SET
          holder = excluded.holder, fence = excluded.fence, acquired = excluded.acquired,
          expires = excluded.expires, released = NULL
      `).run({ subject, holder, fence, acquired: nowIso, expires });
      return { acquired: true, fence, expires };
    });
  }

  /**
   * Check a fence (and optionally the holder) against the subject's lease.
   * @returns {{ok: true} | {ok: false, reason: string}}
   *   reasons: no_lease, stale_fence, unknown_fence, holder_mismatch, lease_released, lease_expired
   */
  checkFence(subject, fence, { holder, now, ignoreExpiry = false } = {}) {
    const cur = this.getLease(subject);
    if (!cur) return { ok: false, reason: 'no_lease' };
    if (!Number.isSafeInteger(fence)) return { ok: false, reason: 'unknown_fence' };
    if (fence < cur.fence) return { ok: false, reason: 'stale_fence' };
    if (fence !== cur.fence) return { ok: false, reason: 'unknown_fence' };
    if (cur.holder === null) return { ok: false, reason: 'lease_released' };
    if (holder !== undefined && holder !== cur.holder) return { ok: false, reason: 'holder_mismatch' };
    if (!ignoreExpiry && cur.expires <= iso(now)) return { ok: false, reason: 'lease_expired' };
    return { ok: true };
  }

  renewLease(subject, holder, fence, { ttlMs, now } = {}) {
    checkTtl(ttlMs);
    return this.tx(() => {
      const c = this.checkFence(subject, fence, { holder, now });
      if (!c.ok) return { renewed: false, reason: c.reason };
      const expires = iso(toMs(now) + ttlMs);
      this.raw.prepare('UPDATE leases SET expires = ? WHERE subject = ? AND fence = ?').run(expires, subject, fence);
      return { renewed: true, expires };
    });
  }

  releaseLease(subject, holder, fence, { now } = {}) {
    const nowIso = iso(now);
    return this.tx(() => {
      // Its own holder may release an expired lease that nobody has taken over:
      // that only tidies up. A newer lease makes this fence stale anyway.
      const c = this.checkFence(subject, fence, { holder, now, ignoreExpiry: true });
      if (!c.ok) return { released: false, reason: c.reason };
      this.raw.prepare('UPDATE leases SET holder = NULL, released = ? WHERE subject = ? AND fence = ?').run(nowIso, subject, fence);
      return { released: true };
    });
  }

  /**
   * Run fn(raw) in a transaction only if `fence` is the subject's current live lease.
   * Throws StaleFenceError without calling fn otherwise.
   */
  withFence(subject, fence, fn, { holder, now } = {}) {
    return this.tx(() => {
      const c = this.checkFence(subject, fence, { holder, now });
      if (!c.ok) throw new StaleFenceError(subject, fence, c.reason);
      return fn(this.raw);
    });
  }

  /**
   * Store a worker's result attempt. Accepted only with the current live fence and holder;
   * otherwise stored as rejected with the reason. Never overwrites earlier attempts.
   */
  recordAttempt({ subject, holder, fence, runId = null, runKey = null, digest = null, now } = {}) {
    if (!subject || !holder) throw new TypeError('subject and holder are required');
    const received = iso(now);
    return this.tx(() => {
      const c = this.checkFence(subject, fence, { holder, now });
      const reason = c.ok ? null : c.reason;
      const r = this.raw.prepare(`
        INSERT INTO attempts (subject, holder, fence, run_id, run_key, digest, received, accepted, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(subject, holder, fence, runId, runKey, digest, received, c.ok ? 1 : 0, reason);
      return { accepted: c.ok, reason, id: Number(r.lastInsertRowid) };
    });
  }

  listAttempts(subject) {
    return this.raw.prepare('SELECT * FROM attempts WHERE subject = ? ORDER BY id').all(subject).map(plain);
  }

  // ---- subjects and runs ----

  upsertSubject({ id, kind, source, now }) {
    const t = iso(now);
    this.raw.prepare(`
      INSERT INTO subjects (id, kind, source, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET last_seen = MAX(subjects.last_seen, excluded.last_seen)
    `).run(id, kind, source, t, t);
  }

  getSubject(id) {
    return plain(this.raw.prepare('SELECT * FROM subjects WHERE id = ?').get(id));
  }

  recordRun({ id, workflow, attempt = 1, started, finished, conclusion }) {
    this.raw.prepare(`
      INSERT INTO runs (id, workflow, attempt, started, finished, conclusion)
      VALUES ($id, $workflow, $attempt, $started, $finished, $conclusion)
      ON CONFLICT (id) DO UPDATE SET
        workflow = excluded.workflow, attempt = excluded.attempt,
        started = COALESCE(excluded.started, runs.started),
        finished = COALESCE(excluded.finished, runs.finished),
        conclusion = COALESCE(excluded.conclusion, runs.conclusion)
    `).run({
      id: String(id), workflow, attempt,
      started: started === undefined ? null : iso(started),
      finished: finished === undefined ? null : iso(finished),
      conclusion: conclusion ?? null,
    });
  }

  getRun(id) {
    return plain(this.raw.prepare('SELECT * FROM runs WHERE id = ?').get(String(id)));
  }

  // ---- slot ledger ----

  /**
   * Take the lowest free slot below min(budget, 15) for `ttlMs`. Open rows past their
   * expiry are reaped first, so a crashed run does not keep its slot.
   * Returns the slot number or null.
   */
  acquireSlot(holderRun, { budget, ttlMs, now } = {}) {
    checkTtl(ttlMs);
    const limit = Math.max(0, Math.min(MAX_SLOTS, Math.trunc(Number(budget) || 0)));
    const t = iso(now);
    const expires = iso(toMs(now) + ttlMs);
    return this.tx(() => {
      this.reapExpired({ now });
      const used = new Set(this.raw.prepare('SELECT slot FROM slot_ledger WHERE released IS NULL').all().map((r) => r.slot));
      for (let slot = 0; slot < limit; slot++) {
        if (used.has(slot)) continue;
        this.raw.prepare('INSERT INTO slot_ledger (slot, holder_run, acquired, expires) VALUES (?, ?, ?, ?)').run(slot, String(holderRun), t, expires);
        return slot;
      }
      return null;
    });
  }

  /** Close every open slot row whose expiry has passed. Returns the number reaped. */
  reapExpired({ now } = {}) {
    const t = iso(now);
    return Number(this.raw.prepare(
      'UPDATE slot_ledger SET released = ? WHERE released IS NULL AND expires <= ?',
    ).run(t, t).changes);
  }

  releaseSlot(slot, holderRun, { now } = {}) {
    const r = this.raw.prepare(
      'UPDATE slot_ledger SET released = ? WHERE slot = ? AND holder_run = ? AND released IS NULL',
    ).run(iso(now), slot, String(holderRun));
    return r.changes > 0;
  }

  openSlots() {
    return this.raw.prepare('SELECT * FROM slot_ledger WHERE released IS NULL ORDER BY slot').all().map(plain);
  }
}

/** Open (creating if needed) and migrate a state database. Use ':memory:' for tests. */
export function openState(path) {
  const db = new StateDb(path);
  db.migrate();
  return db;
}
