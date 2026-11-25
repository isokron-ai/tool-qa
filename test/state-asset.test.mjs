// Tests for scripts/state-asset.mjs. No network: fetch is replaced by a fake
// GitHub API that keeps one repository's releases in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pullState, pushState, migrateState, decodeState, encodeState, ASSET_NAME, TAG } from '../scripts/state-asset.mjs';
import { fakeDecrypt, fakeEncrypt } from '../ingest/testkit.mjs';
import { openState } from '../state/db.mjs';

const TOKEN = 'ghs_SYNTHETICtokenFORtests0000000000000';
const REPO = 'isokron-ai/tool-qa';
const API = 'https://api.github.test';
const UPLOADS = 'https://uploads.github.test';
const STORAGE = 'https://objects.storage.test';
const SCRIPT = fileURLToPath(new URL('../scripts/state-asset.mjs', import.meta.url));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'state-asset-'));
}

function makeDb(dir, name = 'state.sqlite', subject = 'seed') {
  const file = join(dir, name);
  const db = openState(file);
  db.upsertSubject({ id: subject, kind: 'repo', source: 'test', now: 0 });
  db.close();
  return file;
}

/** In-memory fake of the parts of the GitHub Releases API we use. */
function fakeGitHub({ release = null, failFirst = {} } = {}) {
  const state = { release, nextId: 100, calls: [] };
  const failures = { ...failFirst };
  const json = (status, body, headers = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  function releaseJson() {
    const r = state.release;
    return {
      id: r.id, tag_name: TAG, upload_url: `${UPLOADS}/repos/${REPO}/releases/${r.id}/assets{?name,label}`,
      assets: r.assets.map((a) => ({ id: a.id, name: a.name, label: a.label, updated_at: a.updated_at, size: a.data.length, url: `${API}/repos/${REPO}/releases/assets/${a.id}` })),
    };
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    state.calls.push({ method, url: url.href, headers, redirect: init.redirect });
    const key = `${method} ${url.pathname}`;
    if (failures[key] > 0) {
      failures[key]--;
      return json(502, { message: 'Bad gateway' }, { 'retry-after': '0' });
    }

    if (url.origin === STORAGE) {
      const id = Number(url.pathname.split('/').pop());
      const a = state.release?.assets.find((x) => x.id === id);
      return a ? new Response(a.data, { status: 200 }) : new Response('gone', { status: 404 });
    }
    if (url.origin === API || url.origin === UPLOADS) {
      if (headers.authorization && headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    }
    if (url.origin === API && method === 'GET' && url.pathname === `/repos/${REPO}/releases/tags/${TAG}`) {
      return state.release ? json(200, releaseJson()) : json(404, { message: 'Not Found' });
    }
    if (url.origin === API && method === 'POST' && url.pathname === `/repos/${REPO}/releases`) {
      if (!headers.authorization) return json(401, { message: 'Requires authentication' });
      const body = JSON.parse(init.body);
      state.created = body;
      state.release = { id: 7, assets: [] };
      return json(201, releaseJson());
    }
    if (url.origin === API && method === 'GET' && state.release && url.pathname === `/repos/${REPO}/releases/${state.release.id}/assets`) {
      return json(200, releaseJson().assets);
    }
    const assetMatch = url.pathname.match(new RegExp(`^/repos/${REPO}/releases/assets/(\\d+)$`));
    if (url.origin === API && assetMatch) {
      const id = Number(assetMatch[1]);
      const a = state.release?.assets.find((x) => x.id === id);
      if (!a) return json(404, { message: 'Not Found' });
      if (method === 'GET') {
        assert.equal(headers.accept, 'application/octet-stream');
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status: 302, headers: { location: `${STORAGE}/blob/${id}` } });
      }
      if (!headers.authorization) return json(401, { message: 'Requires authentication' });
      if (method === 'DELETE') {
        state.release.assets = state.release.assets.filter((x) => x.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        if (state.release.assets.some((x) => x.name === body.name && x.id !== id)) return json(422, { message: 'already_exists' });
        Object.assign(a, body);
        return json(200, { id: a.id, name: a.name, label: a.label });
      }
    }
    if (url.origin === UPLOADS && method === 'POST' && url.pathname === `/repos/${REPO}/releases/${state.release?.id}/assets`) {
      if (!headers.authorization) return json(401, { message: 'Requires authentication' });
      const name = url.searchParams.get('name');
      if (state.release.assets.some((x) => x.name === name)) return json(422, { message: 'already_exists' });
      const data = Buffer.from(init.body);
      assert.equal(headers['content-type'], 'application/octet-stream');
      assert.equal(Number(headers['content-length']), data.length);
      const a = { id: state.nextId++, name, label: url.searchParams.get('label') || '', data };
      state.release.assets.push(a);
      return json(201, { id: a.id, name: a.name, label: a.label });
    }
    return json(500, { message: `unexpected ${key}` });
  }
  return { fetch, state };
}

// Stand-in for age (ingest/testkit.mjs): a fixed age header in front of the bytes.
const FAKE = { encrypt: fakeEncrypt, decrypt: fakeDecrypt };

/** A release asset as the pump stores it: encrypted (unless `plain`), labelled with the sha256 of what was uploaded. */
function asset(id, name, data, label, { plain = false } = {}) {
  const bytes = plain ? Buffer.from(data) : fakeEncrypt(Buffer.from(data));
  return { id, name, label: label ?? `sha256:${sha256(bytes)}`, data: bytes };
}

function collectLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
}

