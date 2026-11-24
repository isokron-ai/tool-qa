import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { archivePull, main, resolveToken } from '../scripts/archive-pull.mjs';
import { API, fakeApi, fakeClock } from './lib/fake-api.mjs';
import { makeZip } from './lib/zip.mjs';

const REPO = 'isokron-ai/tool-qa';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HOUR = 3_600_000;

function registryZip(tag, { badHash = false } = {}) {
  const gz = gzipSync(Buffer.from(`{"server":"${tag}"}\n`));
  const manifest = { mode: 'delta', file: `registry-${tag}.ndjson.gz`, sha256: badHash ? '0'.repeat(64) : sha(gz), errors: [] };
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: `registry-${tag}.ndjson.gz`, data: gz },
  ]);
}

function packagesZip() {
  const npm = gzipSync(Buffer.from('{"name":"a"}\n'));
  const pypi = gzipSync(Buffer.from('{"name":"b"}\n'));
  const manifest = { schema: 1, source: 'npm', files: [{ name: 'npm.ndjson.gz', sha256: sha(npm) }, { name: 'pypi/pypi.ndjson.gz', sha256: sha(pypi) }] };
  return makeZip([
    { name: 'manifest-npm.json', data: JSON.stringify(manifest) },
    { name: 'npm.ndjson.gz', data: npm },
    { name: 'pypi/pypi.ndjson.gz', data: pypi },
  ]);
}

function world() {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const ago = (h) => new Date(c.t - h * HOUR).toISOString();
  const artifacts = [];
  const zips = new Map();
  const add = (id, name, zip, { hoursAgo = 1, expired = false, digest } = {}) => {
    artifacts.unshift({ id, name, created_at: ago(hoursAgo), expired, size_in_bytes: zip?.length ?? 0, workflow_run: { id: id * 10, head_sha: 'abc' }, ...(digest ? { digest } : {}) });
    if (zip) zips.set(id, zip);
  };
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/artifacts`, (req) => {
      const per = Number(req.query.get('per_page') ?? 30);
      const page = Number(req.query.get('page') ?? 1);
      return { body: { total_count: artifacts.length, artifacts: artifacts.slice((page - 1) * per, page * per) } };
    }],
    ['GET', /\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://storage.test/blob/${req.path.split('/')[6]}?sig=secret` } })],
    ['GET', /^\/blob\/\d+$/, (req) => ({ body: zips.get(Number(req.path.split('/')[2])) })],
  ]);
  const dest = mkdtempSync(join(tmpdir(), 'archive-'));
  const opts = { dest, repo: REPO, token: 'ghs_synthetic_archive', fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep, log: () => {} };
  return { c, api, add, opts, dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

const index = (dest) => readFileSync(join(dest, 'index.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const downloads = (api) => api.calls.filter((r) => r.url.startsWith('https://storage.test/'));

test('pulls new history artifacts, verifies them, and indexes them', async () => {
  const w = world();
  w.add(1, 'registry-delta-20260302T1000Z', registryZip('a'), { hoursAgo: 2 });
  w.add(2, 'history-packages-77', packagesZip(), { hoursAgo: 1 });
  w.add(3, 'something-else', makeZip([{ name: 'x', data: 'x' }]));
  w.add(4, 'history-popularity-5', null, { expired: true });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.pulled, ['registry-delta-20260302T1000Z', 'history-packages-77']);
  assert.deepEqual(out.failed, []);
  assert.ok(existsSync(join(w.dest, 'registry-delta-20260302T1000Z', 'registry-a.ndjson.gz')));
  assert.ok(existsSync(join(w.dest, 'history-packages-77', 'pypi', 'pypi.ndjson.gz')));
  const idx = index(w.dest);
  assert.deepEqual(idx.map((e) => e.id), [1, 2]);
  assert.equal(idx[1].verified, 'manifest');
  assert.equal(idx[1].files.length, 3);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.last_created_at, '2026-03-02T11:00:00.000Z');
  // the storage download carries no token; the API calls do
  for (const d of downloads(w.api)) assert.equal(d.headers.get('authorization'), null);
  assert.equal(w.api.calls[0].headers.get('authorization'), 'Bearer ghs_synthetic_archive');
  assert.equal(readdirSync(w.dest).filter((n) => n.startsWith('.partial')).length, 0);
  w.cleanup();
});

test('a second run downloads only what is new', async () => {
  const w = world();
  w.add(1, 'registry-delta-1', registryZip('a'), { hoursAgo: 2 });
  await archivePull(w.opts);
  w.c.t += HOUR;
  w.add(5, 'registry-full-2', registryZip('b'), { hoursAgo: 0.5 });
  const before = downloads(w.api).length;
  const out = await archivePull(w.opts);
  assert.deepEqual(out.pulled, ['registry-full-2']);
  assert.equal(downloads(w.api).length - before, 1);
  assert.deepEqual(index(w.dest).map((e) => e.id), [1, 5]);
  w.cleanup();
});

test('a checksum mismatch is not kept or indexed, and is retried next time', async () => {
  const w = world();
  w.add(1, 'registry-delta-ok', registryZip('a'), { hoursAgo: 3 });
  w.add(2, 'registry-delta-bad', registryZip('b', { badHash: true }), { hoursAgo: 2 });
  w.add(3, 'registry-delta-later', registryZip('c'), { hoursAgo: 1 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.name), ['registry-delta-bad']);
  assert.match(out.failed[0].error, /sha256/);
  assert.equal(existsSync(join(w.dest, 'registry-delta-bad')), false);
  assert.deepEqual(index(w.dest).map((e) => e.id), [1, 3]);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.last_created_at, '2026-03-02T10:00:00.000Z', 'the cursor stays at the failed artifact');
  const again = await archivePull(w.opts);
  assert.deepEqual(again.failed.map((f) => f.name), ['registry-delta-bad'], 'retried, still failing');
  w.cleanup();
});

