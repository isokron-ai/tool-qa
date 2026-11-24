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

// ---- sealed ingest outputs ----

const AGE = (tag) => Buffer.concat([Buffer.from('age-encryption.org/v1\n-> X25519 synthetic\n--- mac\n'), Buffer.from(`sealed ${tag}`)]);

function ingestZip(attempt, count = 2) {
  return makeZip(Array.from({ length: count }, (_, i) => ({ name: `ingest-${attempt}-${i}.tar.age`, data: AGE(`${attempt}-${i}`), method: 'store' })));
}

const manifestLines = (dest) => {
  const file = join(dest, 'ingest', 'manifest.ndjson');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('ingest artifacts are archived sealed, by day and run, with one manifest line each', async () => {
  const w = world();
  const zip = ingestZip('att-a', 3);
  w.add(7, 'ingest-70-2', zip, { hoursAgo: 13, digest: `sha256:${sha(zip)}` });
  w.add(8, 'registry-delta-1', registryZip('a'), { hoursAgo: 1 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.pulled, ['ingest-70-2', 'registry-delta-1']);
  assert.equal(out.bytes, zip.length + registryZip('a').length);
  const dir = join('ingest', '2026-03-01', 'ingest-70-2');
  for (let i = 0; i < 3; i++) {
    // stored byte for byte as uploaded: nothing is decrypted
    assert.deepEqual(readFileSync(join(w.dest, dir, `ingest-att-a-${i}.tar.age`)), AGE(`att-a-${i}`));
  }
  const m = manifestLines(w.dest);
  assert.equal(m.length, 1);
  assert.equal(m[0].artifact_id, 7);
  assert.equal(m[0].artifact, 'ingest-70-2');
  assert.equal(m[0].run_id, 70);
  assert.equal(m[0].run_attempt, 2);
  assert.equal(m[0].attempt_id, null);
  assert.equal(m[0].date, '2026-03-01');
  assert.equal(m[0].dir, dir);
  assert.equal(m[0].artifact_bytes, zip.length);
  assert.equal(m[0].artifact_sha256, sha(zip));
  assert.deepEqual(m[0].files.map((f) => f.name), ['ingest-att-a-0.tar.age', 'ingest-att-a-1.tar.age', 'ingest-att-a-2.tar.age']);
  assert.equal(m[0].files[1].bytes, AGE('att-a-1').length);
  assert.equal(m[0].files[1].sha256, sha(AGE('att-a-1')));
  assert.equal(index(w.dest).find((e) => e.id === 7).digest_checked, true);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.deepEqual(cursor.by_kind, { history: '2026-03-02T11:00:00.000Z', ingest: '2026-03-01T23:00:00.000Z' });
  assert.equal(cursor.last_created_at, '2026-03-02T11:00:00.000Z');
  // a second run pulls nothing and writes no second manifest line
  const again = await archivePull(w.opts);
  assert.deepEqual(again.pulled, []);
  assert.equal(again.already, 2);
  assert.equal(manifestLines(w.dest).length, 1);
  w.cleanup();
});

test('an ingest artifact holding a file that is not age-encrypted is refused, not kept, and retried', async () => {
  const w = world();
  w.add(1, 'ingest-10-1', makeZip([{ name: 'ingest-x-0.tar.age', data: AGE('x') }, { name: 'ingest-x-1.tar', data: 'plain tar' }]), { hoursAgo: 2 });
  w.add(2, 'ingest-11-1', ingestZip('y', 1), { hoursAgo: 1 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.name), ['ingest-10-1']);
  assert.match(out.failed[0].error, /ingest-x-1\.tar is not an age-encrypted file/);
  assert.equal(existsSync(join(w.dest, 'ingest', '2026-03-02', 'ingest-10-1')), false);
  assert.deepEqual(manifestLines(w.dest).map((m) => m.artifact_id), [2]);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.by_kind.ingest, '2026-03-02T10:00:00.000Z', 'held at the refused artifact');
  const again = await archivePull(w.opts);
  assert.deepEqual(again.failed.map((f) => f.name), ['ingest-10-1']);
  w.cleanup();
});

test('a manual re-ingest artifact uploaded unzipped is kept as its one sealed file', async () => {
  const w = world();
  const sealed = AGE('manual');
  w.add(3, 'ingest-5c1e0f2a-0000-4000-8000-000000000001.tar.age', sealed, { hoursAgo: 1, digest: `sha256:${sha(sealed)}` });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  const dir = join('ingest', '2026-03-02', 'ingest-5c1e0f2a-0000-4000-8000-000000000001.tar.age');
  assert.deepEqual(readFileSync(join(w.dest, dir, 'ingest-5c1e0f2a-0000-4000-8000-000000000001.tar.age')), sealed);
  const [m] = manifestLines(w.dest);
  assert.equal(m.run_id, 30, 'the run id comes from the artifact');
  assert.equal(m.run_attempt, null);
  assert.equal(m.attempt_id, '5c1e0f2a-0000-4000-8000-000000000001');
  w.cleanup();
});

test('R-ARC-01: an archive whose cursor predates ingest still pulls every older ingest artifact', async () => {
  const w = world();
  // An archive made by the earlier version: history only, cursor one hour ago.
  writeFileSync(join(w.dest, '.last-pull.json'), `${JSON.stringify({ last_created_at: '2026-03-02T11:00:00.000Z' })}\n`);
  w.add(1, 'ingest-1-1', ingestZip('old', 1), { hoursAgo: 100 });
  w.add(2, 'registry-delta-old', registryZip('a'), { hoursAgo: 100 });
  w.add(3, 'ingest-3-1', ingestZip('new', 1), { hoursAgo: 0.5 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.pulled, ['ingest-1-1', 'ingest-3-1'], 'old ingest pulled; old history still behind its own cursor');
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.by_kind.history, '2026-03-02T11:00:00.000Z');
  assert.equal(cursor.by_kind.ingest, '2026-03-02T11:30:00.000Z');
  w.cleanup();
});

test('R-ARC-02: a listing cut off by the page cap keeps the cursor and exits 1', async () => {
  const w = world();
  const zip = ingestZip('p', 1);
  for (let i = 1; i <= 250; i++) w.add(i, `ingest-${i}-1`, zip, { hoursAgo: 300 - i });
  const out = await archivePull({ ...w.opts, maxPages: 2 });
  assert.equal(out.complete, false);
  assert.equal(out.pulled.length, 200, 'what it saw is still archived');
  assert.equal(existsSync(join(w.dest, '.last-pull.json')), false, 'no cursor that would hide the unseen artifacts');
  const full = await archivePull(w.opts);
  assert.equal(full.complete, true);
  assert.equal(full.pulled.length, 50, 'a later full listing finds the rest');
  assert.equal(full.already, 200);
  assert.equal(await main(['--dest', w.dest], {}, { ...w.opts, dest: undefined, maxPages: 1 }), 1);
  w.cleanup();
});

test('R-ARC-03: a line appended after a torn last line stays whole, in the index and the manifest', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('a', 1), { hoursAgo: 2 });
  await archivePull(w.opts);
  // an interrupted run left half a line in both files
  writeFileSync(join(w.dest, 'index.ndjson'), `${readFileSync(join(w.dest, 'index.ndjson'), 'utf8')}{"id":99,"na`);
  writeFileSync(join(w.dest, 'ingest', 'manifest.ndjson'), `${readFileSync(join(w.dest, 'ingest', 'manifest.ndjson'), 'utf8')}{"artifact_id":9`);
  w.add(2, 'ingest-2-1', ingestZip('b', 1), { hoursAgo: 1 });
  const before = downloads(w.api).length;
  const out = await archivePull(w.opts);
  assert.deepEqual(out.pulled, ['ingest-2-1']);
  assert.equal(downloads(w.api).length - before, 1);
  // the torn half stays as it was (nothing is rewritten); every whole line parses
  const whole = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  assert.deepEqual(whole(join(w.dest, 'index.ndjson')).map((e) => e.id), [1, 2]);
  assert.deepEqual(whole(join(w.dest, 'ingest', 'manifest.ndjson')).map((m) => m.artifact_id), [1, 2]);
  // and the next run does not pull or recover it again
  const again = await archivePull(w.opts);
  assert.deepEqual([again.pulled, again.recovered], [[], []]);
  w.cleanup();
});

