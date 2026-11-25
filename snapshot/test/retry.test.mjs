// The snapshot release client retries server errors like the pump's clients do
// (pump/retry.mjs), and an upload that was stored but answered with an error
// is not uploaded twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReleaseClient } from '../github.mjs';

const REPO = 'isokron-ai/tool-qa';
const TOKEN = 'ghs_SYNTHETICsnapshotTOKEN000000000';
const API = 'https://api.github.test';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function world(handler) {
  const calls = [];
  const sleeps = [];
  const lines = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams };
    calls.push(call);
    return handler(call, init);
  };
  const gh = createReleaseClient({ repo: REPO, token: TOKEN, fetch, apiUrl: API, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, log: (l) => lines.push(l) });
  return { gh, calls, sleeps, lines };
}

test('R-CHAOS-17: a server error on a read is retried with backoff and logged; a 404 is not retried; the log has no token', async () => {
  let n = 0;
  const w = world((c) => {
    if (c.path.endsWith('/releases/tags/state')) return ++n < 3 ? json(502, { message: 'Bad gateway' }) : json(200, { id: 7, assets: [] });
    return json(404, { message: 'Not Found' });
  });
  assert.equal((await w.gh.getRelease('state')).id, 7);
  assert.deepEqual(w.sleeps, [1000, 2000]);
  assert.equal(w.lines.length, 2);
  assert.ok(w.lines.every((l) => !l.includes(TOKEN)));
  assert.equal(await w.gh.getRelease('nope'), null);
  assert.equal(w.calls.filter((c) => c.path.endsWith('/tags/nope')).length, 1);
});

test('R-CHAOS-17: an upload that was stored but answered 500 is found and used, not uploaded twice; a half-stored one is deleted first', async () => {
  const assets = [];
  let uploads = 0;
  const w = world((c, init) => {
    if (c.method === 'POST' && c.path === '/repos/isokron-ai/tool-qa/releases/7/assets') {
      uploads += 1;
      const name = c.query.get('name');
      if (assets.some((a) => a.name === name)) return json(422, { message: 'already_exists' });
      if (uploads === 1) { assets.push({ id: 31, name, label: 'sha256:aaa', size: 3, state: 'starter' }); return json(500, { message: 'x' }); }
      assets.push({ id: 32, name, label: c.query.get('label'), size: init.body.length, state: 'uploaded' });
      return json(201, assets.at(-1));
    }
    if (c.method === 'GET' && c.path === '/repos/isokron-ai/tool-qa/releases/7/assets') return json(200, assets);
    if (c.method === 'DELETE') { assets.splice(assets.findIndex((a) => `/repos/isokron-ai/tool-qa/releases/assets/${a.id}` === c.path), 1); return new Response(null, { status: 204 }); }
    return json(500, { message: `unexpected ${c.method} ${c.path}` });
  });
  const release = { id: 7, upload_url: 'https://uploads.github.test/repos/isokron-ai/tool-qa/releases/7/assets{?name,label}' };
  const a = await w.gh.upload(release, 'state-1.age', Buffer.from('hello'), 'sha256:bbb');
  assert.equal(a.id, 32);
  assert.deepEqual(assets.map((x) => x.id), [32], 'the half-stored asset was deleted, one asset remains');

  // Stored completely, reply lost: used as it is.
  assets.length = 0;
  uploads = 0;
  const full = world((c, init) => {
    if (c.method === 'POST') { uploads += 1; assets.push({ id: 40, name: c.query.get('name'), label: c.query.get('label'), size: init.body.length, state: 'uploaded' }); return json(504, { message: 'gateway timeout' }); }
    if (c.method === 'GET') return json(200, assets);
    return json(500, {});
  });
  const b = await full.gh.upload(release, 'state-2.age', Buffer.from('hello'), 'sha256:ccc');
  assert.equal(b.id, 40);
  assert.equal(uploads, 1, 'sent once');
});

test('R-CHAOS-17: a release create that failed with a server error is looked up before it is repeated', async () => {
  let created = 0;
  const w = world((c) => {
    if (c.method === 'POST') { created += 1; return json(500, { message: 'x' }); }
    if (c.path.endsWith('/releases/tags/snaps')) return created ? json(200, { id: 9, assets: [] }) : json(404, { message: 'Not Found' });
    return json(500, {});
  });
  const r = await w.gh.createRelease({ tag: 'snaps', name: 'n', body: 'b' });
  assert.equal(r.id, 9);
  assert.equal(created, 1);
});
