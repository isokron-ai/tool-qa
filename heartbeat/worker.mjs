// Off-GitHub heartbeat for the loop (a Cloudflare Worker on a cron trigger).
//
// Why: the pump keeps itself going by dispatching its successor, with a `*/30` schedule as the fallback. On 25 Nov 2026
// a GitHub outage made the successor dispatch return 500 and the chain stopped; the schedule then did not fire after
// GitHub recovered (scheduled runs were also 5-9 h apart that week). This Worker runs every 5 minutes, outside
// GitHub, and dispatches a watched workflow when it has no queued or running run and its newest run is older than
// its limit. A failed call is simply tried again on the next tick: at one check per workflow per 5 minutes, the
// cron is the backoff.
//
// It respects the loop's switches, read the way scripts/guard.mjs reads them: it dispatches nothing while tool-qa's
// LOOP_ENABLED variable is not "true", or while the Worker's own HEARTBEAT_ENABLED is not "true". It also leaves a
// workflow alone while LOOP_PAUSE_UNTIL is in the future (or unreadable) or that workflow's own lane variable (the one its guard step reads; see WATCH) is set
// and not "true"; and the pump alone while LOOP_SLOTS is set to 0 (a pump with no slots does not chain itself).
// All variables are read in one call. One that is not set is the guard's default; if the list cannot be read (401, 5xx,
// network) nothing is dispatched. At most MAX_DISPATCHES dispatches and MAX_CALLS GitHub calls per tick.
//
// Secret GH_TOKEN: a fine-grained token for isokron-ai/tool-qa only, with Actions read and write and Variables read.
// It can start workflows in that one repository and read their runs; nothing else.

import { report } from './report.mjs';
export { report };

export const REPO = 'isokron-ai/tool-qa';
export const REF = 'main';
// One entry per scheduled workflow that should keep running (publish-results.yml is left out: off by design, behind
// RESULTS_PUBLISH_ENABLED). Fields:
//   staleMin   minutes since the newest run started after which a workflow with nothing queued or running is restarted;
//              about 1.5 to 2 times its schedule, because GitHub's scheduler fires late. A newest run counts whatever its
//              conclusion, so a run that keeps failing is retried only after staleMin ...
//   retryFailedAfterMin   ... unless this is set: then a failed newest run is retried after this many minutes (a stale
//              backup is the risk, so state-snapshot retries after 30).
//   stuckMin   twice the workflow's largest timeout-minutes; a run still waiting to start after that is stuck.
//   lane       the repository variable the workflow's own kill-switch step reads (null: the workflow has no guard step).
//   usesSlots  the pump alone stops chaining at LOOP_SLOTS=0.
//   match      which runs count (history-registry: only the full capture; the pump dispatches a delta every ~15 min).
//   inputs     workflow_dispatch inputs to send.
//   perPage, maxPages   runs to list per call, and how many pages to read while no matching run has shown up (default 5, 1).
export const WATCH = [
  { workflow: 'pump.yml', lane: 'LANE_PUMP_ENABLED', staleMin: 15, stuckMin: 40, usesSlots: true },
  { workflow: 'watchdog.yml', lane: 'LANE_WATCHDOG_ENABLED', staleMin: 40, stuckMin: 20 },
  { workflow: 'state-snapshot.yml', lane: 'LANE_STATE_SNAPSHOT_ENABLED', staleMin: 90, stuckMin: 20, retryFailedAfterMin: 30 },
  { workflow: 'keep-forever.yml', lane: 'LANE_KEEP_FOREVER_ENABLED', staleMin: 420, stuckMin: 80 },
  { workflow: 'offsite-backup.yml', lane: 'LANE_OFFSITE_ENABLED', staleMin: 420, stuckMin: 80 },
  { workflow: 'ledger.yml', lane: 'LANE_LEDGER_ENABLED', staleMin: 1560, stuckMin: 20 },
  { workflow: 'history-packages.yml', lane: 'LANE_HISTORY_PACKAGES_ENABLED', staleMin: 1560, stuckMin: 180 },
  // Weekly downloads and stars on Monday (UTC), stars only on other days, as its own schedule.
  { workflow: 'history-popularity.yml', lane: 'LANE_HISTORY_POPULARITY_ENABLED', staleMin: 1560, stuckMin: 90, inputs: (now) => ({ mode: new Date(now).getUTCDay() === 1 ? 'all' : 'stars' }) },
  // The run name carries the mode ("history-registry full" / "history-registry delta"). Deltas come every ~15 min, so list
  // the window (staleMin + 30 min) 100 at a time, up to 3 pages, until a full run shows up.
  { workflow: 'history-registry.yml', label: 'history-registry.yml (full)', lane: 'LANE_HISTORY_REGISTRY_ENABLED', staleMin: 1560, stuckMin: 60, perPage: 100, maxPages: 3, match: (r) => /^history-registry full$/.test(String(r.display_title ?? r.name ?? '').trim()), inputs: () => ({ mode: 'full' }) },
  { workflow: 'perf-baselines.yml', lane: 'LANE_PERF_ENABLED', staleMin: 11520, stuckMin: 40 },
  // chaos-soak.yml is meant to run weekly; it plays an in-memory simulation only and has no guard step or lane variable.
  { workflow: 'chaos-soak.yml', lane: null, staleMin: 11520, stuckMin: 120 },
];
export const MAX_DISPATCHES = 4; // per tick, so recovering from an outage does not burst
const MAX_CALLS = 40; // Workers free plan: 50 subrequests per invocation
const VAR_PAGE = 30; // GitHub caps the variables list at 30 per page
const MAX_VAR_PAGES = 10;
export const MAX_FAILED_RETRIES = 3; // consecutive failed runs after which a fast retry gives way to staleMin
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);
const RUNNING = new Set(['in_progress']);
const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']); // action_required counts as neither
const API = 'https://api.github.com';

