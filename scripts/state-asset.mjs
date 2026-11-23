#!/usr/bin/env node
// Move the loop's state database to and from a GitHub Release asset.
//
//   node scripts/state-asset.mjs pull [--file state/state.sqlite] [--repo owner/name]
//   node scripts/state-asset.mjs push [--file state/state.sqlite] [--repo owner/name]
//
// The asset is `state.sqlite` on the release tagged `state` (a pre-release that
// is never marked latest). Environment: GITHUB_TOKEN (needed for push; pull of a
// public repository works without it), GITHUB_REPOSITORY, GITHUB_API_URL.
//
// push uploads under a temporary name, deletes the old asset, then renames the
// new one, so a failed upload never destroys the last good copy. pull falls back
// to the newest temporary upload if a push stopped between delete and rename.
// The asset label carries `sha256:<hex>`; pull checks it and checks that the
// file is a SQLite database before it replaces the local file.
//
// Only one writer may push at a time (the pump runs in a single concurrency
// group). The token is only ever sent to the API host, never logged, and is
// scrubbed from any error text.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const TAG = 'state';
export const ASSET_NAME = 'state.sqlite';
const UPLOAD_PREFIX = `${ASSET_NAME}.upload-`;
const DEFAULT_FILE = 'state/state.sqlite';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const USER_AGENT = 'isokron-tool-qa-state-asset';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function assertSqlite(buf, where) {
  if (buf.length < 100 || !buf.subarray(0, 16).equals(SQLITE_MAGIC)) {
    throw new Error(`${where} is not a SQLite database`);
  }
}

function quickCheck(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const result = row && Object.values(row)[0];
    if (result !== 'ok') throw new Error(`${file} failed the SQLite quick_check: ${result}`);
  } finally {
    db.close();
  }
}

function makeClient({ repo, token, fetch, apiUrl, sleep, log }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) {
    throw new Error(`repository must be "owner/name", got ${JSON.stringify(repo)}`);
  }
  const api = String(apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  const scrub = (text) => (token ? String(text).split(token).join('***') : String(text));
  const doSleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function headers(extra = {}, withAuth = true) {
    const h = { 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', ...extra };
    if (withAuth && token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async function failure(method, url, res) {
    let detail = '';
    try {
      const text = await res.text();
      try { detail = JSON.parse(text).message || text; } catch { detail = text; }
    } catch { /* ignore */ }
    const path = new URL(url).pathname;
    return new Error(scrub(`GitHub ${method} ${path} failed: HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`));
  }

  // Send a request. Idempotent methods are retried on 429/5xx and network errors.
  async function request(method, url, { body, extraHeaders, ok = [200], redirect, withAuth = true } = {}) {
    const attempts = method === 'POST' ? 1 : 3;
    for (let i = 1; ; i++) {
      let res;
      try {
        res = await fetch(url, { method, headers: headers(extraHeaders, withAuth), body, redirect });
      } catch (err) {
        if (i >= attempts) throw new Error(scrub(`GitHub ${method} ${new URL(url).pathname} failed: ${err.message}`));
        await doSleep(1000 * 2 ** (i - 1));
        continue;
      }
      if (ok.includes(res.status)) return res;
      if (RETRY_STATUS.has(res.status) && i < attempts) {
        const after = Number(res.headers.get('retry-after'));
        log(`GitHub ${method} ${new URL(url).pathname}: HTTP ${res.status}, retrying`);
        await doSleep(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** (i - 1));
        continue;
      }
      throw await failure(method, url, res);
    }
  }

  return {
    api,
    request,
    async getRelease() {
      const res = await request('GET', `${api}/repos/${repo}/releases/tags/${TAG}`, { ok: [200, 404] });
      return res.status === 404 ? null : res.json();
    },
    async createRelease() {
      const res = await request('POST', `${api}/repos/${repo}/releases`, {
        ok: [201],
        extraHeaders: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: TAG,
          name: 'Loop state',
          body: 'State store for the tool-qa loop. The asset is overwritten by the loop; this is not a software release.',
          prerelease: true,
          make_latest: 'false',
        }),
      });
      return res.json();
    },
    async download(asset) {
      const res = await request('GET', `${api}/repos/${repo}/releases/assets/${asset.id}`, {
        ok: [200, 301, 302, 303, 307, 308],
        extraHeaders: { Accept: 'application/octet-stream' },
        redirect: 'manual',
      });
      if (res.status === 200) return Buffer.from(await res.arrayBuffer());
      const location = res.headers.get('location');
      if (!location) throw new Error(`asset ${asset.id} redirect had no location`);
      // The storage host gets no Authorization header.
      const blob = await request('GET', new URL(location, api).href, {
        withAuth: false,
        extraHeaders: { Accept: 'application/octet-stream' },
      });
      return Buffer.from(await blob.arrayBuffer());
    },
    async upload(release, name, data, label) {
      const base = String(release.upload_url).replace(/\{[^}]*\}$/, '');
      const url = `${base}?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label)}`;
      const res = await request('POST', url, {
        ok: [201],
        body: data,
        extraHeaders: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
      });
      return res.json();
    },
    async deleteAsset(id) {
      await request('DELETE', `${api}/repos/${repo}/releases/assets/${id}`, { ok: [204, 404] });
    },
    async renameAsset(id, name, label) {
      const res = await request('PATCH', `${api}/repos/${repo}/releases/assets/${id}`, {
        ok: [200],
        extraHeaders: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, label }),
      });
      return res.json();
    },
  };
}

