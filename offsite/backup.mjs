#!/usr/bin/env node
// Off-site backup: copy the loop's data, still encrypted where it is
// encrypted, into a Cloudflare R2 bucket, outside GitHub and outside the
// operator's Mac. One run of .github/workflows/offsite-backup.yml.
//
//   node offsite/backup.mjs
//
// What it copies, byte for byte as GitHub stores it (nothing is decrypted;
// this process holds no age key):
//   - state snapshots: every snapshot the `state-snapshots` release manifest
//     lists (age ciphertext; checked against the manifest's sha256 and the
//     sha8 in the name, as the restore drill does), and the manifest itself;
//   - ingest artifacts (`ingest-*`: the pump's sealed outputs, age files);
//   - history artifacts (`history-*`, `registry-*`: public registry and
//     package data, not encrypted).
// Artifacts pass archive-pull's origin check first (scripts/archive-pull.mjs
// SOURCES: this repository, not a fork, branch main, the expected workflow).
// One from a fork or another branch is skipped; one of ours from a workflow
// SOURCES does not list is held (a failure, retried) until SOURCES lists it.
// A download is checked against GitHub's sha256 digest before it is uploaded.
//
// Keys, by kind and UTC day:
//   snapshots/<day>/<snapshot name>
//   snapshot-manifests/<day>/manifest-<updated>-<sha8>.json
//   ingest/<day>/<artifact>/<artifact>.zip      (or the one file of an artifact uploaded with archive: false)
//   history/<day>/<artifact>/<artifact>.zip
//   manifest/<day>/<run time>-<run id>.ndjson   one line per object this run copied
//   _state/cursor/<run time>-<run id>.json      where the next run starts listing
// The bucket's lock rule keeps every object for 30 days, so nothing is ever
// rewritten: the per-day manifest is a set of parts, one per run, and the
// cursor is a new small object per run (the newest wins).
//
// Integrity. Every PUT is a new object only (If-None-Match: *) and carries
// Content-MD5, x-amz-checksum-sha256 and the sha256 as metadata; a HEAD after
// it must show the same size, an ETag equal to the MD5, and the same sha256.
// A key that already exists with the same sha256 is skipped (dedupe). One that
// exists with other bytes is never overwritten: the copy goes beside it as
// `<key>.sha256-<12 hex>` and the run reports a verification failure.
//
// Cost guard. The run first lists the whole bucket and sums its size. It
// uploads nothing that would take the bucket past OFFSITE_MAX_BYTES (default
// 8 GB, at most the 10 GB free tier): the run fails and the watchdog item is
// red. A kind stops for this run (and the next run carries on) once a phase
// (snapshots, then artifacts) has copied OFFSITE_MAX_RUN_BYTES (default 2 GB);
// the whole run stops after OFFSITE_MAX_CLASS_A operations (LIST and PUT;
// default 2,000), OFFSITE_MAX_CLASS_B (HEAD and GET; default 20,000), or 30
// minutes. It reports what it used. The run's own manifest part and cursor are
// always written, past those caps.
//
// A run that died before writing its manifest part leaves objects without a
// line; the next run that finds one of them (written after the last cursor)
// writes its line, marked `recovered`.
//
// Not configured yet (any of R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY missing): exit 0 with a notice and an `unconfigured`
// heartbeat (amber on the watchdog).
//
// Heartbeat. The run writes a small JSON file (OFFSITE_HEARTBEAT_FILE) that
// the workflow uploads as the artifact `offsite-heartbeat-<run id>-<attempt>.json`;
// the watchdog reads the newest one (watchdog/offsite.mjs). The job token
// cannot write repository variables, so this replaces a variable.
//
// Exit codes: 0 ok or not configured; 1 over the cap, a verification
// failure, or any item that could not be copied (it is retried next run);
// 2 a usage error.
//
// Environment: GITHUB_TOKEN (actions: read, contents: read), GITHUB_REPOSITORY,
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, R2_* above, OFFSITE_* limits,
// OFFSITE_SHA256_HEADER (`on` sends x-amz-checksum-sha256; off by default, R2 refuses it with Content-MD5),
// OFFSITE_HEARTBEAT_FILE, GITHUB_STEP_SUMMARY.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiBudget, BudgetExceededError } from '../pump/budgets.mjs';
import { createClient, scrub as scrubText } from '../pump/github.mjs';
import { MAX_LIST_PAGES, download, ingestEntryProblem, ingestRun, kindOf, listArtifacts, prefetchRuns, provenanceProblem, verifyEntries } from '../scripts/archive-pull.mjs';
import { readZipLenient } from '../scripts/lib/unzip.mjs';
import { createReleaseClient } from '../snapshot/github.mjs';
import { MANIFEST as SNAPSHOT_MANIFEST, SNAPSHOT_TAG, parseManifest, reconcile, stamp, verifySnapshot } from '../snapshot/snapshot.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const GB = 1000 ** 3;
export const FREE_TIER = Object.freeze({ bytes: 10 * GB, classA: 1_000_000, classB: 10_000_000 });
export const DEFAULTS = Object.freeze({
  maxBytes: 8 * GB,
  maxRunBytes: 2 * GB,
  maxClassA: 2_000,
  maxClassB: 20_000,
  nearCapRatio: 0.85,
});
export const OVERLAP_MS = HOUR;
// A run stops taking new items after this long and leaves them to the next
// run, so it always has time to write its manifest part and cursor before the
// job's timeout.
export const DEFAULT_MAX_RUN_MS = 30 * MIN;
// Room kept under the cap for each run's manifest part and cursor.
export const BOOKKEEPING_BYTES = 1_000_000;
export const REQUIRED = Object.freeze(['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
export const PREFIX = Object.freeze({
  snapshots: 'snapshots/',
  snapshotManifests: 'snapshot-manifests/',
  ingest: 'ingest/',
  keep: 'keep/',
  history: 'history/',
  manifest: 'manifest/',
  cursor: '_state/cursor/',
});
export const KINDS = Object.freeze(['snapshots', 'ingest', 'history']);
const USER_AGENT = 'isokron-tool-qa-offsite';

const hash = (alg, data) => createHash(alg).update(data).digest('hex');
const isZipBytes = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
const day = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`${JSON.stringify(iso)} is not a date`);
  return new Date(t).toISOString().slice(0, 10);
};
export const segment = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';

