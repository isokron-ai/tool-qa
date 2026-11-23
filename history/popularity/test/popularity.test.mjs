import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch, noSleep } from '../../packages/test/helpers.mjs';
import { createHttp } from '../../packages/lib/http.mjs';
import { parseSeed, readSeed } from '../seed.mjs';
import { npmPopularity, pypiPopularity, cratesPopularity } from '../registries.mjs';
import { githubPopularity } from '../github.mjs';
import { runPopularity, readNdjsonGz } from '../run.mjs';

const mk = (h) => { const f = mockFetch(h); return { f, http: createHttp({ fetch: f, sleep: noSleep }) }; };

test('shipped seed parses and has the expected shape', () => {
  const s = readSeed(new URL('../../seed.txt', import.meta.url));
  assert.ok(s.github.length >= 900, 'about 1,000 github subjects');
  assert.ok(s.npm.length > 0 && s.pypi.length > 0 && s.crates.length > 0);
  for (const n of ['isokron-ai/mcp-check', 'github/github-mcp-server', 'modelcontextprotocol/servers']) assert.ok(s.github.includes(n), n);
  assert.ok(s.npm.includes('@isokron/mcp-check'));
});
test('parseSeed', () => {
  const s = parseSeed('# c\nnpm:@a/b\nnpm:@a/b\n\nPyPI: x # trailing\ngithub:o/r\ncrates:c\n'.replace('PyPI: x', 'PyPI: x'));
  assert.deepEqual(s, { npm: ['@a/b'], pypi: ['x'], crates: ['c'], github: ['o/r'] });
  assert.throws(() => parseSeed('foo:bar'), /line 1/);
  assert.throws(() => parseSeed('npm'), /line 1/);
  assert.throws(() => parseSeed('github:norepo'), /owner\/repo/);
});

test('npm popularity encodes scoped names and records both views', async () => {
  const { f, http } = mk((u) => ({ body: u.includes('/versions/') ? { downloads: { '1.0.0': 5 } } : { downloads: 9, start: '2026-11-16', end: '2026-11-22' } }));
  const r = await npmPopularity(http, ['@a/b'], { now: 0, sleep: noSleep });
  assert.equal(r.rows[0].downloads_week, 9);
  assert.deepEqual(r.rows[0].per_version, { '1.0.0': 5 });
  assert.ok(f.calls.every((c) => c.url.includes('%40a%2Fb') || c.url.includes('@a%2Fb')));
});
test('pypistats and per-item errors', async () => {
  const { http } = mk((u) => (u.includes('bad') ? { status: 404, body: {} } : { body: { data: { last_day: 1, last_week: 7, last_month: 30 } } }));
  const r = await pypiPopularity(http, ['Good', 'bad'], { now: 0, sleep: noSleep });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].last_week, 7);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.missing, ['pypi:bad']);
  const boom = mk(() => ({ status: 500, body: {} }));
  const e = await pypiPopularity(createHttp({ fetch: boom.f, sleep: noSleep, retries: 0 }), ['x'], { now: 0, sleep: noSleep });
  assert.equal(e.errors.length, 1, 'a server error is still an error');
});
test('npm: a gone package is missing, not an error', async () => {
  const { http } = mk(() => ({ status: 404, body: {} }));
  const r = await npmPopularity(http, ['gone'], { now: 0, sleep: noSleep });
  assert.deepEqual([r.rows.length, r.errors, r.missing], [0, [], ['npm:gone']]);
});
test('crates projection', () => {
  const r = cratesPopularity([{ id: 'a', downloads_total: 3, versions: 2, latest_version_at: 'x' }], ['a', 'b'], { now: 0 });
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.missing, ['crates:b']);
});

