#!/usr/bin/env node
// Worker of the metadata lanes: one shard of subjects in, one bundle
// directory per item out, ready for the worker kit.
//
//   node meta/run.mjs <meta-github|meta-registry|release-diff> <out-dir>
//
// Environment:
//   SHARD_ID, ATTEMPT_ID, ITEMS   the dispatch inputs (docs/INTERFACES.md)
//   GITHUB_TOKEN                  meta-github only: the job's own token (public reads)
//   META_CACHE_FILE               optional: the conditional-request cache to load and save
//   META_DEADLINE_MINUTES         optional: start no subject after this many minutes (default 22)
//   META_REST_CAP                 optional: counted REST calls per shard (default 400)
//   META_RESERVE_PERCENT, META_RESERVE_MIN   optional: the GitHub reserve, a share of the
//                                 hourly limit (default 25 %), at least META_RESERVE_MIN (300)
//   GITHUB_OUTPUT                 step outputs: has_<i>, fence_<i>, run_key_<i> for every item
//
// Writes <out-dir>/<i>/bundle/ (observations/, results/, controls/, raw/, logs/)
// and <out-dir>/<i>/meta.json for every item i.
//
// Order: the known-answer control (live) and a forgery control (offline) run
// first; if either does not give its expected outcome, nothing is written and
// the exit code is 3, so no bundle is uploaded. If the known-answer read was
// stopped by a rate limit or an outage, no subject is read: every item gets a
// bundle with the forgery control and one retryable skip, so ingest sends it
// back later without counting it against the item (R-META-02). Then every
// subject is read. A subject that fails never fails the run: its bundle
// records skips.
//
// Exit codes: 0 bundles written; 2 bad inputs or usage; 3 a control failed or
// a harness error.

import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InputError, parseInputs, sanitize, sha256Hex, stableJson } from './lib/common.mjs';
import { createCache, createHttp } from './lib/http.mjs';
import { createBudget } from './github.mjs';
import { loadSeedPackages } from './registry.mjs';
import { laneOf } from './lanes.mjs';
import { forgeryControl, knownAnswerControl, newMarker } from './controls.mjs';

export const RESULT_FORMAT = 'isokron-tool-qa-meta-result/1';
const DEFAULT_DEADLINE_MIN = 22;

class ControlFailure extends Error {}

function numberEnv(env, key, dflt) {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  if (!/^\d{1,6}$/.test(v)) throw new InputError(`${key} must be a whole number`);
  return Number(v);
}

const ndjson = (records) => records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
}

/**
 * Run one shard. Returns { outputs, summary }; throws InputError or ControlFailure.
 * Everything that touches the network is injectable for tests.
 */
