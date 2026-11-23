#!/usr/bin/env node
// Trusted ingest of one worker attempt.
//
//   node ingest/ingest.mjs --repo OWNER/NAME --run-id N --attempt-id ID
//     (--state FILE | --ledger-json FILE) (--sealed FILE and/or --work-dir DIR)
//     [--registry FILE] [--seal-to FILE] [--allow-no-controls]
//
// The dispatch inputs (worker repo, run id, attempt id) and the attempts ledger
// are trusted. Everything the worker uploaded is not. Steps, in order:
//
//   1. ledger    the attempt exists, belongs to that repo (and run, if the ledger
//                knows it) and has no result yet; if the subject's fence has
//                moved on, stale_fence is recorded straight away
//   2. run       the run is completed, in that repo, from the dispatched
//                workflow file, started by workflow_dispatch and (if the ledger
//                knows it) at the dispatched commit
//   3. artifact  exactly one artifact named result-<attempt>.tar.age (or
//                result-<attempt>) from that run, not expired, under the size
//                cap; downloaded and, if zipped, unwrapped
//   4. decrypt   with age and the ingest identity
//   5. bundle    a tar of regular files with a valid manifest.json
//   6. forgery   forgery.mjs: identity, file list, foreign claims, controls
//   7. registry  observations use declared, non-deprecated fields of the right type
//   8. secrets   redaction rules and the attempt's canaries over the manifest and
//                every file outside raw/; any hit quarantines; raw/ hits are
//                only counted
//
// The decision is then recorded through the ledger, which does its own fence
// check and may refuse an acceptance (the outcome becomes rejected). Outputs:
//
//   accepted/<attempt>/    manifest.json, every bundle file, ingest.json
//   rejected/<attempt>/    ingest.json and result.tar.age (the ciphertext, if any)
//   quarantine/<attempt>/  ingest.json and result.tar.age
//
// ingest.json is the report: reason codes, paths, lines, digests and counts,
// never file contents or secret values. The CLI packs the outputs into one tar
// and age-encrypts it to worker-kit/ingest.pub (--sealed), so nothing is ever
// stored in the clear in CI. See ingest/README.md.
//
// Exit codes: 0 a decision was made (any outcome), 1 operational error (nothing
// was recorded unless stdout said so), 2 usage error.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { artifactName, MANIFEST_NAME, sha256Hex, validateManifest } from '../worker-kit/contract.mjs';
import { isSafeRelativePath, readTar, TarError, writeTar } from '../worker-kit/tar.mjs';
import { AgeError, ageDecrypt, ageEncrypt, agePublicKey, parseRecipientFile } from './age.mjs';
import { ContainerError, unwrapArtifact } from './container.mjs';
import { checkBundle } from './forgery.mjs';
import { GithubError, makeGithub } from './github.mjs';
import { openLedger } from './ledger.mjs';
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
 * Judge one attempt and record the decision.
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
 *   report: object|null, outputs: Map<string, Buffer>}>}
 */
