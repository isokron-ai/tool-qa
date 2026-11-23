#!/usr/bin/env node
// Trusted ingest of one worker attempt.
//
//   node ingest/ingest.mjs --repo OWNER/NAME --run-id N --attempt-id ID
//     (--state FILE | --ledger-json FILE) (--sealed FILE and/or --work-dir DIR)
//     [--registry FILE] [--seal-to FILE] [--allow-no-controls]
//
// The dispatch inputs (worker repo, run id, attempt id) and the attempts ledger
// are trusted. Everything the worker uploaded is not. An attempt is one shard:
// one or more items (run_keys), each at a 0-based index in the list the worker
// received, and each with its own result bundle. The attempt and its run are
// checked once; every item is then judged and recorded on its own. Steps:
//
//   1. ledger    the attempt exists and belongs to that repo (and run, if the
//                ledger knows it); items that already have a result are
//                skipped; an item whose fence has moved on gets stale_fence
//                recorded straight away, without a download
//   2. run       the run is completed, in that repo, from the dispatched
//                workflow file, started by workflow_dispatch and (if the ledger
//                knows it) at the dispatched commit; a failure here is recorded
//                for every item
//   3. artifact  the run's artifacts are listed once; per item, exactly one
//                named result-<attempt>-<index>.tar.age (or without .tar.age),
//                not expired, under the size cap; downloaded and, if zipped,
//                unwrapped. A one-item attempt also accepts the older name
//                result-<attempt>.tar.age (or result-<attempt>)
//   4. decrypt   with age and the ingest identity
//   5. bundle    a tar of regular files with a valid manifest.json
//   6. forgery   forgery.mjs: identity (this item's run_key and fence), file
//                list, foreign claims, controls
//   7. registry  observations use declared, non-deprecated fields of the right type
//   8. secrets   redaction rules and the attempt's canaries over the manifest and
//                every file outside raw/; any hit quarantines; raw/ hits are
//                only counted
//
// Each item's decision is then recorded through the ledger, which does its own
// fence check and may refuse an acceptance (the outcome becomes rejected).
// Outputs, per item:
//
//   accepted/<attempt>/<index>/    manifest.json, every bundle file, ingest.json
//   rejected/<attempt>/<index>/    ingest.json and result.tar.age (the ciphertext, if any)
//   quarantine/<attempt>/<index>/  ingest.json and result.tar.age
//
// An attempt refused before any item could be judged (unknown attempt, wrong
// repo or run, run not found) records nothing and writes only
// rejected/<attempt>/ingest.json.
//
// ingest.json is the report: reason codes, paths, lines, digests and counts,
// never file contents or secret values. The CLI packs the outputs into one tar
// and age-encrypts it to worker-kit/ingest.pub (--sealed), so nothing is ever
// stored in the clear in CI. See ingest/README.md.
//
// Exit codes: 0 a decision was made (any outcome), 1 operational error (nothing
// was recorded unless stdout said so), 2 usage error.

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { artifactName, legacyArtifactName, MANIFEST_NAME, sha256Hex, validateManifest } from '../worker-kit/contract.mjs';
import { isSafeRelativePath, readTar, TarError, writeTar } from '../worker-kit/tar.mjs';
import { AgeError, ageDecrypt, ageEncrypt, agePublicKey, readSealRecipients } from './age.mjs';
import { ContainerError, unwrapArtifact } from './container.mjs';
import { checkBundle } from './forgery.mjs';
import { GithubError, makeGithub } from './github.mjs';
import { normalizeAttempt, openLedger } from './ledger.mjs';
import { maskText, scanFiles, scanText } from './redact.mjs';
import { loadRegistry, validateObservations } from './registry.mjs';

