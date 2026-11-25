// Pruning closed history out of the live state (loop upgrade #14).
//
// The state grows by about 2.2 KB per attempt and nothing removed rows, so
// this moves rows that are finished, and that nothing the loop decides reads
// any more, out of the live database into a sealed archive. It is pure
// database work: pump/prune.mjs runs it inside the pump (the state's only
// writer), uploads the archive and deletes only what an archive that reads
// back holds.
//
// What is kept, and why (the invariants; docs/OPERATIONS.md, "State pruning"):
//
//   counters        never touched: the fence counter only grows.
//   subjects, results, runs
//                   never touched. results holds one row per run_key: the
//                   latest accepted result for that (subject, workflow,
//                   run_key), with its coverage, fault, assessed_at,
//                   measured_at and skips_streak. ever_assessed and the due
//                   list are computed from all of them.
//   dispatches      kept while open (pending, dispatched) and for `cutoff`
//                   after they closed (done, failed, expired). Ingest judges a
//                   late result for up to LATE_MS (6 h, R-CHAOS-02) after an
//                   expired dispatch closed; the cutoff is never less than
//                   that plus an hour (pruneFloorMs), and is 7 days by default,
//                   past the worker artifacts' 3 days, so nothing can still be
//                   judged or re-ingested.
//   dispatch_items  kept with their dispatch.
//   leases          kept for every run_key a kept dispatch item names (fencing,
//                   stale-fence detection and getAttempt().current_fence for
//                   in-flight and late work), and while held and unexpired.
//                   A run_key with no lease row gets a fresh fence from the
//                   counter when it is next leased, as for one never leased.
//   attempts        kept while their dispatch is kept (duplicate detection,
//                   getAttempt outcomes, the late-result query), and whenever
//                   they still count: a counted rejection after the run_key's
//                   latest acceptance (parking, rejectedCount and
//                   rejectedRunKeys), or a retry_later / retry_throttled after
//                   its last measured result (retryLaterCount, retryThrottled,
//                   retryLaterWaiting: the retry budget and backoff). Those are
//                   kept however old they are.
//   slot_ledger     open rows are never touched; released ones go after cutoff.
//   attempts, slot_ledger  the row with the highest id always stays: both use
//                   INTEGER PRIMARY KEY without AUTOINCREMENT, so pruning the
//                   newest would let SQLite hand its id out again, and two
//                   different attempts would share an id in the archives
//                   (R-PRUNE-02).
//   run_keys        kept for the run_key(s) of each (subject, workflow)'s newest
//                   result (the due list reads its fields), for any run_key a
//                   kept dispatch item names, and while it has a lease row.
//                   A run_key's fields are a function of the key, so a key due
//                   again is recorded again unchanged.
//   kv              only `ingest.failures:<attempt>:<index>` rows of a pruned
//                   dispatch go; the throttle and API budget state, pauses,
//                   breaker memory and every other key are never touched.
//   events          (schema v10) kept a day longer than the cutoff (8 days at
//                   the default 7), so the live view's 7-day windows stay
//                   whole; nothing the loop decides reads them. The newest
//                   row always stays, so the events' max id (the live
//                   snapshot's seq) never goes back.
//
// Every rule is one SQL predicate over the row (`eligibleSql`). The same
// predicates select the rows to archive (a dry run inside a savepoint that is
// rolled back, so later tables see the earlier deletions) and decide, at
// delete time, which archived rows may go: a row is deleted only when it is in
// the archive, is still byte for byte what was archived, and still meets its
// rule against the database as it is then.

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { NOT_COUNTED_REASONS } from './db.mjs';
import { readTar, writeTar } from '../worker-kit/tar.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Rows must have been closed (or received, released, last leased) this long ago. */
export const PRUNE_MIN_AGE_MS = 7 * DAY;
/** Rows one pass may move out. */
export const PRUNE_MAX_ROWS = 50_000;
/** How long one pass may spend selecting rows. */
export const PRUNE_MAX_MS = 30_000;
export const ARCHIVE_FORMAT = 'tool-qa-state-archive';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_META = 'state-archive.json';
export const ARCHIVE_ROWS = 'rows.ndjson.gz';
/** Most plaintext an archive may expand to when read back. */
export const ARCHIVE_MAX_BYTES = 512 * 1024 ** 2;

/** The smallest cutoff age allowed: the late-result window plus an hour. */
export function pruneFloorMs(lateMs) {
  return Math.max(0, Number(lateMs) || 0) + HOUR;
}

/**
 * Tables in the order rows are deleted (children before parents, leases before
 * run_keys). events is last, so when a pass hits its row or time budget it is
 * the first table left for the next pass.
 */