export class CapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapError';
  }
}
export class OpsCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpsCapError';
  }
}
class RunBudgetError extends Error {}
class DeadlineError extends Error {}
class VerifyError extends Error {}

// ---- configuration ----

function limit(env, name, fallback, problems, max = Infinity) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    problems.push(`${name} must be a whole number above 0`);
    return fallback;
  }
  if (Number(raw) > max) {
    problems.push(`${name} is ${raw}, above the free tier's ${max}`);
    return fallback;
  }
  return Number(raw);
}

/**
 * Read the R2 settings and limits. `missing` lists the settings not set (then
 * nothing runs); `problems` lists settings that are set but wrong (an error).
 */
export function readConfig(env) {
  const missing = REQUIRED.filter((n) => !String(env[n] ?? '').trim());
  const problems = [];
  const accountId = String(env.R2_ACCOUNT_ID ?? '').trim();
  const bucket = String(env.R2_BUCKET ?? '').trim();
  if (accountId && !/^[0-9a-f]{32}$/.test(accountId)) problems.push('R2_ACCOUNT_ID is not a 32-character hex Cloudflare account ID');
  if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) problems.push('R2_BUCKET is not a valid R2 bucket name');
  const limits = {
    maxBytes: limit(env, 'OFFSITE_MAX_BYTES', DEFAULTS.maxBytes, problems, FREE_TIER.bytes),
    maxRunBytes: limit(env, 'OFFSITE_MAX_RUN_BYTES', DEFAULTS.maxRunBytes, problems, FREE_TIER.bytes),
    maxClassA: limit(env, 'OFFSITE_MAX_CLASS_A', DEFAULTS.maxClassA, problems, FREE_TIER.classA),
    maxClassB: limit(env, 'OFFSITE_MAX_CLASS_B', DEFAULTS.maxClassB, problems, FREE_TIER.classB),
  };
  return {
    configured: missing.length === 0,
    missing,
    problems,
    accountId,
    bucket,
    accessKeyId: String(env.R2_ACCESS_KEY_ID ?? ''),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY ?? ''),
    // R2 refuses Content-MD5 together with x-amz-checksum-sha256, so the header is off unless asked for.
    sendSha256: String(env.OFFSITE_SHA256_HEADER ?? '').trim().toLowerCase() === 'on',
    limits,
  };
}

// ---- the store, metered ----

/**
 * Count operations as R2 bills them (Class A: LIST, PUT; Class B: HEAD, GET;
 * DELETE is free) and refuse one past the run's cap with OpsCapError.
 */
/** Worth trying again: a network error, 429 or 5xx; never a refusal such as 412 ('exists') or 4xx. */
export const retryable = (err) => err?.code !== 'exists' && (err?.status == null || err.status === 429 || err.status >= 500);
export const STORE_ATTEMPTS = 3;

export function meter(store, { maxClassA = DEFAULTS.maxClassA, maxClassB = DEFAULTS.maxClassB, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = STORE_ATTEMPTS } = {}) {
  const ops = { list: 0, put: 0, head: 0, get: 0, delete: 0 };
  const classA = () => ops.list + ops.put;
  const classB = () => ops.head + ops.get;
  // `essential`: the run's own manifest part and cursor, which go past the cap so a run that
  // stopped at it still records what it did.
  const take = (op, essential = false) => {
    if (essential) {
      ops[op] += 1;
      return;
    }
    if ((op === 'list' || op === 'put') && classA() >= maxClassA) throw new OpsCapError(`this run reached its cap of ${maxClassA} Class A operations (OFFSITE_MAX_CLASS_A)`);
    if ((op === 'head' || op === 'get') && classB() >= maxClassB) throw new OpsCapError(`this run reached its cap of ${maxClassB} Class B operations (OFFSITE_MAX_CLASS_B)`);
    ops[op] += 1;
  };
  // The store does not retry; each attempt here is taken from the caps, so retries count.
  const call = async (op, essential, fn) => {
    for (let i = 1; ; i++) {
      take(op, essential);
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts || !retryable(err)) throw err;
        await sleep(1000 * 2 ** (i - 1));
      }
    }
  };
  return {
    ops,
    counts: () => ({ ...ops, class_a: classA(), class_b: classB() }),
    list: (o) => call('list', false, () => store.list(o)),
    head: (k, essential) => call('head', essential, () => store.head(k)),
    put: (k, b, o) => call('put', o?.essential, () => store.put(k, b, o)),
    get: (k) => call('get', false, () => store.get(k)),
    delete: (k) => call('delete', false, () => store.delete(k)),
  };
}

