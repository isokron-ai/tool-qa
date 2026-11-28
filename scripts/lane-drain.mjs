#!/usr/bin/env node
// Lane drain (.github/workflows/lane-drain.yml): before a pin move, wait until
// no run of the worker workflows of the named lanes is queued or in progress,
// then run the pump (dispatch pump.yml and wait for it) until its ingest line
// says nothing is waiting. It reads pump/workflows.json for the lane to worker
// map, changes no variable, merges nothing, and only dispatches pump.yml.
//
//   LANES=live-probe,writecheck node scripts/lane-drain.mjs
//
// Environment: LANES (required), GITHUB_TOKEN, GITHUB_REPOSITORY, PUMP_REF
// (branch to dispatch the pump on), MAX_PUMPS (default 5), WAIT_MINUTES
// (default 90), POLL_SECONDS (default 60), GITHUB_STEP_SUMMARY.
// Exit 0 when the pump reported `waiting 0`; 1 when it did not, or the wait timed out.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OPEN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
export const PUMP_FILE = 'pump.yml';

/** The lane names asked for: comma or space separated, no repeats, at least one. */
export function parseLanes(text) {
  const lanes = [...new Set(String(text ?? '').split(/[\s,]+/).filter(Boolean))];
  if (lanes.length === 0) throw new Error('lanes is empty');
  for (const l of lanes) if (!/^[a-z0-9][a-z0-9-]*$/.test(l)) throw new Error(`not a lane name: ${l.slice(0, 40)}`);
  return lanes;
}

/** The worker workflows (repo + file, once each) of the lanes, from the pump's workflows.json. */
export function workersFor(config, lanes) {
  const all = config?.workflows ?? {};
  const out = new Map();
  for (const lane of lanes) {
    const w = all[lane];
    if (!w) throw new Error(`unknown lane ${lane}; pump/workflows.json has: ${Object.keys(all).join(', ')}`);
    if (typeof w.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(w.repo) || typeof w.file !== 'string' || !/^[\w.-]+\.ya?ml$/.test(w.file)) throw new Error(`lane ${lane} has no usable repo and file`);
    const key = `${w.repo}/${w.file}`;
    if (!out.has(key)) out.set(key, { repo: w.repo, file: w.file, lanes: [] });
    out.get(key).lanes.push(lane);
  }
  return [...out.values()];
}

/** The last `ingest: checked N, judged N ..., waiting N, errors N` line of a pump log, or null. */
export function lastIngest(log) {
  let found = null;
  for (const line of String(log ?? '').split('\n')) {
    const m = /pump: ingest: checked (\d+), judged (\d+)[^\n]*?, waiting (\d+), errors (\d+)/.exec(line);
    if (m) found = { checked: Number(m[1]), judged: Number(m[2]), waiting: Number(m[3]), errors: Number(m[4]) };
  }
  return found;
}

/** Whether a pump run's ingest result ends the drain: only a line saying waiting 0. */
export const drained = (ingest) => ingest !== null && ingest.waiting === 0;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The drain. `api` has openRuns(repo, file), dispatchPump(), pumpRuns(), pumpLog(runId).
 * Returns {ok, reason, waited, pumps, final_waiting}.
 */
export async function drain({ lanes, config, api, sleep = sleepReal, now = Date.now, maxPumps = 5, waitMs = 90 * 60_000, pollMs = 60_000, pumpWaitMs = 30 * 60_000, appearMs = 10 * 60_000 }) {
  const workers = workersFor(config, lanes);
  const waited = new Map();
  const result = { ok: false, reason: '', lanes, workers: workers.map((w) => `${w.repo}/${w.file}`), waited: [], pumps: [], final_waiting: null };
  const deadline = now() + waitMs;
  for (;;) {
    const open = [];
    for (const w of workers) for (const r of await api.openRuns(w.repo, w.file)) {
      open.push(r);
      waited.set(`${w.repo}#${r.id}`, { repo: w.repo, file: w.file, id: r.id, url: r.url ?? null });
    }
    result.waited = [...waited.values()];
    if (open.length === 0) break;
    if (now() >= deadline) {
      result.reason = `timeout: ${open.length} worker run(s) still open after ${Math.round(waitMs / 60_000)} minutes`;
      return result;
    }
    await sleep(pollMs);
  }
  for (let i = 1; i <= maxPumps; i += 1) {
    const before = new Set((await api.pumpRuns()).map((r) => r.id));
    await api.dispatchPump();
    const t0 = now();
    let run = null;
    while (!run) {
      run = (await api.pumpRuns()).find((r) => !before.has(r.id) && r.event === 'workflow_dispatch') ?? null;
      if (run) break;
      if (now() - t0 >= appearMs) {
        result.reason = `the dispatched pump run never appeared (pump ${i})`;
        return result;
      }
      await sleep(10_000);
    }
    const t1 = now();
    while (run.status !== 'completed') {
      if (now() - t1 >= pumpWaitMs) {
        result.pumps.push({ id: run.id, url: run.url ?? null, status: run.status, conclusion: null, ingest: null });
        result.reason = `timeout: pump run ${run.id} not finished after ${Math.round(pumpWaitMs / 60_000)} minutes`;
        return result;
      }
      await sleep(pollMs);
      run = (await api.pumpRuns()).find((r) => r.id === run.id) ?? run;
    }
    const ingest = lastIngest(await api.pumpLog(run.id));
    result.pumps.push({ id: run.id, url: run.url ?? null, status: run.status, conclusion: run.conclusion ?? null, ingest });
    result.final_waiting = ingest ? ingest.waiting : null;
    if (drained(ingest)) {
      result.ok = true;
      result.reason = `pump run ${run.id} reported waiting 0`;
      return result;
    }
  }
  result.reason = `after ${maxPumps} pump run(s) the ingest line did not say waiting 0 (last: ${result.final_waiting === null ? 'no ingest line in the log' : `waiting ${result.final_waiting}`})`;
  return result;
}