export async function runShard({
  laneName, out, env, fetch: f = globalThis.fetch, now = () => new Date(), clock = () => Date.now(),
  marker = newMarker, sleep, knownAnswerSpec, seed = loadSeedPackages(), log = () => {},
}) {
  const lane = laneOf(laneName);
  const input = parseInputs({ shardId: env.SHARD_ID, attemptId: env.ATTEMPT_ID, items: env.ITEMS });
  const deadlineMin = numberEnv(env, 'META_DEADLINE_MINUTES', DEFAULT_DEADLINE_MIN);
  const token = lane.needsToken ? (env.GITHUB_TOKEN || null) : null;
  if (lane.needsToken && !token) throw new InputError('GITHUB_TOKEN is required for meta-github');
  const budget = createBudget({
    restCap: numberEnv(env, 'META_REST_CAP', 400),
    reserveShare: numberEnv(env, 'META_RESERVE_PERCENT', 25) / 100,
    reserveMin: numberEnv(env, 'META_RESERVE_MIN', 300),
  });
  const cache = createCache({ path: env.META_CACHE_FILE || null, now: clock });
  const http = createHttp({ fetch: f, cache, now: clock, minIntervalMs: lane.minIntervalMs, ...(sleep ? { sleep } : {}) });
  const t0 = clock();
  const startedAt = now().toISOString();
  const settingsDigest = sha256Hex(stableJson(lane.settings));

  // Controls first: a lane that fails them reports nothing.
  const known = await knownAnswerControl(lane, { http, token, budget, ...(knownAnswerSpec ? { spec: knownAnswerSpec } : {}) });
  if (!known.unavailable && known.control.observed !== known.control.expected) throw new ControlFailure(`the known-answer control gave ${known.control.observed}`);
  const firstForgery = await forgeryControl(lane, { marker: marker() });
  if (firstForgery.control.observed !== firstForgery.control.expected) throw new ControlFailure(`the forgery control gave ${firstForgery.control.observed}`);
  log(`controls: known-answer ${known.unavailable ? `unavailable (${known.unavailable})` : known.control.observed}, forgery ${firstForgery.control.observed}`);

  const repos = [...new Set(input.items.map((x) => x.repo).filter(Boolean))];
  const deadline = () => clock() - t0 > deadlineMin * 60_000;
  const results = known.unavailable ? new Map() : await lane.collect({ http, repos, token, budget, deadline, seed, now, log });
  const finishedAt = now().toISOString();

  const shardApi = {
    requests: http.stats.requests,
    not_modified: http.stats.not_modified,
    retries: http.stats.retries,
    ...(lane.needsToken ? { github_rest: { ...budget.rest }, github_graphql: { ...budget.graphql } } : {}),
  };

  rmSync(out, { recursive: true, force: true });
  const outputs = [];
  for (const item of input.items) {
    const i = item.index;
    const forgery = i === input.items[0].index ? firstForgery : await forgeryControl(lane, { marker: marker() });
    if (forgery.control.observed !== forgery.control.expected) throw new ControlFailure(`the forgery control gave ${forgery.control.observed}`);
    let o;
    let outcome;
    if (known.unavailable) {
      o = { records: [], skips: [{ stage: 'known_answer', reason: known.unavailable, retryable: true }], stages: { known_answer: known.unavailable }, sha: null };
      outcome = 'known_answer_unavailable';
    } else if (!item.repo) {
      o = { records: [], skips: [lane.runSkips?.notGithub ?? { stage: 'collect', reason: 'policy_excluded' }], stages: { collect: 'not_a_github_repository' }, sha: null };
      outcome = 'not_a_github_repository';
    } else if (!results.has(item.repo)) {
      o = { records: [], skips: [lane.runSkips?.deadline ?? { stage: 'collect', reason: 'upstream_unavailable', retryable: true }], stages: { collect: 'shard_deadline' }, sha: null };
      outcome = 'shard_deadline';
    } else {
      o = results.get(item.repo);
      outcome = o.skips.length ? 'partial' : 'read';
    }
    const records = sanitize(o.records);
    const report = sanitize({
      format: RESULT_FORMAT, lane: lane.name, lane_version: lane.version, subject: item.subject,
      observed_at: finishedAt, outcome, stages: o.stages, records: records.length,
      fields: [...new Set(records.map((r) => r.field))].sort(), shard_api: shardApi,
    });
    const dir = join(out, String(i));
    const bundle = join(dir, 'bundle');
    const files = {
      [`observations/${lane.name}.ndjson`]: ndjson(records),
      [`results/${lane.name}.json`]: `${JSON.stringify(report, null, 2)}\n`,
      [`logs/${lane.name}.log`]: `${startedAt} ${lane.name} ${lane.version}: item ${i}: ${outcome}; ${records.length} records; ${o.skips.length} skips\n`,
      ...known.files,
      ...forgery.files,
    };
    writeFiles(bundle, files);
    const meta = {
      subject: { id: item.subject, repo: item.repo, sha: o.sha ?? null },
      tools: [{ name: `tool-qa-${lane.name}`, version: lane.version }],
      oracles: [],
      settings_manifest_digest: settingsDigest,
      started_at: startedAt,
      finished_at: finishedAt,
      skips: o.skips,
      controls: known.unavailable ? [forgery.control] : [known.control, forgery.control],
    };
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    outputs.push({ index: i, fence: item.fence, run_key: item.run_key, outcome });
    log(`item ${i}: ${outcome} (${records.length} records, ${o.skips.length} skips)`);
  }
  if (cache.save()) log(`cache: ${cache.size} entries saved`);
  return { outputs, summary: { items: outputs.length, api: shardApi, cache_entries: cache.size } };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const write = io.write ?? ((s) => process.stdout.write(s));
  if (argv.length !== 2 || !['meta-github', 'meta-registry', 'release-diff'].includes(argv[0])) {
    write('usage: node meta/run.mjs <meta-github|meta-registry|release-diff> <out-dir>\n');
    return 2;
  }
  const [laneName, out] = argv;
  try {
    const { outputs, summary } = await runShard({ laneName, out, env, log: (l) => write(`${l}\n`), ...(io.runOptions ?? {}) });
    const lines = outputs.map((o) => `has_${o.index}=true\nfence_${o.index}=${o.fence}\nrun_key_${o.index}=${o.run_key}\n`).join('');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
    write(`${laneName}: ${summary.items} bundles written; ${summary.api.requests} requests, ${summary.api.not_modified} not modified\n`);
    return 0;
  } catch (err) {
    rmSync(out, { recursive: true, force: true });
    if (err instanceof InputError) {
      write(`::error title=${laneName}::${err.message}\n`);
      return 2;
    }
    if (err instanceof ControlFailure) {
      write(`::error title=${laneName}::${err.message}; nothing is uploaded\n`);
      return 3;
    }
    write(`::error title=${laneName}::harness error (${err?.name ?? 'Error'}); nothing is uploaded\n`);
    if (env.META_DEBUG === '1') write(`${err?.stack ?? err}\n`);
    return 3;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
