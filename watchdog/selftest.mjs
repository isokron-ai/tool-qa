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
// API cost per watchdog run: 1 run list per lane (status=failure, last 7
// hours), plus 1 jobs call per failed run (at most 10 per lane) and 1 log call
// per failing self-test job (at most 3 in all). Nothing failed: 2 calls.
// The reads are of public repositories, made with the job's own GITHUB_TOKEN
// (the App token is narrowed to this repository); the log needs a token.

import { isEnabled } from '../pump/due.mjs';
import { runsUntrusted } from '../pump/breaker.mjs';

const HOUR = 3_600_000;
export const SELFTEST = Object.freeze({
  windowMs: 6 * HOUR,
  lookbackMs: 7 * HOUR, // a run is created before its self-test job ends
  amberCount: 2,
  maxRunsPerLane: 10,
  maxLogs: 3,
  logBytes: 12_288,
  job: /sandbox-selftest/i,
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

/**
 * Read the self-test failures of the last 6 hours. Never throws.
 * @returns {Promise<{ on: boolean, failures: object[], errors: string[], more: boolean }>}
 */
export async function readSelftestFailures({ client, workflows, now }) {
  const lanes = selftestLanes(workflows);
  const out = { on: lanes.length > 0, failures: [], errors: [], more: false };
  if (!out.on) return out;
  const t = now();
  const since = new Date(t - SELFTEST.lookbackMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const lane of lanes) {
    try {
      const res = await client.request('GET', `/repos/${lane.repo}/actions/workflows/${lane.file}/runs`, {
        allow: [404], query: { status: 'failure', created: `>=${since}`, per_page: 30, exclude_pull_requests: true },
      });
      const runs = res.status === 404 ? [] : res.data?.workflow_runs ?? [];
      if (runs.length > SELFTEST.maxRunsPerLane) out.more = true;
      for (const run of runs.slice(0, SELFTEST.maxRunsPerLane)) {
        const jobs = await client.request('GET', `/repos/${lane.repo}/actions/runs/${run.id}/jobs`, { allow: [404], query: { per_page: 30 } });
        for (const job of jobs.status === 404 ? [] : jobs.data?.jobs ?? []) {
          if (!SELFTEST.job.test(String(job.name)) || !SELFTEST.failed.includes(job.conclusion)) continue;
          const at = job.completed_at ?? run.updated_at;
          const ms = Date.parse(at);
          if (!Number.isFinite(ms) || t - ms > SELFTEST.windowMs) continue;
          out.failures.push({ lane: lane.name, repo: lane.repo, at, job_id: job.id, url: String(job.html_url ?? run.html_url ?? ''), run_url: String(run.html_url ?? ''), image: null });
        }
      }
    } catch (err) {
      out.errors.push(`${lane.name}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  out.failures.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const f of out.failures.slice(0, SELFTEST.maxLogs)) {
    try {
      const res = await client.request('GET', `/repos/${f.repo}/actions/jobs/${f.job_id}/logs`, { allow: [403, 404, 410], headers: { range: `bytes=0-${SELFTEST.logBytes - 1}` } });
      if (res.status < 300) f.image = imageFromLog(typeof res.data === 'string' ? res.data.slice(0, SELFTEST.logBytes) : '');
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
  const gaps = errs.length ? `; could not read ${errs.join('; ').slice(0, 240)}` : '';
  if (!f.length) {
    return errs.length
      ? { id, status: 'amber', summary: `could not read the lanes' sandbox self tests${gaps.slice(1)}` }
      : { id, status: 'green', summary: 'no sandbox self test failed on a lane in the last 6 hours' };
  }
  const images = [...new Set(f.map((x) => x.image ?? 'unknown'))];
  const off = f.filter((x) => !x.image || x.image !== passedImage);
  const many = f.length >= SELFTEST.amberCount;
  const lanes = [...new Set(f.map((x) => x.lane))].join(', ');
  const link = safeUrl(f[0].url) ?? safeUrl(f[0].run_url);
  const head = `${read.more ? 'at least ' : ''}${f.length} sandbox self test failure${f.length === 1 ? '' : 's'} in the last 6 hours (${lanes}) on runner image ${images.join(', ')}; the nightly last passed on ${passedImage ?? 'no image (it is not green)'}; the lane failed closed, nothing ran`;
  const item = { id, status: many || off.length ? 'amber' : 'green', summary: `${head}${gaps}`, at: f[0].at };
  if (link) item.link = link;
  return item;
}
