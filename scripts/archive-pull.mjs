#!/usr/bin/env node
// Copy history artifacts and sealed ingest outputs from GitHub Actions into a
// local archive folder.
//
//   node scripts/archive-pull.mjs --dest <folder> [--repo isokron-ai/tool-qa] [--dry-run]
//
// Workflow artifacts expire (history after 30 days, ingest outputs after 90),
// so this is meant to run regularly on a machine that keeps the archive
// (docs/OPERATIONS.md has a launchd example). It needs a token that can read
// Actions artifacts: GITHUB_TOKEN or GH_TOKEN, otherwise the GitHub CLI's
// `auth token`.
//
// Two kinds of artifact are pulled:
//   - history: names starting `history-` or `registry-`, stored in
//     `<dest>/<name>/`;
//   - ingest: names starting `ingest-` (the pump's sealed outputs,
//     `ingest-<run id>-<run attempt>`, and a manual re-ingest's
//     `ingest-<attempt id>`), stored still age-encrypted in
//     `<dest>/ingest/<YYYY-MM-DD>/<name>/` (the UTC day the artifact was made),
//     with one line per artifact in `<dest>/ingest/manifest.ndjson`: run id, run
//     attempt, and each file's name, size and sha256. Nothing is decrypted.
//
// For every such artifact that has not expired and is not in the index yet, it:
//   1. downloads it (the API answers with a redirect to storage; the token is
//      sent to the API only, never to the storage host);
//   2. checks the download against the artifact's sha256 digest when GitHub
//      gives one;
//   3. unpacks it in memory (an artifact uploaded with `archive: false` is one
//      file, not a zip) and checks every file listed in `manifest.json`
//      (`file`, `sha256`) and `manifest-*.json` (`files[].name`, `files[].sha256`);
//   4. writes it to a temporary folder, syncs every file and folder to disk,
//      then renames that to its place (or `<place>.<id>` if a different folder
//      already has that name);
//   5. appends a line to `<dest>/index.ndjson` (and, for ingest, to the
//      manifest).
// Nothing in the archive is ever overwritten or deleted. A history artifact
// that fails a check is not kept and not indexed; it is tried again on the next
// run, and the exit code is 1.
//
// An ingest artifact is the only copy of the loop's results, so a check that
// will fail the same way every time does not throw it away. Each file in it
// must be a non-empty `*.tar.age` file that starts like an age file, and must
// not be named `.artifact.json`. If any file fails (or the zip itself is
// damaged), the download is kept as it came, still encrypted, in
// `<dest>/quarantine/<id>-<name>.zip` with a `.reason.json` beside it; the files
// that pass are archived in the usual place; and the index and manifest mark
// the artifact `partial`, listing the refused files. It is then done, not
// retried. Only a download that cannot be trusted (digest or size mismatch) is
// tried again.
//
// `<dest>/.last-pull.json` keeps, per kind, the newest artifact time seen (held
// back to the oldest failure). The next run lists back to one hour before it,
// so artifacts that show up late are not missed; the index skips repeats. A
// kind with no cursor yet (ingest, in an archive made before it was pulled) is
// listed in full.
//
// One run at a time: a run holds the folder `<dest>/.lock` (made with mkdir)
// and leaves at once, with exit 0, if a live run holds it. A lock whose run has
// died (same host, pid gone) or that is older than 12 hours is taken over.
// Temporary `.partial-<id>-<pid>` folders left by a run that died are removed
// when the next run starts.
//
// From the command line, after a successful run it writes `<dest>/.last-ok.json`
// and sets the repository variable ARCHIVE_LAST_OK (JSON: `at`, an ISO time,
// and the run's counts) so the watchdog can tell the archive is alive. A failed
// run, a quarantined artifact, or no successful run for 24 hours shows a macOS
// notification. Neither happens on a dry run, nor when CI or GITHUB_ACTIONS is
// set; `--no-heartbeat` and `--no-notify` turn them off.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiBudget } from '../pump/budgets.mjs';
import { createClient } from '../pump/github.mjs';
import { readZip, readZipLenient } from './lib/unzip.mjs';