test('a crash after the folder or the index still leaves exactly one manifest line', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('a', 2), { hoursAgo: 1 });
  await archivePull(w.opts);
  // crash after the rename, before index and manifest
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  const before = downloads(w.api).length;
  const out = await archivePull(w.opts);
  assert.deepEqual(out.recovered, ['ingest-1-1']);
  assert.equal(downloads(w.api).length, before);
  assert.equal(manifestLines(w.dest).length, 1);
  // crash after the index, before the manifest
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  await archivePull(w.opts);
  const m = manifestLines(w.dest);
  assert.equal(m.length, 1);
  assert.equal(m[0].files.length, 2);
  assert.equal(m[0].dir, join('ingest', '2026-03-02', 'ingest-1-1'));
  await archivePull(w.opts);
  assert.equal(manifestLines(w.dest).length, 1);
  w.cleanup();
});

test('--dry-run lists ingest artifacts and their bytes without writing', async () => {
  const w = world();
  const zip = ingestZip('d', 1);
  w.add(1, 'ingest-1-1', zip);
  const out = await archivePull({ ...w.opts, dryRun: true });
  assert.deepEqual(out.wouldPull, ['ingest-1-1']);
  assert.equal(out.bytes, zip.length);
  assert.deepEqual(readdirSync(w.dest), []);
  w.cleanup();
});