const noSleep = async () => {};

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;

test('pull downloads state.sqlite, follows the redirect without the token, and verifies it', async () => {
  const src = makeDb(tmp());
  const data = readFileSync(src);
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data)] } });
  const out = join(tmp(), 'sub', 'state.sqlite');
  const { log, lines } = collectLog();
  const r = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.equal(r.encrypted, true);
  assert.equal(r.sha256, sha256(fakeEncrypt(data)), 'the digest is of the uploaded ciphertext');
  assert.deepEqual(readFileSync(out), data);
  const storageCall = gh.state.calls.find((c) => c.url.startsWith(STORAGE));
  assert.equal(storageCall.headers.authorization, undefined, 'token must not go to the storage host');
  const apiCall = gh.state.calls.find((c) => c.url.startsWith(API));
  assert.equal(apiCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!lines.join('\n').includes(TOKEN));
});

test('pull works without a token for a public repository', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data)] } });
  const out = join(tmp(), 'state.sqlite');
  const r = await pullState({ crypto: FAKE, repo: REPO, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.ok(gh.state.calls.every((c) => c.headers.authorization === undefined));
});

test('pull reports absent when there is no state release yet', async () => {
  const gh = fakeGitHub();
  const out = join(tmp(), 'state.sqlite');
  const r = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'absent');
  assert.equal(existsSync(out), false);
});

test('pull reports absent when the release has no state asset', async () => {
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, 'other.txt', 'x')] } });
  const r = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: join(tmp(), 's'), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'absent');
});

test('pull falls back to an interrupted upload when state.sqlite is missing', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({ release: { id: 7, assets: [
    asset(1, `${ASSET_NAME}.upload-20261123T100000Z`, 'old junk'),
    asset(2, `${ASSET_NAME}.upload-20261123T110000Z`, data),
  ] } });
  const out = join(tmp(), 'state.sqlite');
  const r = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.equal(r.asset, `${ASSET_NAME}.upload-20261123T110000Z`);
  assert.deepEqual(readFileSync(out), data);
});

test('pull rejects a checksum mismatch and leaves no file', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data, `sha256:${'0'.repeat(64)}`)] } });
  const out = join(tmp(), 'state.sqlite');
  await assert.rejects(
    pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /checksum/,
  );
  assert.equal(existsSync(out), false);
});

