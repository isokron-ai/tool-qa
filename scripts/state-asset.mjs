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
// pull also writes `<file>.pulled.json`: the id, label digest and updated_at of the
// asset it read (or `absent`). push re-reads the remote asset before it uploads and
// again before it deletes the old copy, and refuses (exit 1) if the remote is no
// longer what was pulled, so a stale writer cannot roll newer state back. A push
// with no pull record is refused unless --force is given.
//
// Only one writer may push at a time (the pump runs in a single concurrency
// group). The token is only ever sent to the API host, never logged, and is
// scrubbed from any error text.
//
// The asset is age ciphertext (R-ING-15). The repository is public, so anyone
// can download the asset; the database it holds is for the loop only. push
// encrypts the database to every recipient in state/state.pub and never
// uploads anything that is not age ciphertext. pull decrypts with the age
// identity it is given (AGE_IDENTITY) and refuses an asset that is not age
// ciphertext. The one exception is `migrate`, run once by an operator to
// replace a plaintext asset from before encryption with an encrypted one
// (docs/OPERATIONS.md, "State encryption"). The sha256 label and the
// stale-writer check are over the uploaded bytes, the ciphertext.
//
//   node scripts/state-asset.mjs migrate [--file state/state.sqlite] [--repo owner/name]
//
// Environment for encryption: AGE_IDENTITY (pull of an encrypted asset),
// AGE_BIN and AGE_KEYGEN_BIN (default: age and age-keygen on PATH).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

import { ageDecrypt, ageEncrypt, agePublicKey, readSealRecipients } from '../ingest/age.mjs';
import { isAgeCiphertext } from '../ingest/container.mjs';

export const TAG = 'state';
export const ASSET_NAME = 'state.sqlite';
const UPLOAD_PREFIX = `${ASSET_NAME}.upload-`;
const DEFAULT_FILE = 'state/state.sqlite';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const USER_AGENT = 'isokron-tool-qa-state-asset';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Who the state asset is encrypted to (committed; public keys only). */
export const STATE_RECIPIENTS = fileURLToPath(new URL('../state/state.pub', import.meta.url));
const MAX_STATE_BYTES = 1024 ** 3;

/**
 * Encryption of the state asset with the age binary.
 * encrypt(plaintext) encrypts to every recipient in `recipientsFile`; when
 * `identity` is given it first checks that the identity belongs to one of
 * them, so a writer can never lock itself out of the state it pushes.
 * decrypt(ciphertext) needs `identity`.
 */
export function stateCrypto({ identity, ageBin = 'age', keygenBin = 'age-keygen', tmpDir = tmpdir(), recipientsFile = STATE_RECIPIENTS } = {}) {
  let checked = false;
  return {
    encrypt(plaintext) {
      const recipients = readSealRecipients(recipientsFile);
      if (identity && !checked) {
        const pub = agePublicKey({ identity, keygenBin });
        if (!recipients.includes(pub)) {
          throw new Error(`AGE_IDENTITY is not one of the recipients in ${recipientsFile}; refusing to push a state it could not read back`);
        }
        checked = true;
      }
      return ageEncrypt({ plaintext, recipients, ageBin, maxBytes: MAX_STATE_BYTES });
    },
    decrypt(ciphertext) {
      if (!identity) throw new Error('the state asset is encrypted and AGE_IDENTITY is not set, so it cannot be read');
      return ageDecrypt({ ciphertext, identity, ageBin, tmpDir, maxBytes: MAX_STATE_BYTES });
    },
  };
}

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

function pickAsset(release, ignoreId = null) {
  const assets = (Array.isArray(release?.assets) ? release.assets : []).filter((a) => a.id !== ignoreId);
  const main = assets.find((a) => a.name === ASSET_NAME);
  if (main) return main;
  const partial = assets.filter((a) => String(a.name).startsWith(UPLOAD_PREFIX)).sort((a, b) => b.id - a.id);
  return partial[0] || null;
}

const recordPath = (file) => `${file}.pulled.json`;

function describe(asset, digest) {
  return { id: asset.id, name: asset.name, sha256: digest, updated_at: asset.updated_at ?? null };
}

function readRecord(file) {
  try { return JSON.parse(readFileSync(recordPath(file), 'utf8')); } catch { return null; }
}

