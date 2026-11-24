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
//     attempt, and each file's name, size and sha256. Nothing is decrypted;
//     every file must be an age file, or the artifact is refused.
//
// For every such artifact that has not expired and is not in the index yet, it:
//   1. downloads it (the API answers with a redirect to storage; the token is
//      sent to the API only, never to the storage host);
//   2. checks the download against the artifact's sha256 digest when GitHub
//      gives one;
//   3. unpacks it in memory (an artifact uploaded with `archive: false` is one
//      file, not a zip) and checks every file listed in `manifest.json`
//      (`file`, `sha256`) and `manifest-*.json` (`files[].name`, `files[].sha256`);
//   4. writes it to a temporary folder, then renames that to its place
//      (or `<place>.<id>` if a different folder already has that name);
//   5. appends a line to `<dest>/index.ndjson` (and, for ingest, to the
//      manifest).
// Nothing in the archive is ever overwritten or deleted. An artifact that fails
// a check is not kept and not indexed; it is tried again on the next run, and
// the exit code is 1.
//
// `<dest>/.last-pull.json` keeps, per kind, the newest artifact time seen (held
// back to the oldest failure). The next run lists back to one hour before it,
// so artifacts that show up late are not missed; the index skips repeats. A
// kind with no cursor yet (ingest, in an archive made before it was pulled) is
// listed in full.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiBudget } from '../pump/budgets.mjs';
import { createClient } from '../pump/github.mjs';
import { readZip } from './lib/unzip.mjs';

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
  };
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
  const day = /^\d{4}-\d{2}-\d{2}/.exec(new Date(Date.parse(artifact.created_at)).toISOString())?.[0];
  if (!day) throw new Error(`created_at ${JSON.stringify(artifact.created_at)} is not a date`);
  return join(INGEST_DIR, day, folderName(artifact.name));
}

/** Where an artifact goes: { dir, recovered } or throws if both names are taken. */
function placeFor(dest, artifact) {
  const base = baseDir(artifact);
  for (const dir of [base, `${base}.${artifact.id}`]) {
    const path = join(dest, dir);
    if (!existsSync(path)) return { dir, recovered: null };
    const marker = readJson(join(path, MARKER));
    if (marker && Number(marker.id) === Number(artifact.id)) return { dir, recovered: marker };
  }
  throw new Error(`folders ${base} and ${base}.${artifact.id} already exist and hold other data; not overwriting`);
}