test('pull rejects a file that is not SQLite', async () => {
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, 'not a database')] } });
  const out = join(tmp(), 'state.sqlite');
  await assert.rejects(
    pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /not a SQLite/,
  );
  assert.equal(existsSync(out), false);
});

test('pull retries a transient server error', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({
    release: { id: 7, assets: [asset(1, ASSET_NAME, data)] },
    failFirst: { [`GET /repos/${REPO}/releases/tags/${TAG}`]: 2 },
  });
  const r = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: join(tmp(), 's'), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
});

test('push creates the state release when missing and uploads state.sqlite', async () => {
  const file = makeDb(tmp());
  const gh = fakeGitHub();
  const r = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, now: Date.parse('2026-11-23T12:00:00Z'), force: true });
  assert.equal(r.status, 'pushed');
  assert.equal(gh.state.created.tag_name, TAG);
  assert.equal(gh.state.created.make_latest, 'false');
  assert.equal(gh.state.created.prerelease, true);
  const names = gh.state.release.assets.map((a) => a.name);
  assert.deepEqual(names, [ASSET_NAME]);
  const stored = gh.state.release.assets[0];
  assert.ok(stored.data.equals(fakeEncrypt(encodeState(readFileSync(file)))), 'only the encrypted (gzipped) copy is uploaded');
  assert.equal(stored.label, `sha256:${sha256(stored.data)}`);
});

test('push replaces the existing asset and removes leftover uploads', async () => {
  const dir = tmp();
  const oldData = readFileSync(makeDb(dir, 'old.sqlite', 'old'));
  const file = makeDb(dir, 'new.sqlite', 'new');
  const gh = fakeGitHub({ release: { id: 7, assets: [
    asset(1, ASSET_NAME, oldData),
    asset(2, `${ASSET_NAME}.upload-20260101T000000Z`, 'stale'),
  ] } });
  await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, now: Date.parse('2026-11-23T12:00:00Z'), force: true });
  assert.deepEqual(gh.state.release.assets.map((a) => a.name), [ASSET_NAME]);
  assert.ok(gh.state.release.assets[0].data.equals(fakeEncrypt(encodeState(readFileSync(file)))));
  // Order: upload under a temporary name first, then delete the old asset, then rename.
  const seq = gh.state.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(seq.slice(0, 3), [
    `POST /repos/${REPO}/releases/7/assets`,
    `DELETE /repos/${REPO}/releases/assets/1`,
    `PATCH /repos/${REPO}/releases/assets/100`,
  ]);
  assert.ok(seq.includes(`DELETE /repos/${REPO}/releases/assets/2`));
  // The round trip gives back the new database.
  const out = join(dir, 'pulled.sqlite');
  await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  const db = openState(out);
  assert.ok(db.getSubject('new'));
  assert.equal(db.getSubject('old'), undefined);
  db.close();
});

test('push needs a token and makes no request without one', async () => {
  const gh = fakeGitHub();
  await assert.rejects(
    pushState({ crypto: FAKE, repo: REPO, file: makeDb(tmp()), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /GITHUB_TOKEN/,
  );
  assert.equal(gh.state.calls.length, 0);
});

test('push refuses a file that is not SQLite before any request', async () => {
  const file = join(tmp(), 'state.sqlite');
  writeFileSync(file, 'hello');
  const gh = fakeGitHub();
  await assert.rejects(
    pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, force: true }),
    /not a SQLite/,
  );
  assert.equal(gh.state.calls.length, 0);
});

test('API errors name the status but never the token', async () => {
  const leaky = async () => new Response(JSON.stringify({ message: `token ${TOKEN} rejected` }), { status: 403 });
  const { log, lines } = collectLog();
  let err;
  try {
    await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file: makeDb(tmp()), fetch: leaky, apiUrl: API, log, sleep: noSleep, force: true });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'push should fail');
  assert.match(err.message, /403/);
  assert.ok(!err.message.includes(TOKEN));
  assert.ok(!(err.stack || '').includes(TOKEN));
  assert.ok(!lines.join('\n').includes(TOKEN));
});