function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const main = assets.find((a) => a.name === ASSET_NAME);
  if (main) return main;
  const partial = assets.filter((a) => String(a.name).startsWith(UPLOAD_PREFIX)).sort((a, b) => b.id - a.id);
  return partial[0] || null;
}

/** Download the state asset to `file`. Returns { status: 'absent' } if there is none yet. */
export async function pullState({ repo, token, file = DEFAULT_FILE, fetch = globalThis.fetch, apiUrl, log = console.error, sleep } = {}) {
  const gh = makeClient({ repo, token, fetch, apiUrl, sleep, log });
  const release = await gh.getRelease();
  const asset = release && pickAsset(release);
  if (!asset) {
    log(`no ${ASSET_NAME} on release "${TAG}" in ${repo}; starting from an empty state`);
    return { status: 'absent' };
  }
  if (asset.name !== ASSET_NAME) log(`${ASSET_NAME} is missing; using interrupted upload ${asset.name}`);
  const data = await gh.download(asset);
  assertSqlite(data, `asset ${asset.name}`);
  const digest = sha256(data);
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset.label || '');
  if (m && m[1] !== digest) throw new Error(`asset ${asset.name} checksum mismatch (label ${m[1]}, got ${digest})`);
  if (!m) log(`asset ${asset.name} has no sha256 label; checksum not verified`);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.download`;
  writeFileSync(partial, data);
  try {
    quickCheck(partial);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  log(`pulled ${asset.name} (${data.length} bytes, sha256 ${digest})`);
  return { status: 'pulled', bytes: data.length, sha256: digest, asset: asset.name };
}

/** Upload `file` as the state asset, replacing the previous one. */
export async function pushState({ repo, token, file = DEFAULT_FILE, fetch = globalThis.fetch, apiUrl, log = console.error, sleep, now = Date.now() } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required to push the state asset');
  const gh = makeClient({ repo, token, fetch, apiUrl, sleep, log });
  const data = readFileSync(file);
  assertSqlite(data, file);
  quickCheck(file);
  const digest = sha256(data);
  const label = `sha256:${digest}`;

  const release = (await gh.getRelease()) || (await gh.createRelease());
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tempName = `${UPLOAD_PREFIX}${stamp}`;
  const uploaded = await gh.upload(release, tempName, data, label);

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const old = assets.find((a) => a.name === ASSET_NAME);
  if (old) await gh.deleteAsset(old.id);
  await gh.renameAsset(uploaded.id, ASSET_NAME, label);
  for (const a of assets) {
    if (a.id !== uploaded.id && String(a.name).startsWith(UPLOAD_PREFIX)) await gh.deleteAsset(a.id);
  }
  log(`pushed ${ASSET_NAME} (${data.length} bytes, sha256 ${digest})`);
  return { status: 'pushed', bytes: data.length, sha256: digest, assetId: uploaded.id };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, file: DEFAULT_FILE, repo: undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--file') opts.file = rest[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a === '--repo') opts.repo = rest[++i];
    else if (a.startsWith('--repo=')) opts.repo = a.slice(7);
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (command !== 'pull' && command !== 'push') throw new Error('command must be "pull" or "push"');
  if (!opts.file) throw new Error('--file needs a path');
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
    opts.repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!opts.repo) throw new Error('set GITHUB_REPOSITORY or pass --repo owner/name');
  } catch (err) {
    process.stderr.write(`state-asset: ${err.message}\nusage: node scripts/state-asset.mjs pull|push [--file path] [--repo owner/name]\n`);
    return 2;
  }
  const args = {
    repo: opts.repo,
    token: env.GITHUB_TOKEN || undefined,
    file: opts.file,
    apiUrl: env.GITHUB_API_URL,
    log: (m) => process.stderr.write(`${m}\n`),
  };
  try {
    if (opts.command === 'pull') await pullState(args);
    else await pushState(args);
    return 0;
  } catch (err) {
    const msg = args.token ? String(err.message).split(args.token).join('***') : err.message;
    process.stderr.write(`state-asset: ${msg}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