async function gh(fetchImpl, token, method, path, body) {
  let res;
  try {
    res = await fetchImpl(API + path, {
      method,
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'isokron-loop-heartbeat', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { return { ok: false, status: 0, error: 'network' }; }
  let json = null;
  if (res.status !== 204) { try { json = await res.json(); } catch { json = null; } }
  return { ok: res.ok, status: res.status, json };
}

const ts = (x) => { const t = Date.parse(x); return Number.isFinite(t) ? t : undefined; };
/** When a run started doing something: its start, else its creation. A finished run counts from its last update. */
function runTime(r) {
  if (!r) return undefined;
  if (r.status === 'completed') return ts(r.updated_at) ?? ts(r.run_started_at) ?? ts(r.created_at);
  return ts(r.run_started_at) ?? ts(r.created_at);
}

/** What to do for one watched workflow, from its newest runs. Pure. */
export function decide(runs, { staleMin, stuckMin = Infinity, retryFailedAfterMin, now }) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.some((r) => r && RUNNING.has(r.status))) return { action: 'ok', why: 'a run is running' };
  const waiting = list.filter((r) => r && WAITING.has(r.status));
  if (waiting.length) {
    const since = Math.min(...waiting.map((r) => ts(r.created_at) ?? now));
    if (now - since < stuckMin * 60_000) return { action: 'ok', why: 'a run is queued' };
    return { action: 'dispatch', warn: true, why: `a run has waited ${Math.round((now - since) / 60_000)} min without starting (stuck after ${stuckMin} min)` };
  }
  const timed = list.filter((r) => r && runTime(r) !== undefined).sort((a, b) => runTime(b) - runTime(a));
  const newest = timed.length ? runTime(timed[0]) : undefined;
  let streak = 0;
  for (const r of timed) { if (FAILED.has(r.conclusion)) streak++; else break; }
  const repeated = retryFailedAfterMin !== undefined && streak >= MAX_FAILED_RETRIES;
  const alert = repeated ? `failing repeatedly: ${streak} runs in a row; retrying only after ${staleMin} min` : undefined;
  if (newest !== undefined && retryFailedAfterMin !== undefined && !repeated && streak > 0 && now - newest >= retryFailedAfterMin * 60_000) {
    return { action: 'dispatch', why: `the newest run ${timed[0].conclusion} ${Math.round((now - newest) / 60_000)} min ago (retry after ${retryFailedAfterMin} min)` };
  }
  if (newest !== undefined && now - newest < staleMin * 60_000) return { action: 'ok', alert, why: `newest run was active ${Math.round((now - newest) / 60_000)} min ago` };
  return { action: 'dispatch', alert, why: newest === undefined ? 'no runs found' : `nothing running and the newest run was active ${Math.round((now - newest) / 60_000)} min ago` };
}

// Same reading of the switches as scripts/guard.mjs (a test compares the two).
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
export function parseIsoTime(raw) {
  const m = ISO_RE.exec(String(raw ?? '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
  const month = Number(mo); const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return NaN;
  if (day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return NaN;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return NaN;
  return Date.parse(String(raw).trim());
}
export function parseSlots(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return 0;
  if (!/^[+-]?\d+$/.test(text)) return 0;
  return Math.max(0, Math.min(Number(text), 15));
}
/** Why a workflow must not be started now, from the repository variables, or null. vars: name -> value, absent when unset. */
export function pausedBy(vars, { lane, usesSlots, now }) {
  const pause = vars.LOOP_PAUSE_UNTIL;
  if (pause !== undefined && String(pause).trim() !== '') {
    const until = parseIsoTime(pause);
    if (Number.isNaN(until)) return 'LOOP_PAUSE_UNTIL cannot be read, so the loop stays paused';
    if (until > now) return `the loop is paused until ${new Date(until).toISOString()} (LOOP_PAUSE_UNTIL)`;
  }
  const l = lane ? vars[lane] : undefined;
  if (l !== undefined && l !== '' && l !== 'true') return `this lane is off (${lane} is not "true")`;
  if (usesSlots && String(vars.LOOP_SLOTS ?? '').trim() !== '' && parseSlots(vars.LOOP_SLOTS) === 0) return 'LOOP_SLOTS is 0, so the pump does not chain';
  return null;
}

/** Read all repository variables in as few calls as possible: { ok, vars } (name -> value; unset names are absent). */
async function readVars(call) {
  const vars = {};
  for (let page = 1; page <= MAX_VAR_PAGES; page++) {
    const v = await call('GET', `/repos/${REPO}/actions/variables?per_page=${VAR_PAGE}&page=${page}`);
    if (!v.ok) return { ok: false, status: v.status, error: v.error };
    const list = v.json && Array.isArray(v.json.variables) ? v.json.variables : [];
    for (const x of list) if (x && typeof x.name === 'string' && typeof x.value === 'string') vars[x.name] = x.value;
    const total = v.json && Number.isFinite(v.json.total_count) ? v.json.total_count : list.length;
    if (list.length < VAR_PAGE || Object.keys(vars).length >= total) return { ok: true, vars };
  }
  return { ok: false, error: 'more variable pages than expected' };
}

/** One heartbeat tick. Returns a log of what it saw and did; never throws. */
export async function tick({ token, enabled, fetch: fetchImpl = globalThis.fetch, now = Date.now(), watch = WATCH } = {}) {
  const log = [];
  // Structured record of what the tick decided, for the report step. Not part of the log (log stays a plain array of
  // lines); it only records, and nothing below reads it.
  const decisions = [];
  Object.defineProperty(log, 'decisions', { value: decisions, enumerable: false });
  const at = new Date(now).toISOString();
  const decided = (workflow, action, http) => decisions.push({ at, workflow, action, ...(http ? { http } : {}) });
  if (enabled !== 'true') { log.push('heartbeat: HEARTBEAT_ENABLED is not "true"; nothing done'); return log; }
  if (!token) { log.push('heartbeat: no GH_TOKEN; nothing done'); return log; }
  let calls = 0; // the subrequest budget: never more than MAX_CALLS per tick
  const call = (method, path, body) => (calls++ >= MAX_CALLS ? Promise.resolve({ ok: false, status: 0, error: 'call budget' }) : gh(fetchImpl, token, method, path, body));
  const rv = await readVars(call);
  if (!rv.ok) { log.push(`heartbeat: could not read the repository variables (HTTP ${rv.status || rv.error}); nothing done, next tick retries`); for (const w of watch) decided(w.label || w.workflow, 'failed', rv.status); return log; }
  const vars = rv.vars;
  // The kill switch first: a missing or wrong LOOP_ENABLED ends the tick before any run is read.
  if (vars.LOOP_ENABLED !== 'true') { log.push('heartbeat: the loop kill switch is off (LOOP_ENABLED is not "true"); nothing done'); for (const w of watch) decided(w.label || w.workflow, 'skipped_switch'); return log; }
  let dispatched = 0;
  for (const w of watch) {
    const name = w.label || w.workflow;
    const why = pausedBy(vars, { lane: w.lane, usesSlots: w.usesSlots, now });
    if (why) { log.push(`heartbeat: ${name}: not started: ${why}`); decided(name, 'skipped_switch'); continue; }
    // Only runs on main: a pull request run (perf-baselines has a pull_request trigger) must not hide a missed scheduled run.
    // history-registry: a created window plus paging until the full run shows up, since deltas outnumber it ~100 to 1.
    const perPage = w.perPage || 5;
    const created = w.maxPages ? `&created=${encodeURIComponent('>=' + new Date(now - (w.staleMin + 30) * 60_000).toISOString())}` : '';
    let runs = []; let failed;
    for (let page = 1; page <= (w.maxPages || 1); page++) {
      const r = await call('GET', `/repos/${REPO}/actions/workflows/${w.workflow}/runs?per_page=${perPage}&page=${page}&branch=${REF}${created}`);
      if (!r.ok) { failed = r; break; }
      const got = (r.json && Array.isArray(r.json.workflow_runs)) ? r.json.workflow_runs : [];
      runs = runs.concat(w.match ? got.filter((x) => x && w.match(x)) : got);
      if (got.length < perPage || runs.length) break;
    }
    if (failed) { log.push(`heartbeat: ${name}: could not list runs (HTTP ${failed.status || failed.error}); next tick retries`); decided(name, 'failed', failed.status); continue; }
    const d = decide(runs, { staleMin: w.staleMin, stuckMin: w.stuckMin, retryFailedAfterMin: w.retryFailedAfterMin, now });
    if (d.alert) log.push(`heartbeat: ALERT ${name}: ${d.alert}`);
    if (d.action === 'ok') { log.push(`heartbeat: ${name}: ok (${d.why})`); decided(name, 'ok'); continue; }
    if (dispatched >= MAX_DISPATCHES) { log.push(`heartbeat: ${name}: needs a dispatch (${d.why}) but ${MAX_DISPATCHES} were already sent this tick; next tick retries`); continue; }
    dispatched++;
    const inputs = w.inputs ? w.inputs(now) : undefined;
    const p = await call('POST', `/repos/${REPO}/actions/workflows/${w.workflow}/dispatches`, inputs ? { ref: REF, inputs } : { ref: REF });
    decided(name, p.ok ? 'restarted' : 'failed', p.status);
    log.push(p.ok ? `heartbeat: ${name}: ${d.warn ? 'WARNING stuck run; ' : ''}dispatched (${d.why})` : `heartbeat: ${name}: dispatch failed (HTTP ${p.status || p.error}; ${d.why}); next tick retries`);
  }
  return log;
}

export default {
  async scheduled(_event, env, ctx) {
    const ticked = tick({ token: env.GH_TOKEN, enabled: env.HEARTBEAT_ENABLED }).then((log) => { for (const l of log) console.log(l); return log; });
    ctx.waitUntil(ticked);
    // The report is its own waitUntil, off by default. Nothing it does (or throws) can reach the promise above.
    if (env.REPORT_ENABLED === 'true' && env.LIVE) {
      ctx.waitUntil(ticked
        .then((log) => log.decisions, () => [])
        .then((decisions) => report({ env, decisions }))
        .then((r) => console.log(`heartbeat report: ${r.written ? 'written' : 'not written' + (r.blocked ? ` (blocked by scan rule ${r.blocked})` : '')}`))
        .catch((e) => console.log(`heartbeat report: failed (${e && e.name ? e.name : 'error'})`)));
    }
  },
};
