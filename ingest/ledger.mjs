// The attempts ledger, as ingest sees it.
//
// Ingest needs two calls from the state store (state/db.mjs), either as
// methods on the object openState() returns or as module functions that take
// that object first:
//
//   getAttempt(attempt_id) -> row or null/undefined. The row describes what was
//     dispatched: attempt_id, repo (the worker repo, or worker_repo),
//     workflow_file (or workflow), optionally run_id (or workflow_run_id),
//     workflow_sha and canaries (the canary values injected for this attempt,
//     list or JSON text), and the dispatched items:
//       items: [{index (or item_index), run_key, fence (or fencing_no),
//                current_fence, outcome}]
//     in dispatch order. index is the item's 0-based position in the list the
//     worker received; it names the item's result bundle. current_fence is the
//     run_key's live fence now; outcome is set once a result is recorded for
//     the item. A row without `items` describes one item with run_key, fence,
//     current_fence and outcome at the top level (index 0).
//
//   recordResult({run_key, attempt_id, fence, outcome, accepted, reason,
//                 resultOutcome?, fault?, coverage?})
//     -> {accepted, reason}. One call per item. The store does its own fence
//     check and may refuse (accepted: false, reason: 'stale_fence'); ingest
//     follows its answer. An accepted item also carries its fault side and
//     coverage state (worker-kit/contract.mjs resultFault, R-COV-02).
//
// state/db.mjs implements both as StateDb methods. The pump wraps its own open
// StateDb with dbLedger(); the CLI's --state FILE opens one with openLedger().
// For local runs, a JSON file can stand in for the state store (--ledger-json):
//   {"attempts": [<row>, ...], "results": [...]}

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_FILE_RE = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return undefined;
}

function toInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^\d{1,16}$/.test(v)) return Number(v);
  return NaN;
}

/** Most items one attempt may carry (item indexes run 0..9999). */
export const MAX_ITEMS = 10_000;

function normalizeItem(it, position, bad) {
  if (it === null || typeof it !== 'object' || Array.isArray(it)) bad('items');
  const rawIndex = pick(it, 'index', 'item_index');
  const index = rawIndex === undefined ? position : toInt(rawIndex);
  if (!(index >= 0) || index >= MAX_ITEMS) bad('item index');
  const runKey = pick(it, 'run_key');
  if (typeof runKey !== 'string' || !/^[0-9a-f]{64}$/.test(runKey)) bad('run_key');
  const fence = toInt(pick(it, 'fence', 'fencing_no'));
  if (!(fence >= 1)) bad('fence');
  const curRaw = pick(it, 'current_fence');
  const current = curRaw === undefined ? null : toInt(curRaw);
  if (current !== null && !(current >= 1)) bad('current_fence');
  const outcome = pick(it, 'outcome') ?? null;
  const retriesRaw = pick(it, 'retries');
  const retries = retriesRaw === undefined || retriesRaw === null ? 0 : toInt(retriesRaw);
  if (!(retries >= 0)) bad('retries');
  const throttledRaw = pick(it, 'throttled');
  const throttled = throttledRaw === undefined || throttledRaw === null ? 0 : toInt(throttledRaw);
  if (!(throttled >= 0)) bad('throttled');
  const since = pick(it, 'throttled_since') ?? null;
  if (since !== null && (typeof since !== 'string' || !Number.isFinite(Date.parse(since)))) bad('throttled_since');
  // Who the item is (state schema v8): the subject key it is recorded under,
  // the owner/name the worker was sent, the repository id and current name.
  // Optional, and only present when set (a ledger from before v8 has only the
  // key); a malformed one is left out, never fatal: the result is judged by
  // run_key and fence alone.
  const text = (k) => {
    const v = pick(it, k);
    return typeof v === 'string' && v.length >= 1 && v.length <= 512 && !/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v) ? v : null;
  };
  const repoIdRaw = pick(it, 'repo_id');
  const repoId = Number.isSafeInteger(repoIdRaw) && repoIdRaw > 0 ? repoIdRaw : null;
  return {
    index, run_key: runKey, fence, current_fence: current, outcome: outcome === null ? null : String(outcome), retries,
    throttled, throttled_since: since,
    ...Object.fromEntries(Object.entries({ subject: text('subject'), subject_name: text('subject_name'), repo_id: repoId, name: text('name') })
      .filter(([, v]) => v !== null)),
  };
}