/** Throw if the remote state asset is not the one described by `expected`. */
// `ignoreId` is our own upload in flight, which must not count as a rival asset.
function assertUnchanged(release, expected, ignoreId = null) {
  const cur = release && pickAsset(release, ignoreId);
  const fail = (why) => {
    throw new Error(`remote state changed since it was pulled (${why}); refusing to overwrite it. Pull again and redo the run.`);
  };
  if (expected.absent) {
    if (cur) fail(`${cur.name} now exists`);
    return;
  }
  if (!cur) fail('the asset is gone');
  if (cur.id !== expected.id) fail(`asset id ${expected.id} is now ${cur.id}`);
  const m = /^sha256:([0-9a-f]{64})$/.exec(cur.label || '');
  if (m && expected.sha256 && m[1] !== expected.sha256) fail('the checksum differs');
  if (cur.updated_at && expected.updated_at && cur.updated_at !== expected.updated_at) fail('updated_at differs');
}

/**
 * Download the state asset, decrypt it and write the database to `file`.
 * Returns { status: 'absent' } if there is none yet. Refuses an asset that is
 * not age ciphertext unless `allowPlaintext` (the one-time migration only).
 * `crypto` defaults to stateCrypto({ identity, ageBin, keygenBin, tmpDir }).
 */