test('repository name is validated', async () => {
  await assert.rejects(pullState({ crypto: FAKE, repo: 'not a repo', file: 'x', fetch: async () => { throw new Error('no'); } }), /owner\/name/);
});

test('CLI: unknown command and missing repository are usage errors', () => {
  const env = { PATH: process.env.PATH };
  const a = spawnSync(process.execPath, [SCRIPT, 'sync'], { env, encoding: 'utf8' });
  assert.equal(a.status, 2);
  const b = spawnSync(process.execPath, [SCRIPT, 'pull'], { env, encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /GITHUB_REPOSITORY/);
});

const push = (api, file, extra = {}) =>
  pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: api.fetch, apiUrl: API, log: () => {}, sleep: noSleep, ...extra });
const pull = (api, file) =>
  pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: api.fetch, apiUrl: API, log: () => {}, sleep: noSleep });

test('push without a pull record is refused unless forced', async () => {
  const api = fakeGitHub();
  await assert.rejects(push(api, makeDb(tmp())), /pull record/);
  assert.equal(api.state.calls.length, 0);
});

test('pull then push succeeds when the remote is unchanged, and a second push works', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const api = fakeGitHub({ release: { id: 7, assets: [{ ...asset(1, ASSET_NAME, data), updated_at: '2026-11-23T10:00:00Z' }] } });
  const file = join(dir, 'state.sqlite');
  await pull(api, file);
  const db = openState(file);
  db.upsertSubject({ id: 'more', kind: 'repo', source: 't', now: 1 });
  db.close();
  assert.equal((await push(api, file)).status, 'pushed');
  assert.equal((await push(api, file)).status, 'pushed');
});

test('push refuses when the remote asset changed after the pull, and changes nothing', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const api = fakeGitHub({ release: { id: 7, assets: [{ ...asset(1, ASSET_NAME, data), updated_at: '2026-11-23T10:00:00Z' }] } });
  const file = join(dir, 'state.sqlite');
  await pull(api, file);
  const newer = readFileSync(makeDb(dir, 'newer.sqlite', 'newer'));
  api.state.release.assets = [{ ...asset(5, ASSET_NAME, newer), updated_at: '2026-11-23T11:00:00Z' }];
  await assert.rejects(push(api, file), /remote state changed/);
  assert.equal(api.state.release.assets.length, 1);
  assert.deepEqual(api.state.release.assets[0].data, fakeEncrypt(newer));
  assert.equal(api.state.calls.some((c) => c.method === 'POST' || c.method === 'DELETE'), false);
});

test('push refuses when only updated_at changed', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir));
  const api = fakeGitHub({ release: { id: 7, assets: [{ ...asset(1, ASSET_NAME, data), updated_at: '2026-11-23T10:00:00Z' }] } });
  const file = join(dir, 's.sqlite');
  await pull(api, file);
  api.state.release.assets[0].updated_at = '2026-11-23T10:05:00Z';
  await assert.rejects(push(api, file), /updated_at/);
});

test('push refuses when state appeared after the pull found none', async () => {
  const dir = tmp();
  const api = fakeGitHub();
  const file = join(dir, 'state.sqlite');
  await pull(api, file); // absent: writes a record
  const db = openState(file);
  db.upsertSubject({ id: 'a', kind: 'repo', source: 't', now: 1 });
  db.close();
  api.state.release = { id: 7, assets: [asset(3, ASSET_NAME, readFileSync(makeDb(dir, 'x.sqlite', 'x')))] };
  await assert.rejects(push(api, file), /now exists/);
});

test('push drops its upload and refuses if the remote changes during the push', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const api = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data)] } });
  const file = join(dir, 'state.sqlite');
  await pull(api, file);
  const racing = async (input, init = {}) => {
    const res = await api.fetch(input, init);
    if ((init.method || 'GET') === 'POST' && String(input).includes('/assets')) {
      api.state.release.assets = api.state.release.assets.filter((a) => a.id !== 1);
      api.state.release.assets.push(asset(9, ASSET_NAME, 'newer writer'));
    }
    return res;
  };
  await assert.rejects(push({ fetch: racing }, file), /remote state changed/);
  assert.deepEqual(api.state.release.assets.map((a) => a.id), [9]);
});