/** Every object in the bucket (or under a prefix): { objects, total, byKey }. */
export async function inventory(store, prefix = '') {
  const objects = [];
  let token = null;
  for (let page = 0; page < 100_000; page++) {
    const res = await store.list({ prefix, token });
    objects.push(...res.items);
    // Truncated with no way to go on: the sum (and anything judged from it) would be short.
    if (res.truncated && !res.next) throw new Error(`the bucket listing${prefix ? ` of ${prefix}` : ''} was cut short (truncated, no continuation token)`);
    token = res.next;
    if (!token) break;
  }
  const total = objects.reduce((s, o) => s + (Number(o.size) || 0), 0);
  return { objects, total, byKey: new Map(objects.map((o) => [o.key, o])) };
}

/** The newest readable cursor, or null. Tries the three newest. */
export async function readCursor(store, inv) {
  const keys = inv.objects.map((o) => o.key).filter((k) => k.startsWith(PREFIX.cursor) && k.endsWith('.json')).sort().reverse();
  for (const key of keys.slice(0, 3)) {
    try {
      const c = JSON.parse((await store.get(key))?.toString('utf8') ?? 'null');
      if (c && c.version === 1 && c.by_kind && typeof c.by_kind === 'object') return { ...c, key };
    } catch (err) {
      if (err instanceof OpsCapError) throw err;
      // a cursor that cannot be read: try the one before it
    }
  }
  return null;
}

// ---- keys ----

/** True for `ingest-keep-<run>-<attempt>`: the keep-forever part of a pump run's outputs. */
export const isKeepArtifact = (name) => /^ingest-keep-\d+-\d+$/.test(String(name));

/** The key of an artifact's bytes: by kind, UTC day of creation, and name. */
export function artifactKey(artifact, isZip) {
  const kind = kindOf(artifact.name);
  if (!kind) throw new Error(`${artifact.name} is not an ingest or history artifact`);
  const folder = segment(artifact.name);
  // The keep-forever part of the pump's outputs is its own prefix, so the prune can tell it from full bundles.
  const prefix = isKeepArtifact(artifact.name) ? PREFIX.keep : PREFIX[kind];
  return `${prefix}${day(artifact.created_at)}/${folder}/${isZip ? `${folder}.zip` : folder}`;
}

/** Before download: a `.tar.age` name was uploaded as one file (archive: false); anything else is a zip. */
export const expectZip = (artifact) => !/\.tar\.age$/.test(String(artifact.name));

export const snapshotKey = (entry) => `${PREFIX.snapshots}${day(entry.created)}/${segment(entry.name)}`;
export const snapshotManifestKey = (updated, sha) => `${PREFIX.snapshotManifests}${day(updated)}/manifest-${stamp(Date.parse(updated))}-${sha.slice(0, 8)}.json`;
export const altKey = (key, sha) => `${key}.sha256-${sha.slice(0, 12)}`;

// ---- one object ----

/** Does an object (from HEAD) hold these bytes? */
export function sameObject(head, { size, sha256, md5 }) {
  if (!head || head.size !== size) return false;
  if (head.sha256) return head.sha256 === sha256;
  return /^[0-9a-f]{32}$/.test(head.etag) && head.etag === md5;
}

/** Why a HEAD after a PUT does not show the bytes we sent, or null. */
export function verifyProblem(head, { size, sha256, md5 }, putEtag) {
  if (!head) return 'the object is not there after the PUT';
  const problems = [];
  if (head.size !== size) problems.push(`size ${head.size} is not ${size}`);
  if (/^[0-9a-f]{32}$/.test(head.etag)) {
    if (head.etag !== md5) problems.push(`ETag ${head.etag} is not the MD5 ${md5}`);
  } else if (!head.sha256) problems.push(`ETag ${JSON.stringify(head.etag)} is not an MD5 and there is no sha256 metadata to check`);
  if (putEtag && /^[0-9a-f]{32}$/.test(putEtag) && putEtag !== md5) problems.push(`the PUT answered ETag ${putEtag}, not the MD5 ${md5}`);
  if (head.sha256 && head.sha256 !== sha256) problems.push(`sha256 metadata ${head.sha256} is not ${sha256}`);
  if (head.checksumSha256 && head.checksumSha256 !== Buffer.from(sha256, 'hex').toString('base64')) problems.push('the stored SHA-256 checksum does not match');
  return problems.length ? problems.join('; ') : null;
}