/** The job summary, markdown. */
export function summaryText(r) {
  const link = (x) => (x.url ? `[${x.id}](${x.url})` : String(x.id));
  return [
    `## Lane drain: ${r.ok ? 'drained' : 'NOT drained'}`,
    '',
    `Lanes: ${r.lanes.join(', ')}. Worker workflows: ${r.workers.join(', ')}.`,
    `Result: ${r.reason}.`,
    '',
    `**Worker runs waited on: ${r.waited.length}**`,
    ...r.waited.map((w) => `- ${w.repo}/${w.file} ${link(w)}`),
    '',
    `**Pump runs: ${r.pumps.length}**`,
    '',
    '| pump run | conclusion | checked | judged | waiting | errors |',
    '|---|---|---|---|---|---|',
    ...r.pumps.map((p) => `| ${link(p)} | ${p.conclusion ?? p.status} | ${p.ingest ? `${p.ingest.checked} | ${p.ingest.judged} | ${p.ingest.waiting} | ${p.ingest.errors}` : 'no ingest line | | | '} |`),
    '',
    `Final waiting count: ${r.final_waiting === null ? 'unknown' : r.final_waiting}`,
  ].join('\n');
}

/** The real API: the repository's token reads runs in the public worker repositories and dispatches the pump. */
export function githubApi({ token, repo, ref, fetchImpl = fetch }) {
  const base = 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const call = async (method, path, body, text = false) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    if (res.status === 204) return null;
    return text ? res.text() : res.json();
  };
  const shape = (r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, event: r.event, url: r.html_url });
  return {
    async openRuns(r, file) {
      const out = [];
      for (const s of OPEN_STATUSES) out.push(...(await call('GET', `/repos/${r}/actions/workflows/${file}/runs?status=${s}&per_page=100`)).workflow_runs.map(shape));
      return out;
    },
    dispatchPump: () => call('POST', `/repos/${repo}/actions/workflows/${PUMP_FILE}/dispatches`, { ref }),
    async pumpRuns() {
      return (await call('GET', `/repos/${repo}/actions/workflows/${PUMP_FILE}/runs?event=workflow_dispatch&per_page=30`)).workflow_runs.map(shape);
    },
    async pumpLog(runId) {
      const jobs = (await call('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`)).jobs;
      const job = jobs.find((j) => j.name === 'pump') ?? jobs[0];
      if (!job) return '';
      return call('GET', `/repos/${repo}/actions/jobs/${job.id}/logs`, null, true);
    },
  };
}

const whole = (v, d) => (/^\d+$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : d);

export async function main(env = process.env, write = (s) => process.stdout.write(s)) {
  const lanes = parseLanes(env.LANES);
  const config = JSON.parse(readFileSync(new URL('../pump/workflows.json', import.meta.url), 'utf8'));
  const repo = env.GITHUB_REPOSITORY || 'isokron-ai/tool-qa';
  const api = githubApi({ token: env.GITHUB_TOKEN, repo, ref: env.PUMP_REF || 'main' });
  const r = await drain({ lanes, config, api, maxPumps: whole(env.MAX_PUMPS, 5), waitMs: whole(env.WAIT_MINUTES, 90) * 60_000, pollMs: whole(env.POLL_SECONDS, 60) * 1000 });
  const text = summaryText(r);
  write(`${text}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`::error::${String(err.message).replace(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 2;
  });
}