export const DELETE_ORDER = Object.freeze(['dispatch_items', 'dispatches', 'kv', 'attempts', 'slot_ledger', 'leases', 'run_keys', 'events']);

/** The columns that identify a row of each table. */
export const KEYS = Object.freeze({
  dispatch_items: ['attempt_id', 'run_key'],
  dispatches: ['attempt_id'],
  kv: ['key'],
  attempts: ['id'],
  slot_ledger: ['id'],
  leases: ['subject'],
  run_keys: ['run_key'],
  events: ['id'],
});

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NOT_COUNTED = NOT_COUNTED_REASONS.map(quote).join(', ');
const RETRY = ["'retry_later'", "'retry_throttled'"].join(', ');
const FAILURES_PREFIX = 'ingest.failures:';

const DISPATCH_CLOSED = (d) => `${d}.status IN ('done', 'failed', 'expired') AND ${d}.closed IS NOT NULL AND ${d}.closed < $cutoff`;

/**
 * An attempt that still counts for its run_key. A superset of what
 * rejectedCount, rejectedRunKeys, retryLaterCount, retryThrottled and
 * retryLaterWaiting (state/db.mjs) count: a rejection with no reason is kept
 * too, where those queries would not count it.
 */
const ATTEMPT_NEEDED = `x.run_key IS NOT NULL AND (
    (x.accepted = 0 AND COALESCE(x.reason, '') NOT IN (${NOT_COUNTED})
      AND x.received > COALESCE((SELECT r.accepted_at FROM results r WHERE r.run_key = x.run_key), ''))
    OR (COALESCE(x.reason, '') IN (${RETRY})
      AND x.received > COALESCE((SELECT r.measured_at FROM results r WHERE r.run_key = x.run_key), '')))`;

const RULES = Object.freeze({
  dispatch_items: `EXISTS (SELECT 1 FROM dispatches d WHERE d.attempt_id = x.attempt_id AND ${DISPATCH_CLOSED('d')})`,
  dispatches: `${DISPATCH_CLOSED('x')} AND NOT EXISTS (SELECT 1 FROM dispatch_items i WHERE i.attempt_id = x.attempt_id)`,
  kv: `substr(x.key, 1, ${FAILURES_PREFIX.length}) = ${quote(FAILURES_PREFIX)} AND x.updated < $cutoff
    AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE substr(x.key, ${FAILURES_PREFIX.length + 1}, length(d.attempt_id) + 1) = d.attempt_id || ':')`,
  attempts: `x.received < $cutoff
    AND x.id < (SELECT MAX(id) FROM attempts)
    AND (x.attempt_id IS NULL OR NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.attempt_id = x.attempt_id))
    AND NOT (${ATTEMPT_NEEDED})`,
  slot_ledger: 'x.released IS NOT NULL AND x.released < $cutoff AND x.id < (SELECT MAX(id) FROM slot_ledger)',
  leases: `x.acquired < $cutoff
    AND ((x.holder IS NULL AND COALESCE(x.released, '') < $cutoff) OR (x.holder IS NOT NULL AND x.expires < $cutoff))
    AND NOT EXISTS (SELECT 1 FROM dispatch_items i WHERE i.run_key = x.subject)`,
  run_keys: `x.first_seen < $cutoff
    AND NOT EXISTS (SELECT 1 FROM dispatch_items i WHERE i.run_key = x.run_key)
    AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.subject = x.run_key)
    AND NOT EXISTS (SELECT 1 FROM results r WHERE r.run_key = x.run_key
      AND r.accepted_at >= (SELECT MAX(r2.accepted_at) FROM results r2 WHERE r2.subject = r.subject AND r2.workflow = r.workflow))`,
  events: `x.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', $cutoff, '-1 day') AND x.id < (SELECT MAX(id) FROM events)`,
});

/** The rule a row of `table` (aliased x) must meet to be pruned, with $cutoff. */
export function eligibleSql(table) {
  const rule = RULES[table];
  if (!rule) throw new TypeError(`no prune rule for table ${table}`);
  return rule;
}