export const REPORT_SCHEMA_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 512 * 1024 ** 2;
export const MAX_BUNDLE_BYTES = 1024 ** 3;
export const OUTCOME_DIRS = Object.freeze({ accepted: 'accepted', rejected: 'rejected', quarantined: 'quarantine' });

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LISTED = 50;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// When a bundle has several forgery problems, the most specific one names the
// rejection: identity first, then the file list, then the controls (a forged
// envelope in a control output also shows up as a foreign claim).
const PROBLEM_ORDER = [
  'attempt_mismatch', 'fence_mismatch', 'run_key_mismatch', 'workflow_repo_mismatch', 'workflow_file_mismatch',
  'workflow_sha_mismatch', 'run_id_mismatch', 'run_attempt_mismatch',
  'unlisted_file', 'missing_file', 'size_mismatch', 'digest_mismatch',
  'forgery_control_injected', 'forgery_marker_leaked', 'foreign_identity_claim',
  'control_output_in_raw', 'control_failed', 'control_missing', 'forgery_control_unverified',
];
const PROBLEM_KEYS = ['reason', 'field', 'path', 'line', 'json_path', 'key', 'index', 'kind', 'how', 'expected', 'got', 'detail'];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function checkInput({ repo, runId, attemptId } = {}) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new InputError('invalid repo (expected OWNER/NAME)');
  }
  const run = typeof runId === 'string' && /^[1-9]\d{0,15}$/.test(runId) ? Number(runId) : runId;
  if (!Number.isSafeInteger(run) || run < 1) throw new InputError('invalid run id (expected a positive whole number)');
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) {
    throw new InputError('invalid attempt id (letters, digits, ".", "_" and "-", up to 128)');
  }
  return { repo, runId: run, attemptId };
}

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function rank(reason) {
  const i = PROBLEM_ORDER.indexOf(reason);
  return i === -1 ? PROBLEM_ORDER.length : i;
}

/**
 * Open one attempt for judging: read the ledger, check the run once and list its
 * artifacts once. Nothing is recorded here; judge() records one item at a time,
 * so a caller can give each item its own transaction (collect.mjs does).
 *
 * `done` is set when there is nothing to judge item by item. It has the shape
 * ingestAttempt() returns:
 *   rejected          refused before anything could be judged (unknown_attempt,
 *                     ledger_repo_mismatch, ledger_run_mismatch, run_not_found);
 *                     nothing is recorded, the report goes to rejected/<attempt>/
 *   already_recorded  every item has a result already; no outputs
 *   pending           the run is not completed yet; nothing recorded, no outputs
 * Otherwise `items` are the ledger items that have no result yet, in index
 * order, and judge(item) judges one of them, records the decision and returns
 * {index, run_key, outcome, reason, recorded, accepted, report, outputs}. Each
 * item can be judged once per open.
 *
 * @param {{repo: string, runId: number|string, attemptId: string}} input  from the dispatch
 * @param {object} deps  as for ingestAttempt()
 * @returns {Promise<{done: object|null, attempt: object|null, items: object[],
 *   judge: (item: object) => Promise<object>}>}
 */
