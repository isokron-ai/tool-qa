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
//   unreadable   cannot be fetched, is too large, is not JSON, or is not a
//                well-formed status.
//
// While it is open the pump dispatches no workflow that runs third-party code
// (`runs_untrusted` in pump/workflows.json; a workflow that does not say
// `"runs_untrusted": false` counts as untrusted). Source-only lanes keep
// running. The pump reads the file itself at the start of each run, so the
// breaker is enforced where dispatching happens; the watchdog reads it too and
// shows it on the health issue.
//
// Fetching sends no token and no cookie: the file is public.

export const CONFORMANCE_URL = 'https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json';
export const STATUS_FORMAT = 'isokron-sandbox-conformance/1';
const MIN = 60_000;
const HOUR = 60 * MIN;
export const BREAKER = Object.freeze({ staleMs: 36 * HOUR, futureSkewMs: 10 * MIN, maxBytes: 16 * 1024, timeoutMs: 15_000 });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+/:-]{0,79}$/;

/** A workflow runs third-party code unless it says `"runs_untrusted": false`. */
export const runsUntrusted = (wf) => wf?.runs_untrusted !== false;

/** Names of the workflows that run third-party code (the enabled ones only, with enabledOnly). */
export function untrustedWorkflows(workflows = {}, { enabledOnly = false } = {}) {
  return Object.entries(workflows)
    .filter(([, wf]) => runsUntrusted(wf) && (!enabledOnly || wf?.enabled === true))
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
  return p;
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
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > BREAKER.maxBytes) return { error: `larger than ${BREAKER.maxBytes} bytes` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > BREAKER.maxBytes) return { error: `larger than ${BREAKER.maxBytes} bytes` };
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

function ago(ms) {
  if (ms < 2 * HOUR) return `${Math.max(0, Math.round(ms / MIN))} minutes ago`;
  return `${(ms / HOUR).toFixed(1)} hours ago`;
}
const tok = (v) => (TOKEN.test(String(v ?? '')) ? String(v) : 'unknown');
const runUrl = (v) => (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d{1,20}$/.test(String(v ?? '')) ? v : null);

/**
 * The breaker from what was read ({ status } or { error }) and the time.
 * @returns {{ tripped: boolean, reason: null|'red'|'stale'|'unreadable', summary: string,
 *   checked_at: string|null, run_url: string|null }}
 */
export function breakerFrom({ read, now }) {
  if (!read || read.error || !read.status) {
    return { tripped: true, reason: 'unreadable', summary: `the conformance status cannot be read: ${String(read?.error ?? 'nothing read').slice(0, 200)}`, checked_at: null, run_url: null };
  }
  const s = read.status;
  const bad = statusProblems(s);
  if (bad.length) return { tripped: true, reason: 'unreadable', summary: `the conformance status is not well formed (${bad.join(', ')})`, checked_at: null, run_url: null };
  const at = Date.parse(s.checked_at);
  const base = { checked_at: s.checked_at, run_url: runUrl(s.run_url) };
  const where = `on ${tok(s.runner_image)}, gVisor ${tok(s.gvisor_release)}`;
  if (s.ok !== true || s.selftest !== 'pass' || s.mutations !== 'pass') {
    return { ...base, tripped: true, reason: 'red', summary: `the sandbox conformance run of ${s.checked_at} failed (self test ${s.selftest}, mutations ${s.mutations}) ${where}` };
  }
  if (at - now > BREAKER.futureSkewMs) return { ...base, tripped: true, reason: 'stale', summary: `the conformance status claims a time in the future (${s.checked_at})` };
  if (now - at > BREAKER.staleMs) return { ...base, tripped: true, reason: 'stale', summary: `the last sandbox conformance pass is from ${ago(now - at)} (more than 36 hours)` };
  return { ...base, tripped: false, reason: null, summary: `sandbox conformance passed ${ago(now - at)} ${where}` };
}

/** The workflows the pump may dispatch with this breaker: all, or the trusted ones only. */
export function allowedWorkflows(workflows = {}, breaker) {
  if (!breaker?.tripped) return workflows;
  return Object.fromEntries(Object.entries(workflows).filter(([, wf]) => !runsUntrusted(wf)));
}
