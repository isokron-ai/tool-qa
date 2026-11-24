// The sandbox circuit breaker.
//
// isokron-ai/mcp-surface-corpus runs its sandbox self test and mutation matrix
// every night (conformance-nightly.yml) and publishes the result as a small
// public file, the asset conformance-status.json of its `conformance` release
// (readable without a token). The breaker is open (tripped) when that file:
//
//   red          says ok is not true, or the self test or mutations did not pass;
//   stale        was checked more than 36 hours ago, or claims a time more than
//                10 minutes in the future;
//   unreadable   cannot be fetched, is over 16 KiB, is not JSON, is not a
//                well-formed status; or is older than a status already seen
//                (a rollback); or, for a green one, is not backed by its run:
//                the public Actions API must show that run attempt as a
//                successful conformance-nightly.yml run on main (schedule or
//                workflow_dispatch) of the very commit the status names.
//
// While it is open the pump dispatches no workflow that runs third-party code
// (`runs_untrusted` in pump/workflows.json; a workflow that does not say
// `"runs_untrusted": false` counts as untrusted). Source-only lanes keep
// running. The pump reads the file on every tick, so the breaker is enforced
// where dispatching happens; the watchdog reads it too and shows it on the
// health issue.
//
// Fetching sends no token and no cookie: the file and the run are public. A
// run is looked up once: what was verified, and the newest status seen, are
// remembered (`pump.conformance` in the state).

import { isEnabled } from './due.mjs';

export const CONFORMANCE_URL = 'https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json';
export const STATUS_FORMAT = 'isokron-sandbox-conformance/1';
export const NIGHTLY = Object.freeze({
  api: 'https://api.github.com',
  repo: 'isokron-ai/mcp-surface-corpus',
  path: '.github/workflows/conformance-nightly.yml',
  branch: 'main',
  events: Object.freeze(['schedule', 'workflow_dispatch']),
});
const MIN = 60_000;
const HOUR = 60 * MIN;
export const BREAKER = Object.freeze({ staleMs: 36 * HOUR, futureSkewMs: 10 * MIN, maxBytes: 16 * 1024, timeoutMs: 15_000 });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+/:-]{0,79}$/;
const SHA = /^[0-9a-f]{40}$/;

/** A workflow runs third-party code unless it says `"runs_untrusted": false`. */
export const runsUntrusted = (wf) => wf?.runs_untrusted !== false;

/** Names of the workflows that run third-party code (the enabled ones only, with enabledOnly). */
export function untrustedWorkflows(workflows = {}, { enabledOnly = false } = {}) {
  return Object.entries(workflows)
    .filter(([, wf]) => runsUntrusted(wf) && (!enabledOnly || isEnabled(wf)))
    .map(([name]) => name)
    .sort();
}

/** Problems with a status document; [] when it is well formed. */
export function statusProblems(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['not an object'];
  const p = [];
  if (s.format !== STATUS_FORMAT) p.push('format');
  if (typeof s.ok !== 'boolean') p.push('ok');
  if (!['pass', 'fail'].includes(s.selftest)) p.push('selftest');
  if (!['pass', 'fail', 'skipped'].includes(s.mutations)) p.push('mutations');
  if (!ISO.test(String(s.checked_at)) || !Number.isFinite(Date.parse(s.checked_at))) p.push('checked_at');
  if (!(s.run_id === null || (Number.isSafeInteger(s.run_id) && s.run_id > 0))) p.push('run_id');
  if (!(s.run_attempt === null || (Number.isSafeInteger(s.run_attempt) && s.run_attempt > 0))) p.push('run_attempt');
  if (!(s.sandbox_sha === null || SHA.test(String(s.sandbox_sha)))) p.push('sandbox_sha');
  return p;
}