export async function ingestAttempt(input, deps) {
  const {
    ledger, github, decrypt, registry, now = () => new Date(), allowNoControls = false,
    maxArtifactBytes = MAX_ARTIFACT_BYTES, maxBundleBytes = MAX_BUNDLE_BYTES,
  } = deps;
  const { repo, runId, attemptId } = checkInput(input);

  const report = { input: { repo, run_id: runId } };
  let row = null;
  let label = makeLabeler([]);
  let ciphertext = null;
  let manifestBytes = null;
  let files = null;

  async function finish(outcome, reason, { record = false, write = true, problems = [] } = {}) {
    let recorded = null;
    let finalOutcome = outcome;
    let finalReason = reason;
    const listed = problems.map((p) => cleanProblem(p, label));
    if (record) {
      const wanted = { run_key: row.run_key, attempt_id: row.attempt_id, fence: row.fence, outcome, accepted: outcome === 'accepted', reason };
      const answer = (await ledger.recordResult(wanted)) ?? { accepted: wanted.accepted, reason };
      recorded = { accepted: answer.accepted === true, reason: typeof answer.reason === 'string' ? answer.reason : null };
      if (outcome === 'accepted' && !recorded.accepted) {
        finalOutcome = 'rejected';
        finalReason = recorded.reason && REASON_RE.test(recorded.reason) ? recorded.reason : 'ledger_refused';
        listed.unshift({ reason: finalReason, detail: 'the ledger refused the result' });
      }
    }
    const full = {
      schema_version: REPORT_SCHEMA_VERSION,
      attempt_id: attemptId,
      outcome: finalOutcome,
      reason: finalReason,
      ingested_at: now().toISOString(),
      ...report,
      problems: listed.slice(0, MAX_LISTED),
      problems_total: listed.length,
      recorded,
    };
    const outputs = new Map();
    if (write) {
      const dir = `${OUTCOME_DIRS[finalOutcome]}/${attemptId}`;
      outputs.set(`${dir}/ingest.json`, Buffer.from(`${JSON.stringify(full, null, 2)}\n`));
      if (finalOutcome === 'accepted') {
        outputs.set(`${dir}/${MANIFEST_NAME}`, manifestBytes);
        for (const [path, data] of files) outputs.set(`${dir}/${path}`, data);
      } else if (ciphertext) {
        outputs.set(`${dir}/result.tar.age`, ciphertext);
      }
    }
    return {
      outcome: finalOutcome,
      reason: finalReason,
      recorded: recorded !== null,
      accepted: finalOutcome === 'accepted',
      report: full,
      outputs,
    };
  }
  const refuse = (reason, problems = []) => finish('rejected', reason, { record: false, problems });
  const reject = (reason, problems = []) => finish('rejected', reason, { record: true, problems });

  // 1. ledger
  row = await ledger.getAttempt(attemptId);
  if (!row) return refuse('unknown_attempt');
  label = makeLabeler(row.canaries);
  report.ledger = {
    run_key: row.run_key,
    fence: row.fence,
    repo: row.repo,
    workflow_file: row.workflow_file,
    workflow_sha: row.workflow_sha,
    run_id: row.run_id,
    current_fence: row.current_fence,
    canaries: row.canaries.length,
  };
  if (!sameRepo(row.repo, repo)) return refuse('ledger_repo_mismatch', [{ reason: 'ledger_repo_mismatch', expected: row.repo, got: repo }]);
  if (row.run_id !== null && row.run_id !== runId) {
    return refuse('ledger_run_mismatch', [{ reason: 'ledger_run_mismatch', expected: row.run_id, got: runId }]);
  }
  if (row.outcome !== null) return finish('already_recorded', null, { write: false });
  if (row.current_fence !== null && row.current_fence !== row.fence) {
    return reject('stale_fence', [{ reason: 'stale_fence', expected: row.current_fence, got: row.fence }]);
  }

  // 2. run
  const run = await github.getRun(row.repo, runId);
  if (!run || (run.id !== undefined && Number(run.id) !== runId)) return refuse('run_not_found');
  report.run = {
    id: runId,
    repo: textOrNull(run.repository?.full_name, label),
    path: textOrNull(run.path, label),
    event: textOrNull(run.event, label),
    status: textOrNull(run.status, label),
    conclusion: textOrNull(run.conclusion, label),
    head_sha: textOrNull(run.head_sha, label),
    run_attempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : null,
  };
  if (run.status !== 'completed') return finish('pending', 'run_not_completed', { write: false });
  if (!sameRepo(run.repository?.full_name, row.repo)) {
    return reject('run_repo_mismatch', [{ reason: 'run_repo_mismatch', expected: row.repo, got: report.run.repo }]);
  }
  const runFile = typeof run.path === 'string' ? run.path.replace(/@.*$/s, '') : null;
  if (runFile !== row.workflow_file) {
    return reject('run_workflow_mismatch', [{ reason: 'run_workflow_mismatch', expected: row.workflow_file, got: report.run.path }]);
  }
  if (run.event !== 'workflow_dispatch') {
    return reject('run_event_mismatch', [{ reason: 'run_event_mismatch', expected: 'workflow_dispatch', got: report.run.event }]);
  }
  if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha) || (row.workflow_sha && run.head_sha !== row.workflow_sha)) {
    return reject('run_sha_mismatch', [{ reason: 'run_sha_mismatch', expected: row.workflow_sha ?? 'a commit SHA', got: report.run.head_sha }]);
  }

  // 3. artifact
  const wantedName = artifactName(attemptId);
  const names = new Set([wantedName, wantedName.replace(/\.tar\.age$/, '')]);
  const listedArtifacts = await github.listRunArtifacts(row.repo, runId);
  const matches = (Array.isArray(listedArtifacts) ? listedArtifacts : []).filter((a) => a && names.has(a.name));
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
  try {
    const unwrapped = unwrapArtifact(blob, wantedName, { maxBytes: maxBundleBytes + 1024 ** 2 });
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

  // 6. forgery
  const exp = {
    attempt_id: row.attempt_id,
    fence: row.fence,
    run_key: row.run_key,
    repo: row.repo,
    workflow_file: row.workflow_file,
    workflow_sha: run.head_sha,
    run_id: runId,
    run_attempt: report.run.run_attempt,
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
  if (hits.length > 0) return finish('quarantined', 'secret_scan', { record: true });

  return finish('accepted', null, { record: true });
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
    // Before anything is judged: the identity must belong to the key workers encrypt to.
    let recipients;
    try {
      recipients = parseRecipientFile(readFileSync(sealTo, 'utf8'));
    } catch (err) {
      if (err instanceof AgeError) throw err;
      throw new Error(`cannot read ${sealTo} (${err.code ?? 'error'})`);
    }
    if (recipients.length === 0) {
      throw new Error(`${sealTo} has no age public key yet (see docs/OPERATIONS.md, "Result encryption keys"); nothing was judged`);
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
    const level = result.outcome === 'rejected' || result.outcome === 'quarantined' ? 'warning' : 'notice';
    const why = result.reason ? ` (${result.reason})` : '';
    stdout.write(`::${level} title=ingest::attempt ${opts.attemptId}: ${result.outcome}${why}${result.recorded ? ', recorded' : ''}\n`);
    return 0;
  } catch (err) {
    if (decided?.recorded) {
      // In CI the state is only pushed after this step succeeds, so the decision is not kept.
      return fail(new Error(`${scrubError(err, [token, identity])} (after ${decided.outcome} was recorded in the local ledger)`));
    }
    return fail(err);
  } finally {
    try { ledger?.close(); } catch { /* closing must not hide the real error */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
