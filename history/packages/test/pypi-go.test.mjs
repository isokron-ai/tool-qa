import test from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, noSleep } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import { parseChangelog, runPypi } from '../pypi.mjs';
import { runGo } from '../go.mjs';

const row = (n, v, ts, a, s) => `<value><array><data><value><string>${n}</string></value><value>${v === null ? '<nil/>' : `<string>${v}</string>`}</value><value><int>${ts}</int></value><value><string>${a}</string></value><value><int>${s}</int></value></data></array></value>`;
const resp = (...rows) => `<?xml version='1.0'?><methodResponse><params><param><value><array><data>${rows.join('')}</data></array></value></param></params></methodResponse>`;

test('parseChangelog', () => {
  const ev = parseChangelog(resp(row('a&amp;b', '1.0', 10, 'new release', 7), row('x', null, 11, 'create', 8)));
  assert.deepEqual(ev, [
    { name: 'a&b', version: '1.0', timestamp: 10, action: 'new release', serial: 7 },
    { name: 'x', version: null, timestamp: 11, action: 'create', serial: 8 },
  ]);
});

test('pypi filters by name and advances serial to the max seen', async () => {
  const f = mockFetch((url, init) => {
    if (init.body.includes('changelog_last_serial')) return { body: '<methodResponse><params><param><value><int>50</int></value></param></params></methodResponse>' };
    return { body: resp(row('requests', '2', 1, 'new release', 41), row('fastmcp-x', '0.1', 2, 'new release', 42), row('mcp', null, 3, 'create', 43)) };
  });
  const http = createHttp({ fetch: f, sleep: noSleep });
  const r = await runPypi({ http, state: { serial: 40 }, now: 0 });
  assert.deepEqual(r.rows.map((x) => x.id), ['mcp']);
  assert.equal(r.state.serial, 43);
  assert.match(f.calls.at(-1).init.body, /changelog_since_serial.*<int>40<\/int>/s);
});

test('pypi first run starts at current serial', async () => {
  const f = mockFetch(() => ({ body: '<methodResponse><params><param><value><int>50</int></value></param></params></methodResponse>' }));
  const r = await runPypi({ http: createHttp({ fetch: f, sleep: noSleep }), state: {} });
  assert.equal(r.state.serial, 50);
  assert.equal(f.calls.length, 1);
});

test('go pages through the index, dedupes, filters by path', async () => {
  const line = (p, v, t) => JSON.stringify({ Path: p, Version: v, Timestamp: t });
  const pages = [
    [line('github.com/a/mcp-go', 'v1', '2026-01-01T00:00:00Z'), line('github.com/a/other', 'v1', '2026-01-01T00:00:01Z')],
    [line('github.com/a/other', 'v1', '2026-01-01T00:00:01Z'), line('github.com/b/mcp', 'v2', '2026-01-01T00:00:02Z')],
  ];
  const f = mockFetch((url) => ({ body: (pages[url.includes('since=2026-01-01T00%3A00%3A00Z') ? 0 : url.includes('00%3A01Z') ? 1 : 2] ?? []).join('\n') }));
  const r = await runGo({ http: createHttp({ fetch: f, sleep: noSleep }), state: { since: '2026-01-01T00:00:00Z' }, limit: 2, now: 0 });
  assert.deepEqual(r.rows.map((x) => x.path), ['github.com/a/mcp-go', 'github.com/b/mcp']);
  assert.equal(r.state.since, '2026-01-01T00:00:02Z');
});