export async function openAttempt(input, deps) {
  const {
    ledger, github, decrypt, registry, now = () => new Date(), allowNoControls = false,
    maxArtifactBytes = MAX_ARTIFACT_BYTES, maxBundleBytes = MAX_BUNDLE_BYTES,
  } = deps;
  const { repo, runId, attemptId } = checkInput(input);

  const base = { input: { repo, run_id: runId } };
  let row = null;
  let label = makeLabeler([]);

  const nothingToJudge = async () => { throw new TypeError('openAttempt: there is nothing to judge'); };
  function stop(outcome, reason, { write = true, problems = [] } = {}) {
    const listed = problems.map((p) => cleanProblem(p, label));
    const report = {
      schema_version: REPORT_SCHEMA_VERSION,
      attempt_id: attemptId,
      outcome,
      reason,
      ingested_at: now().toISOString(),
      ...base,
      problems: listed.slice(0, MAX_LISTED),
      problems_total: listed.length,
      recorded: null,
    };
    const outputs = new Map();
    if (write) outputs.set(`${OUTCOME_DIRS[outcome]}/${attemptId}/ingest.json`, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    return { done: { outcome, reason, recorded: false, accepted: false, report, outputs }, attempt: row, items: [], judge: nothingToJudge };
  }

  // 1. ledger
  row = normalizeAttempt(await ledger.getAttempt(attemptId));
  if (!row) return stop('rejected', 'unknown_attempt');
  label = makeLabeler(row.canaries);
  base.ledger = {
    repo: row.repo,
    workflow_file: row.workflow_file,
    workflow_sha: row.workflow_sha,
    run_id: row.run_id,
    items: row.items.length,
    canaries: row.canaries.length,
  };
  if (!sameRepo(row.repo, repo)) {
    return stop('rejected', 'ledger_repo_mismatch', { problems: [{ reason: 'ledger_repo_mismatch', expected: row.repo, got: repo }] });
  }
  if (row.run_id !== null && row.run_id !== runId) {
    return stop('rejected', 'ledger_run_mismatch', { problems: [{ reason: 'ledger_run_mismatch', expected: row.run_id, got: runId }] });
  }
  const pending = row.items.filter((it) => it.outcome === null);
  if (pending.length === 0) return stop('already_recorded', null, { write: false });
  const isStale = (it) => it.current_fence !== null && it.current_fence !== it.fence;

  // 2. run (only when some item still needs it)
  let run = null;
  let runProblem = null;
  let artifacts = [];
  if (pending.some((it) => !isStale(it))) {
    run = await github.getRun(row.repo, runId);
    if (!run || (run.id !== undefined && Number(run.id) !== runId)) return stop('rejected', 'run_not_found');
    base.run = {
      id: runId,
      repo: textOrNull(run.repository?.full_name, label),
      path: textOrNull(run.path, label),
      event: textOrNull(run.event, label),
      status: textOrNull(run.status, label),
      conclusion: textOrNull(run.conclusion, label),
      head_sha: textOrNull(run.head_sha, label),
      run_attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : null,
    };
    if (run.status !== 'completed') return stop('pending', 'run_not_completed', { write: false });
    runProblem = checkRun(run, row, base.run);
    if (!runProblem) {
      // 3. artifact (listed once for every item)
      const listed = await github.listRunArtifacts(row.repo, runId);
      artifacts = (Array.isArray(listed) ? listed : []).filter((a) => a && typeof a === 'object');
    }
  }

  const judged = new Set();

  async function judge(wanted) {
    const item = pending.find((it) => it.index === wanted?.index);
    if (!item) throw new TypeError('openAttempt: judge() takes one of the items openAttempt returned');
    if (judged.has(item.index)) throw new TypeError(`openAttempt: item ${item.index} was judged already`);
    judged.add(item.index);

    const report = { ...base, ledger: { run_key: item.run_key, fence: item.fence, current_fence: item.current_fence, ...base.ledger } };
    let ciphertext = null;
    let manifestBytes = null;
    let files = null;

    async function finish(outcome, reason, problems = []) {
      const listed = problems.map((p) => cleanProblem(p, label));
      const wantedRecord = {
        run_key: item.run_key, attempt_id: row.attempt_id, fence: item.fence, outcome, accepted: outcome === 'accepted', reason,
      };
      const answer = (await ledger.recordResult(wantedRecord)) ?? { accepted: wantedRecord.accepted, reason };
      const recorded = { accepted: answer.accepted === true, reason: typeof answer.reason === 'string' ? answer.reason : null };
      let finalOutcome = outcome;
      let finalReason = reason;
      if (outcome === 'accepted' && !recorded.accepted) {
        finalOutcome = 'rejected';
        finalReason = recorded.reason && REASON_RE.test(recorded.reason) ? recorded.reason : 'ledger_refused';
        listed.unshift({ reason: finalReason, detail: 'the ledger refused the result' });
      }
      const full = {
        schema_version: REPORT_SCHEMA_VERSION,
        attempt_id: attemptId,
        item_index: item.index,
        outcome: finalOutcome,
        reason: finalReason,
        ingested_at: now().toISOString(),
        ...report,
        problems: listed.slice(0, MAX_LISTED),
        problems_total: listed.length,
        recorded,
      };
      const outputs = new Map();
      const dir = `${OUTCOME_DIRS[finalOutcome]}/${attemptId}/${item.index}`;
      outputs.set(`${dir}/ingest.json`, Buffer.from(`${JSON.stringify(full, null, 2)}\n`));
      if (finalOutcome === 'accepted') {
        outputs.set(`${dir}/${MANIFEST_NAME}`, manifestBytes);
        for (const [path, data] of files) outputs.set(`${dir}/${path}`, data);
      } else if (ciphertext) {
        outputs.set(`${dir}/result.tar.age`, ciphertext);
      }
      return {
        index: item.index,
        run_key: item.run_key,
        outcome: finalOutcome,
        reason: finalReason,
        recorded: true,
        accepted: finalOutcome === 'accepted',
        report: full,
        outputs,
      };
    }
    const reject = (reason, problems = []) => finish('rejected', reason, problems);

    if (isStale(item)) return reject('stale_fence', [{ reason: 'stale_fence', expected: item.current_fence, got: item.fence }]);
    if (runProblem) return reject(runProblem.reason, runProblem.problems);

    // 3. artifact
    const wantedName = artifactName(attemptId, item.index);
    const names = [wantedName, wantedName.replace(/\.tar\.age$/, '')];
    if (row.items.length === 1) {
      const legacy = legacyArtifactName(attemptId);
      names.push(legacy, legacy.replace(/\.tar\.age$/, ''));
    }
    const matches = artifacts.filter((a) => names.includes(a.name));
    if (matches.length === 0) return reject('no_artifact', [{ reason: 'no_artifact', expected: wantedName }]);
    if (matches.length > 1) return reject('duplicate_artifact', [{ reason: 'duplicate_artifact', expected: wantedName, got: matches.length }]);
    const art = matches[0];
    report.artifact = {
      id: Number.isSafeInteger(art.id) ? art.id : null,
      name: art.name,
      size_in_bytes: Number.isSafeInteger(art.size_in_bytes) ? art.size_in_bytes : null,
      created_at: textOrNull(art.created_at, label),
    };
    const artRun = art.workflow_run?.id;
    if (artRun !== undefined && artRun !== null && Number(artRun) !== runId) {
      return reject('artifact_run_mismatch', [{ reason: 'artifact_run_mismatch', expected: runId, got: Number(artRun) }]);
    }
    if (art.expired === true) return reject('artifact_expired');
    if (Number(art.size_in_bytes) > maxArtifactBytes) {
      return reject('artifact_too_large', [{ reason: 'artifact_too_large', expected: `<= ${maxArtifactBytes}`, got: art.size_in_bytes }]);
    }
    let blob;
    try {
      blob = await github.downloadArtifact(row.repo, art.id);
    } catch (err) {
      if (err instanceof GithubError && !err.transient && err.status === 410) return reject('artifact_expired');
      if (err instanceof GithubError && err.code === 'too_large') return reject('artifact_too_large');
      throw err;
    }
    report.artifact.download_sha256 = sha256Hex(blob);
    report.artifact.download_bytes = blob.length;
    // A zipped artifact holds one file named like the artifact, with .tar.age.
    const innerName = art.name.endsWith('.tar.age') ? art.name : `${art.name}.tar.age`;
    try {
      const unwrapped = unwrapArtifact(blob, innerName, { maxBytes: maxBundleBytes + 1024 ** 2 });
      ciphertext = unwrapped.ciphertext;
      report.artifact.container = unwrapped.container;
    } catch (err) {
      if (err instanceof ContainerError) return reject('bad_container', [{ reason: 'bad_container', detail: err.message }]);
      throw err;
    }
    report.artifact.sha256 = sha256Hex(ciphertext);
    report.artifact.bytes = ciphertext.length;

    // 4. decrypt
    let plaintext;
    try {
      plaintext = await decrypt(ciphertext);
    } catch (err) {
      if (err instanceof AgeError && err.code === 'failed') return reject('decrypt_failed', [{ reason: 'decrypt_failed', detail: err.message }]);
      if (err instanceof AgeError && err.code === 'too_large') return reject('bundle_too_large', [{ reason: 'bundle_too_large', detail: err.message }]);
      throw err;
    }

    // 5. bundle
    let entries;
    try {
      entries = readTar(plaintext, { maxBytes: maxBundleBytes });
    } catch (err) {
      if (err instanceof TarError) return reject('bad_bundle', [{ reason: 'bad_bundle', detail: err.message }]);
      throw err;
    }
    const manifestEntry = entries.find((e) => e.path === MANIFEST_NAME);
    if (!manifestEntry) return reject('no_manifest');
    manifestBytes = manifestEntry.data;
    let manifest;
    try {
      manifest = JSON.parse(strictUtf8.decode(manifestBytes));
    } catch {
      return reject('manifest_not_json');
    }
    const valid = validateManifest(manifest);
    if (!valid.ok) {
      return reject('manifest_invalid', valid.errors.map((e) => ({ reason: 'manifest_invalid', json_path: e.path, detail: e.message })));
    }
    files = new Map(entries.filter((e) => e.path !== MANIFEST_NAME).map((e) => [e.path, e.data]));
    report.bundle = {
      manifest_sha256: sha256Hex(manifestBytes),
      files: files.size,
      bytes: [...files.values()].reduce((n, d) => n + d.length, 0),
      controls: manifest.controls.length,
      skips: manifest.skips.length,
    };

    // 6. forgery: the bundle must name this item's run_key and fence
    const exp = {
      attempt_id: row.attempt_id,
      fence: item.fence,
      run_key: item.run_key,
      repo: row.repo,
      workflow_file: row.workflow_file,
      workflow_sha: run.head_sha,
      run_id: runId,
      run_attempt: base.run.run_attempt,
    };
    const forged = checkBundle(manifest, files, exp, { requireControl: !allowNoControls })
      .map((p, i) => [p, i])
      .sort((a, b) => rank(a[0].reason) - rank(b[0].reason) || a[1] - b[1])
      .map(([p]) => p);
    if (forged.length > 0) return reject(forged[0].reason, forged);

    // 7. registry
    const obs = validateObservations(files, registry);
    report.registry = { source: registry.source ?? null, version: registry.version, sha256: registry.sha256 };
    report.observations = { records: obs.records, errors: obs.errors.length, ...(obs.truncated ? { truncated: true } : {}) };
    if (!obs.ok) return reject(obs.errors[0]?.reason ?? 'observation_format', obs.errors);

    // 8. secrets
    const scanned = [[MANIFEST_NAME, manifestBytes], ...[...files].filter(([p]) => !p.startsWith('raw/'))];
    const hits = scanFiles(scanned, { canaries: row.canaries });
    const rawHits = scanFiles([...files].filter(([p]) => p.startsWith('raw/')), { canaries: row.canaries });
    const byRule = {};
    for (const h of rawHits) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
    report.secret_scan = {
      hits: hits.slice(0, MAX_LISTED).map((h) => cleanHit(h, label)),
      hits_total: hits.length,
      raw_hits_by_rule: byRule,
    };
    if (hits.length > 0) return finish('quarantined', 'secret_scan');

    return finish('accepted', null);
  }

  return { done: null, attempt: row, items: pending.slice(), judge };
}

/** The run-level checks every item shares; {reason, problems} or null. */
function checkRun(run, row, seen) {
  const fail = (reason, expected, got) => ({ reason, problems: [{ reason, expected, got }] });
  if (!sameRepo(run.repository?.full_name, row.repo)) return fail('run_repo_mismatch', row.repo, seen.repo);
  const runFile = typeof run.path === 'string' ? run.path.replace(/@.*$/s, '') : null;
  if (runFile !== row.workflow_file) return fail('run_workflow_mismatch', row.workflow_file, seen.path);
  if (run.event !== 'workflow_dispatch') return fail('run_event_mismatch', 'workflow_dispatch', seen.event);
  if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha) || (row.workflow_sha && run.head_sha !== row.workflow_sha)) {
    return fail('run_sha_mismatch', row.workflow_sha ?? 'a commit SHA', seen.head_sha);
  }
  return null;
}

