// Keep the registry delta capture going without GitHub's scheduler.
//
// history-registry.yml has a `*/15` cron for the delta capture. On 24 and 25
// November GitHub fired it only every 5 to 9 hours, so the watchdog's
// history-registry-delta item went red. The pump runs back to back and ticks
// every few minutes, so each tick asks: is the newest delta capture older than
// 15 minutes, and is none queued or running? If so it dispatches
// history-registry.yml in delta mode. The cron stays as a second path.
//
// It never blocks the pump: every failure is returned, not thrown. It cannot
// run the capture twice: a delta run that is queued or running (the workflow
// sets run-name to "history-registry delta") stops it, the dispatches are
// spaced, and the workflow's own concurrency group (one delta at a time, a
// pending one replaced, never cancelled) is the last guard.
//
// Needs a token with actions: write on this repository (the minter the
// successor uses): it reads the artifact and run lists and sends the dispatch.

export const REGISTRY_WORKFLOW = 'history-registry.yml';
export const DELTA_PREFIX = 'registry-delta-';
export const DELTA_STALE_MS = 15 * 60_000;
// A queued or running delta that is older than this is not counted (the job
// times out at 30 minutes), so a stuck run cannot hold the capture off for good.
export const ACTIVE_DELTA_MS = 35 * 60_000;
// Dispatches of ours are at least this far apart, whatever the run list shows.
export const MIN_DISPATCH_GAP_MS = 10 * 60_000;
// The workflow's own default window is 90 minutes; past this age the dispatch
// names the start of the gap itself, so a long stall leaves no hole.
export const DEFAULT_SINCE_LIMIT_MS = 75 * 60_000;
export const ARTIFACT_PAGES = 5;
const SINCE_MARGIN_MS = 10 * 60_000;

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Is the lane switched on? Unset or empty leaves it on, as scripts/guard.mjs does. */
export function registryLaneOn(env) {
  const v = String(env?.LANE_HISTORY_REGISTRY_ENABLED ?? '').trim();
  return v === '' || v === 'true';
}

function runMode(run) {
  const title = String(run?.display_title ?? run?.name ?? '');
  if (/\bfull$/.test(title)) return 'full';
  if (/\bdelta$/.test(title)) return 'delta';
  return 'unknown'; // a run from before the workflow set run-name: counted as a delta, to be safe
}

/**
 * @param {{ client: { request: Function }, repo: string, ref?: string, now?: number,
 *   lastDispatchAt?: number|null, log?: (line: string) => void }} args
 * @returns {Promise<{ action: 'fresh'|'running'|'spaced'|'dispatched'|'failed', at: string,
 *   ageMinutes?: number, runId?: number, since?: string, error?: string }>}
 */
export async function ensureRegistryDelta({ client, repo, ref = 'main', now = Date.now(), lastDispatchAt = null, lastCaptureAt = null, log = () => {} }) {
  const at = isoSeconds(now);
  try {
    // Newest first. The pump adds 3 or 4 artifacts every ~12 minutes, so after a
    // stall the delta artifacts sit far down: page until one shows (at most
    // ARTIFACT_PAGES pages), and fall back to the capture time kept from earlier.
    let found = -Infinity;
    for (let page = 1; page <= ARTIFACT_PAGES && found === -Infinity; page++) {
      const arts = await client.request('GET', `/repos/${repo}/actions/artifacts`, { family: 'actions', query: { per_page: 100, page } });
      const list = arts.data?.artifacts ?? [];
      found = list
        .filter((a) => String(a.name).startsWith(DELTA_PREFIX) && !a.expired)
        .map((a) => Date.parse(a.created_at))
        .filter(Number.isFinite)
        .reduce((m, t) => Math.max(m, t), -Infinity);
      if (list.length < 100) break;
    }
    const newest = Math.max(found, Number.isFinite(lastCaptureAt) ? lastCaptureAt : -Infinity);
    const captureAt = Number.isFinite(newest) ? isoSeconds(newest) : undefined;
    const age = Number.isFinite(newest) ? now - newest : Infinity;
    const ageMinutes = Number.isFinite(age) ? Math.round(age / 60_000) : undefined;
    if (age < DELTA_STALE_MS) return { action: 'fresh', at, ageMinutes, captureAt };

    const runs = await client.request('GET', `/repos/${repo}/actions/workflows/${REGISTRY_WORKFLOW}/runs`, {
      family: 'actions', allow: [404], query: { per_page: 30, exclude_pull_requests: true },
    });
    const active = (runs.data?.workflow_runs ?? []).filter((r) => r.status !== 'completed'
      && runMode(r) !== 'full' && now - Date.parse(r.created_at) < ACTIVE_DELTA_MS);
    if (active.length) return { action: 'running', at, ageMinutes, captureAt, runId: Number(active[0].id) };
    if (lastDispatchAt !== null && now - lastDispatchAt < MIN_DISPATCH_GAP_MS) return { action: 'spaced', at, ageMinutes, captureAt };

    const inputs = { mode: 'delta' };
    if (Number.isFinite(newest) && age > DEFAULT_SINCE_LIMIT_MS) inputs.since = isoSeconds(newest - SINCE_MARGIN_MS);
    // A repeat is harmless: the workflow's concurrency group replaces a pending delta.
    const res = await client.request('POST', `/repos/${repo}/actions/workflows/${REGISTRY_WORKFLOW}/dispatches`, {
      family: 'dispatch', retryUnsafe: true, body: { ref, inputs, return_run_details: true },
    });
    const runId = res.status === 200 && res.data?.workflow_run_id ? Number(res.data.workflow_run_id) : undefined;
    log(`registry delta: newest capture ${ageMinutes === undefined ? 'not found' : `${ageMinutes} minutes old`}; dispatched ${REGISTRY_WORKFLOW} (delta${inputs.since ? `, since ${inputs.since}` : ''})`);
    return { action: 'dispatched', at, ageMinutes, captureAt, ...(runId ? { runId } : {}), ...(inputs.since ? { since: inputs.since } : {}) };
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 300);
    log(`registry delta: could not check or dispatch: ${error}`);
    return { action: 'failed', at, error };
  }
}
