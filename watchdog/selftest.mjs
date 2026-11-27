// The sandbox self-test check (R-WD-17).
//
// The lanes that run third-party code (live-probe in isokron-ai/mcp-check,
// writecheck in isokron-ai/mcp-writecheck-action) start with the sandbox's own
// self test (the `sandbox / sandbox-selftest` job of the reusable
// sandbox-conformance workflow). The guard fails closed: when it fails nothing
// third-party runs, nothing is uploaded and the items come back `no_artifact`.
// The nightly status (pump/breaker.mjs) only knows the nightly run, so a runner
// image rollout that broke the self test on the lanes' runners would leave the
// lanes producing nothing while the health issue stayed green.
//
// sandbox-selftest reads the recent failed runs of each enabled lane that runs
// third-party code, counts those whose self-test job failed in the last 6 hours
// and reads the runner image of the newest few from the job log header.
//   amber   2 or more failures in 6 hours, or any failure on a runner image the
//           nightly has not passed on (an image that cannot be read counts as
//           not passed on), or the lookup failed;
//   green   otherwise (a single failure on the image the nightly passed on is
//           shown in the summary);
//   off     no enabled lane runs third-party code.
// Never red: a self test that fails closed is the sandbox doing its job.
//
// API cost per watchdog run: 1 to 3 pages of completed runs per lane (last 7
// hours, 100 a page; a third full page marks the list truncated), plus 1 jobs
// call per failed, timed out, startup-failed or cancelled run (at most 10 per
// lane) and 2 calls per failing self-test job (the API's 302, then the blob
// store, at most 3 jobs in all). Nothing failed: 2 calls.
// The reads are of public repositories, made with the job's own GITHUB_TOKEN
// (the App token is narrowed to this repository) for run and job lists. Job logs return
// 403 to that token for other repositories, so run.mjs mints an App installation token
// for the lanes' repositories with actions: read for them, and falls back (amber, with
// the reason) when it cannot.

import { isEnabled } from '../pump/due.mjs';
import { runsUntrusted } from '../pump/breaker.mjs';

const HOUR = 3_600_000;
export const SELFTEST = Object.freeze({
  windowMs: 6 * HOUR,
  lookbackMs: 7 * HOUR, // a run is created before its self-test job ends
  amberCount: 2,
  maxRunsPerLane: 10,
  maxPages: 3,
  maxLogs: 3,
  logBytes: 12_288,
  job: /^(sandbox|conformance) \/ sandbox-selftest$/,
  failed: Object.freeze(['failure', 'timed_out', 'startup_failure']),
});

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The image version from a job log's head ("Runner Image" group), or null. */
export function imageFromLog(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => /##\[group\]Runner Image\s*$/.test(l));
  if (at < 0) return null;
  for (const l of lines.slice(at + 1, at + 6)) {
    const m = /\bVersion:\s*(\S+)/.exec(l);
    if (m) return VERSION.test(m[1]) ? m[1] : null;
    if (l.includes('##[endgroup]')) break;
  }
  return null;
}

/** The nightly status's runner_image ("ubuntu24/20261122.23.1") as a bare version ("20261122.23.1"), or null. */
export function nightlyImage(status) {
  const v = String(status?.runner_image ?? '').split('/').pop();
  return VERSION.test(v) ? v : null;
}