function isoCutoff(cutoff) {
  const ms = typeof cutoff === 'number' ? cutoff : Date.parse(cutoff);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid prune cutoff: ${cutoff}`);
  return new Date(ms).toISOString();
}

const plain = (row) => ({ ...row });

function hasTable(raw, name) {
  return Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** Run fn in a savepoint that is always rolled back. */
function dryRun(raw, fn) {
  raw.exec('SAVEPOINT prune_dry_run');
  try {
    return fn();
  } finally {
    raw.exec('ROLLBACK TO prune_dry_run');
    raw.exec('RELEASE prune_dry_run');
  }
}

function deleteRowids(raw, table, rowids) {
  const del = raw.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
  for (const id of rowids) del.run(id);
}

/**
 * The rows one prune pass would move out, oldest first, without changing the
 * database: at most `maxRows`, stopping early (and saying so) once `deadline`
 * (by `clock`) has passed. Each table is chosen after the earlier tables'
 * rows are gone, so the rules see the database as the delete will leave it.
 * @returns {{cutoff: string, rows: {table: string, row: object}[], counts: Record<string, number>,
 *   total: number, stopped: null|'rows'|'time'}}
 */
export function selectPrunable(db, { cutoff, maxRows = PRUNE_MAX_ROWS, deadline = Infinity, clock = () => performance.now() } = {}) {
  const raw = db.raw ?? db;
  const at = isoCutoff(cutoff);
  const rows = [];
  const counts = Object.fromEntries(DELETE_ORDER.map((t) => [t, 0]));
  let stopped = null;
  const room = () => maxRows - rows.length;
  const take = (table, list) => {
    for (const r of list) rows.push({ table, row: r });
    counts[table] += list.length;
  };
  dryRun(raw, () => {
    if (!hasTable(raw, 'dispatches')) return;
    // Dispatches with their items, whole: a dispatch goes only with all of them.
    const closed = raw.prepare(`SELECT x.rowid AS rid, x.attempt_id FROM dispatches x WHERE ${DISPATCH_CLOSED('x')} ORDER BY x.closed, x.attempt_id`).all({ cutoff: at });
    const itemsOf = raw.prepare('SELECT rowid AS rid, * FROM dispatch_items WHERE attempt_id = ? ORDER BY item_index');
    const dispatchRow = raw.prepare('SELECT * FROM dispatches WHERE rowid = ?');
    for (const d of closed) {
      if (clock() > deadline) { stopped = 'time'; break; }
      const items = itemsOf.all(d.attempt_id);
      if (items.length + 1 > room()) { stopped = 'rows'; break; }
      take('dispatch_items', items.map(({ rid: _r, ...rest }) => plain(rest)));
      take('dispatches', [plain(dispatchRow.get(d.rid))]);
      deleteRowids(raw, 'dispatch_items', items.map((i) => i.rid));
      deleteRowids(raw, 'dispatches', [d.rid]);
    }
    for (const table of DELETE_ORDER.slice(2)) {
      if (stopped) break;
      if (clock() > deadline) { stopped = 'time'; break; }
      if (room() <= 0) { stopped = 'rows'; break; }
      const order = table === 'attempts' || table === 'slot_ledger' || table === 'events' ? 'x.rowid' : KEYS[table].map((k) => `x.${k}`).join(', ');
      const found = raw.prepare(`SELECT x.rowid AS rid, x.* FROM ${table} x WHERE ${eligibleSql(table)} ORDER BY ${order} LIMIT $limit`)
        .all({ cutoff: at, limit: room() + 1 });
      if (found.length > room()) {
        found.length = room();
        stopped = 'rows';
      }
      take(table, found.map(({ rid: _r, ...rest }) => plain(rest)));
      deleteRowids(raw, table, found.map((r) => r.rid));
    }
  });
  return { cutoff: at, rows, counts, total: rows.length, stopped };
}

const canonical = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

/**
 * Delete archived rows: only those still in the database exactly as archived
 * that still meet their rule against the database as it is now. Runs in one
 * transaction. Returns how many rows of each table went, and how many were
 * kept because they changed, are gone already or no longer meet the rule.
 * @param {{table: string, row: object}[]} rows  the archive's rows
 */
export function deleteArchived(db, { rows, cutoff }) {
  const raw = db.raw ?? db;
  const at = isoCutoff(cutoff);
  const deleted = Object.fromEntries(DELETE_ORDER.map((t) => [t, 0]));
  const kept = Object.fromEntries(DELETE_ORDER.map((t) => [t, 0]));
  const byTable = new Map(DELETE_ORDER.map((t) => [t, []]));
  for (const r of rows) {
    if (!byTable.has(r?.table) || !r.row || typeof r.row !== 'object') throw new Error(`the archive holds a row of an unknown table (${r?.table})`);
    byTable.get(r.table).push(r.row);
  }
  const work = () => {
    raw.exec('CREATE TEMP TABLE IF NOT EXISTS prune_candidates (rid INTEGER PRIMARY KEY)');
    for (const table of DELETE_ORDER) {
      const list = byTable.get(table);
      if (!list.length) continue;
      raw.exec('DELETE FROM temp.prune_candidates');
      const where = KEYS[table].map((k) => `${k} = ?`).join(' AND ');
      const find = raw.prepare(`SELECT rowid AS rid, * FROM ${table} WHERE ${where}`);
      const add = raw.prepare('INSERT OR IGNORE INTO temp.prune_candidates (rid) VALUES (?)');
      let candidates = 0;
      for (const row of list) {
        const cur = find.get(...KEYS[table].map((k) => row[k]));
        if (!cur) continue;
        const { rid, ...rest } = cur;
        if (canonical(rest) !== canonical(row)) continue;
        add.run(rid);
        candidates += 1;
      }
      const n = candidates
        ? Number(raw.prepare(`DELETE FROM ${table} AS x WHERE x.rowid IN (SELECT rid FROM temp.prune_candidates) AND (${eligibleSql(table)})`).run({ cutoff: at }).changes)
        : 0;
      deleted[table] = n;
      kept[table] = list.length - n;
    }
    raw.exec('DELETE FROM temp.prune_candidates');
  };
  if (typeof db.tx === 'function') db.tx(work);
  else {
    raw.exec('BEGIN IMMEDIATE');
    try {
      work();
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  return { deleted, kept, total };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The archive's plaintext: a tar of `state-archive.json` (what it is) and
 * `rows.ndjson.gz` (one `{"table", "row"}` line per row, gzip). Sealing it is
 * the caller's job.
 */
export function buildArchive({ rows, meta = {} }) {
  const ndjson = Buffer.from(rows.map((r) => JSON.stringify({ table: r.table, row: r.row })).join('\n') + (rows.length ? '\n' : ''));
  const gz = gzipSync(ndjson, { level: 9 });
  const counts = Object.fromEntries(DELETE_ORDER.map((t) => [t, 0]));
  for (const r of rows) counts[r.table] = (counts[r.table] ?? 0) + 1;
  const head = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    ...meta,
    rows: rows.length,
    counts,
    rows_file: ARCHIVE_ROWS,
    rows_sha256: sha256(ndjson),
    rows_bytes: ndjson.length,
  };
  const tar = writeTar([
    { path: ARCHIVE_META, data: Buffer.from(`${JSON.stringify(head, null, 2)}\n`) },
    { path: ARCHIVE_ROWS, data: gz },
  ]);
  return { tar, meta: head };
}

/** Read an archive's plaintext back; throws unless it is whole. */
export function readArchive(tar, { maxBytes = ARCHIVE_MAX_BYTES } = {}) {
  const entries = new Map(readTar(tar, { maxEntries: 4, maxBytes }).map((e) => [e.path, e.data]));
  const metaBuf = entries.get(ARCHIVE_META);
  const gz = entries.get(ARCHIVE_ROWS);
  if (!metaBuf || !gz) throw new Error(`a state archive holds ${ARCHIVE_META} and ${ARCHIVE_ROWS}`);
  const meta = JSON.parse(metaBuf.toString('utf8'));
  if (meta?.format !== ARCHIVE_FORMAT || meta.version !== ARCHIVE_VERSION) throw new Error('not a state archive this code reads');
  let ndjson;
  try {
    ndjson = gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new Error(`${ARCHIVE_ROWS} does not decompress (${err?.code ?? err?.message})`);
  }
  if (sha256(ndjson) !== meta.rows_sha256) throw new Error(`${ARCHIVE_ROWS} does not match its sha256`);
  const text = ndjson.toString('utf8');
  const rows = text ? text.replace(/\n$/, '').split('\n').map((l) => JSON.parse(l)) : [];
  if (rows.length !== meta.rows) throw new Error(`the archive says ${meta.rows} rows and holds ${rows.length}`);
  return { meta, rows };
}

/** Size of the database file and the rows of every table. */
export function stateSize(db) {
  const raw = db.raw ?? db;
  const pragma = (name) => Number(Object.values(raw.prepare(`PRAGMA ${name}`).get())[0]);
  const pageSize = pragma('page_size');
  const pages = pragma('page_count');
  const free = pragma('freelist_count');
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const rows = {};
  for (const t of tables) rows[t] = Number(raw.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n);
  return { bytes: pageSize * pages, page_size: pageSize, pages, free_pages: free, rows };
}

/**
 * VACUUM when it pays: at least `minFreeShare` of the pages and `minFreeBytes`
 * are free. Never inside a transaction.
 */
export function maybeVacuum(db, { minFreeShare = 0.1, minFreeBytes = 256 * 1024 } = {}) {
  const raw = db.raw ?? db;
  if (db.inTx) return { vacuumed: false, why: 'in a transaction' };
  const before = stateSize(db);
  const freeBytes = before.free_pages * before.page_size;
  if (!(before.pages > 0) || before.free_pages / before.pages < minFreeShare || freeBytes < minFreeBytes) {
    return { vacuumed: false, bytes: before.bytes, free_bytes: freeBytes };
  }
  raw.exec('VACUUM');
  const after = stateSize(db);
  return { vacuumed: true, before: before.bytes, bytes: after.bytes, free_bytes: after.free_pages * after.page_size };
}