export async function pullState({
  repo, token, file = DEFAULT_FILE, fetch = globalThis.fetch, apiUrl, log = console.error, sleep,
  identity, ageBin, keygenBin, tmpDir, crypto, allowPlaintext = false,
} = {}) {
  const box = crypto ?? stateCrypto({ identity, ageBin, keygenBin, tmpDir });
  const gh = makeClient({ repo, token, fetch, apiUrl, sleep, log });
  const release = await gh.getRelease();
  const asset = release && pickAsset(release);
  if (!asset) {
    log(`no ${ASSET_NAME} on release "${TAG}" in ${repo}; starting from an empty state`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(recordPath(file), JSON.stringify({ absent: true }));
    return { status: 'absent' };
  }
  if (asset.name !== ASSET_NAME) log(`${ASSET_NAME} is missing; using interrupted upload ${asset.name}`);
  const blob = await gh.download(asset);
  const digest = sha256(blob);
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset.label || '');
  if (m && m[1] !== digest) throw new Error(`asset ${asset.name} checksum mismatch (label ${m[1]}, got ${digest})`);
  if (!m) log(`asset ${asset.name} has no sha256 label; checksum not verified`);
  const encrypted = isAgeCiphertext(blob);
  let data;
  if (encrypted) {
    data = await box.decrypt(blob);
  } else if (allowPlaintext) {
    log(`asset ${asset.name} is plaintext (from before the state was encrypted); reading it for the one-time migration`);
    data = blob;
  } else {
    throw new Error(`asset ${asset.name} is not age ciphertext; refusing to use it. The state asset must be encrypted (docs/OPERATIONS.md, "State encryption")`);
  }
  assertSqlite(data, `asset ${asset.name}`);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.download`;
  writeFileSync(partial, data, { mode: 0o600 });
  try {
    quickCheck(partial);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  writeFileSync(recordPath(file), JSON.stringify({ ...describe(asset, digest), encrypted }));
  log(`pulled ${asset.name} (${blob.length} bytes${encrypted ? ' encrypted' : ', plaintext'}, sha256 ${digest})`);
  return { status: 'pulled', bytes: blob.length, sha256: digest, asset: asset.name, encrypted };
}

/**
 * Encrypt `file` and upload it as the state asset, replacing the previous one.
 * Never uploads anything that is not age ciphertext.
 */
export async function pushState({
  repo, token, file = DEFAULT_FILE, fetch = globalThis.fetch, apiUrl, log = console.error, sleep, now = Date.now(), expected, force = false,
  identity, ageBin, keygenBin, tmpDir, crypto,
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required to push the state asset');
  const box = crypto ?? stateCrypto({ identity, ageBin, keygenBin, tmpDir });
  const gh = makeClient({ repo, token, fetch, apiUrl, sleep, log });
  expected = expected ?? readRecord(file);
  if (!expected && !force) {
    throw new Error(`no pull record for ${file}; pull first, or pass --force to overwrite whatever is on the release`);
  }
  // quickCheck opens and closes its own handle, so no connection is open while we read and hash the file.
  assertSqlite(readFileSync(file), file);
  quickCheck(file);
  const data = await box.encrypt(readFileSync(file));
  // Fail closed: whatever encrypt returned, only age ciphertext is uploaded.
  if (!Buffer.isBuffer(data) || !isAgeCiphertext(data)) throw new Error('refusing to push the state: the encrypted copy is not age ciphertext');
  const digest = sha256(data);
  const label = `sha256:${digest}`;

  let release = await gh.getRelease();
  if (expected) assertUnchanged(release, expected);
  release = release || (await gh.createRelease());
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tempName = `${UPLOAD_PREFIX}${stamp}`;
  const uploaded = await gh.upload(release, tempName, data, label);

  if (expected) {
    // Re-check just before the old copy is deleted; drop our upload if we lost the race.
    try {
      assertUnchanged(await gh.getRelease(), expected, uploaded.id);
    } catch (err) {
      await gh.deleteAsset(uploaded.id).catch(() => {});
      throw err;
    }
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const old = assets.find((a) => a.name === ASSET_NAME);
  if (old) await gh.deleteAsset(old.id);
  await gh.renameAsset(uploaded.id, ASSET_NAME, label);
  for (const a of assets) {
    if (a.id !== uploaded.id && String(a.name).startsWith(UPLOAD_PREFIX)) await gh.deleteAsset(a.id);
  }
  // Record what is now on the release (including updated_at), so the next push checks against it.
  const after = await gh.getRelease();
  const mine = after && (after.assets || []).find((a) => a.id === uploaded.id);
  writeFileSync(recordPath(file), JSON.stringify({ id: uploaded.id, name: ASSET_NAME, sha256: digest, updated_at: mine?.updated_at ?? null }));
  log(`pushed ${ASSET_NAME} (${data.length} bytes encrypted, sha256 ${digest})`);
  return { status: 'pushed', bytes: data.length, sha256: digest, assetId: uploaded.id };
}

/**
 * One-time migration: replace a plaintext state asset (from before the state
 * was encrypted) with an encrypted one. Needs a token that can write the
 * release and the age binary, but no identity: it encrypts to state/state.pub.
 * Does nothing if the asset is already encrypted or absent.
 */
export async function migrateState(opts = {}) {
  const log = opts.log ?? console.error;
  const gh = makeClient({ repo: opts.repo, token: opts.token, fetch: opts.fetch ?? globalThis.fetch, apiUrl: opts.apiUrl, sleep: opts.sleep, log });
  const release = await gh.getRelease();
  const asset = release && pickAsset(release);
  if (!asset) {
    log('no state asset; nothing to migrate');
    return { status: 'absent' };
  }
  const blob = await gh.download(asset);
  if (isAgeCiphertext(blob)) {
    log(`${asset.name} is already encrypted; nothing to migrate`);
    return { status: 'already_encrypted' };
  }
  await pullState({ ...opts, log, allowPlaintext: true });
  const pushed = await pushState({ ...opts, log });
  log('migrated: the state asset is now encrypted to state/state.pub');
  return { ...pushed, status: 'migrated' };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, file: DEFAULT_FILE, repo: undefined, force: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--file') opts.file = rest[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a === '--force') opts.force = true;
    else if (a === '--repo') opts.repo = rest[++i];
    else if (a.startsWith('--repo=')) opts.repo = a.slice(7);
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!['pull', 'push', 'migrate'].includes(command)) throw new Error('command must be "pull", "push" or "migrate"');
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
    process.stderr.write(`state-asset: ${err.message}\nusage: node scripts/state-asset.mjs pull|push|migrate [--file path] [--repo owner/name] [--force]\n`);
    return 2;
  }
  const args = {
    repo: opts.repo,
    token: env.GITHUB_TOKEN || undefined,
    file: opts.file,
    force: opts.force,
    apiUrl: env.GITHUB_API_URL,
    log: (m) => process.stderr.write(`${m}\n`),
    identity: env.AGE_IDENTITY || undefined,
    ageBin: env.AGE_BIN || undefined,
    keygenBin: env.AGE_KEYGEN_BIN || undefined,
    tmpDir: env.RUNNER_TEMP || undefined,
  };
  // Nothing started from here (age, age-keygen) needs it in its environment.
  if (env === process.env) delete process.env.AGE_IDENTITY;
  try {
    if (opts.command === 'pull') await pullState(args);
    else if (opts.command === 'push') await pushState(args);
    else await migrateState(args);
    return 0;
  } catch (err) {
    let msg = args.token ? String(err.message).split(args.token).join('***') : err.message;
    if (args.identity) msg = String(msg).split(args.identity.trim()).join('[identity]');
    process.stderr.write(`state-asset: ${msg}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