export const DEFAULT_REPO = 'isokron-ai/tool-qa';
export const KINDS = Object.freeze({
  history: Object.freeze(['history-', 'registry-']),
  ingest: Object.freeze(['ingest-']),
});
export const PREFIXES = Object.freeze(Object.values(KINDS).flat());
const OVERLAP_MS = 60 * 60_000;
// Pages of 100. A listing that reaches this without reaching its end or the
// cursor is incomplete: the cursor is not moved and the run exits 1.
export const MAX_LIST_PAGES = 500;
const MARKER = '.artifact.json';
const INDEX = 'index.ndjson';
const CURSOR = '.last-pull.json';
const INGEST_DIR = 'ingest';
const MANIFEST = join(INGEST_DIR, 'manifest.ndjson');
const QUARANTINE = 'quarantine';
const LOCK = '.lock';
const LAST_OK = '.last-ok.json';
export const LOCK_STALE_MS = 12 * 60 * 60_000;
export const STALE_OK_MS = 24 * 60 * 60_000;
export const HEARTBEAT_VARIABLE = 'ARCHIVE_LAST_OK';
const PARTIAL_RE = /^\.partial-(\d+)-(\d+)(?:\.[a-z.]+)?$/;
const AGE_BINARY = Buffer.from('age-encryption.org/v1\n');
const AGE_ARMOR = Buffer.from('-----BEGIN AGE ENCRYPTED FILE-----');
const USER_AGENT = 'isokron-tool-qa-archive';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** GITHUB_TOKEN, else GH_TOKEN, else the GitHub CLI's token, else null. */
export function resolveToken(env = process.env, run = spawnSync) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    const r = run('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15_000 });
    if (r && !r.error && r.status === 0) return String(r.stdout ?? '').trim() || null;
  } catch {
    // no CLI installed
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The kind of an artifact name: 'history', 'ingest' or null. */
export function kindOf(name) {
  for (const [kind, prefixes] of Object.entries(KINDS)) if (prefixes.some((p) => String(name).startsWith(p))) return kind;
  return null;
}

/** Lines of an ndjson file keyed by `key(line)`; a torn line is skipped. */
function readLines(file, key) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      out.set(Number(key(entry)), entry);
    } catch {
      // a torn last line from an interrupted run; the artifact is recovered by its folder
    }
  }
  return out;
}

