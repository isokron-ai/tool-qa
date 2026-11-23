// The attempts ledger, as ingest sees it.
//
// Ingest needs two calls from the state store (state/db.mjs), either as
// methods on the object openState() returns or as module functions that take
// that object first:
//
//   getAttempt(attempt_id) -> row or null/undefined. The row describes what was
//     dispatched: attempt_id, run_key, fence (or fencing_no), repo (the worker
//     repo, or worker_repo), workflow_file (or workflow), and optionally run_id
//     (or workflow_run_id), workflow_sha, current_fence (the subject's live
//     fence now), outcome (set once a result is recorded) and canaries (the
//     canary values injected for this attempt, list or JSON text).
//
//   recordResult({run_key, attempt_id, fence, outcome, accepted, reason})
//     -> {accepted, reason}. The store does its own fence check and may refuse
//     (accepted: false, reason: 'stale_fence'); ingest follows its answer.
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

/** Normalise a ledger row; null for "no such attempt". Errors name fields, never values. */
export function normalizeAttempt(row) {
  if (row === null || row === undefined) return null;
  const bad = (field) => { throw new LedgerError(`ledger: attempt row has a missing or invalid ${field}`); };
  const attemptId = pick(row, 'attempt_id');
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) bad('attempt_id');
  const runKey = pick(row, 'run_key');
  if (typeof runKey !== 'string' || !/^[0-9a-f]{64}$/.test(runKey)) bad('run_key');
  const fence = toInt(pick(row, 'fence', 'fencing_no'));
  if (!(fence >= 1)) bad('fence');
  const repo = pick(row, 'repo', 'worker_repo');
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) bad('repo');
  const workflowFile = pick(row, 'workflow_file', 'workflow');
  if (typeof workflowFile !== 'string' || !WORKFLOW_FILE_RE.test(workflowFile)) bad('workflow_file');
  const runIdRaw = pick(row, 'run_id', 'workflow_run_id');
  const runId = runIdRaw === undefined ? null : toInt(runIdRaw);
  if (runId !== null && !(runId >= 1)) bad('run_id');
  const sha = pick(row, 'workflow_sha');
  if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))) bad('workflow_sha');
  const curRaw = pick(row, 'current_fence');
  const current = curRaw === undefined ? null : toInt(curRaw);
  if (current !== null && !(current >= 1)) bad('current_fence');
  let canaries = pick(row, 'canaries') ?? [];
  if (typeof canaries === 'string') {
    try { canaries = JSON.parse(canaries); } catch { bad('canaries'); }
  }
  if (!Array.isArray(canaries) || !canaries.every((c) => typeof c === 'string')) bad('canaries');
  const outcome = pick(row, 'outcome') ?? null;
  return {
    attempt_id: attemptId,
    run_key: runKey,
    fence,
    repo,
    run_id: runId,
    workflow_file: workflowFile,
    workflow_sha: sha ?? null,
    current_fence: current,
    outcome: outcome === null ? null : String(outcome),
    canaries,
  };
}

function normalizeRecord(answer, requested) {
  if (answer === undefined || answer === null) return { accepted: requested.accepted, reason: requested.reason ?? null };
  if (typeof answer.accepted !== 'boolean') throw new LedgerError('ledger: recordResult must return {accepted, reason}');
  return { accepted: answer.accepted, reason: answer.reason ?? null };
}

function wrap({ getAttempt, recordResult, close, now }) {
  return {
    kind: 'state',
    getAttempt: (id) => normalizeAttempt(getAttempt(id)),
    recordResult: (r) => normalizeRecord(recordResult(now ? { ...r, now: now() } : r), r),
    close,
  };
}

/**
 * The ledger over a StateDb that is already open (the pump's). close() leaves
 * it open; its owner closes it.
 * @param {{getAttempt: Function, recordResult: Function}} db  a StateDb
 * @param {{now?: () => number|Date}} [opts]  the time recordResult stores
 */
export function dbLedger(db, { now } = {}) {
  if (typeof db?.getAttempt !== 'function' || typeof db?.recordResult !== 'function') {
    throw new LedgerError('ledger: the state store has no getAttempt()/recordResult()');
  }
  return wrap({ getAttempt: (id) => db.getAttempt(id), recordResult: (r) => db.recordResult(r), close: () => {}, now });
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
      const row = doc.attempts.find((a) => a.attempt_id === id);
      // Like the state store: an attempt with a recorded result carries its outcome.
      const last = doc.results.findLast((x) => x.attempt_id === id);
      return normalizeAttempt(row && last && !row.outcome ? { ...row, outcome: last.outcome } : row);
    },
    recordResult: (r) => {
      const a = normalizeAttempt(doc.attempts.find((x) => x.attempt_id === r.attempt_id));
      let { accepted } = r;
      let reason = r.reason ?? null;
      let { outcome } = r;
      if (accepted && (!a || (a.current_fence !== null && a.current_fence !== r.fence))) {
        accepted = false;
        reason = a ? 'stale_fence' : 'unknown_attempt';
        outcome = 'rejected';
      }
      doc.results.push({
        run_key: r.run_key, attempt_id: r.attempt_id, fence: r.fence, outcome, accepted, reason,
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
