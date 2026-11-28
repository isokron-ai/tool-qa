// Judging the contents of one decrypted result bundle: steps 5 to 8 of
// ingest.mjs (bundle, forgery, registry, secrets).
//
// This is synchronous work on untrusted bytes, so ingest never runs it on its
// own thread: runAnalysis() runs analyzeBundle() in a worker thread with a
// wall-clock limit and a memory limit (R-ING-04). A judge that runs out of
// time is stopped and the item is rejected as ingest_timeout; one that fails
// in any other way (an exception, out of memory) is rejected as ingest_error.
// Either way a decision is recorded, so the item is never judged again and
// can never hold up the pump.
//
// analyzeBundle() returns the decision and the report sections; problems are
// already cleaned (hygiene.mjs) and capped. It never returns file contents:
// for an accepted bundle the caller reads the files from the plaintext it
// still holds.

import { Worker } from 'node:worker_threads';

import {
  MANIFEST_NAME, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, resultFault, skipCodes, sha256Hex, validateManifest,
} from '../worker-kit/contract.mjs';
import { readTar, TarError } from '../worker-kit/tar.mjs';
import { pinDecision } from '../pump/pins.mjs';
import { checkBundle } from './forgery.mjs';
import { cleanHit, cleanProblem, makeLabeler, MAX_LISTED } from './hygiene.mjs';
import { scanFiles } from './redact.mjs';
import { validateObservations } from './registry.mjs';

/** Retryable skip reasons that may be throttling, not the subject (R-SUB-04). */
export const THROTTLE_SKIPS = Object.freeze(['rate_limited', 'upstream_unavailable']);

/**
 * Whether a skip is throttling by a third party (R-SUB-09): a retryable
 * rate_limited or upstream_unavailable skip from a stage the lane declares in
 * pump/workflows.json `throttle_stages`, as "stage" (both reasons) or
 * "stage:reason" (that reason only); reader_limit only as "stage:reader_limit".
 * A subject's own fetch or probe is never declared, so its failures stay
 * counted retries. A skip whose fault side is the tool is never throttling.
 */
export function isThrottleSkip(skip, stages = []) {
  if (skip?.retryable !== true) return false;
  // Our own shard deadline (collect:reader_limit of meta-github and meta-registry, meta/run.mjs): the
  // subject was never read, so a later shard may read it. Only when a lane names that exact reason.
  if (skip.reason === 'reader_limit') return stages.includes(`${skip.stage}:reader_limit`);
  if (!THROTTLE_SKIPS.includes(skip.reason)) return false;
  // A tool-side retryable skip (a redirect we do not follow, which the subject steers) is never throttling.
  if (skip.fault === 'tool') return false;
  return stages.includes(skip.stage) || stages.includes(`${skip.stage}:${skip.reason}`);
}

/**
 * Wall-clock limit for judging one item. Within the bundle caps
 * (worker-kit/contract.mjs) judging takes a few seconds even on crafted input
 * on one slow CPU; a minute leaves a wide margin and still fits several items
 * in a pump tick.
 */
export const JUDGE_TIMEOUT_MS = 60_000;
/** Heap limit of the judge thread: a few copies of the largest bundle allowed. */
export const JUDGE_MAX_MEMORY_MB = 1024;

const WORKER_URL = new URL('./judge-worker.mjs', import.meta.url);
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

function rank(reason) {
  const i = PROBLEM_ORDER.indexOf(reason);
  return i === -1 ? PROBLEM_ORDER.length : i;
}

/**
 * Read a decrypted bundle: the tar entries, its manifest bytes and its other
 * files. Throws TarError for a bad tar. Used by analyzeBundle() and, for an
 * accepted bundle, by the caller to collect the files it keeps.
 */
export function readBundle(plaintext, { maxBundleBytes } = {}) {
  const entries = readTar(plaintext, maxBundleBytes === undefined ? {} : { maxBytes: maxBundleBytes });
  const manifestEntry = entries.find((e) => e.path === MANIFEST_NAME);
  return {
    entries,
    manifestBytes: manifestEntry ? manifestEntry.data : null,
    files: new Map(entries.filter((e) => e.path !== MANIFEST_NAME).map((e) => [e.path, e.data])),
  };
}