test('CLI: push without a pull record exits 1 with a clear message', () => {
  const file = makeDb(tmp());
  const r = spawnSync(process.execPath, [SCRIPT, 'push', '--file', file, '--repo', REPO], {
    env: { PATH: process.env.PATH, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: 'http://127.0.0.1:9' }, encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pull record/);
});

test('R-STATE-01: pull from an empty release then push succeeds (first-ever push)', async () => {
  const dir = tmp();
  const api = fakeGitHub();
  const file = join(dir, 'state.sqlite');
  const r1 = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: api.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r1.status, 'absent');
  makeDb(dir, 'state.sqlite', 'first');
  const r2 = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: api.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r2.status, 'pushed');
  assert.deepEqual(api.state.release.assets.map((a) => a.name), [ASSET_NAME]);
  const r3 = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: api.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r3.status, 'pushed');
});

// ---- R-ING-15: the state asset is age ciphertext, and nothing else is used ----

test('R-ING-15: pull refuses an asset that is not age ciphertext and writes nothing', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data, undefined, { plain: true })] } });
  const out = join(dir, 'state.sqlite');
  await assert.rejects(
    pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /is not age ciphertext; refusing to use it/,
  );
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(`${out}.pulled.json`), false);
});

test('R-ING-15: push never uploads plaintext, whatever the encrypter returns', async () => {
  const gh = fakeGitHub();
  const leaky = { encrypt: (plaintext) => plaintext, decrypt: fakeDecrypt };
  await assert.rejects(
    pushState({ crypto: leaky, repo: REPO, token: TOKEN, file: makeDb(tmp()), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, force: true }),
    /refusing to push the state: the encrypted copy is not age ciphertext/,
  );
  assert.equal(gh.state.calls.length, 0, 'not a single request');
});

test('R-ING-15: migrate replaces a plaintext asset with an encrypted one, once', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite', 'from-before'));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data, undefined, { plain: true })] } });
  const file = join(dir, 'state.sqlite');
  const args = { crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep };
  const r = await migrateState(args);
  assert.equal(r.status, 'migrated');
  const [stored] = gh.state.release.assets;
  assert.ok(stored.data.equals(fakeEncrypt(encodeState(data))));
  const again = await migrateState(args);
  assert.equal(again.status, 'already_encrypted');
  const out = join(dir, 'after.sqlite');
  await pullState({ ...args, file: out });
  const db = openState(out);
  assert.ok(db.getSubject('from-before'));
  db.close();
});

test('R-ING-15: with the real age binary: round trip, no identity no read, and no push a writer could not read back', { skip: haveAge ? false : 'age is not installed' }, async () => {
  const { stateCrypto } = await import('../scripts/state-asset.mjs');
  const dir = tmp();
  const key = () => {
    const identity = spawnSync(KEYGEN, [], { encoding: 'utf8' }).stdout;
    return { identity, recipient: spawnSync(KEYGEN, ['-y'], { input: identity, encoding: 'utf8' }).stdout.trim() };
  };
  const pump = key();
  const other = key();
  const recipientsFile = join(dir, 'state.pub');
  writeFileSync(recipientsFile, `# test\n${pump.recipient}\n`);
  const crypto = stateCrypto({ identity: pump.identity, ageBin: AGE, keygenBin: KEYGEN, tmpDir: dir, recipientsFile });
  const gh = fakeGitHub();
  const file = makeDb(dir, 'state.sqlite', 'real-age');
  const args = { crypto, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep };
  await pushState({ ...args, force: true });
  const [stored] = gh.state.release.assets;
  assert.ok(stored.data.subarray(0, 22).toString('latin1') === 'age-encryption.org/v1\n');
  assert.equal(stored.data.includes(Buffer.from('SQLite format 3')), false);
  assert.equal(stored.data.includes(Buffer.from('real-age')), false, 'no subject id in the clear');

  const out = join(dir, 'pulled.sqlite');
  await pullState({ ...args, file: out });
  const db = openState(out);
  assert.ok(db.getSubject('real-age'));
  db.close();

  const noKey = stateCrypto({ ageBin: AGE, keygenBin: KEYGEN, tmpDir: dir, recipientsFile });
  await assert.rejects(pullState({ ...args, crypto: noKey, file: join(dir, 'x.sqlite') }), /AGE_IDENTITY is not set/);

  const outsider = stateCrypto({ identity: other.identity, ageBin: AGE, keygenBin: KEYGEN, tmpDir: dir, recipientsFile });
  await assert.rejects(pushState({ ...args, crypto: outsider, force: true }), /is not one of the recipients/);
});

