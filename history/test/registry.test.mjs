import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capture, SCRIPT_VERSION } from '../registry.mjs';

const srv = (n, v = '1.0.0') => ({ server: { name: `io.example/s${n}`, version: v }, _meta: { n } });
const json = (o) => ({ status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify(o) });
const status = (s) => ({ status: s, ok: false, headers: new Headers(), text: async () => '' });

function mock(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return script[calls.length - 1]();
  };
  return { fetchFn, calls };
}
const fixedNow = () => new Date('2026-11-21T03:17:00.000Z');

test('full: 3 pages incl. 429 and a malformed page', async () => {
  const bad = '{"servers":[{"oops": \u0000 ,"x"], "metadata":{"nextCursor":"c3","count":1}}';
  const { fetchFn, calls } = mock([
    () => json({ servers: [srv(1), srv(2, '2.0.0')], metadata: { nextCursor: 'c2' } }),
    () => status(429),
    () => ({ status: 200, ok: true, headers: new Headers(), text: async () => bad }),
    () => json({ servers: [srv(3)], metadata: {} }),
  ]);
  const sleeps = [];
  const out = await mkdtemp(path.join(tmpdir(), 'h1-'));
  const m = await capture({ mode: 'full', outDir: out, fetchFn, sleep: async (ms) => sleeps.push(ms), now: fixedNow });

  assert.equal(calls.length, 4);
  assert.ok(!calls[0].url.includes('version=latest'));
  assert.ok(calls[0].url.includes('limit=100'));
  assert.ok(calls[1].url.includes('cursor=c2') && calls[2].url.includes('cursor=c2'));
  assert.ok(calls[3].url.includes('cursor=c3'));
  assert.match(calls[0].init.headers['User-Agent'], new RegExp(`^isokron-tool-qa/${SCRIPT_VERSION} \\(\\+https://github.com/isokron-ai/tool-qa\\)$`));
  assert.ok(sleeps.filter((s) => s === 150).length === 2);
  assert.equal(sleeps.length, 3); // two page delays + one backoff

  assert.equal(m.pages, 2);
  assert.equal(m.lines, 3);
  assert.equal(m.errors.length, 1);
  assert.match(m.errors[0].error, /malformed/);
  assert.equal(m.errors[0].recovered_cursor, true);

  const gz = await readFile(path.join(out, m.file));
  assert.equal(createHash('sha256').update(gz).digest('hex'), m.sha256);
  const lines = gunzipSync(gz).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [srv(1), srv(2, '2.0.0'), srv(3)]);

  const disk = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(disk, m);
  assert.equal(m.mode, 'full');
  assert.equal(m.versions, 'all');
  assert.equal(m.started_utc, '2026-11-21T03:17:00.000Z');
  assert.equal(m.script_version, SCRIPT_VERSION);
  assert.ok(m.source.startsWith('https://registry.modelcontextprotocol.io/v0.1/servers?'));
});

test('gives up after 5 retries and records the error', async () => {
  const { fetchFn, calls } = mock(Array(10).fill(() => status(503)));
  const out = await mkdtemp(path.join(tmpdir(), 'h1-'));
  const m = await capture({ outDir: out, fetchFn, sleep: async () => {}, now: fixedNow });
  assert.equal(calls.length, 6);
  assert.equal(m.errors.length, 1);
  assert.equal(m.lines, 0);
});

test('delta: uses state file, sends updated_since, advances state only on clean run', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'h1-'));
  const state = path.join(out, 'state.json');
  await writeFile(state, JSON.stringify({ last_start: '2026-11-21T03:00:00.000Z' }));
  const { fetchFn, calls } = mock([() => json({ servers: [srv(9)], metadata: {} })]);
  const m = await capture({ mode: 'delta', outDir: out, statePath: state, fetchFn, sleep: async () => {}, now: fixedNow });
  assert.ok(calls[0].url.includes('updated_since=2026-11-21T03%3A00%3A00.000Z'));
  assert.equal(m.updated_since, '2026-11-21T03:00:00.000Z');
  assert.equal(m.lines, 1);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).last_start, '2026-11-21T03:17:00.000Z');

  const f2 = mock([() => status(500), () => status(500), () => status(500), () => status(500), () => status(500), () => status(500)]);
  await capture({ mode: 'delta', outDir: out, statePath: state, fetchFn: f2.fetchFn, sleep: async () => {}, now: () => new Date('2026-11-21T04:00:00Z') });
  assert.equal(JSON.parse(await readFile(state, 'utf8')).last_start, '2026-11-21T03:17:00.000Z');
});

test('delta without a since value fails', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'h1-'));
  await assert.rejects(capture({ mode: 'delta', outDir: out, fetchFn: async () => { throw new Error('no'); } }), /since/);
});