/**
 * Judge a decrypted bundle against what was dispatched.
 *
 * @param {Buffer} plaintext
 * @param {{exp: object, registry: object, canaries?: string[], allowNoControls?: boolean,
 *   maxBundleBytes?: number, maxFileBytes?: number}} ctx
 *   exp is the identity the bundle must name (forgery.mjs checkBundle)
 * @returns {{outcome: 'accepted'|'rejected'|'quarantined', reason: string|null,
 *   problems: object[], problemsTotal: number, report: object, retryable?: boolean}}
 *   retryable (accepted only): the bundle has skips and every one is retryable
 *   throttled (accepted only): retryable, and every skip is rate_limited or upstream_unavailable
 */
export function analyzeBundle(plaintext, ctx) {
  const { exp, registry, canaries = [], allowNoControls = false, maxBundleBytes = MAX_BUNDLE_BYTES, maxFileBytes = MAX_FILE_BYTES, throttleStages = [], pins = null } = ctx;
  const label = makeLabeler(canaries);
  const report = {};
  const done = (outcome, reason, problems = []) => ({
    outcome,
    reason,
    problems: problems.slice(0, MAX_LISTED).map((p) => cleanProblem(p, label)),
    problemsTotal: problems.length,
    report,
  });
  const reject = (reason, problems = []) => done('rejected', reason, problems);

  // 5. bundle
  let bundle;
  try {
    bundle = readBundle(plaintext, { maxBundleBytes });
  } catch (err) {
    if (err instanceof TarError) return reject('bad_bundle', [{ reason: 'bad_bundle', detail: err.message }]);
    throw err;
  }
  const { entries, manifestBytes, files } = bundle;
  // Every file, manifest.json included, within the contract's per-file cap.
  const oversized = entries.filter((e) => e.data.length > maxFileBytes)
    .map((e) => ({ reason: 'file_too_large', path: e.path, expected: `<= ${maxFileBytes}`, got: e.data.length }));
  if (oversized.length > 0) return reject('file_too_large', oversized);
  if (!manifestBytes) return reject('no_manifest');
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
  const retryableSkips = manifest.skips.filter((sk) => sk.retryable === true).length;
  // Who the skips are down to (R-COV-01): the declared fault, or the reason's
  // default ("unknown" for an ambiguous reason from an older worker kit).
  const rf = resultFault(manifest.skips);
  report.bundle = {
    manifest_sha256: sha256Hex(manifestBytes),
    files: files.size,
    bytes: [...files.values()].reduce((n, d) => n + d.length, 0),
    controls: manifest.controls.length,
    skips: manifest.skips.length,
    retryable_skips: retryableSkips,
    // results/ files that are not only a skip's evidence: measured results (R-SUB-10).
    result_files: [...files.keys()].filter((p) => p.startsWith('results/') && !manifest.skips.some((sk) => sk.evidence === p)).length,
    fault: rf.fault,
    coverage: rf.coverage,
    skip_faults: rf.faults,
    declared_faults: manifest.skips.filter((sk) => sk.fault !== undefined).length,
    // The skips' codes with their fault (R-COV-49); absent when no skip has one, so older reports keep their shape.
    ...(skipCodes(manifest.skips).length > 0 ? { skip_codes: skipCodes(manifest.skips) } : {}),
  };
  // Every stage that did not run may succeed later (R-ING-16).
  const retryable = manifest.skips.length > 0 && retryableSkips === manifest.skips.length;
  // Throttled: every skip is a retryable rate limit or upstream outage from a
  // third-party stage the lane declares, which says nothing about the subject
  // (R-SUB-04, R-SUB-09).
  const throttled = retryable && manifest.skips.every((sk) => isThrottleSkip(sk, throttleStages));

  // 6. forgery: the bundle must name this item's run_key and fence
  const forged = checkBundle(manifest, files, exp, { requireControl: !allowNoControls })
    .map((p, i) => [p, i])
    .sort((a, b) => rank(a[0].reason) - rank(b[0].reason) || a[1] - b[1])
    .map(([p]) => p);
  if (forged.length > 0) return reject(forged[0].reason, forged);

  // 7. registry
  const obs = validateObservations(files, registry);
  report.registry = { source: registry.source ?? null, version: registry.version, sha256: registry.sha256 };
  report.observations = { records: obs.records, measured: obs.measured, errors: obs.errors.length, ...(obs.truncated ? { truncated: true } : {}) };
  if (!obs.ok) return reject(obs.errors[0]?.reason ?? 'observation_format', obs.errors);

  // 8. secrets
  const scanned = [[MANIFEST_NAME, manifestBytes], ...[...files].filter(([p]) => !p.startsWith('raw/'))];
  const hits = scanFiles(scanned, { canaries });
  const rawHits = scanFiles([...files].filter(([p]) => p.startsWith('raw/')), { canaries });
  const byRule = {};
  for (const h of rawHits) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
  report.secret_scan = {
    hits: hits.slice(0, MAX_LISTED).map((h) => cleanHit(h, label)),
    hits_total: hits.length,
    raw_hits_by_rule: byRule,
  };
  if (hits.length > 0) return done('quarantined', 'secret_scan');

  // 9. version pins (R-PIN-01): the tool and probe versions the run_key is
  // filed under must be what ran, or the result is refused (pump/pins.mjs).
  // Last, so it only ever turns what would be accepted into a refusal.
  if (pins) {
    const d = pinDecision({ mode: pins.mode, expected: pins.expected, tools: manifest.tools, self: pins.self ?? null });
    report.pins = labelPins(d.report, label);
    if (d.reason) return reject(d.reason, d.problems);
  }

  return { ...done('accepted', null), retryable, throttled };
}

