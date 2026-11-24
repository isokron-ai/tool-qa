// Health item for the off-site backup (offsite/backup.mjs, offsite-backup.yml).
//
// Heartbeat. Each backup run uploads a small JSON artifact,
// `offsite-heartbeat-<run id>-<attempt>.json` (archive: false, kept 7 days).
// The workflow's GITHUB_TOKEN cannot write a repository variable such as
// OFFSITE_LAST_OK, and giving the backup job the loop App's key or a second
// R2 token only for that would widen what it holds; an artifact needs no
// permission at all. The watchdog reads it with the token it already has:
// the newest finished runs of offsite-backup.yml (made on main, in this
// repository, by schedule or dispatch, at that path), then the heartbeat
// artifact of the newest one that has it. Three or four API calls a run.
//
//   offsite-backup   green while the last good run is at most 12 hours old;
//                    amber up to 24 hours, when the backup is not configured
//                    yet (no R2 settings), when no run has reported yet, when
//                    the bucket is near the cap (85%), or when a run stopped
//                    early on its per-run caps; red after 24 hours, when the
//                    last run was over the cost cap or had a verification
//                    failure, or when no run has ever been good and the last
//                    one failed. Off when LANE_OFFSITE_ENABLED is set and not
//                    "true".
//
// offsiteCheck never throws: a read that fails is an amber item.

import { laneVariable } from '../scripts/guard.mjs';
import { download } from '../scripts/archive-pull.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const OFFSITE_THRESHOLDS = Object.freeze({ greenMs: 12 * HOUR, redMs: 24 * HOUR, futureSlackMs: 10 * MIN });
export const OFFSITE_WORKFLOW = 'offsite-backup.yml';
export const HEARTBEAT_PREFIX = 'offsite-heartbeat-';
const MAX_RUNS = 3;
const MAX_HEARTBEAT_BYTES = 64 * 1024;

const ago = (ms) => (ms < 2 * HOUR ? `${Math.round(ms / MIN)} minutes` : `${(ms / HOUR).toFixed(1)} hours`);
const gb = (b) => `${(Number(b) / 1e9).toFixed(2)} GB`;

/** A run of offsite-backup.yml we trust: ours, on main, scheduled or dispatched. */
export function trustedRun(run) {
  return Boolean(run)
    && run.status === 'completed'
    && run.head_branch === 'main'
    && ['schedule', 'workflow_dispatch'].includes(run.event)
    && String(run.path ?? '').split('@')[0] === `.github/workflows/${OFFSITE_WORKFLOW}`
    && run.repository?.id != null && run.head_repository?.id === run.repository.id;
}

/**
 * Judge a heartbeat (pure).
 * @param {{ now: number, hb: object|null, latest: object|null, laterFailed?: number }} input
 *   `latest` is the newest trusted finished run; `laterFailed` counts runs newer
 *   than the heartbeat's that failed without leaving one.
 */