/**
 * Judge every item of one attempt that has no result yet and record each
 * decision.
 *
 * @param {{repo: string, runId: number|string, attemptId: string}} input  from the dispatch
 * @param {object} deps
 * @param {{getAttempt: Function, recordResult: Function}} deps.ledger  see ledger.mjs
 * @param {{getRun: Function, listRunArtifacts: Function, downloadArtifact: Function}} deps.github  see github.mjs
 * @param {(ciphertext: Buffer) => Buffer|Promise<Buffer>} deps.decrypt  throws AgeError
 * @param {{version: number, sha256: string, fields: Map, source?: string}} deps.registry
 * @param {() => Date} [deps.now]
 * @param {boolean} [deps.allowNoControls]  accept bundles that carry no control at all
 * @param {number} [deps.maxArtifactBytes]
 * @param {number} [deps.maxBundleBytes]
 * @returns {Promise<{outcome: string, reason: string|null, recorded: boolean, accepted: boolean,
 *   report: object|null, outputs: Map<string, Buffer>, items: object[]}>}
 *   outcome and reason are the items' own when they all agree; otherwise outcome
 *   is 'mixed' and reason null. report is the item's report when one item was
 *   judged (or the attempt's when none was), else null. items holds each judged
 *   item's result (see openAttempt), in index order.
 */