test('R-ING-15: the committed state.pub lists the ingest key, so the pump can read what it pushes', async () => {
  const { readSealRecipients } = await import('../ingest/age.mjs');
  const state = readSealRecipients(fileURLToPath(new URL('../state/state.pub', import.meta.url)));
  const ingest = readSealRecipients(fileURLToPath(new URL('../worker-kit/ingest.pub', import.meta.url)));
  assert.ok(ingest.every((k) => state.includes(k)), 'every ingest recipient is a state recipient');
});

// ---- compression (loop upgrade #14) ----

test('compression: push gzips the database inside the age envelope; pull reads it back whole', async () => {
  const dir = tmp();
  const file = makeDb(dir, 'state.sqlite', 'gzipped');
  const db = openState(file);
  for (let i = 0; i < 400; i++) db.upsertSubject({ id: `org/repo-${i}`, kind: 'repo', source: 'test', now: i });
  db.close();
  const gh = fakeGitHub();
  const r = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, force: true });
  assert.equal(r.compressed, true);
  const [stored] = gh.state.release.assets;
  const inside = fakeDecrypt(stored.data);
  assert.deepEqual([...inside.subarray(0, 2)], [0x1f, 0x8b], 'gzip inside the envelope');
  assert.ok(stored.data.length < readFileSync(file).length / 2, `${stored.data.length} bytes for a ${readFileSync(file).length}-byte database`);
  const out = join(dir, 'pulled.sqlite');
  const p = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(p.compressed, true);
  assert.ok(readFileSync(out).equals(readFileSync(file)), 'byte for byte the database that was pushed');
  assert.equal(JSON.parse(readFileSync(`${out}.pulled.json`, 'utf8')).compressed, true);
});

test('compression: old and new forms mixed: an uncompressed asset still pulls, is pushed back compressed, and --no-compress writes the old form', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'old.sqlite', 'from-before-gzip'));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data)] } });
  const file = join(dir, 'state.sqlite');
  const p1 = await pull(gh, file);
  assert.equal(p1.compressed, false);
  assert.ok(readFileSync(file).equals(data));
  await push(gh, file);
  assert.deepEqual([...fakeDecrypt(gh.state.release.assets[0].data).subarray(0, 2)], [0x1f, 0x8b]);
  const p2 = await pull(gh, file);
  assert.equal(p2.compressed, true);
  assert.ok(readFileSync(file).equals(data));
  // Back to the old form, for going back to code from before compression.
  const r = await push(gh, file, { compress: false });
  assert.equal(r.compressed, false);
  assert.ok(fakeDecrypt(gh.state.release.assets[0].data).equals(data));
  assert.equal((await pull(gh, file)).compressed, false);
  // The CLI flag is parsed.
  const cli = spawnSync(process.execPath, [SCRIPT, 'push', '--no-compress', '--bogus'], { env: { PATH: process.env.PATH, GITHUB_REPOSITORY: REPO }, encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /unknown argument "--bogus"/);
});