/**
 * Normalise a ledger row; null for "no such attempt". Errors name fields,
 * never values. Returns {attempt_id, repo, run_id, workflow_file, workflow_sha,
 * canaries, items: [{index, run_key, fence, current_fence, outcome}]} with
 * items sorted by index, and the indexes exactly 0..n-1.
 */
export function normalizeAttempt(row) {
  if (row === null || row === undefined) return null;
  const bad = (field) => { throw new LedgerError(`ledger: attempt row has a missing or invalid ${field}`); };
  const attemptId = pick(row, 'attempt_id');
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) bad('attempt_id');
  const repo = pick(row, 'repo', 'worker_repo');
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) bad('repo');
  const workflowFile = pick(row, 'workflow_file', 'workflow');
  if (typeof workflowFile !== 'string' || !WORKFLOW_FILE_RE.test(workflowFile)) bad('workflow_file');
  const runIdRaw = pick(row, 'run_id', 'workflow_run_id');
  const runId = runIdRaw === undefined ? null : toInt(runIdRaw);
  if (runId !== null && !(runId >= 1)) bad('run_id');
  const sha = pick(row, 'workflow_sha');
  if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))) bad('workflow_sha');
  let canaries = pick(row, 'canaries') ?? [];
  if (typeof canaries === 'string') {
    try { canaries = JSON.parse(canaries); } catch { bad('canaries'); }
  }
  if (!Array.isArray(canaries) || !canaries.every((c) => typeof c === 'string')) bad('canaries');
  let items;
  if (row.items !== undefined) {
    if (!Array.isArray(row.items) || row.items.length === 0 || row.items.length > MAX_ITEMS) bad('items');
    items = row.items.map((it, i) => normalizeItem(it, i, bad)).sort((a, b) => a.index - b.index);
  } else {
    items = [normalizeItem({ ...row, index: 0 }, 0, bad)];
  }
  items.forEach((it, i) => { if (it.index !== i) bad('item index (indexes must run 0, 1, 2, ... without gaps)'); });
  if (new Set(items.map((it) => it.run_key)).size !== items.length) bad('run_key (each item needs its own)');
  // The lane name (pump/workflows.json key), when the row has one besides the file.
  const lane = pick(row, 'workflow_file') !== undefined && typeof row.workflow === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(row.workflow) ? row.workflow : null;
  return {
    attempt_id: attemptId,
    repo,
    run_id: runId,
    workflow_file: workflowFile,
    workflow_name: lane,
    workflow_sha: sha ?? null,
    canaries,
    items,
  };
}

function normalizeRecord(answer, requested) {
  if (answer === undefined || answer === null) return { accepted: requested.accepted, reason: requested.reason ?? null };
  if (typeof answer.accepted !== 'boolean') throw new LedgerError('ledger: recordResult must return {accepted, reason}');
  return { accepted: answer.accepted, reason: answer.reason ?? null };
}

/**
 * When the result was in, for the store's lease check (R-CHAOS-02): the run's
 * completion, or the item's artifact upload if that is later (R-CHAOS-10).
 * null when the run's completion is not known (the store then uses now).
 */
export function resultInAt(completedAt, artifactCreatedAt) {
  const done = completedAt === null || completedAt === undefined ? NaN : (typeof completedAt === 'number' ? completedAt : Date.parse(completedAt));
  if (!Number.isFinite(done)) return null;
  const art = artifactCreatedAt ? Date.parse(artifactCreatedAt) : NaN;
  return Number.isFinite(art) ? Math.max(done, art) : done;
}

function wrap({ getAttempt, recordResult, close, now, completedAt }) {
  return {
    kind: 'state',
    getAttempt: (id) => normalizeAttempt(getAttempt(id)),
    recordResult: (r) => {
      const { artifactCreatedAt, ...rest } = r;
      const inAt = resultInAt(completedAt, artifactCreatedAt);
      return normalizeRecord(recordResult({ ...rest, ...(now ? { now: now() } : {}), ...(inAt !== null ? { completedAt: inAt } : {}) }), r);
    },
    close,
  };
}

