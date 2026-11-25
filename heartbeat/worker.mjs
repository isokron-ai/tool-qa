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
// workflow alone while LOOP_PAUSE_UNTIL is in the future (or unreadable) or that workflow's LANE_<JOB>_ENABLED is set
// and not "true"; and the pump alone while LOOP_SLOTS is set to 0 (a pump with no slots does not chain itself).
// A variable that is not set (404) is the guard's default; one that cannot be read (401, 5xx, network) means no dispatch.
//
// Secret GH_TOKEN: a fine-grained token for isokron-ai/tool-qa only, with Actions read and write and Variables read.
// It can start workflows in that one repository and read their runs; nothing else.

export const REPO = 'isokron-ai/tool-qa';
export const REF = 'main';
// minutes since the newest run started after which a workflow with nothing queued or running is restarted
// stuckMin: twice the workflow's timeout-minutes (pump 20, watchdog 10); a run still waiting to start after that is stuck.
export const WATCH = [
  { workflow: 'pump.yml', job: 'pump', staleMin: 15, stuckMin: 40, usesSlots: true },
  { workflow: 'watchdog.yml', job: 'watchdog', staleMin: 40, stuckMin: 20, usesSlots: false },
];
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
export function decide(runs, { staleMin, stuckMin = Infinity, now }) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.some((r) => r && RUNNING.has(r.status))) return { action: 'ok', why: 'a run is running' };
  const waiting = list.filter((r) => r && WAITING.has(r.status));
  if (waiting.length) {
    const since = Math.min(...waiting.map((r) => ts(r.created_at) ?? now));
    if (now - since < stuckMin * 60_000) return { action: 'ok', why: 'a run is queued' };
    return { action: 'dispatch', warn: true, why: `a run has waited ${Math.round((now - since) / 60_000)} min without starting (stuck after ${stuckMin} min)` };
  }
  const newest = list.map(runTime).filter((t) => t !== undefined).sort((a, b) => b - a)[0];
  if (newest !== undefined && now - newest < staleMin * 60_000) return { action: 'ok', why: `newest run was active ${Math.round((now - newest) / 60_000)} min ago` };
  return { action: 'dispatch', why: newest === undefined ? 'no runs found' : `nothing running and the newest run was active ${Math.round((now - newest) / 60_000)} min ago` };
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
export function pausedBy(vars, { job, usesSlots, now }) {
  const pause = vars.LOOP_PAUSE_UNTIL;
  if (pause !== undefined && String(pause).trim() !== '') {
    const until = parseIsoTime(pause);
    if (Number.isNaN(until)) return 'LOOP_PAUSE_UNTIL cannot be read, so the loop stays paused';
    if (until > now) return `the loop is paused until ${new Date(until).toISOString()} (LOOP_PAUSE_UNTIL)`;
  }
  const lane = `LANE_${String(job).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_ENABLED`;
  const l = vars[lane];
  if (l !== undefined && l !== '' && l !== 'true') return `this lane is off (${lane} is not "true")`;
  if (usesSlots && String(vars.LOOP_SLOTS ?? '').trim() !== '' && parseSlots(vars.LOOP_SLOTS) === 0) return 'LOOP_SLOTS is 0, so the pump does not chain';
  return null;
}

/** Read one repository variable: { ok, value } (value undefined when it is not set: 404). */
async function readVar(fetchImpl, token, name) {
  const v = await gh(fetchImpl, token, 'GET', `/repos/${REPO}/actions/variables/${name}`);
  if (v.status === 404) return { ok: true, value: undefined };
  if (!v.ok) return { ok: false, status: v.status, error: v.error };
  return { ok: true, value: v.json && typeof v.json.value === 'string' ? v.json.value : undefined };
}

/** One heartbeat tick. Returns a log of what it saw and did; never throws. */
export async function tick({ token, enabled, fetch: fetchImpl = globalThis.fetch, now = Date.now(), watch = WATCH } = {}) {
  const log = [];
  if (enabled !== 'true') { log.push('heartbeat: HEARTBEAT_ENABLED is not "true"; nothing done'); return log; }
  if (!token) { log.push('heartbeat: no GH_TOKEN; nothing done'); return log; }
  const vars = {};
  for (const name of ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LOOP_SLOTS', ...watch.map((w) => `LANE_${w.job.toUpperCase()}_ENABLED`)]) {
    const v = await readVar(fetchImpl, token, name);
    if (!v.ok) { log.push(`heartbeat: could not read ${name} (HTTP ${v.status || v.error}); nothing done, next tick retries`); return log; }
    vars[name] = v.value;
    // The kill switch first: a missing or wrong LOOP_ENABLED ends the tick before any other read.
    if (name === 'LOOP_ENABLED' && v.value !== 'true') { log.push('heartbeat: the loop kill switch is off (LOOP_ENABLED is not "true"); nothing done'); return log; }
  }
  for (const w of watch) {
    const why = pausedBy(vars, { job: w.job, usesSlots: w.usesSlots, now });
    if (why) { log.push(`heartbeat: ${w.workflow}: not started: ${why}`); continue; }
    const r = await gh(fetchImpl, token, 'GET', `/repos/${REPO}/actions/workflows/${w.workflow}/runs?per_page=5&exclude_pull_requests=true`);
    if (!r.ok) { log.push(`heartbeat: ${w.workflow}: could not list runs (HTTP ${r.status || r.error}); next tick retries`); continue; }
    const d = decide(r.json && r.json.workflow_runs, { staleMin: w.staleMin, stuckMin: w.stuckMin, now });
    if (d.action === 'ok') { log.push(`heartbeat: ${w.workflow}: ok (${d.why})`); continue; }
    const p = await gh(fetchImpl, token, 'POST', `/repos/${REPO}/actions/workflows/${w.workflow}/dispatches`, { ref: REF });
    log.push(p.ok ? `heartbeat: ${w.workflow}: ${d.warn ? 'WARNING stuck run; ' : ''}dispatched (${d.why})` : `heartbeat: ${w.workflow}: dispatch failed (HTTP ${p.status || p.error}; ${d.why}); next tick retries`);
  }
  return log;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick({ token: env.GH_TOKEN, enabled: env.HEARTBEAT_ENABLED }).then((log) => { for (const l of log) console.log(l); }));
  },
};