// ---- the run ----

/**
 * One backup run. `store` is the R2 store (offsite/store-r2.mjs) or a fake;
 * `gh` is { client, release, fetch, sleep } for this repository.
 * @returns {Promise<object>} the heartbeat (see the header)
 */
export async function runBackup({ store, gh, repo, runId = 'local', limits = DEFAULTS, sendSha256 = false, now = Date.now, log = () => {}, maxRunMs = DEFAULT_MAX_RUN_MS }) {
  const m = meter(store, { ...limits, ...(gh?.sleep ? { sleep: gh.sleep } : {}) });
  const startedAt = new Date(now()).toISOString();
  const deadline = Date.parse(startedAt) + maxRunMs;
  const out = {
    version: 1,
    at: startedAt,
    run_id: runId,
    status: 'ok',
    reason: null,
    last_ok_at: null,
    bucket_bytes: null,
    cap_bytes: limits.maxBytes,
    near_cap: false,
    copied: { snapshots: 0, ingest: 0, history: 0, manifests: 0 },
    copied_bytes: 0,
    already: 0,
    foreign: [],
    deferred: 0,
    deferred_reason: null,
    failures: [],
    verify_failures: 0,
    ops: null,
    cursor: null,
  };
  const lines = [];
  // phaseBytes: bytes copied in this phase (snapshots, then artifacts), for OFFSITE_MAX_RUN_BYTES,
  // so the snapshots never starve the artifacts. deferrals: why kinds were left for the next run.
  const state = { total: 0, runBytes: 0, phaseBytes: 0, stop: null, deferrals: [] };
  let inv;
  let previous = null;
  try {
    inv = await inventory(m);
    state.total = inv.total;
    previous = await readCursor(m, inv);
    out.last_ok_at = previous?.last_ok_at ?? null;
    if (inv.total >= limits.maxBytes) {
      state.stop = new CapError(`the bucket holds ${inv.total} bytes, at or over the cap of ${limits.maxBytes} (OFFSITE_MAX_BYTES)`);
    }
  } catch (err) {
    out.status = 'error';
    out.reason = `could not read the bucket: ${err?.message ?? err}`;
    out.ops = m.counts();
    return out;
  }

  const present = (key) => inv.byKey.has(key);

  /** Upload one object unless it is there already. Returns 'copied' | 'already' | 'conflict'. */
  async function put(key, data, digests, line, { contentType, afterExists = false } = {}, depth = 0) {
    if (depth > 2) throw new Error(`${key}: the key exists but cannot be read back; not copied`);
    if (present(key)) {
      const head = await m.head(key);
      if (sameObject(head, digests)) {
        // Refused as existing during this run, but not there when it started: our own PUT whose
        // answer was lost (the client retried). It is this run's copy: count it and record it.
        if (afterExists && !startKeys.has(key)) {
          account(digests.size);
          lines.push({ ...line, key, bytes: digests.size, sha256: digests.sha256, md5: digests.md5, copied_at: new Date(now()).toISOString(), run: runId });
          return 'copied';
        }
        recordRecovered(key, head, line);
        return 'already';
      }
      if (head) {
        const alt = altKey(key, digests.sha256);
        log(`offsite: ${key} already holds other bytes; it is never overwritten, the copy goes to ${alt}`);
        const r = await put(alt, data, digests, { ...line, conflict_with: key }, { contentType }, depth + 1);
        if (r === 'already') return 'already';
        return 'conflict';
      }
    }
    if (state.total + digests.size > limits.maxBytes - BOOKKEEPING_BYTES) {
      throw new CapError(`${key} (${digests.size} bytes) would take the bucket to ${state.total + digests.size} bytes, over the cap of ${limits.maxBytes} (OFFSITE_MAX_BYTES)`);
    }
    if (state.phaseBytes + digests.size > limits.maxRunBytes && state.phaseBytes > 0) {
      throw new RunBudgetError(`this run has copied ${state.phaseBytes} bytes in this phase; ${key} would pass OFFSITE_MAX_RUN_BYTES (${limits.maxRunBytes}); the next run carries on`);
    }
    let res;
    try {
      res = await m.put(key, data, { md5: digests.md5, sha256: digests.sha256, sendSha256, contentType });
    } catch (err) {
      if (err?.code !== 'exists') {
        // Every attempt failed, but one may have been stored: count it against the cap.
        possiblyStored(digests.size);
        throw err;
      }
      // Made since we listed (another run, or a PUT whose answer was lost): judge what is there.
      inv.byKey.set(key, { key, size: null });
      return put(key, data, digests, line, { contentType, afterExists: true }, depth + 1);
    }
    inv.byKey.set(key, { key, size: digests.size });
    account(digests.size);
    const problem = verifyProblem(await m.head(key), digests, res?.etag);
    if (problem) throw new VerifyError(`${key}: ${problem}`);
    lines.push({ ...line, key, bytes: digests.size, sha256: digests.sha256, md5: digests.md5, copied_at: new Date(now()).toISOString(), run: runId });
    return 'copied';
  }

  const digestsOf = (data) => ({ size: data.length, sha256: hash('sha256', data), md5: hash('md5', data) });
  const startKeys = new Set(inv.byKey.keys());
  function possiblyStored(size) {
    state.total += size;
    out.possibly_stored_bytes = (out.possibly_stored_bytes ?? 0) + size;
  }
  function account(size) {
    state.total += size;
    state.runBytes += size;
    state.phaseBytes += size;
    out.copied_bytes += size;
  }
  // Written after the last finished run wrote its cursor: copied by a run that died before
  // writing its manifest part. The line is written now, marked recovered.
  const previousEnd = Date.parse(previous?.finished_at ?? '');
  function recordRecovered(key, head, line) {
    const o = inv.byKey.get(key);
    const t = Date.parse(o?.lastModified ?? '');
    if (!Number.isFinite(t) || (Number.isFinite(previousEnd) && t <= previousEnd) || (!Number.isFinite(previousEnd) && previous)) return;
    lines.push({ ...line, key, bytes: head.size, sha256: head.sha256, md5: head.etag, copied_at: o.lastModified, run: runId, recovered: true });
  }

  /** Is it there already, with this sha256, under its key or a conflict key? HEADs only. */
  async function alreadyThere(key, sha, size, line) {
    for (const k of [key, sha ? altKey(key, sha) : null]) {
      if (!k || !present(k)) continue;
      const head = await m.head(k);
      if (head && sha && head.sha256 === sha && (size == null || head.size === size)) {
        recordRecovered(k, head, line);
        return true;
      }
    }
    return false;
  }
  const checkDeadline = () => {
    if (now() > deadline) throw new DeadlineError(`this run reached its time limit of ${Math.round(maxRunMs / MIN)} minutes; the next run carries on`);
  };

  // Each kind's items in time order; the cursor moves to the newest one done,
  // held back before the first that was not.
  const cursor = { ...(previous?.by_kind ?? {}) };
  const progress = Object.fromEntries(KINDS.map((k) => [k, { last: null, blocked: false }]));
  const done = (kind, t) => {
    const p = progress[kind];
    if (!p.blocked && t && (!p.last || t > p.last)) p.last = t;
  };
  const blocked = (kind) => {
    progress[kind].blocked = true;
  };
  const fail = (kind, what, err) => {
    blocked(kind);
    const message = String(err?.message ?? err).slice(0, 300);
    if (err instanceof VerifyError) out.verify_failures += 1;
    out.failures.push({ kind, item: what, error: message, verify: err instanceof VerifyError });
    log(`offsite: ${what}: ${message}`);
  };
  /** Handle an error from one item; true if the run must stop copying. */
  // OFFSITE_MAX_RUN_BYTES leaves the rest of that kind to the next run, and the other kinds go
  // on; the cost cap, the operation caps, the GitHub API budget and the time limit stop the run.
  const skip = new Set();
  const stopOn = (kind, what, err) => {
    if (err instanceof RunBudgetError) {
      blocked(kind);
      skip.add(kind);
      state.deferrals.push(err.message);
      return false;
    }
    if (err instanceof CapError || err instanceof OpsCapError || err instanceof BudgetExceededError || err instanceof DeadlineError) {
      blocked(kind);
      state.stop = err;
      if (!(err instanceof CapError)) state.deferrals.push(err.message);
      return true;
    }
    fail(kind, what, err);
    return false;
  };
  const sinceOf = (kind) => (cursor[kind] ? Date.parse(cursor[kind]) - OVERLAP_MS : null);

  // 1. State snapshots (first: the newest state matters most).
  if (!state.stop) {
    try {
      await copySnapshots();
    } catch (err) {
      if (!stopOn('snapshots', 'state snapshots', err)) blocked('snapshots');
    }
  }
  async function copySnapshots() {
    const release = await gh.release.getRelease(SNAPSHOT_TAG);
    if (!release) {
      log(`offsite: no ${SNAPSHOT_TAG} release yet`);
      return;
    }
    const assets = await gh.release.listAssets(release);
    const asset = assets.find((a) => a.name === SNAPSHOT_MANIFEST && (!a.state || a.state === 'uploaded'));
    if (!asset) {
      fail('snapshots', SNAPSHOT_MANIFEST, new Error(`the ${SNAPSHOT_TAG} release has no ${SNAPSHOT_MANIFEST}; snapshots are copied only as it lists them`));
      return;
    }
    const manifestBytes = await gh.release.download(asset);
    const manifest = parseManifest(manifestBytes.toString('utf8'));
    if (!manifest) {
      fail('snapshots', SNAPSHOT_MANIFEST, new Error(`${SNAPSHOT_MANIFEST} is not a snapshot manifest`));
      return;
    }
    const manifestSha = hash('sha256', manifestBytes);
    const since = sinceOf('snapshots');
    const { entries } = reconcile(manifest, assets);
    const wanted = entries.filter((e) => since === null || Date.parse(e.created) >= since).sort((a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name));
    const snapLine = (entry) => ({
      kind: 'snapshot',
      source: { repo, release: SNAPSHOT_TAG, asset: entry.name, asset_id: entry.asset_id, created: entry.created, manifest_sha256: manifestSha },
    });
    for (const entry of wanted) {
      const key = snapshotKey(entry);
      try {
        checkDeadline();
        if (await alreadyThere(key, entry.sha256, entry.size, snapLine(entry))) {
          out.already += 1;
          done('snapshots', entry.created);
          continue;
        }
        const bytes = await gh.release.download({ id: entry.asset_id, name: entry.name });
        const v = verifySnapshot(bytes, entry);
        if (!v.ok) throw new Error(`the release copy fails its manifest entry: ${v.reason}; not copied`);
        const r = await put(key, bytes, digestsOf(bytes), snapLine(entry));
        if (r === 'copied') out.copied.snapshots += 1;
        else if (r === 'already') out.already += 1;
        else fail('snapshots', entry.name, new VerifyError(`${key} held other bytes; copied beside it`));
        if (r !== 'conflict') done('snapshots', entry.created);
      } catch (err) {
        if (stopOn('snapshots', entry.name, err) || skip.has('snapshots')) break;
      }
    }
    if (state.stop) return;
    // The manifest itself, once per version.
    const updated = typeof manifest.updated === 'string' && Number.isFinite(Date.parse(manifest.updated)) ? manifest.updated : startedAt;
    const mkey = snapshotManifestKey(updated, manifestSha);
    try {
      const r = await put(mkey, manifestBytes, digestsOf(manifestBytes), {
        kind: 'snapshot-manifest',
        source: { repo, release: SNAPSHOT_TAG, asset: SNAPSHOT_MANIFEST, asset_id: asset.id, updated },
      }, { contentType: 'application/json' });
      if (r === 'copied') out.copied.manifests += 1;
      else if (r === 'already') out.already += 1;
      else fail('snapshots', SNAPSHOT_MANIFEST, new VerifyError(`${mkey} held other bytes; copied beside it`));
    } catch (err) {
      stopOn('snapshots', SNAPSHOT_MANIFEST, err);
    }
  }

  // 2 and 3. Ingest, then history artifacts.
  if (!state.stop) {
    try {
      await copyArtifacts();
    } catch (err) {
      for (const kind of ['ingest', 'history']) if (!stopOn(kind, 'artifacts', err)) blocked(kind);
    }
  }
  async function copyArtifacts() {
    const sinces = ['ingest', 'history'].map(sinceOf);
    const since = sinces.includes(null) ? null : Math.min(...sinces);
    const listing = await listArtifacts(gh.client, repo, since, MAX_LIST_PAGES);
    if (!listing.complete) {
      blocked('ingest');
      blocked('history');
      log(`offsite: the artifact list did not end within ${MAX_LIST_PAGES} pages; the cursor stays where it was`);
    }
    const seen = new Set();
    const wanted = listing.items
      .filter((a) => kindOf(a.name) && !a.expired)
      .filter((a) => {
        const s = sinceOf(kindOf(a.name));
        const t = Date.parse(a.created_at);
        return s === null || !Number.isFinite(t) || t >= s;
      })
      .filter((a) => !seen.has(Number(a.id)) && seen.add(Number(a.id)))
      .sort((a, b) => {
        const k = (x) => (kindOf(x.name) === 'ingest' ? 0 : 1);
        return k(a) - k(b) || String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id;
      });
    const runs = new Map();
    await prefetchRuns(gh.client, repo, wanted, runs);
    state.phaseBytes = 0;
    for (const a of wanted) {
      const kind = kindOf(a.name);
      if (state.stop) break;
      if (skip.has(kind)) continue;
      try {
        checkDeadline();
        const origin = await provenanceProblem(gh.client, repo, a, runs);
        if (origin?.ours) throw new Error(`held, not copied: ${origin.why}; add the workflow to SOURCES in scripts/archive-pull.mjs`);
        if (origin) {
          out.foreign.push({ name: a.name, id: a.id, why: origin.why });
          log(`offsite: ${a.name}: REFUSED, not from our own workflow on main: ${origin.why}`);
          done(kind, a.created_at);
          continue;
        }
        const digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''))?.[1] ?? null;
        const run = runs.get(a.workflow_run?.id) ?? null;
        const artLine = (zip, contents) => ({
          kind,
          source: {
            repo,
            artifact_id: a.id,
            artifact: a.name,
            created_at: a.created_at,
            format: zip ? 'zip' : 'file',
            digest_checked: Boolean(digest),
            workflow_run_id: a.workflow_run?.id ?? null,
            head_sha: a.workflow_run?.head_sha ?? null,
            workflow: run?.path ? String(run.path).split('@')[0] : null,
            ...(kind === 'ingest' ? ingestRun(a) : {}),
          },
          ...(contents ? { contents } : {}),
        });
        if (digest && (await alreadyThere(artifactKey(a, expectZip(a)), digest, null, artLine(expectZip(a))))) {
          out.already += 1;
          done(kind, a.created_at);
          continue;
        }
        const data = await download(gh.client, gh.fetch, repo, a, gh.sleep);
        const d = digestsOf(data);
        if (digest && digest !== d.sha256) throw new Error(`download sha256 ${d.sha256} does not match the artifact digest ${digest}; tried again next run`);
        const declared = Number(a.size_in_bytes);
        if (!digest && Number.isFinite(declared) && declared !== data.length) throw new Error(`downloaded ${data.length} bytes but the artifact is ${declared}, and there is no digest to check; tried again next run`);
        const zip = isZipBytes(data);
        const contents = describe(a, data, zip);
        const r = await put(artifactKey(a, zip), data, d, artLine(zip, contents), { contentType: zip ? 'application/zip' : 'application/octet-stream' });
        if (r === 'copied') out.copied[kind] += 1;
        else if (r === 'already') out.already += 1;
        else fail(kind, a.name, new VerifyError(`${artifactKey(a, zip)} held other bytes; copied beside it`));
        if (r !== 'conflict') done(kind, a.created_at);
        if (contents.problems.length) log(`offsite: ${a.name}: copied as stored, with notes: ${contents.problems.slice(0, 3).join('; ')}`);
      } catch (err) {
        if (stopOn(kind, a.name, err)) break;
      }
    }
    // A kind with nothing in a complete listing starts from now (less the overlap) next time,
    // not from the beginning again.
    for (const kind of ['ingest', 'history']) {
      if (listing.complete && !state.stop && !skip.has(kind) && !cursor[kind] && !progress[kind].last) done(kind, startedAt);
    }
  }

  // The manifest part and the cursor.
  if (state.deferrals.length) {
    out.deferred = state.deferrals.length;
    out.deferred_reason = state.deferrals.join('; ').slice(0, 300);
    log(`offsite: left for the next run: ${out.deferred_reason}`);
  }
  if (state.stop instanceof CapError) {
    out.status = 'over_cap';
    out.reason = state.stop.message;
  } else if (out.verify_failures) {
    out.status = 'verify_failed';
    out.reason = `${out.verify_failures} object(s) failed verification`;
  } else if (out.failures.length) {
    out.status = 'error';
    out.reason = `${out.failures.length} item(s) could not be copied; they are tried again next run`;
  }
  for (const kind of KINDS) if (progress[kind].last) cursor[kind] = progress[kind].last;
  const runStamp = stamp(Date.parse(startedAt));
  try {
    if (lines.length) {
      const body = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const key = `${PREFIX.manifest}${startedAt.slice(0, 10)}/${runStamp}-${segment(runId)}.ndjson`;
      await putSmall(key, body, 'application/x-ndjson');
    }
    const ok = out.status === 'ok';
    out.last_ok_at = ok ? startedAt : out.last_ok_at;
    const c = { version: 1, at: startedAt, finished_at: new Date(now()).toISOString(), run_id: runId, status: out.status, last_ok_at: out.last_ok_at, by_kind: cursor };
    await putSmall(`${PREFIX.cursor}${runStamp}-${segment(runId)}.json`, Buffer.from(`${JSON.stringify(c)}\n`), 'application/json');
    out.cursor = cursor;
  } catch (err) {
    if (out.status === 'ok' || out.status === 'error') {
      out.status = err instanceof CapError ? 'over_cap' : err instanceof VerifyError ? 'verify_failed' : 'error';
      out.reason = `could not write the run's manifest or cursor: ${String(err?.message ?? err).slice(0, 200)}`;
    }
    if (err instanceof VerifyError) out.verify_failures += 1;
    out.last_ok_at = previous?.last_ok_at ?? null;
  }
  async function putSmall(key, body, contentType) {
    // The cap still applies; these are a few hundred bytes.
    const d = digestsOf(body);
    if (state.total + d.size > limits.maxBytes) throw new CapError(`${key} would take the bucket over the cap`);
    let res;
    try {
      res = await m.put(key, body, { md5: d.md5, sha256: d.sha256, sendSha256, contentType, essential: true });
    } catch (err) {
      // A retried PUT whose first try was stored: fine if the bytes are ours.
      if (err?.code !== 'exists') possiblyStored(d.size);
      if (err?.code !== 'exists' || !sameObject(await m.head(key, true), d)) throw err;
      return;
    }
    state.total += d.size;
    const problem = verifyProblem(await m.head(key, true), d, res?.etag);
    if (problem) throw new VerifyError(`${key}: ${problem}`);
  }

  out.bucket_bytes = state.total;
  out.near_cap = state.total >= limits.maxBytes * DEFAULTS.nearCapRatio;
  out.ops = m.counts();
  return out;
}