/** The body of a response, refused as soon as it passes `max` bytes (never read whole first). */
export async function readCapped(res, max = BREAKER.maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new RangeError(`larger than ${max} bytes`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new RangeError(`larger than ${max} bytes`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new RangeError(`larger than ${max} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch the status file: { status } or { error }. One retry after a short
 * pause, because the publisher replaces the asset (delete, then upload).
 */
export async function readConformance({ fetch = globalThis.fetch, url = CONFORMANCE_URL, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 1, timeoutMs = BREAKER.timeoutMs } = {}) {
  let error = 'not read';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(3000);
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { accept: 'application/json, application/octet-stream' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        continue;
      }
      let buf;
      try {
        buf = await readCapped(res);
      } catch (err) {
        if (err instanceof RangeError) return { error: err.message };
        throw err;
      }
      let status;
      try {
        status = JSON.parse(buf.toString('utf8'));
      } catch {
        return { error: 'not JSON' };
      }
      const bad = statusProblems(status);
      if (bad.length) return { error: `not a well-formed status (${bad.join(', ')})` };
      return { status };
    } catch (err) {
      error = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : String(err?.message ?? err).slice(0, 200);
    }
  }
  return { error };
}

/** What is wrong with a run attempt (GET /repos/{repo}/actions/runs/{id}/attempts/{n}) as backing for a status. */
export function runProblems(run, status) {
  if (!run || typeof run !== 'object') return ['no run'];
  const p = [];
  if (run.id !== status.run_id) p.push('another run');
  if (run.run_attempt !== status.run_attempt) p.push('another attempt');
  if (run.repository?.full_name !== NIGHTLY.repo) p.push('another repository');
  if (run.path !== NIGHTLY.path) p.push(`not ${NIGHTLY.path}`);
  if (run.head_branch !== NIGHTLY.branch) p.push(`not on ${NIGHTLY.branch}`);
  if (!NIGHTLY.events.includes(run.event)) p.push(`started by ${String(run.event).slice(0, 30)}`);
  if (run.status !== 'completed') p.push('not finished yet');
  else if (run.conclusion !== 'success') p.push(`concluded ${String(run.conclusion).slice(0, 30)}`);
  if (run.head_sha !== status.sandbox_sha) p.push('another commit');
  return p;
}

/** Look the status's run attempt up in the public Actions API (no token): { ok, why }. */
export async function verifyRun({ fetch = globalThis.fetch, status, timeoutMs = BREAKER.timeoutMs } = {}) {
  if (!Number.isSafeInteger(status?.run_id) || !Number.isSafeInteger(status?.run_attempt) || !SHA.test(String(status?.sandbox_sha))) {
    return { ok: false, why: 'the status names no run, attempt and commit' };
  }
  try {
    const res = await fetch(`${NIGHTLY.api}/repos/${NIGHTLY.repo}/actions/runs/${status.run_id}/attempts/${status.run_attempt}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'isokron-tool-qa-breaker' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, why: `the Actions API answered HTTP ${res.status}` };
    const run = JSON.parse((await readCapped(res, 256 * 1024)).toString('utf8'));
    const bad = runProblems(run, status);
    return bad.length ? { ok: false, why: bad.join(', ') } : { ok: true, why: 'a successful nightly run on main of that commit' };
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) };
  }
}

const runOf = (s) => ({ run_id: s.run_id, run_attempt: s.run_attempt, checked_at: s.checked_at });
/** -1, 0 or 1: how a status's run compares with a remembered one (by run_id, then run_attempt). */
export function compareRuns(a, b) {
  if (a.run_id !== b.run_id) return a.run_id < b.run_id ? -1 : 1;
  if (a.run_attempt !== b.run_attempt) return a.run_attempt < b.run_attempt ? -1 : 1;
  return 0;
}

function ago(ms) {
  if (ms < 2 * HOUR) return `${Math.max(0, Math.round(ms / MIN))} minutes ago`;
  return `${(ms / HOUR).toFixed(1)} hours ago`;
}
const tok = (v) => (TOKEN.test(String(v ?? '')) ? String(v) : 'unknown');
const runUrl = (v) => (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d{1,20}$/.test(String(v ?? '')) ? v : null);
const unreadable = (summary, extra = {}) => ({ tripped: true, reason: 'unreadable', summary, checked_at: null, run_url: null, sandbox_sha: null, ...extra });

/**
 * The breaker from what was read ({ status } or { error }) and the time. Pure;
 * the rollback and provenance checks are in judgeConformance.
 * @returns {{ tripped: boolean, reason: null|'red'|'stale'|'unreadable', summary: string,
 *   checked_at: string|null, run_url: string|null, sandbox_sha: string|null }}
 */
