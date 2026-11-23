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
//
// Schema v3 adds the dispatch ledger. Leases are keyed by run_key (the `subject`
// column of `leases` holds the run_key), each dispatch (attempt_id) carries one or
// more run_keys with their fences. Ingest reads a dispatch with getAttempt() and
// reports every result it has checked with recordResult(); the pump runs ingest
// in-process, so it stays the only writer. See docs/INTERFACES.md.
//
// Schema v4 numbers the items of a dispatch (item_index, their 0-based position
// in the dispatched list). The worker names each item's result bundle by that
// position and ingest judges every item on its own.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 4;
export const MAX_SLOTS = 15;

const MIGRATIONS = [
  { version: 1, sql: () => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8') },
  { version: 2, sql: () => readFileSync(new URL('./schema-v2.sql', import.meta.url), 'utf8') },
  { version: 3, sql: () => readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8') },
  { version: 4, sql: () => readFileSync(new URL('./schema-v4.sql', import.meta.url), 'utf8') },
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

// Rejection reasons that say nothing about the run_key's own work (identity or
// fencing failures), so they don't count towards parking it.
const NOT_COUNTED = ["'unknown_attempt'", "'unknown_run_key'", "'fence_mismatch'", "'duplicate_result'", "'stale_fence'"].join(', ');

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

  /**
   * Like tx(), for an async fn: BEGIN IMMEDIATE, await fn(), COMMIT (ROLLBACK if it
   * throws). The pump uses it to keep a recorded result and its sealed outputs
   * together. Nothing else may use this connection until it settles.
   */
  async txAsync(fn) {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = await fn();
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
      // Every open row counts, including rows above a budget that has since shrunk.
      if (used.size >= limit) return null;
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
      "UPDATE slot_ledger SET released = ?, release_reason = 'expired' WHERE released IS NULL AND expires <= ?",
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

  /** Close the open slot row held by an attempt. Returns true if one was open. */
  releaseSlotForAttempt(attemptId, reason, { now } = {}) {
    const r = this.raw.prepare(
      'UPDATE slot_ledger SET released = ?, release_reason = ? WHERE holder_run = ? AND released IS NULL',
    ).run(iso(now), reason, String(attemptId));
    return r.changes > 0;
  }

  // ---- subjects: what the due list reads (schema v3) ----

  /**
   * Insert or update a subject with its tier and current version. A new SHA or
   * artifact digest counts as a change event and moves `changed_at`.
   */
  setSubjectVersion({ id, kind, source, tier, sha = null, artifactDigest = null, now }) {
    if (!Number.isInteger(tier) || tier < 0 || tier > 4) throw new TypeError(`tier must be 0..4, got ${tier}`);
    const t = iso(now);
    this.tx(() => {
      this.upsertSubject({ id, kind, source, now });
      const cur = this.getSubject(id);
      const changed = cur.sha !== sha || cur.artifact_digest !== artifactDigest;
      this.raw.prepare(`
        UPDATE subjects SET tier = ?, sha = ?, artifact_digest = ?,
          changed_at = CASE WHEN ? THEN ? ELSE changed_at END,
          change_reason = CASE WHEN ? THEN 'new_version' ELSE change_reason END
        WHERE id = ?
      `).run(tier, sha, artifactDigest, changed ? 1 : 0, t, changed ? 1 : 0, id);
    });
  }

  /** Record a change event (for example an advisory) that makes the subject due. */
  noteChange(id, { reason, now } = {}) {
    const r = this.raw.prepare('UPDATE subjects SET changed_at = ?, change_reason = ? WHERE id = ?').run(iso(now), String(reason || 'change'), id);
    return r.changes > 0;
  }

  listSubjects() {
    return this.raw.prepare('SELECT * FROM subjects ORDER BY id').all().map(plain);
  }

  // ---- run keys, dispatches and results (schema v3) ----

  /** Remember the fields a run_key was computed from. First write wins. */
  recordRunKey(runKey, { subject, workflow, fields, now }) {
    this.raw.prepare(`
      INSERT INTO run_keys (run_key, subject, workflow, fields, first_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (run_key) DO NOTHING
    `).run(runKey, subject, workflow, typeof fields === 'string' ? fields : JSON.stringify(fields), iso(now));
  }

  getRunKey(runKey) {
    return plain(this.raw.prepare('SELECT * FROM run_keys WHERE run_key = ?').get(runKey));
  }

  /**
   * Record a dispatch before it is sent. `items` are [{run_key, subject, fence}]
   * in the order the worker receives them; each item's position is stored as its
   * item_index. Their leases (keyed by run_key, held by attemptId) must already
   * be taken.
   */
  createDispatch({ attemptId, shardId, workflow, repo, workflowFile, ref, expires, items, now }) {
    if (!attemptId || !shardId || !workflow || !repo || !workflowFile || !ref) {
      throw new TypeError('createDispatch needs attemptId, shardId, workflow, repo, workflowFile and ref');
    }
    if (!Array.isArray(items) || items.length === 0) throw new TypeError('createDispatch needs at least one item');
    const t = iso(now);
    this.tx(() => {
      this.raw.prepare(`
        INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(attemptId, shardId, workflow, repo, workflowFile, ref, t, iso(expires));
      const ins = this.raw.prepare('INSERT INTO dispatch_items (attempt_id, run_key, subject, workflow, fence, item_index) VALUES (?, ?, ?, ?, ?, ?)');
      items.forEach((it, index) => ins.run(attemptId, it.run_key, it.subject, workflow, it.fence, index));
    });
  }

  /** The worker run was created. runId may be null when it could not be correlated yet. */
  markDispatched(attemptId, { runId = null, runUrl = null, workflowSha = null, correlatedBy = null } = {}) {
    const r = this.raw.prepare(`
      UPDATE dispatches SET status = 'dispatched', run_id = ?, run_url = ?, workflow_sha = ?, correlated_by = ?
      WHERE attempt_id = ? AND status = 'pending'
    `).run(runId === null ? null : String(runId), runUrl, workflowSha, correlatedBy, attemptId);
    return r.changes > 0;
  }

  /**
   * Fill in the run of a live dispatch that was sent without one (found later by
   * its run name). Never replaces a known run id. A pending dispatch becomes
   * dispatched. Returns true if the row changed.
   */
  setDispatchRun(attemptId, { runId, runUrl = null, workflowSha = null, correlatedBy = null } = {}) {
    if (runId === undefined || runId === null) throw new TypeError('setDispatchRun needs a runId');
    const r = this.raw.prepare(`
      UPDATE dispatches SET status = 'dispatched', run_id = ?, run_url = ?, workflow_sha = COALESCE(?, workflow_sha), correlated_by = ?
      WHERE attempt_id = ? AND run_id IS NULL AND status IN ('pending', 'dispatched')
    `).run(String(runId), runUrl, workflowSha, correlatedBy, attemptId);
    return r.changes > 0;
  }

  /** The dispatch call failed: close it and free its leases and slot so the work is due again. */
  failDispatch(attemptId, { error, now } = {}) {
    const t = iso(now);
    return this.tx(() => {
      const r = this.raw.prepare(`
        UPDATE dispatches SET status = 'failed', closed = ?, close_reason = 'dispatch_failed', error = ?
        WHERE attempt_id = ? AND status = 'pending'
      `).run(t, error === undefined ? null : String(error).slice(0, 500), attemptId);
      if (r.changes === 0) return false;
      for (const it of this.raw.prepare('SELECT run_key, fence FROM dispatch_items WHERE attempt_id = ?').all(attemptId)) {
        this.releaseLease(it.run_key, attemptId, it.fence, { now });
      }
      this.releaseSlotForAttempt(attemptId, 'failed', { now });
      return true;
    });
  }

  /**
   * Close a live dispatch whose worker run ended without reporting every run_key
   * (for example the run failed). Call it after recording every result the run
   * did produce. Leases of unresolved items and the slot are released with
   * `reason`, so that work is due again. Returns false if it was not open.
   */
  closeDispatch(attemptId, { reason, now } = {}) {
    const t = iso(now);
    const why = String(reason || 'closed');
    return this.tx(() => {
      const r = this.raw.prepare(`
        UPDATE dispatches SET status = 'done', closed = ?, close_reason = ?
        WHERE attempt_id = ? AND status IN ('pending', 'dispatched')
      `).run(t, why, attemptId);
      if (r.changes === 0) return false;
      for (const it of this.raw.prepare('SELECT run_key, fence FROM dispatch_items WHERE attempt_id = ? AND resolved IS NULL').all(attemptId)) {
        this.releaseLease(it.run_key, attemptId, it.fence, { now });
      }
      this.releaseSlotForAttempt(attemptId, why, { now });
      return true;
    });
  }

  /** A dispatch with its items in dispatch order (item_index), or undefined. */
  getDispatch(attemptId) {
    const d = plain(this.raw.prepare('SELECT * FROM dispatches WHERE attempt_id = ?').get(attemptId));
    if (!d) return undefined;
    d.items = this.raw.prepare('SELECT * FROM dispatch_items WHERE attempt_id = ? ORDER BY item_index').all(attemptId).map(plain);
    return d;
  }

  /** Dispatches still waiting for results whose lease has not expired. */
  openDispatches({ now } = {}) {
    return this.raw.prepare(`
      SELECT * FROM dispatches WHERE status IN ('pending', 'dispatched') AND expires > ? ORDER BY created, attempt_id
    `).all(iso(now)).map(plain);
  }

  /**
   * Dispatches ingest should look at: every open one (pending or dispatched,
   * expired or not, since the pump ingests before it reaps), and ones closed as
   * expired within the last `lateMs` that have a run id and an item with nothing
   * recorded yet (a late result is still judged and stored, as rejected). Oldest
   * first.
   */
  dispatchesAwaitingResults({ now, lateMs = 0 } = {}) {
    const since = iso(toMs(now) - Math.max(0, Number(lateMs) || 0));
    return this.raw.prepare(`
      SELECT d.* FROM dispatches d
      WHERE d.status IN ('pending', 'dispatched')
         OR (d.status = 'expired' AND d.closed > ? AND d.run_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM dispatch_items i WHERE i.attempt_id = d.attempt_id
               AND NOT EXISTS (SELECT 1 FROM attempts a
                 WHERE a.attempt_id = i.attempt_id AND a.run_key = i.run_key AND a.fence = i.fence)))
      ORDER BY d.created, d.attempt_id
    `).all(since).map(plain);
  }

  /**
   * The ingest interface (docs/INTERFACES.md). What ingest needs to know about a
   * dispatch, or undefined if there is no such attempt:
   *
   *   {attempt_id, workflow, repo, workflow_file, run_id, workflow_sha,
   *    canaries, status, shard_id, created, expires,
   *    items: [{index, run_key, fence, subject, current_fence, outcome, resolved}]}
   *
   * workflow_file is a path under .github/workflows/. items are in dispatch
   * order; index is the item's 0-based position, which names its result bundle
   * (result-<attempt_id>-<index>.tar.age). current_fence is the fence of the
   * item's run_key lease now (a newer one means the item is stale). outcome is
   * null until a result for this attempt, run_key and fence is recorded.
   * canaries is always empty for now (none are injected yet).
   */
  getAttempt(attemptId) {
    const d = this.getDispatch(attemptId);
    if (!d) return undefined;
    const recorded = this.raw.prepare(`
      SELECT accepted, outcome FROM attempts WHERE attempt_id = ? AND run_key = ? AND fence = ? ORDER BY id LIMIT 1
    `);
    const items = d.items.map((it) => {
      const lease = this.getLease(it.run_key);
      const rec = recorded.get(attemptId, it.run_key, it.fence);
      return {
        index: it.item_index,
        run_key: it.run_key,
        fence: it.fence,
        subject: it.subject,
        current_fence: lease ? lease.fence : null,
        outcome: rec ? rec.outcome ?? (rec.accepted === 1 ? 'accepted' : 'rejected') : null,
        resolved: it.resolved,
      };
    });
    const file = String(d.workflow_file);
    return {
      attempt_id: d.attempt_id,
      workflow: d.workflow,
      repo: d.repo,
      workflow_file: file.includes('/') ? file : `.github/workflows/${file}`,
      run_id: d.run_id !== null && /^\d{1,16}$/.test(d.run_id) ? Number(d.run_id) : null,
      workflow_sha: d.workflow_sha,
      canaries: [],
      status: d.status,
      shard_id: d.shard_id,
      created: d.created,
      expires: d.expires,
      items,
    };
  }

  /** [{subject, workflow}] with an unresolved item on a live dispatch. */
  inFlight({ now } = {}) {
    return this.raw.prepare(`
      SELECT DISTINCT i.subject, i.workflow FROM dispatch_items i JOIN dispatches d USING (attempt_id)
      WHERE d.status IN ('pending', 'dispatched') AND d.expires > ? AND i.resolved IS NULL
    `).all(iso(now)).map(plain);
  }

  /**
   * Close dispatches whose lease expired and release their slots. Their leases
   * lapse on their own, so the run_keys become due again. Returns the closed rows.
   */
  reapExpiredDispatches({ now } = {}) {
    const t = iso(now);
    return this.tx(() => {
      const rows = this.raw.prepare(`
        SELECT * FROM dispatches WHERE status IN ('pending', 'dispatched') AND expires <= ? ORDER BY attempt_id
      `).all(t).map(plain);
      for (const d of rows) {
        this.raw.prepare("UPDATE dispatches SET status = 'expired', closed = ?, close_reason = 'lease_expired' WHERE attempt_id = ?").run(t, d.attempt_id);
        this.releaseSlotForAttempt(d.attempt_id, 'expired', { now });
      }
      this.reapExpired({ now });
      return rows;
    });
  }

  /**
   * The ingest interface (docs/INTERFACES.md). Store one checked result.
   *
   * Accepted only when the attempt is known, carries this run_key with the fence
   * the pump issued, that fence is the current live lease for the run_key, and
   * ingest itself accepted it. Anything else is stored as a rejected attempt with
   * the reason (outcome 'accepted' is stored as 'rejected' then) and never
   * overwrites a result. When the attempt is current (accepted or rejected by
   * ingest), its lease is released, and its slot is released once every run_key
   * in the dispatch has reported.
   *
   * Idempotent: once something is stored for this attempt, run_key and fence, a
   * repeat returns that first answer with `duplicate: true` and writes nothing.
   *
   * @param {{run_key: string, attempt_id: string, fence: number, outcome?: string,
   *   verdict?: 'accepted'|'rejected', accepted?: boolean, reason?: string,
   *   digest?: string, now?: number|string|Date}} args
   * @returns {{accepted: boolean, reason: string|null, id: number, duplicate?: true}}
   */
  recordResult({ run_key: runKey, attempt_id: attemptId, fence, outcome = null, verdict, accepted, reason = null, digest = null, now } = {}) {
    if (verdict === undefined && typeof accepted === 'boolean') verdict = accepted ? 'accepted' : 'rejected';
    if (verdict !== 'accepted' && verdict !== 'rejected') {
      throw new TypeError('recordResult needs verdict "accepted" or "rejected" (or accepted: true|false)');
    }
    if (!runKey || !attemptId) throw new TypeError('recordResult needs run_key and attempt_id');
    const t = iso(now);
    return this.tx(() => {
      const d = plain(this.raw.prepare('SELECT * FROM dispatches WHERE attempt_id = ?').get(attemptId));
      const item = d && plain(this.raw.prepare('SELECT * FROM dispatch_items WHERE attempt_id = ? AND run_key = ?').get(attemptId, runKey));
      if (item && item.fence === fence) {
        const prior = this.raw.prepare(`
          SELECT id, accepted, reason FROM attempts WHERE attempt_id = ? AND run_key = ? AND fence = ? ORDER BY id LIMIT 1
        `).get(attemptId, runKey, fence);
        if (prior) return { accepted: prior.accepted === 1, reason: prior.reason, id: Number(prior.id), duplicate: true };
      }
      let why = null;
      let current = false;
      if (!d) why = 'unknown_attempt';
      else if (!item) why = 'unknown_run_key';
      else if (item.fence !== fence) why = 'fence_mismatch';
      else if (item.resolved !== null) why = 'duplicate_result';
      else {
        const c = this.checkFence(runKey, fence, { holder: attemptId, now });
        if (!c.ok) why = c.reason;
        else current = true;
      }
      const ok = current && verdict === 'accepted';
      if (current && !ok) why = reason ? String(reason) : 'rejected_by_ingest';
      // An acceptance the store refused is kept with outcome 'rejected'.
      const stored = !ok && outcome === 'accepted' ? 'rejected' : outcome;
      const subject = item?.subject ?? this.getRunKey(runKey)?.subject ?? 'unknown';
      const r = this.raw.prepare(`
        INSERT INTO attempts (subject, holder, fence, run_id, run_key, digest, received, accepted, reason, attempt_id, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(subject, attemptId, Number.isSafeInteger(fence) ? fence : -1, d?.run_id ?? null, runKey, digest, t, ok ? 1 : 0, why, attemptId, stored);
      if (current) {
        this.raw.prepare('UPDATE dispatch_items SET resolved = ? WHERE attempt_id = ? AND run_key = ?').run(t, attemptId, runKey);
        this.releaseLease(runKey, attemptId, fence, { now });
        if (ok) {
          this.raw.prepare(`
            INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, digest, accepted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (run_key) DO UPDATE SET attempt_id = excluded.attempt_id, fence = excluded.fence,
              outcome = excluded.outcome, digest = excluded.digest, accepted_at = excluded.accepted_at
          `).run(runKey, item.subject, item.workflow, attemptId, fence, outcome, digest, t);
        }
        const open = this.raw.prepare('SELECT COUNT(*) AS n FROM dispatch_items WHERE attempt_id = ? AND resolved IS NULL').get(attemptId).n;
        if (open === 0) {
          this.raw.prepare(`
            UPDATE dispatches SET status = 'done', closed = ?, close_reason = 'results_in'
            WHERE attempt_id = ? AND status IN ('pending', 'dispatched')
          `).run(t, attemptId);
          this.releaseSlotForAttempt(attemptId, 'result', { now });
        }
      }
      return { accepted: ok, reason: why, id: Number(r.lastInsertRowid) };
    });
  }

  getResult(runKey) {
    return plain(this.raw.prepare('SELECT * FROM results WHERE run_key = ?').get(runKey));
  }

  /** All accepted results (one row per run_key). */
  listResults() {
    return this.raw.prepare('SELECT * FROM results ORDER BY subject, workflow, accepted_at').all().map(plain);
  }

  /**
   * Rejections that count against a run_key: ingest said no (or the lease lapsed)
   * since its last accepted result. Identity and fencing failures from other
   * attempts don't count, so a forger can't park someone else's work.
   */
  rejectedCount(runKey) {
    return this.raw.prepare(`
      SELECT COUNT(*) AS n FROM attempts WHERE run_key = ? AND accepted = 0 AND reason NOT IN (${NOT_COUNTED})
        AND received > COALESCE((SELECT accepted_at FROM results WHERE run_key = ?), '')
    `).get(runKey, runKey).n;
  }

  /** [{run_key, n}] for run_keys with no accepted result and at least `min` counted rejections. */
  rejectedRunKeys(min = 1) {
    return this.raw.prepare(`
      SELECT a.run_key, COUNT(*) AS n FROM attempts a
      WHERE a.run_key IS NOT NULL AND a.accepted = 0 AND a.reason NOT IN (${NOT_COUNTED})
        AND NOT EXISTS (SELECT 1 FROM results r WHERE r.run_key = a.run_key)
      GROUP BY a.run_key HAVING COUNT(*) >= ?
    `).all(min).map(plain);
  }

  // ---- kv ----

  getKv(key) {
    const row = this.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  setKv(key, value, { now } = {}) {
    this.raw.prepare(`
      INSERT INTO kv (key, value, updated) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated
    `).run(key, JSON.stringify(value), iso(now));
  }
}

/** Open (creating if needed) and migrate a state database. Use ':memory:' for tests. */
export function openState(path) {
  const db = new StateDb(path);
  db.migrate();
  return db;
}
