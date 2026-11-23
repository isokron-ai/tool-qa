#!/usr/bin/env node
// Copy history artifacts from GitHub Actions into a local archive folder.
//
//   node scripts/archive-pull.mjs --dest <folder> [--repo isokron-ai/tool-qa] [--dry-run]
//
// Workflow artifacts expire after 30 days, so this is meant to run regularly on
// a machine that keeps the archive (docs/OPERATIONS.md has a launchd example).
// It needs a token that can read Actions artifacts: GITHUB_TOKEN or GH_TOKEN,
// otherwise the GitHub CLI's `auth token`.
//
// For every artifact whose name starts with `history-` or `registry-`, that has
// not expired and is not in the index yet, it:
//   1. downloads the zip (the API answers with a redirect to storage; the token
//      is sent to the API only, never to the storage host);
//   2. checks the zip against the artifact's sha256 digest when GitHub gives one;
//   3. unpacks it in memory and checks every file listed in `manifest.json`
//      (`file`, `sha256`) and `manifest-*.json` (`files[].name`, `files[].sha256`);
//   4. writes it to a temporary folder, then renames that to `<dest>/<name>`
//      (or `<dest>/<name>.<id>` if a different folder already has that name);
//   5. appends a line to `<dest>/index.ndjson`.
// Nothing in the archive is ever overwritten or deleted. An artifact that fails
// a check is not kept and not indexed; it is tried again on the next run, and
// the exit code is 1.
//
// `<dest>/.last-pull.json` keeps the newest artifact time seen (held back to
// the oldest failure). The next run lists back to one hour before it, so
// artifacts that show up late are not missed; the index skips repeats.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiBudget } from '../pump/budgets.mjs';
import { createClient } from '../pump/github.mjs';
import { readZip } from './lib/unzip.mjs';

export const DEFAULT_REPO = 'isokron-ai/tool-qa';
export const PREFIXES = Object.freeze(['history-', 'registry-']);
const OVERLAP_MS = 60 * 60_000;
const MARKER = '.artifact.json';
const INDEX = 'index.ndjson';
const CURSOR = '.last-pull.json';
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

function readIndex(dest) {
  const ids = new Set();
  const file = join(dest, INDEX);
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      ids.add(Number(JSON.parse(line).id));
    } catch {
      // a torn last line from an interrupted run; the artifact is recovered by its folder
    }
  }
  return ids;
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

/** Where an artifact goes: { dir, recovered } or throws if both names are taken. */
function placeFor(dest, artifact) {
  const base = folderName(artifact.name);
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
    renameSync(temp, final);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

async function listArtifacts(client, repo, since) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const res = await client.request('GET', `/repos/${repo}/actions/artifacts`, { query: { per_page: 100, page } });
    const items = res.data?.artifacts ?? [];
    out.push(...items);
    if (items.length < 100) break;
    if (since !== null && items.every((a) => Date.parse(a.created_at) < since)) break;
  }
  return out;
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
  const previous = readJson(join(dest, CURSOR))?.last_created_at ?? null;
  const since = previous && Number.isFinite(Date.parse(previous)) ? Date.parse(previous) - OVERLAP_MS : null;
  const indexed = readIndex(dest);

  const listed = await listArtifacts(client, repo, since);
  const wanted = listed
    .filter((a) => PREFIXES.some((p) => String(a.name).startsWith(p)) && !a.expired)
    .filter((a) => since === null || Date.parse(a.created_at) >= since)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);

  const out = { listed: listed.length, pulled: [], recovered: [], already: 0, failed: [], wouldPull: [], cursor: previous };
  const record = (entry) => appendFileSync(join(dest, INDEX), `${JSON.stringify(entry)}\n`);
  for (const a of wanted) {
    if (indexed.has(Number(a.id))) {
      out.already += 1;
      continue;
    }
    try {
      const place = placeFor(dest, a);
      if (place.recovered) {
        if (!dryRun) record({ ...place.recovered, dir: place.dir });
        out.recovered.push(a.name);
        log(`archive-pull: ${a.name}: found in ${place.dir} from an earlier run; indexed`);
        continue;
      }
      if (dryRun) {
        out.wouldPull.push(a.name);
        log(`archive-pull: would pull ${a.name} (${a.size_in_bytes ?? '?'} bytes) into ${place.dir}`);
        continue;
      }
      const zip = await download(client, fetch, repo, a, sleep);
      const zipSha = sha256(zip);
      const digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''));
      if (digest && digest[1] !== zipSha) throw new Error(`zip sha256 ${zipSha} does not match the artifact digest ${digest[1]}`);
      const entries = readZip(zip);
      const { verified, problems } = verifyEntries(entries);
      if (problems.length) throw new Error(problems.slice(0, 5).join('; '));
      const marker = {
        id: a.id,
        name: a.name,
        created_at: a.created_at,
        workflow_run: a.workflow_run ? { id: a.workflow_run.id ?? null, head_sha: a.workflow_run.head_sha ?? null } : null,
        size_in_bytes: a.size_in_bytes ?? zip.length,
        zip_sha256: zipSha,
        pulled_at: new Date(now()).toISOString(),
        verified,
        files: entries.map((e) => ({ name: e.name, bytes: e.data.length, sha256: sha256(e.data) })),
      };
      writeFolder(dest, place.dir, entries, marker);
      record({ ...marker, dir: place.dir });
      out.pulled.push(a.name);
      log(`archive-pull: ${a.name}: ${entries.length} files into ${place.dir}${verified === 'none' ? ' (no manifest to check against)' : ''}`);
    } catch (err) {
      out.failed.push({ name: a.name, id: a.id, error: String(err?.message ?? err) });
      log(`archive-pull: ${a.name}: FAILED: ${err?.message ?? err}`);
    }
  }

  if (!dryRun) {
    let cursor = [previous, ...wanted.map((a) => a.created_at)].filter(Boolean).sort().at(-1) ?? null;
    const firstFailure = out.failed.map((f) => wanted.find((a) => a.id === f.id).created_at).sort()[0];
    if (firstFailure && (!cursor || firstFailure < cursor)) cursor = firstFailure;
    if (cursor) writeFileSync(join(dest, CURSOR), `${JSON.stringify({ last_created_at: cursor, updated: new Date(now()).toISOString() })}\n`);
    out.cursor = cursor;
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
    log(`archive-pull: ${opts.dryRun ? `would pull ${out.wouldPull.length}` : `pulled ${out.pulled.length}`}, recovered ${out.recovered.length}, already had ${out.already}, failed ${out.failed.length}`);
    return out.failed.length ? 1 : 0;
  } catch (err) {
    log(`archive-pull: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