test('compression: a gzip that is cut short, or that would grow past the limit, is refused and the local file is left alone', async () => {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const packed = encodeState(data);
  const cut = packed.subarray(0, Math.floor(packed.length / 2));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, cut)] } });
  const file = join(dir, 'state.sqlite');
  writeFileSync(file, 'previous');
  await assert.rejects(pull(gh, file), /gzip that does not decompress/);
  assert.equal(readFileSync(file, 'utf8'), 'previous');
  assert.throws(() => decodeState(packed, { maxBytes: 100 }), /does not decompress/);
  assert.deepEqual(decodeState(data), { data, compressed: false });
  assert.ok(decodeState(packed).data.equals(data));
});

// R-CHAOS-14: the state push survives GitHub server errors (25 Nov 2026: HTTP 500
// and 502 on the asset upload), and a retried upload cannot leave two copies or
// roll newer state back.
function pushSetup() {
  const dir = tmp();
  const data = readFileSync(makeDb(dir, 'seed.sqlite'));
  const api = fakeGitHub({ release: { id: 7, assets: [{ ...asset(1, ASSET_NAME, data), updated_at: '2026-11-23T10:00:00Z' }] } });
  const file = join(dir, 'state.sqlite');
  return { dir, api, file };
}
const uploadPath = `/repos/${REPO}/releases/7/assets`;
const retryOpts = (extra = {}) => {
  const sleeps = [];
  const lines = [];
  return { sleeps, lines, opts: { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, log: (l) => lines.push(l), ...extra } };
};

test('R-CHAOS-14: a push whose upload gets HTTP 500 and 502 is repeated until it lands, with backoff, and logs the retries', async () => {
  const { api, file } = pushSetup();
  await pull(api, file);
  const r = retryOpts();
  const inner = api.fetch;
  let hits = 0;
  const flaky = async (input, init) => {
    if (new URL(String(input)).pathname === uploadPath && (init?.method ?? 'GET') === 'POST' && hits++ < 2) {
      return new Response(JSON.stringify({ message: 'Server Error' }), { status: hits === 1 ? 500 : 502 });
    }
    return inner(input, init);
  };
  const out = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: flaky, apiUrl: API, ...r.opts });
  assert.equal(out.status, 'pushed');
  assert.deepEqual(r.sleeps, [1000, 2000]);
  assert.equal(api.state.release.assets.length, 1, 'one state asset');
  assert.equal(api.state.release.assets[0].name, ASSET_NAME);
  assert.ok(r.lines.some((l) => /attempt 1\/6 failed/.test(l)));
  assert.ok(r.lines.every((l) => !l.includes(TOKEN)));
});

test('R-CHAOS-14: an upload that was stored but answered 500 is not uploaded twice: the stored copy is used, and the push still checks the remote is unchanged', async () => {
  const { api, file } = pushSetup();
  await pull(api, file);
  const r = retryOpts();
  const inner = api.fetch;
  let first = true;
  const lostReply = async (input, init) => {
    const res = await inner(input, init);
    if (first && new URL(String(input)).pathname === uploadPath && init?.method === 'POST') {
      first = false;
      return new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 });
    }
    return res;
  };
  const out = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: lostReply, apiUrl: API, ...r.opts });
  assert.equal(out.status, 'pushed');
  assert.equal(api.state.calls.filter((c) => c.method === 'POST' && c.url.includes('/assets?')).length, 1, 'the upload was sent once');
  assert.deepEqual(api.state.release.assets.map((a) => a.name), [ASSET_NAME], 'exactly one asset, under the final name, no leftover upload');
});

