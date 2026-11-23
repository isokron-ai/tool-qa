import test from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, noSleep } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import { runNpm } from '../npm.mjs';

const NOW = Date.parse('2026-11-23T04:00:00Z');
function setup(feedResults, docs) {
  const f = mockFetch((url) => {
    if (url.startsWith('https://replicate.npmjs.com/_changes')) return { body: { results: feedResults, last_seq: feedResults.at(-1)?.seq ?? 5 } };
    if (url === 'https://replicate.npmjs.com/') return { body: { update_seq: 100 } };
    if (url.includes('/-/v1/search')) return { body: { objects: [{ package: { name: 'kw-only' } }] } };
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    return docs[name] ? { body: docs[name] } : { status: 404, body: {} };
  });
  return { f, http: createHttp({ fetch: f, sleep: noSleep }) };
}

test('first run initialises at update_seq and reads nothing else', async () => {
  const { f, http } = setup([], {});
  const r = await runNpm({ http, now: NOW, refresh: false });
  assert.equal(r.state.since, 100);
  assert.deepEqual(r.rows, []);
  assert.ok(f.calls.every((c) => !c.url.includes('_changes')));
});

test('filters feed, fetches packuments, reports changed versions', async () => {
  const feed = [
    { seq: 101, id: 'lodash' },
    { seq: 102, id: '@acme/mcp-server' },
    { seq: 103, id: 'kw-only' },
    { seq: 104, id: 'gone-mcp', deleted: true },
    { seq: 105, id: 'mcp-liar' },
  ];
  const docs = {
    '@acme/mcp-server': { name: '@acme/mcp-server', time: { modified: '2026-11-22T10:00:00Z', '1.0.0': '2026-01-01T00:00:00Z', '1.1.0': '2026-11-22T10:00:00Z' }, versions: { '1.0.0': {}, '1.1.0': {} } },
    'kw-only': { name: 'kw-only', keywords: ['modelcontextprotocol'], time: { modified: '2026-11-22T11:00:00Z', '0.1.0': '2026-11-22T11:00:00Z' }, versions: { '0.1.0': {} } },
    'mcp-liar': { name: 'mcp-liar', time: {}, versions: {} },
  };
  const { f, http } = setup(feed, docs);
  const r = await runNpm({ http, now: NOW, state: { since: 100, last_run_ms: NOW - 86400000 } });
  assert.deepEqual(r.rows.map((x) => x.id), ['@acme/mcp-server', 'kw-only', 'gone-mcp', 'mcp-liar']);
  assert.deepEqual(r.rows[0].versions_changed, ['1.1.0']);
  assert.deepEqual(r.rows[1].match, ['keyword']);
  assert.equal(r.rows[2].deleted, true);
  assert.equal(r.state.since, 105);
  assert.ok(r.state.known.includes('kw-only'));
  assert.ok(f.calls.some((c) => c.url.endsWith('/%40acme%2Fmcp-server') || c.url.includes('%2Fmcp-server')));
  assert.ok(!f.calls.some((c) => c.url.endsWith('/lodash')));
});

test('a failed packument fetch does not advance since', async () => {
  const f = mockFetch((url) => (url.startsWith('https://replicate.npmjs.com/_changes')
    ? { body: { results: [{ seq: 101, id: 'a-mcp' }], last_seq: 101 } }
    : { status: 403, body: {} }));
  const http = createHttp({ fetch: f, sleep: noSleep });
  const r = await runNpm({ http, now: NOW, state: { since: 100 }, refresh: false });
  assert.equal(r.state.since, 100);
  assert.equal(r.errors.length, 1);
});

test('retries on 429 honouring Retry-After', async () => {
  let n = 0; const sleeps = [];
  const f = mockFetch(() => (++n < 3 ? { status: 429, headers: { 'retry-after': '2' }, body: {} } : { body: { ok: 1 } }));
  const http = createHttp({ fetch: f, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await http.json('https://x/'), { ok: 1 });
  assert.deepEqual(sleeps, [2000, 2000]);
});

for (const status of [404, 410]) {
  test(`a packument that returns ${status} is recorded as deleted and the feed advances`, async () => {
    const feed = [{ seq: 101, id: 'gone-mcp' }, { seq: 102, id: 'ok-mcp' }];
    const f = mockFetch((url) => {
      if (url.startsWith('https://replicate.npmjs.com/_changes')) return { body: { results: feed, last_seq: 102 } };
      if (url.endsWith('/gone-mcp')) return { status, body: {} };
      return { body: { name: 'ok-mcp', time: { modified: '2026-11-23T01:00:00Z' }, versions: {} } };
    });
    const http = createHttp({ fetch: f, sleep: noSleep });
    const r = await runNpm({ http, now: NOW, state: { since: 100 }, refresh: false });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.id, x.deleted]), [['gone-mcp', true], ['ok-mcp', false]]);
    assert.equal(r.state.since, 102);
  });
}