/** Append one line, first ending a torn last line so the new one stays whole. */
function appendLine(file, entry) {
  let prefix = '';
  if (existsSync(file)) {
    const text = readFileSync(file);
    if (text.length && text[text.length - 1] !== 0x0a) prefix = '\n';
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`);
}

/** Per-kind cursors; an archive from before kinds holds the history cursor only. */
function readCursors(dest) {
  const c = readJson(join(dest, CURSOR));
  const valid = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  const out = {};
  for (const kind of Object.keys(KINDS)) out[kind] = valid(c?.by_kind?.[kind]);
  if (!c?.by_kind) out.history = valid(c?.last_created_at);
  return out;
}

/** Run id, run attempt and attempt id from an ingest artifact. */
export function ingestRun(artifact) {
  const runId = artifact.workflow_run?.id ?? null;
  const name = String(artifact.name);
  const m = /^ingest-(\d+)-(\d+)$/.exec(name);
  if (m && (runId === null || String(runId) === m[1])) return { run_id: Number(m[1]), run_attempt: Number(m[2]), attempt_id: null };
  const attempt = name.replace(/^ingest-/, '').replace(/\.tar\.age$/, '');
  return { run_id: runId, run_attempt: null, attempt_id: attempt || null };
}

const isAge = (data) =>
  (data.length >= AGE_BINARY.length && data.subarray(0, AGE_BINARY.length).equals(AGE_BINARY)) ||
  (data.length >= AGE_ARMOR.length && data.subarray(0, AGE_ARMOR.length).equals(AGE_ARMOR));

/** The manifest line for one archived ingest artifact. */
function manifestLine(marker, dir) {
  const { run_id, run_attempt, attempt_id } = ingestRun(marker);
  return {
    artifact_id: marker.id,
    artifact: marker.name,
    run_id,
    run_attempt,
    attempt_id,
    created_at: marker.created_at,
    date: String(marker.created_at).slice(0, 10),
    dir,
    artifact_bytes: marker.size_in_bytes,
    artifact_sha256: marker.zip_sha256,
    files: marker.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    ...(marker.partial
      ? { partial: true, problems: marker.problems ?? [], refused: marker.refused ?? [], quarantine: marker.quarantine ?? null }
      : {}),
  };
}

/** Why one file of an ingest artifact cannot be archived as a sealed output, or null. */
export function ingestEntryProblem(entry) {
  const base = entry.name.split('/').pop();
  if (base === MARKER) return `${MARKER} is a reserved name`;
  if (!base.endsWith('.tar.age')) return 'not a .tar.age file';
  if (!entry.data.length) return 'empty file';
  if (!isAge(entry.data)) return 'not an age-encrypted file';
  return null;
}

/**
 * Check every file the artifact's manifests list.
 * @returns {{ verified: 'manifest'|'none', problems: string[] }}
 */
export function verifyEntries(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const problems = [];
  let manifests = 0;
  const check = (where, file, expected) => {
    if (typeof file !== 'string' || !/^[0-9a-f]{64}$/.test(String(expected))) {
      problems.push(`${where}: an entry has no file name or sha256`);
      return;
    }
    const e = byName.get(file);
    if (!e) problems.push(`${where}: ${file} is missing`);
    else if (sha256(e.data) !== expected) problems.push(`${where}: sha256 of ${file} does not match`);
  };
  for (const e of entries) {
    const base = e.name.split('/').pop();
    if (base !== 'manifest.json' && !/^manifest-.+\.json$/.test(base)) continue;
    manifests += 1;
    const folder = e.name.slice(0, e.name.length - base.length);
    let m;
    try {
      m = JSON.parse(e.data.toString('utf8'));
    } catch {
      problems.push(`${e.name} is not valid JSON`);
      continue;
    }
    if (m && (typeof m.file === 'string' || m.sha256 !== undefined)) check(e.name, `${folder}${m.file}`, m.sha256);
    if (Array.isArray(m?.files)) for (const f of m.files) check(e.name, `${folder}${f?.name}`, f?.sha256);
  }
  return { verified: manifests ? 'manifest' : 'none', problems };
}

const folderName = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');

/** The folder of an artifact, relative to the archive. */
function baseDir(artifact) {
  if (kindOf(artifact.name) !== 'ingest') return folderName(artifact.name);
  // Date.parse first: new Date(NaN).toISOString() throws its own RangeError.
  const t = Date.parse(artifact.created_at);
  if (!Number.isFinite(t)) throw new Error(`created_at ${JSON.stringify(artifact.created_at)} is not a date`);
  return join(INGEST_DIR, new Date(t).toISOString().slice(0, 10), folderName(artifact.name));
}

/** Problems with a folder that carries our marker: each file it lists must be there with its size and sha256. */
function checkFolder(path, marker) {
  if (!Array.isArray(marker.files)) return ['its marker lists no files'];
  const problems = [];
  for (const f of marker.files) {
    if (!f || typeof f.name !== 'string' || !safeName(f.name)) {
      problems.push('its marker lists an unsafe file name');
      continue;
    }
    let data;
    try {
      data = readFileSync(join(path, ...f.name.split('/')));
    } catch {
      problems.push(`${f.name} is missing`);
      continue;
    }
    if (data.length !== f.bytes || sha256(data) !== f.sha256) problems.push(`${f.name} does not match its sha256`);
  }
  return problems;
}

const safeName = (name) => name && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && name.split('/').every((p) => p && p !== '..' && p !== '.');

/**
 * Where an artifact goes: { dir, recovered } or throws if both names are taken.
 * A folder with this artifact's marker is trusted only if every file it lists
 * still has its sha256; otherwise it is left alone and the next name is used.
 */
function placeFor(dest, artifact, log = () => {}) {
  const base = baseDir(artifact);
  for (const dir of [base, `${base}.${artifact.id}`]) {
    const path = join(dest, dir);
    if (!existsSync(path)) return { dir, recovered: null };
    const marker = readJson(join(path, MARKER));
    if (!marker || Number(marker.id) !== Number(artifact.id)) continue;
    const problems = checkFolder(path, marker);
    if (!problems.length) return { dir, recovered: marker };
    log(`archive-pull: ${artifact.name}: ${dir} from an earlier run does not check out (${problems.slice(0, 3).join('; ')}); left as it is`);
  }
  throw new Error(`folders ${base} and ${base}.${artifact.id} already exist and hold other data; not overwriting`);
}

/** Write a file and sync it to disk before closing it. */
function writeDurable(path, data, fsync) {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, data);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Sync a folder's entries to disk; a platform that cannot open a folder skips it. */
function syncDir(path, fsync) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (['EISDIR', 'EPERM', 'EACCES'].includes(err?.code)) return;
    throw err;
  }
  try {
    fsync(fd);
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(err?.code)) throw err;
  } finally {
    closeSync(fd);
  }
}

function writeFolder(dest, dir, entries, marker, fsync = fsyncSync) {
  const final = join(dest, dir);
  const temp = join(dest, `.partial-${marker.id}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    const dirs = new Set([temp]);
    for (const e of entries) {
      const path = join(temp, ...e.name.split('/'));
      for (let d = dirname(path); d.length > temp.length; d = dirname(d)) dirs.add(d);
      mkdirSync(dirname(path), { recursive: true });
      writeDurable(path, e.data, fsync);
    }
    writeDurable(join(temp, MARKER), `${JSON.stringify(marker, null, 2)}\n`, fsync);
    // Deepest first, so each folder's entry is on disk before its parent's.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) syncDir(d, fsync);
    if (existsSync(final)) throw new Error(`${dir} appeared while writing; not overwriting it`);
    mkdirSync(dirname(final), { recursive: true });
    renameSync(temp, final);
    syncDir(dirname(final), fsync);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Keep a download that failed its checks as it came, with the reasons beside
 * it. Returns its path relative to the archive. An earlier copy with the same
 * sha256 (a run that died before indexing) is reused; one that differs is kept
 * and this one gets its own name.
 */
function writeQuarantine(dest, artifact, data, isZip, reason, fsync = fsyncSync) {
  const qdir = join(dest, QUARANTINE);
  mkdirSync(qdir, { recursive: true });
  const stem = `${artifact.id}-${folderName(artifact.name)}`;
  const ext = isZip ? '.zip' : '.download';
  const digest = sha256(data);
  for (const name of [`${stem}${ext}`, `${stem}.${digest.slice(0, 12)}${ext}`]) {
    const file = join(qdir, name);
    if (existsSync(file)) {
      if (sha256(readFileSync(file)) === digest) return join(QUARANTINE, name);
      continue;
    }
    const reasonFile = file.slice(0, -ext.length) + '.reason.json';
    const tempData = join(qdir, `.partial-${artifact.id}-${process.pid}${ext}`);
    const tempReason = join(qdir, `.partial-${artifact.id}-${process.pid}.reason.json`);
    rmSync(tempData, { force: true });
    rmSync(tempReason, { force: true });
    writeDurable(tempData, data, fsync);
    writeDurable(tempReason, `${JSON.stringify(reason, null, 2)}\n`, fsync);
    // The reason first: a quarantined download is never without one.
    if (!existsSync(reasonFile)) renameSync(tempReason, reasonFile);
    else rmSync(tempReason, { force: true });
    renameSync(tempData, file);
    syncDir(qdir, fsync);
    return join(QUARANTINE, name);
  }
  throw new Error(`quarantine names for ${stem} are taken by other downloads; not overwriting`);
}

// ---- one run at a time ----

/** True if a process with this pid exists (EPERM: it does, as another user). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const heldLocks = new Set();

/**
 * Take `<dest>/.lock`. Returns { release } or { holder } when a live run holds
 * it. A lock from a dead pid on this host, or older than LOCK_STALE_MS, is
 * taken over.
 */
export function acquireLock(dest, { now = Date.now, alive = pidAlive, pid = process.pid, host = hostname(), log = () => {} } = {}) {
  const dir = join(dest, LOCK);
  const owner = join(dir, 'owner.json');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const holder = readJson(owner);
      let started = Date.parse(holder?.started_at);
      if (!Number.isFinite(started)) {
        try {
          started = statSync(dir).mtimeMs;
        } catch {
          continue; // released just now
        }
      }
      const age = now() - started;
      // A lock with no owner file yet may be one being taken right now.
      const dead = holder ? holder.host === host && !alive(Number(holder.pid)) : age > 60_000;
      if (!dead && age <= LOCK_STALE_MS) return { holder: holder ?? { pid: null, started_at: new Date(started).toISOString() } };
      log(`archive-pull: taking over a stale lock (pid ${holder?.pid ?? '?'} on ${holder?.host ?? '?'}, ${Math.round(age / 60_000)} min old)`);
      const aside = join(dest, `${LOCK}.stale-${pid}-${attempt}`);
      try {
        renameSync(dir, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // another run took it over first; try again
      }
      continue;
    }
    writeFileSync(owner, `${JSON.stringify({ pid, host, started_at: new Date(now()).toISOString() })}\n`);
    const lock = {
      release() {
        heldLocks.delete(lock);
        const h = readJson(owner);
        if (h && Number(h.pid) === pid && h.host === host) rmSync(dir, { recursive: true, force: true });
      },
    };
    heldLocks.add(lock);
    return lock;
  }
  return { holder: readJson(owner) ?? { pid: null } };
}

/** Release every lock this process holds (for a signal handler). */
export function releaseAllLocks() {
  for (const lock of [...heldLocks]) lock.release();
}

/** Remove `.partial-<id>-<pid>` leftovers from runs that died. Returns the names removed. */
export function cleanPartials(dest, { alive = pidAlive, pid = process.pid } = {}) {
  const removed = [];
  for (const dir of [dest, join(dest, QUARANTINE)]) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = PARTIAL_RE.exec(name);
      if (!m || Number(m[2]) === pid || alive(Number(m[2]))) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      removed.push(dir === dest ? name : join(QUARANTINE, name));
    }
  }
  return removed;
}