/**
 * The ledger over a StateDb that is already open (the pump's). close() leaves
 * it open; its owner closes it.
 * @param {{getAttempt: Function, recordResult: Function}} db  a StateDb
 * @param {{now?: () => number|Date, completedAt?: number|string|null}} [opts]
 *   now: the time recordResult stores; completedAt: when GitHub says the
 *   worker run completed, which the store checks the lease against (R-CHAOS-02)
 */
export function dbLedger(db, { now, completedAt = null } = {}) {
  if (typeof db?.getAttempt !== 'function' || typeof db?.recordResult !== 'function') {
    throw new LedgerError('ledger: the state store has no getAttempt()/recordResult()');
  }
  return wrap({ getAttempt: (id) => db.getAttempt(id), recordResult: (r) => db.recordResult(r), close: () => {}, now, completedAt });
}

function stateLedger(mod, path) {
  if (typeof mod.openState !== 'function') throw new LedgerError('ledger: state/db.mjs has no openState()');
  const db = mod.openState(path);
  const bind = (name) => {
    if (typeof db[name] === 'function') return (...a) => db[name](...a);
    if (typeof mod[name] === 'function') return (...a) => mod[name](db, ...a);
    return null;
  };
  const getAttempt = bind('getAttempt');
  const recordResult = bind('recordResult');
  const close = () => db.close?.();
  if (!getAttempt) {
    close();
    throw new LedgerError('ledger: state/db.mjs has no getAttempt(attempt_id); ingest needs the attempts ledger from the state store');
  }
  if (!recordResult) {
    close();
    throw new LedgerError('ledger: state/db.mjs has no recordResult({run_key, attempt_id, fence, outcome, accepted, reason})');
  }
  return wrap({ getAttempt, recordResult, close });
}

function jsonLedger(path, now) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LedgerError(`ledger: cannot read ${path} (${err.code ?? 'not JSON'})`);
  }
  if (!doc || !Array.isArray(doc.attempts)) throw new LedgerError(`ledger: ${path} needs an "attempts" list`);
  doc.results ??= [];
  const save = () => {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    kind: 'json',
    getAttempt: (id) => {
      const a = normalizeAttempt(doc.attempts.find((x) => x.attempt_id === id));
      if (!a) return null;
      // Like the state store: an item with a recorded result carries its outcome.
      for (const it of a.items) {
        const last = doc.results.findLast((x) => x.attempt_id === id && x.run_key === it.run_key && x.fence === it.fence);
        if (last && it.outcome === null) it.outcome = last.outcome ?? null;
      }
      return a;
    },
    recordResult: (r) => {
      const a = normalizeAttempt(doc.attempts.find((x) => x.attempt_id === r.attempt_id));
      const item = a?.items.find((it) => it.run_key === r.run_key);
      let { accepted } = r;
      let reason = r.reason ?? null;
      let { outcome } = r;
      if (accepted && (!item || item.fence !== r.fence || (item.current_fence !== null && item.current_fence !== r.fence))) {
        accepted = false;
        reason = !a ? 'unknown_attempt' : !item ? 'unknown_run_key' : item.fence !== r.fence ? 'fence_mismatch' : 'stale_fence';
        outcome = 'rejected';
      }
      doc.results.push({
        run_key: r.run_key, attempt_id: r.attempt_id, fence: r.fence, outcome, accepted, reason,
        ...(accepted && r.resultOutcome ? { result_outcome: r.resultOutcome } : {}),
        ...(accepted && r.coverage ? { fault: r.fault ?? null, coverage: r.coverage } : {}),
        recorded_at: now().toISOString(),
      });
      save();
      return { accepted, reason };
    },
    close: () => {},
  };
}

/**
 * @param {{statePath?: string, ledgerJson?: string, importState?: () => Promise<object>, now?: () => Date}} p
 */
export async function openLedger({ statePath, ledgerJson, importState = () => import('../state/db.mjs'), now = () => new Date() } = {}) {
  if (ledgerJson) return jsonLedger(ledgerJson, now);
  if (statePath) return stateLedger(await importState(), statePath);
  throw new LedgerError('ledger: pass --state or --ledger-json');
}