export async function ingestAttempt(input, deps) {
  const opened = await openAttempt(input, deps);
  if (opened.done) return { ...opened.done, items: [] };
  const results = [];
  for (const item of opened.items) {
    try {
      results.push(await opened.judge(item));
    } catch (err) {
      // Items judged before the failure stay recorded; say so to the caller.
      if (results.length > 0 && err !== null && typeof err === 'object') err.partial = combineResults(results);
      throw err;
    }
  }
  return combineResults(results);
}

/** One summary over several judged items (see ingestAttempt). */
export function combineResults(results) {
  if (!Array.isArray(results) || results.length === 0) throw new TypeError('combineResults: no judged items');
  const outputs = new Map();
  for (const r of results) for (const [path, data] of r.outputs) outputs.set(path, data);
  const same = (key) => results.every((r) => r[key] === results[0][key]);
  return {
    outcome: same('outcome') ? results[0].outcome : 'mixed',
    reason: same('reason') ? results[0].reason : null,
    recorded: results.some((r) => r.recorded),
    accepted: results.every((r) => r.accepted),
    report: results.length === 1 ? results[0].report : null,
    outputs,
    items: results,
  };
}

// ---- report hygiene ----

/** Printable ASCII only, secret and canary spans masked, length capped. */
function makeLabeler(canaries) {
  return (value, max = 200) => {
    let s = String(value).replace(/[^\x20-\x7e]/g, '?');
    const hits = scanText(s, { canaries });
    if (hits.length > 0) s = maskText(s, hits);
    return s.length > max ? `${s.slice(0, max)}...` : s;
  };
}