function writeFolder(dest, dir, entries, marker) {
  const final = join(dest, dir);
  const temp = join(dest, `.partial-${marker.id}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    for (const e of entries) {
      const path = join(temp, ...e.name.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, e.data, { flag: 'wx' });
    }
    writeFileSync(join(temp, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    if (existsSync(final)) throw new Error(`${dir} appeared while writing; not overwriting it`);
    mkdirSync(dirname(final), { recursive: true });
    renameSync(temp, final);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
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

/** The files of a download: a zip's entries, or the one file of an unzipped artifact. */
function unpack(data, artifact) {
  const zip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 3 || data[2] === 5);
  return zip ? readZip(data) : [{ name: folderName(artifact.name), data }];
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
 *   failed: {name: string, id: number, error: string}[], wouldPull: string[], cursor: string|null }>}
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
} = {}) {
  if (!dest) throw new Error('--dest is required');
  if (!token) throw new Error('no token: set GITHUB_TOKEN or GH_TOKEN, or sign in with the GitHub CLI');
  if (!dryRun) mkdirSync(dest, { recursive: true });
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
  const previous = readCursors(dest);
  const sinceOf = (kind) => (previous[kind] ? Date.parse(previous[kind]) - OVERLAP_MS : null);
  // List back to the oldest cursor; a kind without one needs the whole list.
  const sinces = Object.keys(KINDS).map(sinceOf);
  const since = sinces.includes(null) ? null : Math.min(...sinces);
  const indexed = readLines(join(dest, INDEX), (e) => e.id);
  const manifested = readLines(join(dest, MANIFEST), (e) => e.artifact_id);

  const listing = await listArtifacts(client, repo, since, maxPages);
  const listed = listing.items;
  const wanted = listed
    .filter((a) => kindOf(a.name) && !a.expired)
    .filter((a) => {
      const s = sinceOf(kindOf(a.name));
      return s === null || Date.parse(a.created_at) >= s;
    })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);

  const out = {
    listed: listed.length,
    complete: listing.complete,
    pulled: [],
    recovered: [],
    already: 0,
    failed: [],
    wouldPull: [],
    bytes: 0,
    cursor: previous.history,
    cursors: { ...previous },
  };
  if (!listing.complete) log(`archive-pull: the artifact list did not end within ${maxPages} pages; older artifacts were not seen and the cursor stays where it was`);
  const record = (entry) => appendLine(join(dest, INDEX), entry);
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
      if (!dryRun && known.files && known.dir) manifest(known, known.dir);
      continue;
    }
    try {
      const place = placeFor(dest, a);
      if (place.recovered) {
        if (!dryRun) {
          record({ ...place.recovered, dir: place.dir });
          manifest(place.recovered, place.dir);
        }
        out.recovered.push(a.name);
        log(`archive-pull: ${a.name}: found in ${place.dir} from an earlier run; indexed`);
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
      const entries = unpack(zip, a);
      const { verified, problems } = verifyEntries(entries);
      if (kindOf(a.name) === 'ingest') {
        if (!entries.length) problems.push('the artifact holds no files');
        for (const e of entries) if (!isAge(e.data)) problems.push(`${e.name} is not an age-encrypted file; ingest outputs are archived sealed only`);
      }
      if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
      const marker = {
        id: a.id,
        name: a.name,
        created_at: a.created_at,
        workflow_run: a.workflow_run ? { id: a.workflow_run.id ?? null, head_sha: a.workflow_run.head_sha ?? null } : null,
        size_in_bytes: a.size_in_bytes ?? zip.length,
        zip_sha256: zipSha,
        digest_checked: Boolean(digest),
        pulled_at: new Date(now()).toISOString(),
        verified,
        files: entries.map((e) => ({ name: e.name, bytes: e.data.length, sha256: sha256(e.data) })),
      };
      writeFolder(dest, place.dir, entries, marker);
      record({ ...marker, dir: place.dir });
      manifest(marker, place.dir);
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
      let cursor = listing.complete ? ([previous[kind], ...mine.map((a) => a.created_at)].filter(Boolean).sort().at(-1) ?? null) : previous[kind];
      const firstFailure = out.failed.map((f) => mine.find((a) => a.id === f.id)?.created_at).filter(Boolean).sort()[0];
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
  return out;
}

function parseArgs(argv) {
  const opts = { dest: undefined, repo: DEFAULT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dest' && argv[i + 1] !== undefined) opts.dest = argv[++i];
    else if (a === '--repo' && argv[i + 1] !== undefined) opts.repo = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  if (!opts.dest) throw new Error('--dest <folder> is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new Error('--repo must be owner/name');
  return opts;
}

/** `deps` lets tests pass fetch, a clock and a token. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`archive-pull: ${err.message}`);
    return 2;
  }
  const token = deps.token ?? resolveToken(env);
  if (!token) {
    log('archive-pull: no token: set GITHUB_TOKEN or GH_TOKEN, or sign in with the GitHub CLI');
    return 2;
  }
  try {
    const out = await archivePull({ ...deps, log, token, dest: opts.dest, repo: opts.repo, dryRun: opts.dryRun });
    log(`archive-pull: ${opts.dryRun ? `would pull ${out.wouldPull.length}` : `pulled ${out.pulled.length}`} (${out.bytes} bytes), recovered ${out.recovered.length}, already had ${out.already}, failed ${out.failed.length}${out.complete ? '' : ', list incomplete'}`);
    return out.failed.length || !out.complete ? 1 : 0;
  } catch (err) {
    log(`archive-pull: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
