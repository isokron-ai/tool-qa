#!/usr/bin/env node
// The discover capture (.github/workflows/discover.yml): candidate subjects
// from the history feeds.
//
//   node discover/run.mjs --registry <registry-full-*.ndjson.gz> --packages <history-packages dir> --out <dir>
//                         [--lookups 400] [--no-network]
//
// Reads the newest H1 full registry capture and the newest H2 package
// capture, maps their rows to GitHub repositories (discover/extract.mjs) and
// writes <out>/candidates.json.gz plus <out>/manifest.json (input sha256s,
// counts, times). npm and PyPI rows carry no repository URL, so for names
// the registry does not already list, up to --lookups of them are looked up
// one GET each (registry.npmjs.org/<name>/latest, pypi.org/pypi/<name>/json),
// 150 ms apart, with an identifying User-Agent. Nothing here needs a token,
// and nothing is written anywhere but --out. The pump turns candidates into
// subjects (pump/discover.mjs).

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';

import { buildCandidates, CANDIDATES_VERSION, feedNames, FRAME_SOURCE, fromCrates, fromGo, fromRegistry, purlFor, repoFromNpm, repoFromPypi } from './extract.mjs';

export const SCRIPT_VERSION = '1.0.0';
export const USER_AGENT = `isokron-tool-qa-discover/${SCRIPT_VERSION} (+https://github.com/isokron-ai/tool-qa)`;
export const DEFAULT_LOOKUPS = 400;

/** Every JSON line of a .ndjson.gz file (bad lines are counted, not thrown). */
export async function readNdjsonGz(file) {
  const rows = [];
  let bad = 0;
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { rows, bad };
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** One GET with a few retries on 429/5xx. Returns parsed JSON, null for 404, throws otherwise. */
export async function getJson(url, { fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3 } = {}) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(1000 * i);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < attempts) { await sleep(2000 * i); continue; }
    throw new Error(`GET ${new URL(url).hostname}: HTTP ${res.status}`);
  }
}

/**
 * Observations for npm and PyPI names, by lookup, at most `limit` in all
 * (npm first, then PyPI, each in name order). Errors are counted, never fatal.
 */
export async function lookupPackages({ npm = [], pypi = [], limit = DEFAULT_LOOKUPS, fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 150 }) {
  const out = [];
  const stats = { npm: 0, pypi: 0, found: 0, not_found: 0, no_repo: 0, errors: 0, left: 0 };
  const queue = [...npm.map((n) => ['npm', n]), ...pypi.map((n) => ['pypi', n])];
  stats.left = Math.max(0, queue.length - limit);
  for (const [kind, name] of queue.slice(0, Math.max(0, limit))) {
    stats[kind] += 1;
    const url = kind === 'npm'
      ? `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}/latest`
      : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    try {
      const doc = await getJson(url, { fetch, sleep });
      if (!doc) { stats.not_found += 1; continue; }
      const gh = kind === 'npm' ? repoFromNpm(doc) : repoFromPypi(doc);
      if (!gh) { stats.no_repo += 1; continue; }
      stats.found += 1;
      out.push({ feed: kind, repo: gh.repo, subfolder: gh.subfolder, purls: [purlFor(kind, name)], packaged: true });
    } catch {
      stats.errors += 1;
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  return { observations: out, stats };
}

const newest = (dir, prefix) => readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.ndjson.gz')).sort().at(-1) ?? null;

export async function runDiscover({ registry, packages, out, lookups = DEFAULT_LOOKUPS, network = true, fetch = globalThis.fetch, sleep, now = Date.now }) {
  const started = new Date(now()).toISOString();
  const manifest = { version: CANDIDATES_VERSION, frame: FRAME_SOURCE, script_version: SCRIPT_VERSION, started_at: started, inputs: {}, counts: {}, errors: [] };
  const obs = [];
  if (registry) {
    const { rows, bad } = await readNdjsonGz(registry);
    const o = fromRegistry(rows);
    obs.push(...o);
    manifest.inputs.registry = { file: registry.split('/').at(-1), sha256: sha256File(registry), rows: rows.length, bad_lines: bad, observations: o.length };
  } else manifest.errors.push('no registry capture given');
  const known = new Set(obs.flatMap((o) => o.purls));
  let npm = [];
  let pypi = [];
  if (packages) {
    for (const [kind, fn] of [['crates', fromCrates], ['go', fromGo], ['npm', null], ['pypi', null]]) {
      const f = newest(packages, `${kind}-`);
      if (!f) { manifest.errors.push(`no ${kind} capture in ${packages}`); continue; }
      const path = join(packages, f);
      const { rows, bad } = await readNdjsonGz(path);
      const entry = { file: f, sha256: sha256File(path), rows: rows.length, bad_lines: bad };
      if (fn) {
        const o = fn(rows);
        obs.push(...o);
        entry.observations = o.length;
      } else {
        // Names the registry already ties to a repository need no lookup.
        const names = feedNames(rows, kind).filter((n) => !known.has(purlFor(kind, n)));
        if (kind === 'npm') npm = names; else pypi = names;
        entry.names_to_look_up = names.length;
      }
      manifest.inputs[kind] = entry;
    }
  } else manifest.errors.push('no package capture given');
  if (network && lookups > 0 && (npm.length || pypi.length)) {
    const l = await lookupPackages({ npm, pypi, limit: lookups, fetch, ...(sleep ? { sleep } : {}) });
    obs.push(...l.observations);
    manifest.lookups = l.stats;
  } else manifest.lookups = { skipped: true, npm_names: npm.length, pypi_names: pypi.length };
  const candidates = buildCandidates(obs);
  manifest.counts = {
    observations: obs.length, candidates: candidates.length,
    by_class: [0, 1, 2].map((c) => candidates.filter((x) => x.class === c).length),
    by_feed: Object.fromEntries(['registry', 'npm', 'pypi', 'crates', 'go'].map((f) => [f, candidates.filter((x) => x.feeds.includes(f)).length])),
    with_subfolder: candidates.filter((x) => x.keys.some((k) => k.subfolder)).length,
  };
  manifest.finished_at = new Date(now()).toISOString();
  const doc = { version: CANDIDATES_VERSION, frame: FRAME_SOURCE, generated_at: manifest.finished_at, inputs: manifest.inputs, candidates };
  mkdirSync(out, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)));
  writeFileSync(join(out, 'candidates.json.gz'), gz);
  manifest.output = { file: 'candidates.json.gz', sha256: createHash('sha256').update(gz).digest('hex'), bytes: gz.length };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const o = { registry: null, packages: null, out: null, lookups: DEFAULT_LOOKUPS, network: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') o.registry = argv[++i];
    else if (a === '--packages') o.packages = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--lookups') o.lookups = Number(argv[++i]);
    else if (a === '--no-network') o.network = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error('--out is required');
  if (!(o.lookups >= 0)) throw new Error('--lookups must be 0 or more');
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (err) {
    process.stderr.write(`discover: ${err.message}\nusage: node discover/run.mjs --registry <file> --packages <dir> --out <dir> [--lookups n] [--no-network]\n`);
    return 2;
  }
  const m = await runDiscover(o);
  process.stdout.write(`discover: ${m.counts.candidates} candidates (class 0/1/2: ${m.counts.by_class.join('/')}) from ${m.counts.observations} observations; lookups ${JSON.stringify(m.lookups)}${m.errors.length ? `; errors: ${m.errors.join('; ')}` : ''}\n`);
  // No registry capture is a failed run: the pump keeps using the last good one.
  return m.inputs.registry ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