function textOrNull(v, label) {
  return typeof v === 'string' ? label(v) : null;
}

function cleanProblem(p, label) {
  const out = {};
  for (const k of PROBLEM_KEYS) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = label(v);
  }
  return out;
}

function cleanHit(h, label) {
  const out = { path: label(h.path), rule: h.rule, class: h.class };
  if (Number.isInteger(h.line)) out.line = h.line;
  if (typeof h.json_path === 'string') out.json_path = label(h.json_path);
  if (h.in_key) out.in_key = true;
  out.start = h.start;
  out.length = h.length;
  return out;
}

// ---- command line ----

const USAGE = `usage: node ingest/ingest.mjs --repo OWNER/NAME --run-id N --attempt-id ID
         (--state FILE | --ledger-json FILE) (--sealed FILE and/or --work-dir DIR)
         [--registry FILE] [--seal-to FILE] [--allow-no-controls]
environment: GITHUB_TOKEN (or GH_TOKEN), AGE_IDENTITY; optional AGE_BIN, AGE_KEYGEN_BIN,
             GITHUB_API_URL, RUNNER_TEMP, GITHUB_OUTPUT`;

const FLAGS = {
  '--repo': 'repo', '--run-id': 'runId', '--attempt-id': 'attemptId', '--state': 'state',
  '--ledger-json': 'ledgerJson', '--sealed': 'sealed', '--work-dir': 'workDir', '--registry': 'registry',
  '--seal-to': 'sealTo',
};

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { allowNoControls: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let value;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a === '--allow-no-controls' && value === undefined) {
      o.allowNoControls = true;
      continue;
    }
    if (a === '--help' || a === '-h') throw new UsageError('');
    const key = FLAGS[a];
    if (!key) throw new UsageError(`unknown argument ${JSON.stringify(String(a).slice(0, 60))}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`${a} needs a value`);
    }
    if (value === '') throw new UsageError(`${a} needs a value`);
    o[key] = value;
  }
  for (const f of ['--repo', '--run-id', '--attempt-id']) {
    if (o[FLAGS[f]] === undefined) throw new UsageError(`${f} is required`);
  }
  if (Boolean(o.state) === Boolean(o.ledgerJson)) throw new UsageError('pass exactly one of --state and --ledger-json');
  if (!o.sealed && !o.workDir) throw new UsageError('pass --sealed and/or --work-dir');
  return o;
}

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** One line, no secrets: the token and identity are cut out, anything key-shaped is masked. */
function scrubError(err, secrets) {
  let s = err instanceof Error ? `${err.message}` : String(err);
  for (const secret of secrets) if (secret) s = s.split(secret).join('[secret]');
  const hits = scanText(s);
  if (hits.length > 0) s = maskText(s, hits);
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function writeWorkDir(dir, outputs) {
  const root = resolve(dir);
  for (const [path, data] of outputs) {
    if (!isSafeRelativePath(path)) throw new Error(`refusing to write unsafe output path ${JSON.stringify(path.slice(0, 120))}`);
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error('refusing to write outside --work-dir');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { mode: 0o600 });
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env  secrets are removed from it when it is process.env
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}, fetch?: Function}} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const fetchFn = io.fetch ?? globalThis.fetch;

  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  const identity = env.AGE_IDENTITY || '';
  if (env === process.env) {
    // Nothing started from here (age, age-keygen) needs them.
    delete process.env.AGE_IDENTITY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  }
  const fail = (err) => {
    stdout.write(`::error title=ingest::${escapeData(scrubError(err, [token, identity]))}\n`);
    return 1;
  };

  let opts;
  try {
    opts = parseArgs(argv);
    checkInput(opts);
  } catch (err) {
    if (!(err instanceof UsageError || err instanceof InputError)) throw err;
    stderr.write(`${err.message ? `ingest: ${err.message}\n` : ''}${USAGE}\n`);
    return 2;
  }
  if (!token) return fail(new Error('GITHUB_TOKEN (or GH_TOKEN) is not set'));
  if (!identity) return fail(new Error('AGE_IDENTITY is not set'));

  const ageBin = env.AGE_BIN || 'age';
  const keygenBin = env.AGE_KEYGEN_BIN || 'age-keygen';
  const tmpDir = env.RUNNER_TEMP || tmpdir();
  const sealTo = opts.sealTo ?? fileURLToPath(new URL('../worker-kit/ingest.pub', import.meta.url));

  let ledger;
  let decided = null;
  try {
    // Before anything is judged: the outputs can be sealed (ingest.pub holds a
    // real key) and the identity belongs to the key workers encrypt to.
    let recipients;
    try {
      recipients = readSealRecipients(sealTo);
    } catch (err) {
      throw new Error(`${err.message}; nothing was judged`);
    }
    const publicKey = agePublicKey({ identity, keygenBin });
    if (!recipients.includes(publicKey)) {
      throw new Error(`AGE_IDENTITY does not belong to any key in ${sealTo}; nothing was judged`);
    }

    const registry = opts.registry
      ? { ...(await loadRegistry({ path: opts.registry })), source: 'file' }
      : { ...(await loadRegistry({ fetch: fetchFn })), source: 'pinned' };
    const github = makeGithub({ token, fetch: fetchFn, apiUrl: env.GITHUB_API_URL || undefined });
    ledger = await openLedger({ statePath: opts.state, ledgerJson: opts.ledgerJson });
    const decrypt = (ciphertext) => ageDecrypt({ ciphertext, identity, ageBin, tmpDir, maxBytes: MAX_BUNDLE_BYTES });

    const result = await ingestAttempt(
      { repo: opts.repo, runId: opts.runId, attemptId: opts.attemptId },
      { ledger, github, decrypt, registry, allowNoControls: opts.allowNoControls },
    );
    decided = result;

    let sealed = '';
    if (result.outputs.size > 0) {
      if (opts.sealed) {
        const tar = writeTar([...result.outputs].map(([path, data]) => ({ path, data })));
        const box = ageEncrypt({ plaintext: tar, recipients, ageBin, maxBytes: tar.length });
        mkdirSync(dirname(resolve(opts.sealed)), { recursive: true });
        writeFileSync(opts.sealed, box, { mode: 0o600 });
        chmodSync(opts.sealed, 0o600);
        sealed = opts.sealed;
      }
      if (opts.workDir) writeWorkDir(opts.workDir, result.outputs);
    }

    const outputs = {
      outcome: result.outcome,
      reason: result.reason ?? '',
      accepted: String(result.accepted),
      recorded: String(result.recorded),
      sealed,
    };
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}\n`).join(''));
    }
    const line = (what, r) => {
      const level = ['rejected', 'quarantined', 'mixed'].includes(r.outcome) ? 'warning' : 'notice';
      const why = r.reason ? ` (${r.reason})` : '';
      stdout.write(`::${level} title=ingest::${what}: ${r.outcome}${why}${r.recorded ? ', recorded' : ''}\n`);
    };
    line(`attempt ${opts.attemptId}`, result);
    if (result.items.length > 1) for (const it of result.items) line(`attempt ${opts.attemptId} item ${it.index}`, it);
    return 0;
  } catch (err) {
    const before = decided ?? err?.partial;
    if (before?.recorded) {
      // In CI the state is only pushed after this step succeeds, so the decision is not kept.
      return fail(new Error(`${scrubError(err, [token, identity])} (after ${before.outcome} was recorded in the local ledger)`));
    }
    return fail(err);
  } finally {
    try { ledger?.close(); } catch { /* closing must not hide the real error */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