test('R-CHAOS-14: a half-stored upload under the same name is deleted before the repeat, and a rival asset that appeared still refuses the push', async () => {
  const { dir, api, file } = pushSetup();
  await pull(api, file);
  const r = retryOpts();
  const inner = api.fetch;
  let first = true;
  const partial = async (input, init) => {
    if (first && new URL(String(input)).pathname === uploadPath && init?.method === 'POST') {
      first = false;
      const name = new URL(String(input)).searchParams.get('name');
      api.state.release.assets.push({ id: 900, name, label: 'sha256:partial', data: Buffer.from('cut') });
      return new Response(JSON.stringify({ message: 'Bad gateway' }), { status: 502 });
    }
    return inner(input, init);
  };
  const out = await pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: partial, apiUrl: API, ...r.opts });
  assert.equal(out.status, 'pushed');
  assert.ok(!api.state.release.assets.some((a) => a.id === 900), 'the partial asset is gone');
  assert.deepEqual(api.state.release.assets.map((a) => a.name), [ASSET_NAME]);

  // Fenced: the same lost reply, but another writer replaced the state meanwhile.
  const s2 = pushSetup();
  await pull(s2.api, s2.file);
  const newer = readFileSync(makeDb(dir, 'newer.sqlite', 'newer'));
  const inner2 = s2.api.fetch;
  let again = true;
  const raced = async (input, init) => {
    const res = await inner2(input, init);
    if (again && new URL(String(input)).pathname === uploadPath && init?.method === 'POST') {
      again = false;
      s2.api.state.release.assets = [...s2.api.state.release.assets.filter((a) => a.name !== ASSET_NAME), { ...asset(5, ASSET_NAME, newer), updated_at: '2026-11-23T11:00:00Z' }];
      return new Response('{}', { status: 500 });
    }
    return res;
  };
  await assert.rejects(pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file: s2.file, fetch: raced, apiUrl: API, ...retryOpts().opts }), /remote state changed/);
  assert.deepEqual(s2.api.state.release.assets.find((a) => a.name === ASSET_NAME).data, fakeEncrypt(newer), 'the newer state is untouched');
});

test('R-CHAOS-14: pull retries a server error on the release read and on the asset download', async () => {
  const { api, dir } = pushSetup();
  const r = retryOpts();
  const inner = api.fetch;
  const seen = new Set();
  const flaky = async (input, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    if (!seen.has(key)) {
      seen.add(key);
      return new Response('{}', { status: 503 });
    }
    return inner(input, init);
  };
  const res = await pullState({ crypto: FAKE, repo: REPO, token: TOKEN, file: join(dir, 'p.sqlite'), fetch: flaky, apiUrl: API, ...r.opts });
  assert.equal(res.status, 'pulled');
  assert.ok(r.sleeps.length >= 2);
});

test('R-CHAOS-18: retries stop at the deadline the caller gives, so a push cannot outlast the run; the error is marked transient', async () => {
  const { api, file } = pushSetup();
  await pull(api, file);
  const clock = { t: 1_000_000 };
  const r = retryOpts({ sleep: async (ms) => { clock.t += ms; } });
  const down = async () => new Response('{}', { status: 502 });
  await assert.rejects(
    pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: down, apiUrl: API, ...r.opts, random: () => 0.999999, retryUntil: Date.now() + 1 }),
    (e) => e.transient === true,
  );
  assert.deepEqual(r.sleeps, [], 'no retry could finish before the deadline');
  // And with no deadline the total sleeping is still capped.
  const r2 = retryOpts({ random: () => 0.999999 });
  await assert.rejects(pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: down, apiUrl: API, ...r2.opts, retryTotalMs: 5000 }), (e) => e.transient === true);
  assert.ok(r2.sleeps.reduce((a, b) => a + b, 0) <= 5000);
});

test('R-CHAOS-16: a 4xx is never retried by the state client', async () => {
  const { api, file } = pushSetup();
  await pull(api, file);
  const r = retryOpts();
  let n = 0;
  const denied = async () => { n += 1; return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }); };
  await assert.rejects(pushState({ crypto: FAKE, repo: REPO, token: TOKEN, file, fetch: denied, apiUrl: API, ...r.opts }), (e) => !e.transient);
  assert.equal(n, 1);
  assert.deepEqual(r.sleeps, []);
});