/** Enabled lanes that run third-party code and name a repository and workflow file. */
export function selftestLanes(workflows = {}) {
  const seen = new Set();
  const out = [];
  for (const [name, wf] of Object.entries(workflows)) {
    if (!runsUntrusted(wf) || !isEnabled(wf)) continue;
    if (typeof wf.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(wf.repo) || typeof wf.file !== 'string' || !/^[\w.-]+$/.test(wf.file)) continue;
    const key = `${wf.repo}/${wf.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, repo: wf.repo, file: wf.file });
  }
  return out;
}

/** Run conclusions that can mean a self-test job did not pass (status=completed lists them all; the API takes one status only). */
const BAD_RUN = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);

/** The first bytes of a job log. The API answers 302 to the blob store; follow it by hand so the token goes to the API host only (R-WD-19). */
async function readLogHead({ client, fetch, repo, jobId }) {
  const res = await client.request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, { allow: [403, 404, 410], redirect: 'manual', headers: { range: `bytes=0-${SELFTEST.logBytes - 1}` } });
  const where = res.headers?.get?.('location');
  if (res.status < 300 || res.status >= 400 || !where) return null;
  let url;
  try {
    url = new URL(where);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const got = await fetch(url.href, { redirect: 'error', headers: { range: `bytes=0-${SELFTEST.logBytes - 1}` }, signal: AbortSignal.timeout(15_000) });
  if (got.status !== 200 && got.status !== 206) return null;
  return (await got.text()).slice(0, SELFTEST.logBytes);
}

/**
 * Read the self-test failures of the last 6 hours. Never throws.
 * `more` is true when a list was cut off (R-WD-18); `errors` holds what could not be read,
 * a 404 included (R-WD-21), and a lane whose examined runs show no self-test job at all
 * (R-WD-20).
 * @returns {Promise<{ on: boolean, failures: object[], errors: string[], more: boolean }>}
 */
export async function readSelftestFailures({ client, workflows, now, fetch = globalThis.fetch }) {
  const lanes = selftestLanes(workflows);
  const out = { on: lanes.length > 0, failures: [], errors: [], more: false };
  if (!out.on) return out;
  const t = now();
  const since = new Date(t - SELFTEST.lookbackMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const lane of lanes) {
    try {
      const runs = [];
      for (let page = 1; page <= SELFTEST.maxPages; page++) {
        const res = await client.request('GET', `/repos/${lane.repo}/actions/workflows/${lane.file}/runs`, {
          allow: [404], query: { status: 'completed', created: `>=${since}`, per_page: 100, page, exclude_pull_requests: true },
        });
        if (res.status === 404) throw new Error(`the runs list of ${lane.file} answered 404 (not found, or the token cannot see it)`);
        const got = res.data?.workflow_runs ?? [];
        runs.push(...got);
        if (got.length < 100) break;
        if (page === SELFTEST.maxPages) out.more = true;
      }
      const bad = runs.filter((r) => BAD_RUN.has(r.conclusion));
      if (bad.length > SELFTEST.maxRunsPerLane) out.more = true;
      let seen = 0;
      let named = 0;
      for (const run of bad.slice(0, SELFTEST.maxRunsPerLane)) {
        const jobs = await client.request('GET', `/repos/${lane.repo}/actions/runs/${run.id}/jobs`, { allow: [404], query: { per_page: 100 } });
        if (jobs.status === 404) throw new Error(`the jobs of run ${run.id} answered 404`);
        // a pending run replaced in its concurrency group shows as cancelled with no jobs: not evidence of a renamed job
        if (run.conclusion !== 'cancelled') seen += 1;
        for (const job of jobs.data?.jobs ?? []) {
          if (!SELFTEST.job.test(String(job.name))) continue;
          named += 1;
          if (!SELFTEST.failed.includes(job.conclusion)) continue;
          const at = job.completed_at ?? run.updated_at;
          const ms = Date.parse(at);
          if (!Number.isFinite(ms) || t - ms > SELFTEST.windowMs) continue;
          out.failures.push({ lane: lane.name, repo: lane.repo, at, job_id: job.id, url: String(job.html_url ?? run.html_url ?? ''), run_url: String(run.html_url ?? ''), image: null });
        }
      }
      if (seen > 0 && named === 0) out.errors.push(`${lane.name}: self-test job not found in ${seen} failed run${seen === 1 ? '' : 's'} (renamed?)`);
    } catch (err) {
      out.errors.push(`${lane.name}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  out.failures.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const f of out.failures.slice(0, SELFTEST.maxLogs)) {
    try {
      f.image = imageFromLog(await readLogHead({ client, fetch, repo: f.repo, jobId: f.job_id }));
    } catch {
      // the image stays unknown
    }
  }
  return out;
}

const safeUrl = (u) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/job\/\d+)?$/.test(String(u)) ? String(u) : null);

/**
 * The health item. `read` is readSelftestFailures()'s result (or { error }),
 * `passedImage` the runner image version the nightly last passed on (null when
 * the nightly is not green).
 */
export function selftestCheck({ read, passedImage = null }) {
  const id = 'sandbox-selftest';
  if (!read || (read.error && read.on === undefined)) return { id, status: 'amber', summary: `could not read the lanes' sandbox self tests: ${String(read?.error ?? 'nothing read').slice(0, 200)}` };
  if (!read.on) return { id, status: 'off', summary: 'no lane that runs third-party code is enabled' };
  const f = read.failures ?? [];
  const errs = read.errors ?? [];
  const gaps = (errs.length ? `; could not read ${errs.join('; ').slice(0, 240)}` : '') + (read.tokenError ? `; no log token (${read.tokenError}), so runner images cannot be read` : '');
  if (!f.length) {
    if (read.tokenError && !errs.length) return { id, status: 'amber', summary: `no self test failure found, but no log token could be minted, so a failure's runner image could not be read: ${read.tokenError}` };
    return errs.length
      ? { id, status: 'amber', summary: `could not read the lanes' sandbox self tests${gaps.slice(1)}` }
      : read.more
        ? { id, status: 'amber', summary: 'no self test failure found, but the list of runs was truncated (more runs than were read), so one may be missed' }
        : { id, status: 'green', summary: 'no sandbox self test failed on a lane in the last 6 hours' };
  }
  const images = [...new Set(f.map((x) => x.image ?? 'unknown'))];
  const off = f.filter((x) => !x.image || x.image !== passedImage);
  const many = f.length >= SELFTEST.amberCount;
  const lanes = [...new Set(f.map((x) => x.lane))].join(', ');
  const link = safeUrl(f[0].url) ?? safeUrl(f[0].run_url);
  const head = `${read.more ? 'at least ' : ''}${f.length} sandbox self test failure${f.length === 1 ? '' : 's'} in the last 6 hours (${lanes}) on runner image ${images.join(', ')}; the nightly last passed on ${passedImage ?? 'no image (it is not green)'}; the lane failed closed, nothing ran`;
  const item = { id, status: many || off.length || read.tokenError || errs.length || read.more ? 'amber' : 'green', summary: `${head}${gaps}`, at: f[0].at };
  if (link) item.link = link;
  return item;
}