test('github: ETag sent, 304 reuses cache and still emits a row, token used', async () => {
  const body = { stargazers_count: 10, forks_count: 2, pushed_at: 'p' };
  const { f, http } = mk((u, init) => {
    const inm = init.headers['if-none-match'];
    if (u.endsWith('/releases/latest')) return inm ? { status: 304, body: '', headers: { 'x-ratelimit-remaining': '4000' } } : { headers: { etag: '"r1"', 'x-ratelimit-remaining': '4000' }, body: { tag_name: 'v1', published_at: 't' } };
    return inm ? { status: 304, body: '', headers: { 'x-ratelimit-remaining': '4000' } } : { headers: { etag: '"c1"' }, body };
  });
  const a = await githubPopularity(http, ['o/r'], { token: 'T', now: 0 });
  assert.equal(a.rows[0].stars, 10);
  assert.equal(a.rows[0].latest_release.tag, 'v1');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer T');
  const b = await githubPopularity(http, ['o/r'], { token: 'T', state: a.state, now: 1 });
  assert.equal(b.stats.not_modified, 2);
  assert.equal(b.rows[0].stars, 10);
  assert.equal(b.rows[0].latest_release.tag, 'v1');
  assert.equal(f.calls.at(-1).init.headers['if-none-match'], '"r1"');
});
test('github: 404 release is null, rate limit stops the loop', async () => {
  const { http } = mk((u) => (u.endsWith('/releases/latest') ? { status: 404, body: {} } : { body: { stargazers_count: 1, forks_count: 0 }, headers: {} }));
  const a = await githubPopularity(http, ['o/r'], { now: 0 });
  assert.equal(a.rows[0].latest_release, null);
  const lim = mk(() => ({ status: 403, body: {} }));
  const b = await githubPopularity(lim.http, ['o/a', 'o/b'], { now: 0 });
  assert.equal(b.rows.length, 0);
  assert.equal(b.stats.skipped_rate_limit, 2);
  assert.equal(lim.f.calls.length, 1);
  assert.equal(b.errors.length, 1, 'a stop before any repo was read is an error (broken token)');
});
test('github: a stop after some rows is a warning, a gone repo is missing', async () => {
  let n = 0;
  const { http } = mk((u) => {
    if (u.includes('/o/gone')) return { status: 404, body: {}, headers: { 'x-ratelimit-remaining': '900' } };
    n++; if (n > 2) return { status: 403, body: {} };
    return u.endsWith('/releases/latest') ? { status: 404, body: {}, headers: { 'x-ratelimit-remaining': '900' } } : { body: { stargazers_count: 1, forks_count: 0 }, headers: {} };
  });
  const r = await githubPopularity(http, ['o/gone', 'o/a', 'o/b', 'o/c'], { now: 0 });
  assert.deepEqual(r.rows.map((x) => x.id), ['o/a']);
  assert.deepEqual(r.missing, ['github:o/gone']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.rate_limited, true);
  assert.equal(r.stats.skipped_rate_limit, 2);
  assert.match(r.warnings[0], /2 of 4 repos not read/);
});

test('runPopularity: empty seed makes no network calls and writes a clean manifest', async () => {
  const { f, http } = mk(() => { throw new Error('network'); });
  const out = mkdtempSync(join(tmpdir(), 'p-')); const stateDir = mkdtempSync(join(tmpdir(), 'ps-'));
  const m = await runPopularity({ seed: parseSeed(''), mode: 'all', http, out, stateDir, now: Date.parse('2026-11-23T00:00:00Z') });
  assert.equal(m.ok, true);
  assert.equal(f.calls.length, 0);
  assert.equal(m.files.length, 4);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest-popularity-all.json'))).source, 'popularity-all');
});
test('runPopularity downloads mode with data', async () => {
  const { http } = mk((u) => ({ body: u.includes('/versions/') ? { downloads: {} } : { downloads: 1, start: 's', end: 'e' } }));
  const out = mkdtempSync(join(tmpdir(), 'p-')); const stateDir = mkdtempSync(join(tmpdir(), 'ps-'));
  const m = await runPopularity({ seed: parseSeed('npm:x'), mode: 'downloads', http, out, stateDir, sleep: noSleep, delayMs: 0 });
  assert.equal(readNdjsonGz(join(out, m.files[0].name)).length, 1);
});