test('an artifact digest from GitHub is checked against the download', async () => {
  const w = world();
  const zip = registryZip('a');
  w.add(1, 'registry-delta-x', zip, { digest: `sha256:${'f'.repeat(64)}` });
  w.add(2, 'registry-delta-y', registryZip('b'), { digest: `sha256:${sha(registryZip('b'))}` });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.name), ['registry-delta-x']);
  assert.deepEqual(out.pulled, ['registry-delta-y']);
  w.cleanup();
});

test('existing folders are never overwritten', async () => {
  const w = world();
  mkdirSync(join(w.dest, 'registry-delta-1'));
  writeFileSync(join(w.dest, 'registry-delta-1', 'mine.txt'), 'keep me');
  w.add(9, 'registry-delta-1', registryZip('a'));
  const out = await archivePull(w.opts);
  assert.deepEqual(out.pulled, ['registry-delta-1']);
  assert.equal(readFileSync(join(w.dest, 'registry-delta-1', 'mine.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(w.dest, 'registry-delta-1.9', 'manifest.json')));
  assert.equal(index(w.dest)[0].dir, 'registry-delta-1.9');
  w.cleanup();
});

test('a folder left by an interrupted run is indexed without downloading again', async () => {
  const w = world();
  w.add(1, 'registry-delta-1', registryZip('a'));
  await archivePull(w.opts);
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, '.last-pull.json'));
  const before = downloads(w.api).length;
  const out = await archivePull(w.opts);
  assert.deepEqual(out.recovered, ['registry-delta-1']);
  assert.equal(downloads(w.api).length, before);
  assert.deepEqual(index(w.dest).map((e) => e.id), [1]);
  w.cleanup();
});

test('a first pull of a long backlog pages through the list and waits for the budget instead of failing', async () => {
  const w = world();
  const zip = registryZip('a');
  for (let i = 1; i <= 250; i++) w.add(i, `registry-delta-${String(i).padStart(4, '0')}`, zip, { hoursAgo: 300 - i });
  const out = await archivePull(w.opts);
  assert.equal(out.failed.length, 0, out.failed[0]?.error);
  assert.equal(out.pulled.length, 250);
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/actions/artifacts')).length, 3);
  w.cleanup();
});

test('--dry-run lists without writing', async () => {
  const w = world();
  w.add(1, 'registry-delta-1', registryZip('a'));
  const out = await archivePull({ ...w.opts, dryRun: true });
  assert.deepEqual(out.wouldPull, ['registry-delta-1']);
  assert.equal(downloads(w.api).length, 0);
  assert.deepEqual(readdirSync(w.dest), []);
  w.cleanup();
});

test('the token comes from the environment, else from the GitHub CLI', () => {
  assert.equal(resolveToken({ GITHUB_TOKEN: 'a' }, () => assert.fail('not called')), 'a');
  assert.equal(resolveToken({ GH_TOKEN: 'b' }, () => assert.fail('not called')), 'b');
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: 'ghs_from_cli\n' };
  };
  assert.equal(resolveToken({}, run), 'ghs_from_cli');
  assert.deepEqual(calls, [['gh', 'auth', 'token']]);
  assert.equal(resolveToken({}, () => ({ status: 1, stdout: '' })), null);
  assert.equal(resolveToken({}, () => ({ error: new Error('ENOENT') })), null);
});

test('the CLI needs --dest and exits 1 when something failed', async () => {
  assert.equal(await main([], {}, {}), 2);
  const w = world();
  w.add(2, 'registry-delta-bad', registryZip('b', { badHash: true }));
  const code = await main(['--dest', w.dest], {}, { ...w.opts, dest: undefined });
  assert.equal(code, 1);
  w.cleanup();
});
