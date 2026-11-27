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
//
// Schema v8 keys subject identity by GitHub's numeric repository id
// (repo_id) while subjects.id stays the frozen subject key that run_keys name:
// see state/schema-v8.sql and pump/identity.mjs.
//
// Schema v10 adds the append-only events table (state/schema-v10.sql): each
// event is written in the same transaction as the fact it describes.
//
// Schema v11 adds discovery_keys (state/schema-v11.sql): the subfolder and
// purl keys the discover lane saw each subject under (pump/discover.mjs).

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { deriveDisagreements, foldDisagreement, ORACLE_BUDGET_DAYS, ORACLE_BUDGET_MAX, ORACLE_MAX_UNCHANGED, ORACLE_LANES } from './oracle.mjs';

export const SCHEMA_VERSION = 11;
export const MAX_SLOTS = 15;
/** How long an accepted id conflict waits for its lookup (R-SUBJ-17). */
export const ACCEPT_TTL_MS = 48 * 3_600_000;
/** How far apart one tick's dispatches may be created and still count as one burst (R-ING-26). */
export const SHA_BURST_MS = 30_000;
/** How long a lane is paused after a result was refused for its version pins (R-PIN-01). */
export const PIN_PAUSE_MS = 3_600_000;

const MIGRATIONS = [
  { version: 1, sql: () => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8') },
  { version: 2, sql: () => readFileSync(new URL('./schema-v2.sql', import.meta.url), 'utf8') },
  { version: 3, sql: () => readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8') },
  { version: 4, sql: () => readFileSync(new URL('./schema-v4.sql', import.meta.url), 'utf8') },
  { version: 5, sql: () => readFileSync(new URL('./schema-v5.sql', import.meta.url), 'utf8') },
  { version: 6, sql: () => readFileSync(new URL('./schema-v6.sql', import.meta.url), 'utf8') },
  { version: 7, sql: () => readFileSync(new URL('./schema-v7.sql', import.meta.url), 'utf8') },
  { version: 8, sql: () => readFileSync(new URL('./schema-v8.sql', import.meta.url), 'utf8') },
  { version: 9, sql: () => readFileSync(new URL('./schema-v9.sql', import.meta.url), 'utf8') },
  { version: 10, sql: () => readFileSync(new URL('./schema-v10.sql', import.meta.url), 'utf8') },
  { version: 11, sql: () => readFileSync(new URL('./schema-v11.sql', import.meta.url), 'utf8') },
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
// retry_later (the worker hit a passing condition) is bounded on its own
// (ingest MAX_RETRIES) and is not counted either, nor is retry_throttled (a
// rate limit or upstream outage, bounded by ingest RETRY_WINDOW_MS; R-SUB-04). Nor is run_sha_mismatch
// (R-ING-18): the run was at another commit than the one recorded at dispatch,
// because the worker branch moved between the pump reading it and GitHub
// starting the run, or because someone else's run took the shard's run name.
// Neither says anything about the run_key's own work. Nor do pin_mismatch and
// pin_unverified (R-PIN-01): our worker ran, or did not prove it ran, other
// code than the run_key is filed under; that is our side, and the lane is
// paused instead (pausePinRefused), so a fixed worker never finds its work parked.
export const NOT_COUNTED_REASONS = Object.freeze(['unknown_attempt', 'unknown_run_key', 'fence_mismatch', 'duplicate_result', 'stale_fence', 'retry_later', 'retry_throttled', 'run_sha_mismatch', 'pin_mismatch', 'pin_unverified']);
const NOT_COUNTED = NOT_COUNTED_REASONS.map((r) => `'${r}'`).join(', ');

/** Event data strings are bounded (reasons, URLs, lane names). */
function cap(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : v;
}

function plain(row) {
  return row ? { ...row } : undefined;
}

const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * A GitHub GraphQL repository answer as {repoId, nodeId, name, createdAt}, or
 * null when it is not usable (a missing or malformed field).
 */
function checkNode(node) {
  if (!node || typeof node !== 'object') return null;
  const repoId = node.databaseId;
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
  if (typeof node.id !== 'string' || !/^[A-Za-z0-9_=-]{1,200}$/.test(node.id)) return null;
  if (typeof node.nameWithOwner !== 'string' || !REPO_NAME_RE.test(node.nameWithOwner)) return null;
  const createdAt = typeof node.createdAt === 'string' && Number.isFinite(Date.parse(node.createdAt)) ? node.createdAt : null;
  if (createdAt === null) return null;
  return { repoId, nodeId: node.id, name: node.nameWithOwner, createdAt };
}

/** transferred when the owner changed (case aside), else renamed. */
function renameKind(from, to) {
  const owner = (n) => String(n ?? '').split('/')[0].toLowerCase();
  return owner(from) !== owner(to) ? 'transferred' : 'renamed';
}

export class StateDb {
  constructor(path) {
    this.raw = new DatabaseSync(path);
    this.inTx = false;
    /** Where a failed event insert is reported (one line); the pump sets its own log. */
    this.log = (line) => process.stderr.write(`${line}\n`);
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

  /**
   * Insert a subject (its display name defaults to the key) or move its
   * last_seen. An existing subject's name is never changed here: only an
   * identity lookup moves it (applyIdentityLookup), since a seed may still
   * spell an old name.
   */
  upsertSubject({ id, kind, source, name = null, now }) {
    const t = iso(now);
    this.raw.prepare(`
      INSERT INTO subjects (id, kind, source, first_seen, last_seen, name) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET last_seen = MAX(subjects.last_seen, excluded.last_seen)
    `).run(id, kind, source, t, t, name ?? id);
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
   * artifact digest counts as a change event and moves `changed_at`. A retired
   * subject is active again.
   */
  setSubjectVersion({ id, kind, source, tier, sha = null, artifactDigest = null, name = null, now }) {
    if (!Number.isInteger(tier) || tier < 0 || tier > 4) throw new TypeError(`tier must be 0..4, got ${tier}`);
    const t = iso(now);
    this.tx(() => {
      this.upsertSubject({ id, kind, source, name, now });
      const cur = this.getSubject(id);
      const changed = cur.sha !== sha || cur.artifact_digest !== artifactDigest;
      this.raw.prepare(`
        UPDATE subjects SET tier = ?, sha = ?, artifact_digest = ?, retired_at = NULL,
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

  /**
   * A new default-branch head seen by the head poll (pump/heads.mjs): the sha
   * becomes `sha` and changed_at moves, with `reason` (head_first_seen or
   * new_sha) as the change_reason. The subject's run_keys move with the sha,
   * so its pairs are due as new_version. Nothing is written when the sha is
   * the one held. Returns whether a row changed.
   */
  noteHead(id, { sha, reason, now } = {}) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new TypeError(`noteHead needs a full commit sha, got ${JSON.stringify(sha)}`);
    const r = this.raw.prepare('UPDATE subjects SET sha = ?, changed_at = ?, change_reason = ? WHERE id = ? AND sha IS NOT ?')
      .run(sha, iso(now), String(reason || 'new_sha'), id, sha);
    return r.changes > 0;
  }

  /**
   * Retire every active subject first seen from a source starting with
   * `sourcePrefix` that is not in `keep`: it stays, with its results, but the
   * due list no longer picks it. Returns how many were retired.
   */
  retireSubjects({ sourcePrefix, keep, now } = {}) {
    if (typeof sourcePrefix !== 'string' || sourcePrefix === '') throw new TypeError('retireSubjects: sourcePrefix is required');
    const t = iso(now);
    const kept = new Set(keep);
    return this.tx(() => {
      let n = 0;
      const rows = this.raw.prepare('SELECT id, source FROM subjects WHERE retired_at IS NULL').all();
      const stmt = this.raw.prepare('UPDATE subjects SET retired_at = ? WHERE id = ? AND retired_at IS NULL');
      for (const r of rows) {
        if (!r.source.startsWith(sourcePrefix) || kept.has(r.id)) continue;
        n += Number(stmt.run(t, r.id).changes);
      }
      return n;
    });
  }

  /**
   * Record that the discover lane saw `subject` under (subfolder, purl) in
   * `feed`. Returns true when the key is new for the subject. repo_id is the
   * subject's own when not given.
   */
  noteDiscoveryKey({ subject, repoId = null, subfolder = '', purl = '', feed, now }) {
    const t = iso(now);
    const cur = this.raw.prepare('SELECT feeds FROM discovery_keys WHERE subject = ? AND subfolder = ? AND purl = ?').get(subject, subfolder, purl);
    if (cur) {
      const feeds = [...new Set([...String(cur.feeds).split(','), feed])].filter(Boolean).sort().join(',');
      this.raw.prepare('UPDATE discovery_keys SET feeds = ?, last_seen = ? WHERE subject = ? AND subfolder = ? AND purl = ?').run(feeds, t, subject, subfolder, purl);
      return false;
    }
    const rid = repoId ?? this.getSubject(subject)?.repo_id ?? null;
    this.raw.prepare('INSERT INTO discovery_keys (subject, repo_id, subfolder, purl, feeds, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)').run(subject, rid, subfolder, purl, String(feed), t, t);
    return true;
  }

  listDiscoveryKeys(subject) {
    return (subject === undefined
      ? this.raw.prepare('SELECT * FROM discovery_keys ORDER BY subject, subfolder, purl').all()
      : this.raw.prepare('SELECT * FROM discovery_keys WHERE subject = ? ORDER BY subfolder, purl').all(subject)).map(plain);
  }

  listSubjects() {
    return this.raw.prepare('SELECT * FROM subjects ORDER BY id').all().map(plain);
  }

  // ---- subject identity (schema v8, loop upgrade #15) ----
  //
  // subjects.id is the subject key: frozen at first sight, named by run_keys,
  // leases, dispatch items, attempts and results. repo_id (GitHub's numeric
  // repository id) is the identity: one subject per repository, whatever it
  // is called now (subjects.name). pump/identity.mjs looks the ids up and
  // hands each answer to applyIdentityLookup().

  /** The subject bound to a repository id, or undefined. */
  getSubjectByRepoId(repoId) {
    return plain(this.raw.prepare('SELECT * FROM subjects WHERE repo_id = ?').get(repoId));
  }

  static acceptKey(key) {
    return `subjects.identity.accept:${key}`;
  }

  /**
   * A person accepts the binding for a subject in id conflict (run with the
   * pump paused; scripts/subject-accept.mjs): the repository its last
   * id_conflict event found (id and creation time) is bound by the next
   * lookup if that lookup answers exactly it, the reuse and squatter guards
   * aside, and the conflict clears. The acceptance is used up by that next
   * lookup whatever it answers, and lapses after ACCEPT_TTL_MS. An id another
   * subject holds is still refused.
   * @returns {{ok: boolean, why?: string}}
   */
  acceptIdentityConflict(key, { now } = {}) {
    return this.tx(() => {
      const s = this.getSubject(key);
      if (!s) return { ok: false, why: `no subject ${key}` };
      if (s.id_status !== 'conflict') return { ok: false, why: `${key} is not in conflict (id_status ${s.id_status ?? 'none'})` };
      // Exactly the repository the conflict found: its id and creation time.
      const last = this.listSubjectEvents(key).filter((e) => e.kind === 'id_conflict').at(-1);
      const got = last?.detail?.got;
      if (!Number.isSafeInteger(got?.repo_id) || typeof got?.created_at !== 'string') return { ok: false, why: `${key}: its last id_conflict event names no repository to accept` };
      const at = iso(now);
      this.setKv(StateDb.acceptKey(key), { at, expires: iso(toMs(now) + ACCEPT_TTL_MS), repo_id: got.repo_id, created_at: got.created_at }, { now });
      this.raw.prepare('UPDATE subjects SET id_status = NULL, id_checked_at = NULL WHERE id = ?').run(key);
      return { ok: true, repo_id: got.repo_id, created_at: got.created_at, expires: iso(toMs(now) + ACCEPT_TTL_MS) };
    });
  }

  /** Whether any result or attempt names this subject key. */
  hasSubjectHistory(key) {
    return Boolean(this.raw.prepare(`
      SELECT EXISTS (SELECT 1 FROM results WHERE subject = ?) OR EXISTS (SELECT 1 FROM attempts WHERE subject = ?) AS h
    `).get(key, key).h);
  }

  /** Append an identity event (never rewritten). */
  recordSubjectEvent({ subject, repoId = null, kind, oldName = null, newName = null, detail = null, now }) {
    this.raw.prepare(`
      INSERT INTO subject_events (subject, repo_id, kind, old_name, new_name, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(subject, repoId, kind, oldName, newName, detail === null ? null : JSON.stringify(detail), iso(now));
  }

  /** Identity events, oldest first; all of them, or one subject's. detail is parsed. */
  listSubjectEvents(subject) {
    const rows = subject === undefined
      ? this.raw.prepare('SELECT * FROM subject_events ORDER BY id').all()
      : this.raw.prepare('SELECT * FROM subject_events WHERE subject = ? ORDER BY id').all(subject);
    return rows.map((r) => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) }));
  }

  /**
   * Subjects due an identity lookup now, at most `limit` of each kind:
   *   byName  not bound to an id yet (never looked up first, then by tier and
   *           key); looked up by their current name
   *   byId    bound, looked up again by node id to follow renames, transfers
   *           and deletions (oldest check first)
   * Only active GitHub subjects whose name is owner/name (not retired, not
   * merged into another). How long to wait after a lookup depends on how it
   * went: `retryMs` maps id_status (ok, error, not_found, conflict) to ms.
   */
  identityCandidates({ now, retryMs, limit = 100 } = {}) {
    const t = toMs(now);
    const wait = (status) => Number(retryMs?.[status ?? 'none'] ?? 0);
    const rows = this.raw.prepare(`
      SELECT * FROM subjects WHERE kind = 'github' AND retired_at IS NULL AND alias_of IS NULL
        AND (id_status IS NULL OR id_status <> 'duplicate')
      ORDER BY (id_checked_at IS NOT NULL), id_checked_at, tier, id
    `).all().map(plain);
    const ready = (s) => s.id_checked_at === null || Date.parse(s.id_checked_at) + wait(s.id_status) <= t;
    const byName = rows.filter((s) => s.repo_id === null && REPO_NAME_RE.test(String(s.name)) && ready(s)).slice(0, limit);
    const byId = rows.filter((s) => s.repo_id !== null && typeof s.node_id === 'string' && s.node_id !== '' && ready(s)).slice(0, limit);
    return { byName, byId };
  }

  /**
   * Apply one identity lookup of subject `key`, in one transaction.
   *   lookup.status  ok | not_found | error
   *   lookup.node    for ok: {databaseId, id, nameWithOwner, createdAt}
   *   lookup.via     name | id
   * Never moves the subject key, so no run_key changes. Returns the events it
   * recorded. What it does:
   *   error      id_status error (a bound subject keeps its id; one not found
   *              or in conflict keeps that status); tried again soon
   *   not_found  the repository was deleted or turned private, or the name is
   *              gone: id_status not_found and gone_at, a subject-fault skip
   *              (the due list leaves it out); event not_found, once
   *   ok         binds the id (event id_bound) if it is not bound yet; a new
   *              owner/name is recorded (renamed, or transferred when the
   *              owner changed) and becomes the name workers are sent; a
   *              subject that was not found is back (found_again).
   *              Guards: an id already bound to another subject with the same
   *              creation time is the same repository listed twice: the two
   *              are merged. The survivor is the one with history (results or
   *              attempts), else the one first seen earlier, whichever was
   *              bound first; the binding moves to it in this transaction if
   *              needed, the other becomes its alias (alias_of, retired; event
   *              merged), and the survivor is active if either was. With
   *              another creation time, or when a bound subject's lookup
   *              answers another id or creation time, the id would have been
   *              reused, which GitHub never does; and a first binding to a
   *              repository created after the subject was first seen would be
   *              a newcomer squatting on the old name. Neither binds, renames
   *              or merges anything (id_status conflict, event id_conflict
   *              once).
   */
  applyIdentityLookup(key, lookup, { now } = {}) {
    const t = iso(now);
    const events = [];
    const event = (e) => {
      const row = { subject: key, repoId: null, oldName: null, newName: null, detail: null, ...e };
      events.push(row);
      this.recordSubjectEvent({ ...row, now });
    };
    return this.tx(() => {
      const s = this.getSubject(key);
      if (!s) return events;
      const set = (fields) => {
        const cols = Object.keys(fields);
        this.raw.prepare(`UPDATE subjects SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), key);
      };
      const via = lookup?.via === 'id' ? 'id' : 'name';
      // A person's acceptance of this subject's conflict (acceptIdentityConflict)
      // is used up by this lookup, whatever it answers (R-SUBJ-17). It binds
      // only the exact repository accepted (id and creation time), and only
      // within ACCEPT_TTL_MS.
      const acceptKey = StateDb.acceptKey(key);
      const marker = this.getKv(acceptKey);
      if (marker !== undefined) this.deleteKv(acceptKey);
      const live = marker && typeof marker === 'object' && Date.parse(marker.expires) > toMs(now) ? marker : null;
      if (lookup?.status === 'not_found') {
        if (s.id_status !== 'not_found') {
          event({
            kind: 'not_found', repoId: s.repo_id, oldName: s.name,
            detail: { via, skip: { reason: 'repo_not_visible', fault: 'subject' } },
          });
        }
        set({ id_status: 'not_found', id_checked_at: t, gone_at: s.gone_at ?? t });
        return events;
      }
      const n = lookup?.status === 'ok' ? checkNode(lookup.node) : null;
      if (!n) {
        // No usable answer counts as an error: try again soon, change nothing
        // else. An acceptance used up here leaves the conflict as it was.
        let status = 'error';
        if (s.id_status === 'not_found' || s.id_status === 'conflict') status = s.id_status;
        else if (marker !== undefined && s.id_status === null) status = 'conflict'; // the accepted conflict stands
        set({ id_status: status, id_checked_at: t });
        return events;
      }
      const accepted = live !== null && n.repoId === live.repo_id && n.createdAt === live.created_at;
      const acceptance = accepted ? { at: live.at, repo_id: live.repo_id, created_at: live.created_at } : null;
      const conflict = (detail) => {
        if (s.id_status !== 'conflict') event({ kind: 'id_conflict', repoId: s.repo_id ?? n.repoId, oldName: s.name, newName: n.name, detail: { via, ...detail } });
        set({ id_status: 'conflict', id_checked_at: t });
        return events;
      };
      const heldElsewhere = () => { const o = this.getSubjectByRepoId(n.repoId); return o !== undefined && o.id !== key; };
      if (s.repo_id !== null) {
        if (s.repo_id !== n.repoId || (s.repo_created_at !== null && s.repo_created_at !== n.createdAt)) {
          if (!accepted || heldElsewhere()) {
            return conflict({ expected: { repo_id: s.repo_id, created_at: s.repo_created_at }, got: { repo_id: n.repoId, created_at: n.createdAt } });
          }
          event({ kind: 'id_bound', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, accepted: acceptance, replaced: { repo_id: s.repo_id, created_at: s.repo_created_at } } });
          set({ repo_id: n.repoId, repo_created_at: n.createdAt });
        }
      } else if (accepted && !heldElsewhere()) {
        event({ kind: 'id_bound', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, created_at: n.createdAt, accepted: acceptance } });
        set({ repo_id: n.repoId, repo_created_at: n.createdAt });
      } else {
        // A repository created after the subject was first seen cannot be the
        // one the subject meant: its old name now belongs to a newcomer, which
        // GitHub answers ahead of the redirect (R-SUBJ-12).
        const squat = (x) => Date.parse(n.createdAt) > Date.parse(x.first_seen);
        const squatConflict = () => conflict({ reason: 'created_after_first_seen', first_seen: s.first_seen, got: { repo_id: n.repoId, created_at: n.createdAt } });
        const other = this.getSubjectByRepoId(n.repoId);
        if (other && other.id !== key) {
          if (other.repo_created_at !== n.createdAt) {
            return conflict({ bound_to: other.id, expected: { created_at: other.repo_created_at }, got: { repo_id: n.repoId, created_at: n.createdAt } });
          }
          // The same repository as `other`. The survivor is the one with
          // history (results or attempts), else the one first seen earlier;
          // whichever was bound first does not matter (R-SUBJ-07).
          const sHist = this.hasSubjectHistory(key);
          const oHist = this.hasSubjectHistory(other.id);
          const sSurvives = sHist !== oHist ? sHist : s.first_seen < other.first_seen;
          if (!sSurvives) {
            const wasActive = s.retired_at === null;
            event({ kind: 'merged', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, into: other.id } });
            set({ alias_of: other.id, id_status: 'duplicate', id_checked_at: t, retired_at: s.retired_at ?? t });
            this.raw.prepare('UPDATE subjects SET alias_of = ? WHERE alias_of = ?').run(other.id, key);
            if (wasActive) {
              this.raw.prepare('UPDATE subjects SET retired_at = NULL, tier = MIN(tier, ?) WHERE id = ?').run(s.tier, other.id);
            }
            if (other.name !== n.name) {
              event({ subject: other.id, kind: renameKind(other.name, n.name), repoId: n.repoId, oldName: other.name, newName: n.name, detail: { via, seen_through: key } });
              this.raw.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(n.name, other.id);
            }
            return events;
          }
          if (squat(s)) return squatConflict();
          // This subject has the history: the binding moves here, in this
          // transaction, and the one bound first becomes its alias.
          const otherActive = other.retired_at === null;
          this.raw.prepare(`
            UPDATE subjects SET repo_id = NULL, node_id = NULL, repo_created_at = NULL, alias_of = ?, id_status = 'duplicate',
              id_checked_at = ?, retired_at = COALESCE(retired_at, ?) WHERE id = ?
          `).run(key, t, t, other.id);
          this.raw.prepare('UPDATE subjects SET alias_of = ? WHERE alias_of = ?').run(key, other.id);
          event({ subject: other.id, kind: 'merged', repoId: n.repoId, oldName: other.name, newName: n.name, detail: { via, into: key, binding_moved: true } });
          event({ kind: 'id_bound', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, created_at: n.createdAt, moved_from: other.id } });
          set({ repo_id: n.repoId, repo_created_at: n.createdAt, ...(otherActive ? { retired_at: null, tier: Math.min(s.tier, other.tier) } : {}) });
        } else {
          if (squat(s)) return squatConflict();
          event({ kind: 'id_bound', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, created_at: n.createdAt } });
          set({ repo_id: n.repoId, repo_created_at: n.createdAt });
        }
      }
      if (s.name !== n.name) {
        event({ kind: renameKind(s.name, n.name), repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via } });
      }
      if (s.gone_at !== null || s.id_status === 'not_found') {
        event({ kind: 'found_again', repoId: n.repoId, oldName: s.name, newName: n.name, detail: { via, gone_since: s.gone_at } });
      }
      set({ name: n.name, node_id: n.nodeId, id_status: 'ok', id_checked_at: t, gone_at: null });
      return events;
    });
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
   * The tool and probe versions a run_key is filed under, from the fields it
   * was computed from: {tool, probe}, or null when the run_key or its fields
   * are not recorded (R-PIN-01; ingest checks the result against them), or
   * 'malformed' when they are recorded but cannot be read (R-PIN-02: refused
   * on an enforce lane, never taken as no label).
   */
  runKeyPins(runKey) {
    const row = this.raw.prepare('SELECT fields FROM run_keys WHERE run_key = ?').get(runKey);
    if (!row || row.fields === null || row.fields === undefined) return null;
    if (typeof row.fields !== 'string') return 'malformed';
    let f;
    try { f = JSON.parse(row.fields); } catch { return 'malformed'; }
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return 'malformed';
    return { tool: f.tool_versions ?? {}, probe: f.probe_versions ?? {} };
  }

  /**
   * Record a dispatch before it is sent. `items` are [{run_key, subject, fence}]
   * in the order the worker receives them; each item's position is stored as its
   * item_index. Their leases (keyed by run_key, held by attemptId) must already
   * be taken.
   */
  createDispatch({ attemptId, shardId, workflow, repo, workflowFile, ref, expires, items, workflowSha = null, now }) {
    if (!attemptId || !shardId || !workflow || !repo || !workflowFile || !ref) {
      throw new TypeError('createDispatch needs attemptId, shardId, workflow, repo, workflowFile and ref');
    }
    if (!Array.isArray(items) || items.length === 0) throw new TypeError('createDispatch needs at least one item');
    const t = iso(now);
    this.tx(() => {
      this.raw.prepare(`
        INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status, workflow_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(attemptId, shardId, workflow, repo, workflowFile, ref, t, iso(expires), workflowSha);
      // subject_name: the owner/name the worker is sent (schema v8); the
      // result is recorded under the subject key whatever it is called later.
      const ins = this.raw.prepare('INSERT INTO dispatch_items (attempt_id, run_key, subject, workflow, fence, item_index, subject_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
      items.forEach((it, index) => ins.run(attemptId, it.run_key, it.subject, workflow, it.fence, index, it.subject_name ?? it.name ?? null));
      this.recordEvent({ type: 'dispatch_created', lane: workflow, n: items.length, data: { shard_id: shardId, items: items.length } }, now);
    });
  }

  /**
   * The worker run was created. runId may be null when it could not be
   * correlated yet. workflowSha only fills in a dispatch created without the
   * expected commit; the one recorded at creation (the ref's commit before
   * sending) is never replaced. Records a dispatch_sent event with it.
   */
  markDispatched(attemptId, { runId = null, runUrl = null, workflowSha = null, correlatedBy = null, now } = {}) {
    return this.tx(() => {
      const r = this.raw.prepare(`
        UPDATE dispatches SET status = 'dispatched', run_id = ?, run_url = ?, workflow_sha = COALESCE(workflow_sha, ?), correlated_by = ?
        WHERE attempt_id = ? AND status = 'pending'
      `).run(runId === null ? null : String(runId), runUrl, workflowSha, correlatedBy, attemptId);
      if (r.changes === 0) return false;
      this.dispatchEvent('dispatch_sent', attemptId, { run_id: runId === null ? null : String(runId), run_url: cap(runUrl) }, now);
      return true;
    });
  }

  /** An event about one dispatch: lane its workflow, n its item count. */
  dispatchEvent(type, attemptId, data, now) {
    return this.recordEvent(() => {
      const d = this.raw.prepare(`
        SELECT d.workflow, (SELECT COUNT(*) FROM dispatch_items i WHERE i.attempt_id = d.attempt_id) AS n
        FROM dispatches d WHERE d.attempt_id = ?
      `).get(attemptId);
      return { type, lane: d?.workflow ?? null, n: d?.n ?? 0, data };
    }, now);
  }

  /**
   * Fill in the run of a live dispatch that was sent without one (found later by
   * its run name). Never replaces a known run id. A pending dispatch becomes
   * dispatched. Returns true if the row changed.
   *
   * It never touches workflow_sha: a run found by its name is a claim to be
   * checked, so its own head_sha must not become the commit it is checked
   * against (R-ING-12). Ingest compares the run with the commit recorded when
   * the dispatch was created.
   */
  setDispatchRun(attemptId, { runId, runUrl = null, correlatedBy = null, now } = {}) {
    if (runId === undefined || runId === null) throw new TypeError('setDispatchRun needs a runId');
    return this.tx(() => {
      // A pending one was never marked sent, so this is its dispatch_sent; a
      // dispatched one had its event from markDispatched already.
      const wasPending = this.raw.prepare("SELECT 1 FROM dispatches WHERE attempt_id = ? AND status = 'pending' AND run_id IS NULL").get(attemptId);
      const r = this.raw.prepare(`
        UPDATE dispatches SET status = 'dispatched', run_id = ?, run_url = ?, correlated_by = ?
        WHERE attempt_id = ? AND run_id IS NULL AND status IN ('pending', 'dispatched')
      `).run(String(runId), runUrl, correlatedBy, attemptId);
      if (r.changes === 0) return false;
      if (wasPending) this.dispatchEvent('dispatch_sent', attemptId, { run_id: String(runId), run_url: cap(runUrl), correlated_by: 'run-name' }, now);
      return true;
    });
  }

  /**
   * The dispatch call failed: close it and free its leases and slot so the work is due again.
   * status: the HTTP status of the failed call, if any; withdrawn: it was never sent.
   */
  failDispatch(attemptId, { error, status = null, withdrawn = false, now } = {}) {
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
      this.dispatchEvent('dispatch_failed', attemptId, { status: Number.isSafeInteger(status) ? status : null, withdrawn: withdrawn === true }, now);
      return true;
    });
  }

  /**
   * The dispatch call ended so that GitHub may or may not have started the run
   * (R-CHAOS-05): the dispatch stays pending. Only records a
   * dispatch_unconfirmed event; false if the dispatch is not pending.
   */
  noteUnconfirmedDispatch(attemptId, { status = null, now } = {}) {
    return this.tx(() => {
      const d = this.raw.prepare("SELECT 1 FROM dispatches WHERE attempt_id = ? AND status = 'pending'").get(attemptId);
      if (!d) return false;
      this.dispatchEvent('dispatch_unconfirmed', attemptId, { status: Number.isSafeInteger(status) ? status : null }, now);
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
      this.dispatchEvent('dispatch_closed', attemptId, { close_reason: cap(why) }, now);
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
   * Dispatches ingest should look at: every open one (pending or dispatched;
   * the pump reaps expired ones first, so these are live), and ones closed as
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
   *    items: [{index, run_key, fence, subject, subject_name, repo_id, name,
   *             current_fence, outcome, resolved, retries}]}
   *
   * workflow_file is a path under .github/workflows/. items are in dispatch
   * order; index is the item's 0-based position, which names its result bundle
   * (result-<attempt_id>-<index>.tar.age). current_fence is the fence of the
   * item's run_key lease now (a newer one means the item is stale). outcome is
   * null until a result for this attempt, run_key and fence is recorded.
   * retries is how many retry_later decisions the run_key has had since its
   * last accepted result that measured something (retryLaterCount); throttled
   * and throttled_since are the count and first time of its retry_throttled
   * decisions since then
   * (retryThrottled; R-SUB-04).
   * subject is the subject key the result is recorded under; subject_name the
   * owner/name the worker was sent (null for dispatches from before schema
   * v8); repo_id and name the subject's repository id (null until looked up)
   * and current name, which may differ from subject_name after a rename.
   * canaries is always empty for now (none are injected yet). When they are,
   * they live only here, in the state database, which is stored encrypted
   * (scripts/state-asset.mjs); they must never go into dispatch inputs (shown
   * in the worker repos' public run pages), logs or unsealed outputs.
   */
  getAttempt(attemptId) {
    const d = this.getDispatch(attemptId);
    if (!d) return undefined;
    const recorded = this.raw.prepare(`
      SELECT accepted, outcome FROM attempts WHERE attempt_id = ? AND run_key = ? AND fence = ? ORDER BY id LIMIT 1
    `);
    const subj = this.raw.prepare('SELECT repo_id, name FROM subjects WHERE id = ?');
    const items = d.items.map((it) => {
      const lease = this.getLease(it.run_key);
      const rec = recorded.get(attemptId, it.run_key, it.fence);
      const s = subj.get(it.subject);
      return {
        index: it.item_index,
        run_key: it.run_key,
        fence: it.fence,
        subject: it.subject,
        subject_name: it.subject_name ?? null,
        repo_id: s?.repo_id ?? null,
        name: s?.name ?? null,
        current_fence: lease ? lease.fence : null,
        outcome: rec ? rec.outcome ?? (rec.accepted === 1 ? 'accepted' : 'rejected') : null,
        resolved: it.resolved,
        retries: this.retryLaterCount(it.run_key),
        ...this.retryThrottled(it.run_key),
        pins: this.runKeyPins(it.run_key),
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
        this.dispatchEvent('dispatch_expired', d.attempt_id, {}, now);
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
   *   digest?: string, resultOutcome?: string, fault?: string|null, coverage?: string,
   *   now?: number|string|Date}} args
   *   resultOutcome: what the results row stores as its outcome when accepted
   *   (default: outcome); ingest passes 'skips_only' for a result with no
   *   records whose every skip is retryable (R-SUB-06).
   *   completedAt: when GitHub says the worker run completed (ms or ISO).
   *   The lease's expiry is checked against it when it is earlier than now,
   *   so a run that finished in time is not rejected as lease_expired because
   *   the pump looked later (R-CHAOS-02).
   *   fault, coverage: the result's fault side and coverage state
   *   (worker-kit/contract.mjs resultFault, R-COV-02); stored on the results
   *   row, NULL when not given. coverage 'assessed' also sets assessed_at.
   *   oracle: the accepted bundle's oracle facts (state/oracle.mjs
   *   oracleFacts), folded into the subject's disagreement by noteOracle().
   *   It never changes fault or coverage.
   * @returns {{accepted: boolean, reason: string|null, id: number, duplicate?: true}}
   */
  recordResult({ run_key: runKey, attempt_id: attemptId, fence, outcome = null, verdict, accepted, reason = null, digest = null, resultOutcome = null, fault = null, coverage = null, oracle = null, completedAt = null, now } = {}) {
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
        // A result is on time if its run finished before the lease ran out,
        // even when the pump only judged it afterwards (R-CHAOS-02): the lease
        // bounds the worker, not the pump's next tick. completedAt is when
        // GitHub says the run completed (never the worker's own claim), and
        // only ever moves the check earlier. A newer lease still makes this
        // fence stale, whatever the time.
        const done = completedAt === null || completedAt === undefined ? NaN : toMs(completedAt);
        const asOf = Number.isFinite(done) && done < toMs(now) ? done : now;
        const c = this.checkFence(runKey, fence, { holder: attemptId, now: asOf });
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
      this.recordEvent({
        type: 'result_recorded', lane: item?.workflow ?? d?.workflow ?? this.getRunKey(runKey)?.workflow ?? null, subject: subject === 'unknown' ? null : subject,
        data: { verdict: ok ? 'accepted' : 'rejected', reason: cap(why), outcome: ok ? resultOutcome ?? outcome : stored, fault: ok ? fault : null, coverage: ok ? coverage : null },
      }, now);
      if (current) {
        this.raw.prepare('UPDATE dispatch_items SET resolved = ? WHERE attempt_id = ? AND run_key = ?').run(t, attemptId, runKey);
        this.releaseLease(runKey, attemptId, fence, { now });
        if (ok) {
          // A skips_only result keeps measured_at, so the retry counters run on (R-SUB-08).
          const final = resultOutcome ?? outcome;
          const skipsOnly = final === 'skips_only';
          // fault and coverage describe this result; assessed_at keeps the
          // last assessed one for the run_key (R-COV-02).
          const assessed = coverage === 'assessed' ? t : null;
          this.raw.prepare(`
            INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, digest, accepted_at, measured_at, skips_streak,
              fault, coverage, assessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (run_key) DO UPDATE SET attempt_id = excluded.attempt_id, fence = excluded.fence,
              outcome = excluded.outcome, digest = excluded.digest, accepted_at = excluded.accepted_at,
              measured_at = CASE WHEN excluded.outcome IS 'skips_only' THEN results.measured_at ELSE excluded.accepted_at END,
              skips_streak = CASE WHEN excluded.outcome IS 'skips_only' THEN results.skips_streak + 1 ELSE 0 END,
              fault = excluded.fault, coverage = excluded.coverage,
              assessed_at = COALESCE(excluded.assessed_at, results.assessed_at)
          `).run(runKey, item.subject, item.workflow, attemptId, fence, final, digest, t, skipsOnly ? null : t, skipsOnly ? 1 : 0,
            fault, coverage, assessed);
          if (oracle || ORACLE_LANES.includes(item.workflow)) this.noteOracle(item.subject, item.workflow, runKey, oracle, { now: t, observedAt: completedAt != null && toMs(completedAt) < toMs(now) ? completedAt : now });
        }
        const open = this.raw.prepare('SELECT COUNT(*) AS n FROM dispatch_items WHERE attempt_id = ? AND resolved IS NULL').get(attemptId).n;
        if (open === 0) {
          const closed = this.raw.prepare(`
            UPDATE dispatches SET status = 'done', closed = ?, close_reason = 'results_in'
            WHERE attempt_id = ? AND status IN ('pending', 'dispatched')
          `).run(t, attemptId);
          this.releaseSlotForAttempt(attemptId, 'result', { now });
          if (closed.changes > 0) this.dispatchEvent('dispatch_closed', attemptId, { close_reason: 'results_in' }, now);
        }
      }
      return { accepted: ok, reason: why, id: Number(r.lastInsertRowid) };
    });
  }

  /**
   * Keep the oracle facts of an accepted result and re-derive the subject's
   * disagreement (state/oracle.mjs). Called inside recordResult()'s
   * transaction.
   *
   * Facts carry the subject version they were read at (sha, else artifact
   * digest, from the run_key's fields); a lane whose facts are of another
   * version than this result's is stale and left out of the comparison, and
   * is dropped when an accepted result of that lane for the newer version has
   * no facts (`facts` null) (R-ORD-12).
   *
   * One check cycle is one result from every lane that has current facts. A
   * cycle that leaves the disagreement unchanged counts as one re-check
   * towards settling (R-ORD-13). Besides that, a rolling budget of
   * ORACLE_BUDGET_MAX cycles with a disagreement per ORACLE_BUDGET_DAYS settles
   * a subject whatever its clears and reopens (a server that flaps).
   * Server-side evidence is stored beside it and never opens or keeps one.
   * @returns {{status: string|null, kinds: object[]}}
   */
  noteOracle(subject, workflow, runKey, facts, { now, observedAt = now, maxUnchanged = ORACLE_MAX_UNCHANGED } = {}) {
    const t = iso(now);
    const at = toMs(observedAt);
    const rk = this.getRunKey(runKey);
    let fields = {};
    try { fields = rk ? JSON.parse(rk.fields) : {}; } catch { /* no version */ }
    const version = fields.sha ?? fields.artifact_digest ?? null;
    // A result that was observed before the lane's stored facts is late: it may be of an older version, and must not
    // overwrite or drop the newer facts (R-ORD-17). Versions are hashes with no order, so the observation time decides.
    const stored = this.raw.prepare('SELECT facts, updated_at FROM oracle_facts WHERE subject = ? AND workflow = ?').get(subject, workflow);
    if (stored) {
      const sf = JSON.parse(stored.facts);
      const storedAt = Number.isFinite(sf.at) ? sf.at : toMs(stored.updated_at);
      if (at < storedAt) return { status: null, kinds: [], refused: 'older' };
    }
    if (facts) {
      this.raw.prepare(`
        INSERT INTO oracle_facts (subject, workflow, run_key, facts, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (subject, workflow) DO UPDATE SET run_key = excluded.run_key, facts = excluded.facts, updated_at = excluded.updated_at
      `).run(subject, workflow, runKey, JSON.stringify({ ...facts, version, at }), t);
    } else {
      // No facts from this result: its lane's older facts are dropped when they are of another version.
      const old = this.raw.prepare('SELECT facts FROM oracle_facts WHERE subject = ? AND workflow = ?').get(subject, workflow);
      if (!old || (JSON.parse(old.facts).version ?? null) === version) return { status: null, kinds: [] };
      this.raw.prepare('DELETE FROM oracle_facts WHERE subject = ? AND workflow = ?').run(subject, workflow);
    }
    const rows = this.raw.prepare('SELECT workflow, facts, updated_at FROM oracle_facts WHERE subject = ?').all(subject)
      .map((r) => { const f = JSON.parse(r.facts); return [r.workflow, { ...f, at: Number.isFinite(f.at) ? f.at : toMs(r.updated_at) }]; }).filter(([, f]) => (f.version ?? null) === version);
    const byLane = Object.fromEntries(rows);
    const derived = deriveDisagreements({ static: byLane['scan-static'] ?? null, live: byLane['live-probe'] ?? null, version });
    const prior = plain(this.raw.prepare('SELECT * FROM oracle_disagreements WHERE subject = ?').get(subject));
    const seen = new Set([...(prior ? JSON.parse(prior.lanes_seen) : []), workflow]);
    const cycle = rows.every(([lane]) => seen.has(lane));
    const next = foldDisagreement(prior, derived, { maxUnchanged, cycle });
    if (next.status === null) return { status: null, kinds: [] };
    if (next.status === 'cleared' && prior?.status === 'cleared') return { status: 'cleared', kinds: [] }; // already cleared: keep its time
    const reopened = next.status === 'open' && (!prior || prior.status === 'cleared' || prior.signature !== derived.signature);
    // The rolling budget: cycles with a disagreement present, and every (re)opening, in the last ORACLE_BUDGET_DAYS.
    const since = toMs(t) - ORACLE_BUDGET_DAYS * 86_400_000;
    let log = (prior ? JSON.parse(prior.recheck_log) : []).filter((x) => toMs(x) >= since);
    let { status, reason } = next;
    if (derived.signature && (cycle || reopened)) log.push(t);
    log = log.slice(-(ORACLE_BUDGET_MAX + 1)); // the log needs no more than the budget and one
    if (status === 'open' && log.length > ORACLE_BUDGET_MAX) { status = 'settled'; reason = 'recheck_budget'; }
    const lanesSeen = status === 'cleared' || reopened || cycle ? [] : [...seen];
    const kinds = status === 'cleared' ? prior.kinds : JSON.stringify(derived.kinds);
    this.raw.prepare(`
      INSERT INTO oracle_disagreements (subject, status, kinds, signature, server_side, unchanged_rechecks, lanes_seen, recheck_log, opened_at, updated_at, cleared_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject) DO UPDATE SET status = excluded.status, kinds = excluded.kinds, signature = excluded.signature,
        server_side = excluded.server_side, unchanged_rechecks = excluded.unchanged_rechecks, lanes_seen = excluded.lanes_seen,
        recheck_log = excluded.recheck_log,
        opened_at = CASE WHEN ? THEN excluded.opened_at ELSE oracle_disagreements.opened_at END,
        updated_at = excluded.updated_at, cleared_at = excluded.cleared_at, reason = excluded.reason
    `).run(subject, status, kinds, status === 'cleared' ? prior.signature : derived.signature, JSON.stringify(derived.server_side),
      next.unchanged_rechecks, JSON.stringify(lanesSeen), JSON.stringify(log), t, t, status === 'cleared' ? t : null, reason, reopened ? 1 : 0);
    return { status, kinds: derived.kinds };
  }

  /** The stored disagreement rows, parsed. `status` filters (default: all). */
  listOracleDisagreements({ status = null } = {}) {
    const rows = status ? this.raw.prepare('SELECT * FROM oracle_disagreements WHERE status = ? ORDER BY subject').all(status)
      : this.raw.prepare('SELECT * FROM oracle_disagreements ORDER BY subject').all();
    return rows.map((r) => ({ ...plain(r), kinds: JSON.parse(r.kinds), server_side: r.server_side ? JSON.parse(r.server_side) : [] }));
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

  // ---- retry_later ----

  /**
   * retry_later decisions for a run_key since its last accepted result that
   * measured something (results.measured_at): a skips_only result does not
   * start the count over (R-SUB-08).
   */
  retryLaterCount(runKey) {
    return this.raw.prepare(`
      SELECT COUNT(*) AS n FROM attempts WHERE run_key = ? AND reason = 'retry_later'
        AND received > COALESCE((SELECT measured_at FROM results WHERE run_key = ?), '')
    `).get(runKey, runKey).n;
  }

  /**
   * retry_throttled decisions for a run_key since its last accepted result that
   * measured something: {throttled, throttled_since}. A skips_only result does
   * not open a new window (R-SUB-08).
   */
  retryThrottled(runKey) {
    const r = this.raw.prepare(`
      SELECT COUNT(*) AS n, MIN(received) AS first FROM attempts WHERE run_key = ? AND reason = 'retry_throttled'
        AND received > COALESCE((SELECT measured_at FROM results WHERE run_key = ?), '')
    `).get(runKey, runKey);
    return { throttled: Number(r.n), throttled_since: r.first ?? null };
  }

  /**
   * run_keys sent back as retry_later or retry_throttled that must wait before
   * they are due again: the n-th retry waits baseMs x 2^(n-1) after the
   * decision, at most maxMs (R-SUB-04).
   * @returns {string[]}
   */
  retryLaterWaiting({ now, baseMs, maxMs = Infinity }) {
    const t = toMs(now);
    const rows = this.raw.prepare(`
      SELECT a.run_key, COUNT(*) AS n, MAX(a.received) AS last FROM attempts a
      WHERE a.reason IN ('retry_later', 'retry_throttled') AND a.run_key IS NOT NULL
        AND a.received > COALESCE((SELECT accepted_at FROM results r WHERE r.run_key = a.run_key), '')
      GROUP BY a.run_key
    `).all();
    return rows.filter((r) => Date.parse(r.last) + Math.min(maxMs, baseMs * 2 ** Math.min(10, r.n - 1)) > t).map((r) => r.run_key);
  }

  // ---- run_sha_mismatch alarm (R-ING-22) ----
  //
  // run_sha_mismatch does not count towards parking a run_key (R-ING-18), so on
  // its own nothing would stop a workflow whose every run is at the wrong
  // commit (a branch that keeps moving, a run name someone else keeps taking).
  // Ingest counts consecutive dispatches of a workflow rejected that way; at
  // `limit` the workflow is paused for `pauseMs` (kv pump.paused:<workflow>):
  // the pump dispatches none of it and fails its runs, which shows red on the
  // health issue, until the pause ends. A dispatch whose run passed the checks
  // resets the count.

  /**
   * One more dispatch of `workflow` rejected as run_sha_mismatch. `sha` is the
   * commit recorded with that dispatch and `created` when the dispatch was
   * made. The shards of one tick that a merge overtook (all recorded at the old
   * commit, all run at the new one) are one burst and count once (R-ING-24).
   * A mismatch belongs to the current burst only when it has the burst's
   * recorded commit AND its dispatch was made within `burstMs` of the burst's
   * FIRST dispatch (R-ING-26). One tick reserves all its shards in one loop of
   * local writes, so their `created` times lie within seconds. Ticks start
   * 150 s apart, but each runs ingest first and ingest's length varies, so
   * there is no fixed minimum gap between two ticks' dispatches: usually about
   * two minutes, yet as little as ~10 s when one tick's ingest runs long and
   * the next one's is short. 30 s holds one tick's shards with room to spare;
   * two ticks that happen to land within 30 s of a burst's start count once
   * (one mismatch missed, not a chain), and since the burst's start never
   * moves, repeats cannot chain from tick to tick. The same commit in later
   * ticks therefore keeps counting, and a cause that persists at a fixed
   * commit (someone taking the run names, a ref GitHub resolves differently)
   * still pauses the workflow (R-ING-25).
   * Returns {count, paused}.
   */
  noteShaMismatch(workflow, { sha = null, created = null, now, limit = 3, pauseMs = 6 * 3_600_000, burstMs = SHA_BURST_MS } = {}) {
    const key = `pump.sha_mismatch:${workflow}`;
    const prev = this.getKv(key);
    const before = Number.isSafeInteger(prev?.count) ? prev.count : 0;
    const at = created === null || created === undefined ? NaN : toMs(created);
    const burstAt = prev?.burst_created ? Date.parse(prev.burst_created) : NaN;
    const sameBurst = Number.isFinite(at) && Number.isFinite(burstAt) && Math.abs(at - burstAt) <= burstMs;
    if (before > 0 && sha !== null && prev.last_sha === sha && sameBurst) {
      this.setKv(key, { ...prev, last: iso(now) }, { now }); // the burst's start stays where it was
      return { count: before, paused: false };
    }
    const count = before + 1;
    if (count < limit) {
      this.setKv(key, {
        count, first: prev?.first ?? iso(now), last: iso(now), last_sha: sha, burst_created: Number.isFinite(at) ? iso(at) : null,
      }, { now });
      return { count, paused: false };
    }
    const until = iso(toMs(now) + pauseMs);
    this.tx(() => {
      this.setKv(`pump.paused:${workflow}`, { reason: 'run_sha_mismatch', count, since: iso(now), until }, { now });
      this.deleteKv(key);
      this.recordEvent({ type: 'workflow_paused', lane: workflow, data: { until } }, now);
    });
    return { count, paused: true };
  }

  /**
   * Pause `workflow` after a result was refused for its version pins
   * (pin_mismatch or pin_unverified; R-PIN-01): the same pause as the
   * run_sha_mismatch alarm (pump.paused:<workflow>, the pump dispatches none
   * of it and fails its runs until `until`), set at the first refusal because
   * a pin refusal is not a race: every shard would be refused the same way
   * until a pin or the worker changes. It is not counted towards parking, so
   * when the pause ends the work is due again. An existing longer pause is
   * kept. Returns {until}.
   */
  pausePinRefused(workflow, { reason, now, pauseMs = PIN_PAUSE_MS } = {}) {
    const key = `pump.paused:${workflow}`;
    const prev = this.getKv(key);
    const until = iso(toMs(now) + pauseMs);
    if (prev?.until && Date.parse(prev.until) >= Date.parse(until)) return { until: prev.until };
    const same = prev?.reason === reason && Date.parse(prev.until) > toMs(now);
    this.tx(() => {
      this.setKv(key, { reason, count: (same && Number.isSafeInteger(prev.count) ? prev.count : 0) + 1, since: same ? prev.since : iso(now), until }, { now });
      this.recordEvent({ type: 'workflow_paused', lane: workflow, data: { until } }, now);
    });
    return { until };
  }

  /**
   * Replace the expected commit of a dispatch not sent yet (pending): the pump
   * reads the ref again just before sending (R-ING-24).
   */
  updateDispatchSha(attemptId, workflowSha) {
    const r = this.raw.prepare("UPDATE dispatches SET workflow_sha = ? WHERE attempt_id = ? AND status = 'pending'").run(workflowSha, attemptId);
    return r.changes > 0;
  }

  /** A dispatch of `workflow` whose run passed the run checks: the count starts again. */
  clearShaMismatch(workflow) {
    this.deleteKv(`pump.sha_mismatch:${workflow}`);
  }

  /** [{workflow, reason, count, since, until}] paused now. */
  pausedWorkflows({ now } = {}) {
    const t = toMs(now);
    return this.raw.prepare("SELECT key, value FROM kv WHERE key LIKE 'pump.paused:%' ORDER BY key").all()
      .map((r) => ({ workflow: r.key.slice('pump.paused:'.length), ...JSON.parse(r.value) }))
      .filter((p) => Date.parse(p.until) > t);
  }

  // ---- ingest failures ----
  //
  // How often the pump failed to judge one item of a dispatch (an error that
  // was neither transient nor a decision). Kept in kv, outside the item's
  // judging transaction, so a failure still counts when that transaction
  // rolls back. collect.mjs gives up on the item after a few (R-ING-05).

  static ingestFailureKey(attemptId, index) {
    return `ingest.failures:${attemptId}:${index}`;
  }

  /** Count one more failure; returns the new count. */
  noteIngestFailure(attemptId, index, { error = null, now } = {}) {
    const key = StateDb.ingestFailureKey(attemptId, index);
    const prev = this.getKv(key);
    const t = iso(now);
    const count = (Number.isSafeInteger(prev?.count) ? prev.count : 0) + 1;
    this.setKv(key, { count, first: prev?.first ?? t, last: t, error: error === null ? null : String(error).slice(0, 300) }, { now });
    return count;
  }

  /** {count, first, last, error} for an item, or {count: 0}. */
  ingestFailures(attemptId, index) {
    return this.getKv(StateDb.ingestFailureKey(attemptId, index)) ?? { count: 0 };
  }

  clearIngestFailures(attemptId, index) {
    this.deleteKv(StateDb.ingestFailureKey(attemptId, index));
  }

  // ---- events (schema v10) ----

  /**
   * Append one event. Call it inside the transaction that writes the fact it
   * describes: an event commits only with its fact. `event` is the event or a
   * function that returns it (run inside the guard below). occurredAt
   * defaults to now; data is stored as JSON. Returns the new id.
   *
   * A failed event never undoes or blocks its fact: the insert runs in its
   * own savepoint, and if anything about it throws, only that savepoint is
   * rolled back, the failure is counted in kv `events.insert_failures`
   * ({count, last_at, last_type}, in the same transaction), one line is
   * logged, and null is returned.
   */
  recordEvent(event = {}, now) {
    return this.tx(() => {
      this.raw.exec('SAVEPOINT event_insert');
      let type = typeof event === 'function' ? null : event?.type ?? null;
      try {
        const ev = typeof event === 'function' ? event() : event;
        type = ev?.type ?? null;
        const { occurredAt, lane = null, n = 1, subject = null, data = {} } = ev ?? {};
        if (typeof type !== 'string' || type === '') throw new TypeError('recordEvent needs a type');
        if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`recordEvent n must be a whole number >= 0, got ${n}`);
        const recorded = iso(now);
        const r = this.raw.prepare(`
          INSERT INTO events (type, occurred_at, recorded_at, lane, n, subject, data) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(type, occurredAt === undefined || occurredAt === null ? recorded : iso(occurredAt), recorded, lane ?? null, n, subject ?? null, JSON.stringify(data ?? {}));
        this.raw.exec('RELEASE event_insert');
        return Number(r.lastInsertRowid);
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK TO event_insert');
          this.raw.exec('RELEASE event_insert');
        } catch {
          throw err; // SQLite gave up the whole transaction: the fact is gone too
        }
        this.noteEventFailure(type, err, now);
        return null;
      }
    });
  }

  /** Count and log an event that could not be recorded (never throws). */
  noteEventFailure(type, err, now) {
    const t = Number.isFinite(toMs(now)) ? iso(now) : new Date().toISOString();
    try {
      const prev = this.getKv('events.insert_failures');
      this.setKv('events.insert_failures', { count: (Number.isSafeInteger(prev?.count) ? prev.count : 0) + 1, last_at: t, last_type: cap(type) }, { now: t });
    } catch { /* the count is best effort */ }
    try {
      this.log(`state: event ${cap(type) ?? '(no type)'} not recorded (${cap(String(err?.message ?? err))}); its fact is kept`);
    } catch { /* a log that throws changes nothing */ }
  }

  /** Events with id > sinceId, oldest first, at most `limit`; data parsed. */
  listEvents({ sinceId = 0, limit = 1000 } = {}) {
    return this.raw.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(sinceId, limit)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }

  // ---- pump notes: a kv record and its event in one transaction ----

  /**
   * pump_run_started / pump_run_finished. With lastRun, also writes kv
   * pump.last_run (as run.mjs did on its own before).
   */
  notePumpRun(phase, { ticks = 0, dispatched = 0, lastRun, occurredAt } = {}, { now } = {}) {
    if (phase !== 'started' && phase !== 'finished') throw new TypeError(`notePumpRun phase must be started or finished, got ${phase}`);
    return this.tx(() => {
      if (lastRun !== undefined) this.setKv('pump.last_run', lastRun, { now });
      return this.recordEvent({ type: `pump_run_${phase}`, occurredAt, data: { ticks, dispatched } }, now);
    });
  }

  /** kv pump.successor (what pump/successor.mjs wrote) and a successor event. */
  noteSuccessor(result, { now } = {}) {
    return this.tx(() => {
      this.setKv('pump.successor', result, { now });
      const status = /\bHTTP (\d{3})\b/.exec(String(result?.error ?? ''));
      return this.recordEvent({
        type: 'successor',
        data: { ok: result?.ok === true, run_id: Number.isSafeInteger(result?.runId) ? result.runId : null, status: status ? Number(status[1]) : null },
      }, now);
    });
  }

  /** kv `key` (the registry delta record); a registry_delta event when it dispatched or failed. */
  noteRegistryDelta(key, value, { now } = {}) {
    return this.tx(() => {
      this.setKv(key, value, { now });
      if (value?.action === 'dispatched' || value?.action === 'failed') {
        this.recordEvent({ type: 'registry_delta', data: { action: value.action } }, now);
      }
    });
  }

  /** kv `key` (the sandbox breaker record) and a breaker_changed event. */
  noteBreaker(key, value, { now } = {}) {
    return this.tx(() => {
      this.setKv(key, value, { now });
      return this.recordEvent({
        type: 'breaker_changed',
        data: { tripped: value?.tripped === true, reason: cap(value?.reason ?? null), held: Array.isArray(value?.held) ? value.held.map((h) => cap(h)) : [] },
      }, now);
    });
  }

  // ---- kv ----

  getKv(key) {
    const row = this.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  deleteKv(key) {
    this.raw.prepare('DELETE FROM kv WHERE key = ?').run(key);
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