/** What an artifact holds, for the manifest: its files' names, sizes and sha256s, and anything odd. Never decrypts. */
export function describe(artifact, data, zip) {
  const kind = kindOf(artifact.name);
  const problems = [];
  let entries = [];
  if (zip) {
    try {
      const r = readZipLenient(data);
      entries = r.entries;
      for (const x of r.refused) problems.push(`${x.name}: ${x.reason}`);
    } catch (err) {
      problems.push(`the zip cannot be read: ${err?.message ?? err}`);
    }
  } else {
    entries = [{ name: segment(artifact.name), data }];
  }
  if (kind === 'ingest') {
    for (const e of entries) {
      const p = ingestEntryProblem(e);
      if (p) problems.push(`${e.name}: ${p}`);
    }
  } else if (zip) {
    problems.push(...verifyEntries(entries).problems);
  }
  return { files: entries.map((e) => ({ name: e.name, bytes: e.data.length, sha256: hash('sha256', e.data) })), problems };
}

// ---- command line ----

export function summary(hb) {
  const gb = (b) => (b == null ? '?' : `${(b / GB).toFixed(3)} GB`);
  const rows = [
    `**Off-site backup: ${hb.status}**${hb.reason ? ` (${hb.reason})` : ''}`,
    '',
    `- bucket: ${gb(hb.bucket_bytes)} of the ${gb(hb.cap_bytes)} cap${hb.near_cap ? ' (near the cap)' : ''}`,
    `- copied: ${hb.copied ? Object.entries(hb.copied).map(([k, v]) => `${v} ${k}`).join(', ') : '0'} (${hb.copied_bytes ?? 0} bytes); already there: ${hb.already ?? 0}; refused as not ours: ${hb.foreign?.length ?? 0}`,
    `- operations: ${hb.ops ? `Class A ${hb.ops.class_a} (LIST ${hb.ops.list}, PUT ${hb.ops.put}), Class B ${hb.ops.class_b} (HEAD ${hb.ops.head}, GET ${hb.ops.get})` : 'none'}`,
    `- last good run: ${hb.last_ok_at ?? 'none yet'}`,
  ];
  if (hb.deferred) rows.push(`- stopped early, the next run carries on: ${hb.deferred_reason}`);
  for (const f of hb.failures ?? []) rows.push(`- FAILED ${f.kind} ${f.item}: ${f.error}`);
  return `${rows.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  if (argv.length) {
    process.stderr.write(`offsite: unknown argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }
  const cfg = readConfig(env);
  const secrets = [cfg.accessKeyId, cfg.secretAccessKey, cfg.accountId, env.GITHUB_TOKEN];
  const say = (line) => process.stderr.write(`${scrubText(line, secrets)}\n`);
  const runId = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}` : `local-${process.pid}`;
  const actions = env.GITHUB_ACTIONS === 'true';
  // The account ID is not a secret, but it stays out of public logs.
  if (actions && cfg.accountId) process.stdout.write(`::add-mask::${cfg.accountId}\n`);
  let hb;
  if (!cfg.configured) {
    hb = { version: 1, at: new Date().toISOString(), run_id: runId, status: 'unconfigured', reason: `not configured yet: ${cfg.missing.join(', ')} not set (docs/OPERATIONS.md, "Off-site backup")`, missing: cfg.missing };
    if (actions) process.stdout.write(`::notice title=Off-site backup not configured::${hb.reason}\n`);
    say(`offsite: ${hb.reason}; nothing copied`);
  } else if (cfg.problems.length) {
    hb = { version: 1, at: new Date().toISOString(), run_id: runId, status: 'error', reason: cfg.problems.join('; ') };
    say(`offsite: ${hb.reason}`);
  } else {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !repo.includes('/')) {
      say('offsite: GITHUB_REPOSITORY is required (owner/name)');
      return 2;
    }
    const token = env.GITHUB_TOKEN;
    if (!token) {
      say('offsite: GITHUB_TOKEN is required');
      return 2;
    }
    let store;
    try {
      store = deps.store ?? (await (await import('./store-r2.mjs')).createR2Store(cfg));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const budget = new ApiBudget({
        sleep,
        families: { artifacts: { perHour: 600, perMinute: 60 }, actions: { perHour: 200, perMinute: 30 } },
        totalPerHour: 800,
        maxWaitMs: 120_000,
      });
      const gh = {
        client: createClient({ token, budget, sleep, userAgent: USER_AGENT }),
        release: createReleaseClient({ repo, token, sleep, log: say }),
        fetch: globalThis.fetch,
        sleep,
      };
      hb = await runBackup({ store, gh, repo, runId, limits: cfg.limits, sendSha256: cfg.sendSha256, log: say });
    } catch (err) {
      hb = { version: 1, at: new Date().toISOString(), run_id: runId, status: 'error', reason: String(err?.message ?? err).slice(0, 300) };
    } finally {
      store?.destroy?.();
    }
  }
  const text = scrubText(JSON.stringify(hb), secrets);
  hb = JSON.parse(text);
  if (env.OFFSITE_HEARTBEAT_FILE) {
    mkdirSync(dirname(env.OFFSITE_HEARTBEAT_FILE), { recursive: true });
    writeFileSync(env.OFFSITE_HEARTBEAT_FILE, `${text}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(hb));
  say(`offsite: ${hb.status}${hb.reason ? `: ${hb.reason}` : ''}`);
  if (actions && !['ok', 'unconfigured'].includes(hb.status)) process.stdout.write(`::error title=Off-site backup ${hb.status}::${String(hb.reason ?? '').replace(/[\r\n]+/g, ' ')}\n`);
  return hb.status === 'ok' || hb.status === 'unconfigured' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