export function judgeOffsite({ now, hb, latest, laterFailed = 0 }) {
  const id = 'offsite-backup';
  if (!latest) return { id, status: 'amber', summary: `no finished ${OFFSITE_WORKFLOW} run on main yet` };
  if (!hb) {
    const status = latest.conclusion === 'failure' ? 'red' : 'amber';
    return { id, status, summary: `the newest ${OFFSITE_WORKFLOW} runs left no heartbeat (newest: ${latest.conclusion ?? latest.status}, ${latest.html_url ?? `run ${latest.id}`})` };
  }
  const notes = [];
  if (laterFailed) notes.push(`${laterFailed} newer run(s) failed without a heartbeat`);
  if (hb.near_cap) notes.push(`the bucket is near the cap (${gb(hb.bucket_bytes)} of ${gb(hb.cap_bytes)})`);
  if (hb.deferred) notes.push(`the last run stopped early and the next carries on (${String(hb.deferred_reason ?? '').slice(0, 120)})`);
  const tail = notes.length ? `; ${notes.join('; ')}` : '';
  if (hb.status === 'unconfigured') return { id, status: 'amber', summary: `not configured yet: ${String(hb.reason ?? '').slice(0, 160)}${tail}` };
  if (hb.status === 'over_cap') return { id, status: 'red', summary: `over the cost cap, nothing new is copied: ${String(hb.reason ?? '').slice(0, 200)}${tail}` };
  if (hb.status === 'verify_failed') return { id, status: 'red', summary: `the last run had verification failures: ${String(hb.reason ?? '').slice(0, 160)}; see the run's summary${tail}` };
  const at = Date.parse(hb.last_ok_at ?? '');
  if (!Number.isFinite(at)) {
    return { id, status: hb.status === 'ok' ? 'amber' : 'red', summary: `no good backup run yet; the last one says ${hb.status}: ${String(hb.reason ?? '').slice(0, 160)}${tail}` };
  }
  const iso = new Date(at).toISOString();
  const age = now - at;
  if (age < -OFFSITE_THRESHOLDS.futureSlackMs) return { id, status: 'amber', summary: `the last good backup is dated ${iso}, in the future${tail}`, at: iso };
  const bucket = hb.bucket_bytes != null ? `, bucket ${gb(hb.bucket_bytes)} of ${gb(hb.cap_bytes)}` : '';
  const lastFailed = hb.status !== 'ok' ? `; the last run failed: ${String(hb.reason ?? '').slice(0, 160)}` : '';
  if (age > OFFSITE_THRESHOLDS.redMs) return { id, status: 'red', summary: `no good off-site backup for ${ago(age)} (last at ${iso})${lastFailed}${tail}`, at: iso };
  if (age > OFFSITE_THRESHOLDS.greenMs) return { id, status: 'amber', summary: `no good off-site backup for ${ago(age)} (last at ${iso})${lastFailed}${tail}`, at: iso };
  const status = hb.status !== 'ok' || notes.length ? 'amber' : 'green';
  return { id, status, summary: `last good off-site backup ${ago(Math.max(0, age))} ago${bucket}${lastFailed}${tail}`, at: iso };
}

/** Read the newest heartbeat and judge it. Never throws. */
export async function offsiteCheck({ client, repo, now, env = {}, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const id = 'offsite-backup';
  const lane = laneVariable('offsite');
  const raw = env[lane];
  if (raw !== undefined && raw !== '' && raw !== 'true') return { id, status: 'off', summary: `the off-site backup is switched off (${lane} is not "true")` };
  try {
    const res = await client.request('GET', `/repos/${repo}/actions/workflows/${OFFSITE_WORKFLOW}/runs`, { allow: [404], query: { per_page: 10, branch: 'main', exclude_pull_requests: true } });
    if (res.status === 404) return { id, status: 'amber', summary: `${OFFSITE_WORKFLOW} is not on main yet` };
    const runs = (res.data?.workflow_runs ?? [])
      .filter(trustedRun)
      .filter((r) => !['cancelled', 'skipped'].includes(r.conclusion))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const latest = runs[0] ?? null;
    let hb = null;
    let laterFailed = 0;
    for (const run of runs.slice(0, MAX_RUNS)) {
      const name = `${HEARTBEAT_PREFIX}${run.id}-${run.run_attempt ?? 1}.json`;
      const list = await client.request('GET', `/repos/${repo}/actions/runs/${run.id}/artifacts`, { query: { name, per_page: 5 } });
      const art = (list.data?.artifacts ?? []).find((a) => a.name === name && !a.expired && a.workflow_run?.id === run.id);
      if (!art) {
        if (run.conclusion === 'failure') laterFailed += 1;
        continue;
      }
      if (Number(art.size_in_bytes) > MAX_HEARTBEAT_BYTES) return { id, status: 'amber', summary: `the heartbeat of run ${run.id} is too large to be one` };
      const bytes = await download(client, fetch, repo, art, sleep);
      try {
        hb = JSON.parse(bytes.toString('utf8'));
      } catch {
        return { id, status: 'amber', summary: `the heartbeat of run ${run.id} is not JSON` };
      }
      if (!hb || typeof hb !== 'object' || hb.version !== 1 || typeof hb.status !== 'string') return { id, status: 'amber', summary: `the heartbeat of run ${run.id} is not one of ours` };
      break;
    }
    return judgeOffsite({ now, hb, latest, laterFailed });
  } catch (err) {
    return { id, status: 'amber', summary: `could not read the off-site backup heartbeat: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
