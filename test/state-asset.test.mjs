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

import { pullState, pushState, ASSET_NAME, TAG } from '../scripts/state-asset.mjs';
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
      assets: r.assets.map((a) => ({ id: a.id, name: a.name, label: a.label, size: a.data.length, url: `${API}/repos/${REPO}/releases/assets/${a.id}` })),
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

function asset(id, name, data, label = `sha256:${sha256(data)}`) {
  return { id, name, label, data: Buffer.from(data) };
}

function collectLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
}

const noSleep = async () => {};

test('pull downloads state.sqlite, follows the redirect without the token, and verifies it', async () => {
  const src = makeDb(tmp());
  const data = readFileSync(src);
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data)] } });
  const out = join(tmp(), 'sub', 'state.sqlite');
  const { log, lines } = collectLog();
  const r = await pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.equal(r.sha256, sha256(data));
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
  const r = await pullState({ repo: REPO, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.ok(gh.state.calls.every((c) => c.headers.authorization === undefined));
});

test('pull reports absent when there is no state release yet', async () => {
  const gh = fakeGitHub();
  const out = join(tmp(), 'state.sqlite');
  const r = await pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'absent');
  assert.equal(existsSync(out), false);
});

test('pull reports absent when the release has no state asset', async () => {
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, 'other.txt', 'x')] } });
  const r = await pullState({ repo: REPO, token: TOKEN, file: join(tmp(), 's'), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'absent');
});

test('pull falls back to an interrupted upload when state.sqlite is missing', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({ release: { id: 7, assets: [
    asset(1, `${ASSET_NAME}.upload-20261123T100000Z`, 'old junk'),
    asset(2, `${ASSET_NAME}.upload-20261123T110000Z`, data),
  ] } });
  const out = join(tmp(), 'state.sqlite');
  const r = await pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
  assert.equal(r.asset, `${ASSET_NAME}.upload-20261123T110000Z`);
  assert.deepEqual(readFileSync(out), data);
});

test('pull rejects a checksum mismatch and leaves no file', async () => {
  const data = readFileSync(makeDb(tmp()));
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, data, `sha256:${'0'.repeat(64)}`)] } });
  const out = join(tmp(), 'state.sqlite');
  await assert.rejects(
    pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /checksum/,
  );
  assert.equal(existsSync(out), false);
});

test('pull rejects a file that is not SQLite', async () => {
  const gh = fakeGitHub({ release: { id: 7, assets: [asset(1, ASSET_NAME, 'not a database')] } });
  const out = join(tmp(), 'state.sqlite');
  await assert.rejects(
    pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
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
  const r = await pullState({ repo: REPO, token: TOKEN, file: join(tmp(), 's'), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  assert.equal(r.status, 'pulled');
});

test('push creates the state release when missing and uploads state.sqlite', async () => {
  const file = makeDb(tmp());
  const gh = fakeGitHub();
  const r = await pushState({ repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, now: Date.parse('2026-11-23T12:00:00Z') });
  assert.equal(r.status, 'pushed');
  assert.equal(gh.state.created.tag_name, TAG);
  assert.equal(gh.state.created.make_latest, 'false');
  assert.equal(gh.state.created.prerelease, true);
  const names = gh.state.release.assets.map((a) => a.name);
  assert.deepEqual(names, [ASSET_NAME]);
  const stored = gh.state.release.assets[0];
  assert.deepEqual(stored.data, readFileSync(file));
  assert.equal(stored.label, `sha256:${sha256(readFileSync(file))}`);
});

test('push replaces the existing asset and removes leftover uploads', async () => {
  const dir = tmp();
  const oldData = readFileSync(makeDb(dir, 'old.sqlite', 'old'));
  const file = makeDb(dir, 'new.sqlite', 'new');
  const gh = fakeGitHub({ release: { id: 7, assets: [
    asset(1, ASSET_NAME, oldData),
    asset(2, `${ASSET_NAME}.upload-20260101T000000Z`, 'stale'),
  ] } });
  await pushState({ repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep, now: Date.parse('2026-11-23T12:00:00Z') });
  assert.deepEqual(gh.state.release.assets.map((a) => a.name), [ASSET_NAME]);
  assert.deepEqual(gh.state.release.assets[0].data, readFileSync(file));
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
  await pullState({ repo: REPO, token: TOKEN, file: out, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep });
  const db = openState(out);
  assert.ok(db.getSubject('new'));
  assert.equal(db.getSubject('old'), undefined);
  db.close();
});

test('push needs a token and makes no request without one', async () => {
  const gh = fakeGitHub();
  await assert.rejects(
    pushState({ repo: REPO, file: makeDb(tmp()), fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /GITHUB_TOKEN/,
  );
  assert.equal(gh.state.calls.length, 0);
});

test('push refuses a file that is not SQLite before any request', async () => {
  const file = join(tmp(), 'state.sqlite');
  writeFileSync(file, 'hello');
  const gh = fakeGitHub();
  await assert.rejects(
    pushState({ repo: REPO, token: TOKEN, file, fetch: gh.fetch, apiUrl: API, log: () => {}, sleep: noSleep }),
    /not a SQLite/,
  );
  assert.equal(gh.state.calls.length, 0);
});

test('API errors name the status but never the token', async () => {
  const leaky = async () => new Response(JSON.stringify({ message: `token ${TOKEN} rejected` }), { status: 403 });
  const { log, lines } = collectLog();
  let err;
  try {
    await pushState({ repo: REPO, token: TOKEN, file: makeDb(tmp()), fetch: leaky, apiUrl: API, log, sleep: noSleep });
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
  await assert.rejects(pullState({ repo: 'not a repo', file: 'x', fetch: async () => { throw new Error('no'); } }), /owner\/name/);
});

test('CLI: unknown command and missing repository are usage errors', () => {
  const env = { PATH: process.env.PATH };
  const a = spawnSync(process.execPath, [SCRIPT, 'sync'], { env, encoding: 'utf8' });
  assert.equal(a.status, 2);
  const b = spawnSync(process.execPath, [SCRIPT, 'pull'], { env, encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /GITHUB_REPOSITORY/);
});