/** The pins section of the report, with every string from the bundle through the labeler. */
function labelPins(r, label) {
  const entry = (e) => ({ kind: e.kind, name: label(e.name), pin: label(e.pin), got: e.got === null ? null : label(e.got), ...(e.note ? { note: label(e.note, 200) } : {}) });
  const out = { ...r };
  for (const k of ['verified', 'unverified', 'mismatched']) if (Array.isArray(r[k])) out[k] = r[k].slice(0, MAX_LISTED).map(entry);
  return out;
}

/**
 * Run analyzeBundle() in a worker thread. Resolves (never rejects) with
 * {result} on a decision, {timedOut: true} when it ran past `timeoutMs` (the
 * thread is stopped), or {error: text} when the judge failed (an exception,
 * out of memory, an early exit).
 *
 * @param {Buffer} plaintext
 * @param {object} ctx  as for analyzeBundle (must survive a structured clone)
 * @param {{timeoutMs?: number, maxMemoryMb?: number, workerUrl?: URL}} [opts]
 *   workerUrl is for tests (a judge that hangs)
 */
export function runAnalysis(plaintext, ctx, { timeoutMs = JUDGE_TIMEOUT_MS, maxMemoryMb = JUDGE_MAX_MEMORY_MB, workerUrl = WORKER_URL } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let worker;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
      worker?.terminate().catch(() => {});
    };
    try {
      worker = new Worker(workerUrl, {
        workerData: { plaintext, ctx },
        env: {}, // the judge needs no environment, and gets none
        resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
      });
    } catch (err) {
      finish({ error: `the judge could not start (${err?.code ?? err?.name ?? 'error'})` });
      return;
    }
    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    worker.once('message', (m) => finish(m && typeof m === 'object' ? m : { error: 'the judge sent no decision' }));
    worker.once('error', (err) => finish({ error: `${err?.name ?? 'Error'}${err?.code ? ` ${err.code}` : ''}: ${err?.message ?? err}` }));
    worker.once('exit', (code) => finish({ error: `the judge exited without a decision (exit code ${code})` }));
  });
}