/** @returns {Promise<{ items: object[], complete: boolean }>} */
async function listArtifacts(client, repo, since, maxPages) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.request('GET', `/repos/${repo}/actions/artifacts`, { query: { per_page: 100, page } });
    const batch = res.data?.artifacts ?? [];
    items.push(...batch);
    if (batch.length < 100) return { items, complete: true };
    if (since !== null && batch.every((a) => Date.parse(a.created_at) < since)) return { items, complete: true };
  }
  return { items, complete: false };
}

async function download(client, fetch, repo, artifact, sleep) {
  const res = await client.request('GET', `/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !location) throw new Error(`expected a redirect to the archive, got HTTP ${res.status}`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // A plain request: the signed storage link must not get the API token.
      const r = await fetch(location, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      lastError = new Error(`archive download returned HTTP ${r.status}`);
      if (r.status < 500) break;
    } catch (err) {
      lastError = new Error(`archive download failed: ${err?.message ?? err}`);
    }
    await sleep(1000 * attempt);
  }
  throw lastError;
}

/**
 * @returns {Promise<{ listed: number, pulled: string[], recovered: string[], already: number,
 *   quarantined: {name: string, id: number, kept: number, refused: number, path: string, problems: string[]}[],
 *   failed: {name: string, id: number, error: string}[], wouldPull: string[], cursor: string|null,
 *   locked: object|null }>}
 */
export async function archivePull({
  dest,
  repo = DEFAULT_REPO,
  token,
  fetch = globalThis.fetch,
  apiUrl,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => process.stderr.write(`${line}\n`),
  dryRun = false,
  budget: budgetFor,
  maxPages = MAX_LIST_PAGES,
  alive = pidAlive,
  zipLimits = {},
  fsync = fsyncSync,
} = {}) {
  if (!dest) throw new Error('--dest is required');
  if (!token) throw new Error('no token: set GITHUB_TOKEN or GH_TOKEN, or sign in with the GitHub CLI');
  const previous = readCursors(dest);
  const out = {
    listed: 0,
    complete: true,
    pulled: [],
    recovered: [],
    already: 0,
    quarantined: [],
    failed: [],
    wouldPull: [],
    bytes: 0,
    cursor: previous.history,
    cursors: { ...previous },
    locked: null,
  };
  let lock = null;
  if (!dryRun) {
    mkdirSync(dest, { recursive: true });
    lock = acquireLock(dest, { now, alive, log });
    if (lock.holder) {
      out.locked = lock.holder;
      log(`archive-pull: another pull holds ${join(dest, LOCK)} (pid ${lock.holder.pid ?? '?'}, since ${lock.holder.started_at ?? '?'}); nothing done`);
      return out;
    }
  }
  try {
    if (!dryRun) {
      const removed = cleanPartials(dest, { alive });
      if (removed.length) log(`archive-pull: removed ${removed.length} temporary folder(s) left by a run that died: ${removed.join(', ')}`);
    }
    await pullAll({ dest, repo, token, fetch, apiUrl, now, sleep, log, dryRun, budgetFor, maxPages, zipLimits, fsync, previous, out });
    return out;
  } finally {
    lock?.release();
  }
}

async function pullAll({ dest, repo, token, fetch, apiUrl, now, sleep, log, dryRun, budgetFor, maxPages, zipLimits, fsync, previous, out }) {
  // This runs on its own machine with its own token, not inside the loop, so a
  // long backlog may use more calls than the pump's caps allow. It waits for the
  // hourly cap rather than giving up; GitHub's own limits are still honoured.
  const budget = budgetFor ?? new ApiBudget({
    now,
    sleep,
    families: { artifacts: { perHour: 2000, perMinute: 60 } },
    totalPerHour: 2500,
    maxWaitMs: 65 * 60_000,
  });
  const client = createClient({ token, fetch, apiUrl, now, sleep, budget, userAgent: USER_AGENT });
  const sinceOf = (kind) => (previous[kind] ? Date.parse(previous[kind]) - OVERLAP_MS : null);
  // List back to the oldest cursor; a kind without one needs the whole list.
  const sinces = Object.keys(KINDS).map(sinceOf);
  const since = sinces.includes(null) ? null : Math.min(...sinces);
  const indexed = readLines(join(dest, INDEX), (e) => e.id);
  const manifested = readLines(join(dest, MANIFEST), (e) => e.artifact_id);

  const listing = await listArtifacts(client, repo, since, maxPages);
  const listed = listing.items;
  // The list can repeat an artifact across pages when new ones arrive while it is read.
  const seen = new Set();
  const wanted = listed
    .filter((a) => kindOf(a.name) && !a.expired)
    .filter((a) => {
      const s = sinceOf(kindOf(a.name));
      return s === null || Date.parse(a.created_at) >= s;
    })
    .filter((a) => !seen.has(Number(a.id)) && seen.add(Number(a.id)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  out.listed = listed.length;
  out.complete = listing.complete;

  if (!listing.complete) log(`archive-pull: the artifact list did not end within ${maxPages} pages; older artifacts were not seen and the cursor stays where it was`);
  const record = (entry) => {
    appendLine(join(dest, INDEX), entry);
    indexed.set(Number(entry.id), entry);
  };
  // An ingest artifact's manifest line; written once, also after a crash between the index and the manifest.
  const manifest = (marker, dir) => {
    if (kindOf(marker.name) !== 'ingest' || manifested.has(Number(marker.id))) return;
    appendLine(join(dest, MANIFEST), manifestLine(marker, dir));
    manifested.set(Number(marker.id), true);
  };
  for (const a of wanted) {
    const known = indexed.get(Number(a.id));
    if (known) {
      out.already += 1;
      if (!dryRun && known.files && (known.dir || known.partial)) manifest(known, known.dir ?? null);
      continue;
    }
    try {
      const place = placeFor(dest, a, log);
      if (place.recovered) {
        if (!dryRun) {
          record({ ...place.recovered, dir: place.dir });
          manifest(place.recovered, place.dir);
        }
        out.recovered.push(a.name);
        log(`archive-pull: ${a.name}: found in ${place.dir} from an earlier run, every file checked; indexed`);
        continue;
      }
      if (dryRun) {
        out.wouldPull.push(a.name);
        out.bytes += Number(a.size_in_bytes) || 0;
        log(`archive-pull: would pull ${a.name} (${a.size_in_bytes ?? '?'} bytes) into ${place.dir}`);
        continue;
      }
      const zip = await download(client, fetch, repo, a, sleep);
      const zipSha = sha256(zip);
      const digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''));
      if (digest && digest[1] !== zipSha) throw new Error(`zip sha256 ${zipSha} does not match the artifact digest ${digest[1]}`);
      const isZip = zip.length >= 4 && zip[0] === 0x50 && zip[1] === 0x4b && (zip[2] === 3 || zip[2] === 5);
      const base = {
        id: a.id,
        name: a.name,
        created_at: a.created_at,
        workflow_run: a.workflow_run ? { id: a.workflow_run.id ?? null, head_sha: a.workflow_run.head_sha ?? null } : null,
        size_in_bytes: a.size_in_bytes ?? zip.length,
        zip_sha256: zipSha,
        digest_checked: Boolean(digest),
        pulled_at: new Date(now()).toISOString(),
      };
      const fileList = (entries) => entries.map((e) => ({ name: e.name, bytes: e.data.length, sha256: sha256(e.data) }));

      if (kindOf(a.name) === 'ingest') {
        const sorted = sortIngest(zip, isZip, a, zipLimits);
        if (!sorted.problems.length) {
          const marker = { ...base, verified: 'none', files: fileList(sorted.kept) };
          writeFolder(dest, place.dir, sorted.kept, marker, fsync);
          record({ ...marker, dir: place.dir });
          manifest(marker, place.dir);
          out.pulled.push(a.name);
          out.bytes += zip.length;
          log(`archive-pull: ${a.name}: ${sorted.kept.length} files into ${place.dir} (sealed${digest ? ', digest checked' : ', no digest to check'})`);
          continue;
        }
        // A check failed. Unless the download itself is in doubt, it will fail the same way every
        // time: keep the download and the files that pass, and mark the artifact partial.
        const declared = Number(a.size_in_bytes);
        if (!digest && Number.isFinite(declared) && declared !== zip.length) {
          throw new Error(`downloaded ${zip.length} bytes but the artifact is ${declared}, and there is no digest to check; tried again next run (${sorted.problems.slice(0, 3).join('; ')})`);
        }
        const marker = {
          ...base,
          verified: 'none',
          partial: true,
          problems: sorted.problems,
          refused: sorted.refused,
          quarantine: null,
          files: fileList(sorted.kept),
        };
        marker.quarantine = writeQuarantine(dest, a, zip, isZip, {
          artifact_id: a.id,
          artifact: a.name,
          created_at: a.created_at,
          workflow_run: base.workflow_run,
          bytes: zip.length,
          sha256: zipSha,
          digest_checked: Boolean(digest),
          quarantined_at: base.pulled_at,
          problems: sorted.problems,
          refused: sorted.refused,
          kept: marker.files.map((f) => f.name),
          kept_in: sorted.kept.length ? place.dir : null,
          note: 'The download as it came, still encrypted. Nothing in it was decrypted.',
        }, fsync);
        const dir = sorted.kept.length ? place.dir : null;
        if (dir) writeFolder(dest, dir, sorted.kept, marker, fsync);
        record({ ...marker, dir });
        manifest(marker, dir);
        out.quarantined.push({ name: a.name, id: a.id, kept: sorted.kept.length, refused: sorted.refused.length, path: marker.quarantine, problems: sorted.problems });
        out.bytes += zip.length;
        log(`archive-pull: ${a.name}: QUARANTINED in ${marker.quarantine} (${sorted.problems.slice(0, 5).join('; ')}); ${sorted.kept.length} sealed file(s) kept${dir ? ` in ${dir}` : ''}, marked partial`);
        continue;
      }

      const entries = isZip ? readZip(zip, zipLimits) : [{ name: folderName(a.name), data: zip }];
      const { verified, problems } = verifyEntries(entries);
      if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
      const marker = { ...base, verified, files: fileList(entries) };
      writeFolder(dest, place.dir, entries, marker, fsync);
      record({ ...marker, dir: place.dir });
      out.pulled.push(a.name);
      out.bytes += zip.length;
      log(`archive-pull: ${a.name}: ${entries.length} files into ${place.dir}${verified === 'none' ? ' (no manifest to check against)' : ''}`);
    } catch (err) {
      out.failed.push({ name: a.name, id: a.id, error: String(err?.message ?? err) });
      log(`archive-pull: ${a.name}: FAILED: ${err?.message ?? err}`);
    }
  }

  if (!dryRun) {
    const cursors = {};
    for (const kind of Object.keys(KINDS)) {
      const mine = wanted.filter((a) => kindOf(a.name) === kind);
      // An incomplete listing missed older artifacts: keep the cursor so a later run still looks for them.
      const isTime = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t));
      let cursor = listing.complete ? ([previous[kind], ...mine.map((a) => a.created_at)].filter(isTime).sort().at(-1) ?? null) : previous[kind];
      const firstFailure = out.failed.map((f) => mine.find((a) => a.id === f.id)?.created_at).filter(isTime).sort()[0];
      if (firstFailure && (!cursor || firstFailure < cursor)) cursor = firstFailure;
      cursors[kind] = cursor;
    }
    if (Object.values(cursors).some(Boolean)) {
      // last_created_at is the history cursor, as earlier versions wrote it.
      const body = { last_created_at: cursors.history, by_kind: cursors, updated: new Date(now()).toISOString() };
      writeFileSync(join(dest, CURSOR), `${JSON.stringify(body)}\n`);
    }
    out.cursors = cursors;
    out.cursor = cursors.history;
  }
}

/**
 * Split an ingest download into the sealed files that can be archived and the
 * ones that cannot. problems is empty when every file passed.
 */
function sortIngest(zip, isZip, artifact, zipLimits) {
  const problems = [];
  const refused = [];
  let entries = [];
  if (isZip) {
    try {
      const r = readZipLenient(zip, zipLimits);
      entries = r.entries;
      for (const x of r.refused) refused.push({ name: x.name, bytes: null, sha256: null, reason: x.reason });
    } catch (err) {
      problems.push(`the zip cannot be read: ${err?.message ?? err}`);
    }
  } else {
    entries = [{ name: folderName(artifact.name), data: zip }];
  }
  const kept = [];
  const names = new Set();
  for (const e of entries) {
    let reason = ingestEntryProblem(e);
    if (!reason && names.has(e.name)) reason = 'a second file with this name';
    if (!reason && [...names].some((n) => n.startsWith(`${e.name}/`) || e.name.startsWith(`${n}/`))) reason = 'its name clashes with a folder of another file';
    if (reason) refused.push({ name: e.name, bytes: e.data.length, sha256: sha256(e.data), reason });
    else {
      kept.push(e);
      names.add(e.name);
    }
  }
  for (const r of refused) problems.push(`${r.name}: ${r.reason}`);
  if (!problems.length && !kept.length) problems.push('the artifact holds no files');
  return { kept, refused, problems };
}

// ---- alerts ----

const escapeless = (text) => String(text).replace(/[\u0000-\u001f]/g, ' ').slice(0, 220);

/** Notifications show only on a Mac, and never in CI. */
export function canNotify(env = process.env, platform = process.platform) {
  return platform === 'darwin' && !env.CI && !env.GITHUB_ACTIONS && env.ARCHIVE_PULL_NOTIFY !== '0';
}

/**
 * A macOS notification through osascript. The text goes in as arguments, not
 * as script source, so nothing in it is run.
 */
export function notifyMac(message, { env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (!canNotify(env, platform)) return false;
  try {
    const r = run('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e', 'end run',
      escapeless(message), 'tool-qa archive',
    ], { timeout: 10_000, stdio: 'ignore' });
    return Boolean(r && !r.error && r.status === 0);
  } catch {
    return false;
  }
}

/** Set the repository variable the watchdog reads: PATCH, or POST if it does not exist yet. */
export async function setHeartbeat({ repo, token, fetch = globalThis.fetch, apiUrl, now = Date.now, sleep, value, name = HEARTBEAT_VARIABLE }) {
  const client = createClient({ token, fetch, apiUrl, now, sleep, userAgent: USER_AGENT });
  const body = { name, value };
  const res = await client.request('PATCH', `/repos/${repo}/actions/variables/${name}`, { body, allow: [404] });
  if (res.status !== 404) return 'updated';
  const made = await client.request('POST', `/repos/${repo}/actions/variables`, { body, allow: [409] });
  if (made.status !== 409) return 'created';
  await client.request('PATCH', `/repos/${repo}/actions/variables/${name}`, { body });
  return 'updated';
}

function parseArgs(argv) {
  const opts = { dest: undefined, repo: DEFAULT_REPO, dryRun: false, heartbeat: true, notify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dest' && argv[i + 1] !== undefined) opts.dest = argv[++i];
    else if (a === '--repo' && argv[i + 1] !== undefined) opts.repo = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-heartbeat') opts.heartbeat = false;
    else if (a === '--no-notify') opts.notify = false;
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  if (!opts.dest) throw new Error('--dest <folder> is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new Error('--repo must be owner/name');
  return opts;
}

/** The last successful run recorded in the archive, as a time in ms, or null. */
function lastOk(dest) {
  const t = Date.parse(readJson(join(dest, LAST_OK))?.at);
  return Number.isFinite(t) ? t : null;
}

/**
 * `deps` lets tests pass fetch, a clock, a token, `notify(message)` and `env`.
 * Exit codes: 0 done (or another run holds the lock), 1 something failed, 2 bad
 * arguments or no token.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? Date.now;
  const ci = Boolean(env.CI || env.GITHUB_ACTIONS);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`archive-pull: ${err.message}`);
    return 2;
  }
  const notifyFn = deps.notify ?? ((message) => notifyMac(message, { env }));
  const alerts = [];
  // A failed run also says how long it has been since the last good one.
  const finish = (code, problem) => {
    if (opts.dryRun || !opts.notify) return code;
    if (problem) alerts.unshift(problem);
    const last = lastOk(opts.dest);
    if (code !== 0 && last !== null && now() - last > STALE_OK_MS) alerts.push(`No successful pull since ${new Date(last).toISOString()}.`);
    if (alerts.length) {
      try {
        notifyFn(alerts.join(' '));
      } catch {
        // a notification is best effort
      }
    }
    return code;
  };
  const token = deps.token ?? resolveToken(env);
  if (!token) {
    log('archive-pull: no token: set GITHUB_TOKEN or GH_TOKEN, or sign in with the GitHub CLI');
    return finish(2, 'Archive pull failed: no GitHub token.');
  }
  let out;
  try {
    out = await archivePull({ ...deps, log, token, dest: opts.dest, repo: opts.repo, dryRun: opts.dryRun });
  } catch (err) {
    log(`archive-pull: ${err?.message ?? err}`);
    return finish(1, `Archive pull failed: ${err?.message ?? err}`);
  }
  if (out.locked) {
    // Not a failure; but if the holder never finishes, say so once it has been a day.
    const last = lastOk(opts.dest);
    if (!opts.dryRun && last !== null && now() - last > STALE_OK_MS) {
      return finish(0, `Archive pull is locked by pid ${out.locked.pid ?? '?'} and has not succeeded since ${new Date(last).toISOString()}.`);
    }
    return 0;
  }
  log(`archive-pull: ${opts.dryRun ? `would pull ${out.wouldPull.length}` : `pulled ${out.pulled.length}`} (${out.bytes} bytes), recovered ${out.recovered.length}, quarantined ${out.quarantined.length}, already had ${out.already}, failed ${out.failed.length}${out.complete ? '' : ', list incomplete'}`);
  if (opts.dryRun) return out.failed.length || !out.complete ? 1 : 0;
  if (out.quarantined.length) {
    alerts.push(`${out.quarantined.length} ingest artifact(s) quarantined in ${join(opts.dest, QUARANTINE)}: ${out.quarantined.map((q) => q.name).join(', ')}.`);
  }
  if (out.failed.length || !out.complete) {
    const first = out.failed[0];
    return finish(1, `Archive pull failed: ${out.failed.length} artifact(s)${first ? ` (${first.name}: ${first.error})` : ''}${out.complete ? '' : '; the artifact list was cut off'}.`);
  }
  const counts = {
    at: new Date(now()).toISOString(),
    pulled: out.pulled.length,
    recovered: out.recovered.length,
    quarantined: out.quarantined.length,
    already: out.already,
    failed: 0,
    listed: out.listed,
  };
  writeFileSync(join(opts.dest, LAST_OK), `${JSON.stringify(counts)}\n`);
  if (opts.heartbeat && !ci) {
    try {
      const how = await setHeartbeat({ repo: opts.repo, token, fetch: deps.fetch, apiUrl: deps.apiUrl, now, sleep: deps.sleep, value: JSON.stringify(counts) });
      log(`archive-pull: heartbeat ${HEARTBEAT_VARIABLE} ${how} on ${opts.repo}`);
    } catch (err) {
      log(`archive-pull: could not set the heartbeat variable ${HEARTBEAT_VARIABLE}: ${err?.message ?? err}`);
      alerts.push(`Archive pull worked, but the heartbeat variable ${HEARTBEAT_VARIABLE} could not be set: ${err?.message ?? err}`);
    }
  }
  return finish(0, null);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      releaseAllLocks();
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]);
    });
  }
  process.exitCode = await main();
}
