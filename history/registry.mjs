// H1: capture of the official MCP registry. No dependencies.
// Usage: node history/registry.mjs --mode full|delta [--out DIR] [--since ISO] [--state FILE]
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SCRIPT_VERSION = '1.0.0';
export const BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const UA = `isokron-tool-qa/${SCRIPT_VERSION} (+https://github.com/isokron-ai/tool-qa)`;
const MAX_RETRIES = 5;
const MAX_PAGES = 10000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

function pageUrl(mode, cursor, since) {
  const p = new URLSearchParams({ limit: '100' });
  // All versions are captured: version=latest is deliberately omitted.
  if (mode === 'delta') p.set('updated_since', since);
  if (cursor) p.set('cursor', cursor);
  return `${BASE_URL}?${p}`;
}

async function fetchText(url, { fetchFn, sleep, errors }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw new Error(`network error: ${e.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries`);
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : backoff(attempt));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
}
const backoff = (n) => Math.min(1000 * 2 ** n, 30000);

export async function capture({
  mode = 'full', outDir = 'history-out', since, statePath,
  fetchFn = globalThis.fetch, sleep = sleepReal, now = () => new Date(), pageDelayMs = 150,
} = {}) {
  if (mode !== 'full' && mode !== 'delta') throw new Error(`bad mode: ${mode}`);
  if (mode === 'delta' && !since && statePath) {
    try { since = JSON.parse(await readFile(statePath, 'utf8')).last_start; } catch { /* no state */ }
  }
  if (mode === 'delta' && !since) throw new Error('delta mode needs --since or a state file with last_start');

  await mkdir(outDir, { recursive: true });
  const started = now().toISOString();
  const stamp = started.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const gzName = `registry-${mode}-${stamp}.ndjson.gz`;
  const gz = createGzip();
  const file = createWriteStream(path.join(outDir, gzName));
  const hash = createHash('sha256');
  file.on('error', () => {});
  gz.on('data', (c) => hash.update(c));
  gz.pipe(file);

  const errors = [];
  let pages = 0, lines = 0, cursor = null, firstUrl = null;
  const seen = new Set();
  while (pages + errors.length < MAX_PAGES) {
    const url = pageUrl(mode, cursor, since);
    firstUrl ??= pageUrl(mode, null, since);
    let raw;
    try {
      raw = await fetchText(url, { fetchFn, sleep, errors });
    } catch (e) {
      errors.push({ url, cursor, error: e.message });
      break;
    }
    let next = null;
    try {
      const d = JSON.parse(raw);
      if (!Array.isArray(d.servers)) throw new Error('page has no servers array');
      for (const s of d.servers) {
        if (!gz.write(JSON.stringify(s) + '\n')) await once(gz, 'drain');
        lines++;
      }
      pages++;
      next = d.metadata?.nextCursor || null;
    } catch (e) {
      // Record the bad page and carry on if a next cursor can still be read.
      const m = /"nextCursor"\s*:\s*"([^"]+)"/.exec(raw);
      next = m ? m[1] : null;
      errors.push({ url, cursor, error: `malformed page: ${e.message}`, bytes: raw.length, recovered_cursor: !!next });
    }
    if (!next) break;
    if (seen.has(next)) { errors.push({ url, cursor, error: 'cursor repeated, stopping' }); break; }
    seen.add(next);
    cursor = next;
    await sleep(pageDelayMs);
  }
  gz.end();
  await once(file, 'finish');

  const manifest = {
    source: firstUrl,
    mode,
    versions: 'all',
    updated_since: mode === 'delta' ? since : null,
    started_utc: started,
    finished_utc: now().toISOString(),
    pages,
    lines,
    file: gzName,
    sha256: hash.digest('hex'),
    script_version: SCRIPT_VERSION,
    errors,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Only advance the delta window after a clean run.
  if (statePath && errors.length === 0) {
    await mkdir(path.dirname(path.resolve(statePath)), { recursive: true });
    await writeFile(statePath, JSON.stringify({ last_start: started, mode }) + '\n');
  }
  return manifest;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${k}`);
    o[k.slice(2)] = argv[i + 1];
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const m = await capture({ mode: a.mode ?? 'full', outDir: a.out ?? 'history-out', since: a.since || undefined, statePath: a.state });
    console.log(`${m.mode}: ${m.pages} pages, ${m.lines} lines, ${m.errors.length} errors, sha256 ${m.sha256}`);
    // A capture with errors is still published; the manifest records them.
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