export function breakerFrom({ read, now }) {
  if (!read || read.error || !read.status) return unreadable(`the conformance status cannot be read: ${String(read?.error ?? 'nothing read').slice(0, 200)}`);
  const s = read.status;
  const bad = statusProblems(s);
  if (bad.length) return unreadable(`the conformance status is not well formed (${bad.join(', ')})`);
  const at = Date.parse(s.checked_at);
  const base = { checked_at: s.checked_at, run_url: runUrl(s.run_url), sandbox_sha: s.sandbox_sha };
  const where = `on ${tok(s.runner_image)}, gVisor ${tok(s.gvisor_release)}`;
  if (s.ok !== true || s.selftest !== 'pass' || s.mutations !== 'pass') {
    return { ...base, tripped: true, reason: 'red', summary: `the sandbox conformance run of ${s.checked_at} failed (self test ${s.selftest}, mutations ${s.mutations}) ${where}` };
  }
  if (at - now > BREAKER.futureSkewMs) return { ...base, tripped: true, reason: 'stale', summary: `the conformance status claims a time in the future (${s.checked_at})` };
  if (now - at > BREAKER.staleMs) return { ...base, tripped: true, reason: 'stale', summary: `the last sandbox conformance pass is from ${ago(now - at)} (more than 36 hours)` };
  return { ...base, tripped: false, reason: null, summary: `sandbox conformance passed ${ago(now - at)} ${where}` };
}

/**
 * The whole judgement: breakerFrom, plus
 *   - no rollback: a status older than the newest already seen (memory.newest)
 *     is unreadable; a newer one becomes the newest;
 *   - provenance: a green status counts only once its run attempt is verified
 *     (verify(status) -> { ok, why }); a verified run is remembered
 *     (memory.verified), so it is looked up once.
 * memory is { newest, verified } (or null); the result carries the updated
 * memory and `changed` when it differs.
 */
export async function judgeConformance({ read, now, memory = null, verify }) {
  const mem = { newest: memory?.newest ?? null, verified: memory?.verified ?? null };
  let changed = false;
  const s = read?.status;
  if (!read?.error && s && !statusProblems(s).length && s.run_id !== null && s.run_attempt !== null) {
    if (mem.newest && compareRuns(s, mem.newest) < 0) {
      return { ...unreadable(`the conformance status went back to run ${s.run_id} attempt ${s.run_attempt}, older than run ${mem.newest.run_id} attempt ${mem.newest.run_attempt} already seen`), memory: mem, changed };
    }
    if (!mem.newest || compareRuns(s, mem.newest) > 0) {
      mem.newest = runOf(s);
      changed = true;
    }
  }
  const b = breakerFrom({ read, now });
  if (b.tripped) return { ...b, memory: mem, changed };
  // Green: only from a run that GitHub shows as a successful nightly on main of that commit.
  if (!(mem.verified && compareRuns(s, mem.verified) === 0)) {
    const v = await verify(s);
    if (!v?.ok) return { ...unreadable(`the conformance status is not backed by its run: ${String(v?.why ?? 'not verified').slice(0, 200)}`), memory: mem, changed };
    mem.verified = runOf(s);
    changed = true;
  }
  return { ...b, memory: mem, changed };
}

/**
 * Enabled lanes that run third-party code whose pinned sandbox commit is not
 * the one the nightly tested: [{ lane, pins, tested }].
 */
export function pinMismatches(workflows = {}, testedSha) {
  return untrustedWorkflows(workflows, { enabledOnly: true })
    .map((lane) => ({ lane, pins: workflows[lane]?.sandbox_sha ?? null, tested: testedSha ?? null }))
    .filter((m) => m.pins !== m.tested);
}

/** The workflows the pump may dispatch with this breaker: all, or the trusted ones only. */
export function allowedWorkflows(workflows = {}, breaker) {
  if (!breaker?.tripped) return workflows;
  return Object.fromEntries(Object.entries(workflows).filter(([, wf]) => !runsUntrusted(wf)));
}
