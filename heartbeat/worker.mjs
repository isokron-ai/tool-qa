// Off-GitHub heartbeat for the loop (a Cloudflare Worker on a cron trigger).
//
// Why: the pump keeps itself going by dispatching its successor, with a `*/30` schedule as the fallback. On 25 Nov 2026
// a GitHub outage made the successor dispatch return 500 and the chain stopped; the schedule then did not fire after
// GitHub recovered (scheduled runs were also 5-9 h apart that week). This Worker runs every 5 minutes, outside
// GitHub, and dispatches a watched workflow when it has no queued or running run and its newest run is older than
// its limit. A failed call is simply tried again on the next tick: at one check per workflow per 5 minutes, the
// cron is the backoff.
//
// It respects the loop's kill switch: it dispatches nothing while tool-qa's LOOP_ENABLED variable is not "true",
// or while the Worker's own HEARTBEAT_ENABLED is not "true".
//
// Secret GH_TOKEN: a fine-grained token for isokron-ai/tool-qa only, with Actions read and write and Variables read.
// It can start workflows in that one repository and read their runs; nothing else.

export const REPO = 'isokron-ai/tool-qa';
export const REF = 'main';
// minutes since the newest run started after which a workflow with nothing queued or running is restarted
export const WATCH = [
  { workflow: 'pump.yml', staleMin: 15 },
  { workflow: 'watchdog.yml', staleMin: 40 },
];
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
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

/** What to do for one watched workflow, from its newest runs. Pure. */
export function decide(runs, { staleMin, now }) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.some((r) => ACTIVE.has(r && r.status))) return { action: 'ok', why: 'a run is queued or running' };
  const newest = list.map((r) => Date.parse(r && r.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (newest !== undefined && now - newest < staleMin * 60_000) return { action: 'ok', why: `newest run started ${Math.round((now - newest) / 60_000)} min ago` };
  return { action: 'dispatch', why: newest === undefined ? 'no runs found' : `nothing running and the newest run started ${Math.round((now - newest) / 60_000)} min ago` };
}

/** One heartbeat tick. Returns a log of what it saw and did; never throws. */
export async function tick({ token, enabled, fetch: fetchImpl = globalThis.fetch, now = Date.now(), watch = WATCH } = {}) {
  const log = [];
  if (enabled !== 'true') { log.push('heartbeat: HEARTBEAT_ENABLED is not "true"; nothing done'); return log; }
  if (!token) { log.push('heartbeat: no GH_TOKEN; nothing done'); return log; }
  const v = await gh(fetchImpl, token, 'GET', `/repos/${REPO}/actions/variables/LOOP_ENABLED`);
  if (!v.ok) { log.push(`heartbeat: could not read LOOP_ENABLED (HTTP ${v.status || v.error}); nothing done, next tick retries`); return log; }
  if (!v.json || v.json.value !== 'true') { log.push('heartbeat: the loop kill switch is off (LOOP_ENABLED is not "true"); nothing done'); return log; }
  for (const w of watch) {
    const r = await gh(fetchImpl, token, 'GET', `/repos/${REPO}/actions/workflows/${w.workflow}/runs?per_page=5&exclude_pull_requests=true`);
    if (!r.ok) { log.push(`heartbeat: ${w.workflow}: could not list runs (HTTP ${r.status || r.error}); next tick retries`); continue; }
    const d = decide(r.json && r.json.workflow_runs, { staleMin: w.staleMin, now });
    if (d.action === 'ok') { log.push(`heartbeat: ${w.workflow}: ok (${d.why})`); continue; }
    const p = await gh(fetchImpl, token, 'POST', `/repos/${REPO}/actions/workflows/${w.workflow}/dispatches`, { ref: REF });
    log.push(p.ok ? `heartbeat: ${w.workflow}: dispatched (${d.why})` : `heartbeat: ${w.workflow}: dispatch failed (HTTP ${p.status || p.error}; ${d.why}); next tick retries`);
  }
  return log;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick({ token: env.GH_TOKEN, enabled: env.HEARTBEAT_ENABLED }).then((log) => { for (const l of log) console.log(l); }));
  },
};
