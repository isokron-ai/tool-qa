import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { SOURCES, acquireLock, archivePull, canNotify, commandOf, kindOf, main, notifyMac, resolveToken } from '../scripts/archive-pull.mjs';
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
  // Each artifact's run: our repository (id 1), branch main, the workflow that makes that kind.
  const runs = new Map();
  const workflowFor = (name) => (name.startsWith('ingest-') ? 'pump.yml' : name.startsWith('registry-') ? 'history-registry.yml'
    : name.startsWith('history-packages-') ? 'history-packages.yml' : name.startsWith('history-popularity-') ? 'history-popularity.yml' : 'test.yml');
  const add = (id, name, zip, { hoursAgo = 1, expired = false, digest, size, createdAt, runId = id * 10, branch = 'main', headRepo = 1, workflow, runGone = false, inRunList = true } = {}) => {
    artifacts.unshift({
      id, name, created_at: createdAt ?? ago(hoursAgo), expired, size_in_bytes: size ?? zip?.length ?? 0,
      workflow_run: { id: runId, repository_id: 1, head_repository_id: headRepo, head_branch: branch, head_sha: 'abc' },
      ...(digest ? { digest } : {}),
    });
    const runAt = new Date((Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : c.t - hoursAgo * HOUR) - 60_000).toISOString();
    if (!runGone) runs.set(runId, { id: runId, created_at: runAt, inRunList, path: `.github/workflows/${workflow ?? workflowFor(name)}`, repository: { id: 1 }, head_repository: { id: headRepo } });
    if (zip) zips.set(id, zip);
  };
  // Repository variables, for the heartbeat; `varStatus` forces an error answer.
  const vars = new Map();
  const v = { status: null };
  const api = fakeApi([
    ['PATCH', /\/repos\/isokron-ai\/tool-qa\/actions\/variables\/[A-Z_]+$/, (req) => {
      if (v.status) return { status: v.status, body: { message: 'Resource not accessible by integration' } };
      const name = req.path.split('/').pop();
      if (!vars.has(name)) return { status: 404, body: { message: 'Not Found' } };
      vars.set(name, req.json.value);
      return { status: 204 };
    }],
    ['POST', `/repos/${REPO}/actions/variables`, (req) => {
      vars.set(req.json.name, req.json.value);
      return { status: 201, body: {} };
    }],
    ['GET', `/repos/${REPO}/actions/artifacts`, (req) => {
      const per = Number(req.query.get('per_page') ?? 30);
      const page = Number(req.query.get('page') ?? 1);
      return { body: { total_count: artifacts.length, artifacts: artifacts.slice((page - 1) * per, page * per) } };
    }],
    ['GET', `/repos/${REPO}/actions/runs`, (req) => {
      const per = Number(req.query.get('per_page') ?? 30);
      const page = Number(req.query.get('page') ?? 1);
      const list = [...runs.values()].filter((r) => r.inRunList).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { body: { total_count: list.length, workflow_runs: list.slice((page - 1) * per, page * per) } };
    }],
    ['GET', /^\/repos\/isokron-ai\/tool-qa\/actions\/runs\/\d+$/, (req) => {
      const run = runs.get(Number(req.path.split('/').pop()));
      return run ? { body: run } : { status: 404, body: { message: 'Not Found' } };
    }],
    ['GET', /\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://storage.test/blob/${req.path.split('/')[6]}?sig=secret` } })],
    ['GET', /^\/blob\/\d+$/, (req) => ({ body: zips.get(Number(req.path.split('/')[2])) })],
  ]);
  const dest = mkdtempSync(join(tmpdir(), 'archive-'));
  const opts = { dest, repo: REPO, token: 'ghs_synthetic_archive', fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep, log: () => {} };
  return { c, api, add, artifacts, runs, zips, vars, v, opts, dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
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
  const code = await main(['--dest', w.dest], {}, { ...w.opts, dest: undefined, notify: () => {} });
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
  assert.equal(await main(['--dest', w.dest], {}, { ...w.opts, dest: undefined, maxPages: 1, notify: () => {} }), 1);
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

// ---- R-ARC-04..10: review of the ingest archive (quarantine, alerts, locking) ----

const quarantineFiles = (dest) => (existsSync(join(dest, 'quarantine')) ? readdirSync(join(dest, 'quarantine')).sort() : []);

test('R-ARC-04: an ingest artifact with files that will never pass is quarantined as downloaded, its sealed files kept, marked partial, and not retried', async () => {
  const w = world();
  const zip = makeZip([
    { name: 'ingest-a-0.tar.age', data: AGE('a-0'), method: 'store' },
    { name: 'ingest-a-1.tar', data: 'plain tar' },
    { name: 'ingest-a-2.tar.age', data: '' },
    { name: '.artifact.json', data: AGE('marker') },
    // what collect.mjs leaves when the pump is cancelled mid-write; the upload runs under always()
    { name: 'ingest-a-3.tar.age.tmp-4242', data: AGE('a-3') },
    { name: 'ingest-a-4.tar.age', data: AGE('a-4'), method: 'store' },
  ]);
  w.add(1, 'ingest-10-1', zip, { hoursAgo: 2, digest: `sha256:${sha(zip)}` });
  w.add(2, 'ingest-11-1', ingestZip('y', 1), { hoursAgo: 1 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.pulled, ['ingest-11-1']);
  assert.equal(out.quarantined.length, 1);
  assert.deepEqual([out.quarantined[0].kept, out.quarantined[0].refused], [2, 4]);
  // the download is kept byte for byte, with its reasons
  assert.deepEqual(quarantineFiles(w.dest), ['1-ingest-10-1.reason.json', '1-ingest-10-1.zip']);
  assert.deepEqual(readFileSync(join(w.dest, 'quarantine', '1-ingest-10-1.zip')), zip);
  const reason = JSON.parse(readFileSync(join(w.dest, 'quarantine', '1-ingest-10-1.reason.json'), 'utf8'));
  assert.equal(reason.sha256, sha(zip));
  assert.equal(reason.digest_checked, true);
  assert.deepEqual(reason.refused.map((r) => [r.name, r.reason]), [
    ['ingest-a-1.tar', 'not a .tar.age file'],
    ['ingest-a-2.tar.age', 'empty file'],
    ['.artifact.json', '.artifact.json is a reserved name'],
    ['ingest-a-3.tar.age.tmp-4242', 'not a .tar.age file'],
  ]);
  assert.deepEqual(reason.kept, ['ingest-a-0.tar.age', 'ingest-a-4.tar.age']);
  // the good sealed files go where they always go
  const dir = join('ingest', '2026-03-02', 'ingest-10-1');
  assert.deepEqual(readdirSync(join(w.dest, dir)).sort(), ['.artifact.json', 'ingest-a-0.tar.age', 'ingest-a-4.tar.age']);
  assert.deepEqual(readFileSync(join(w.dest, dir, 'ingest-a-4.tar.age')), AGE('a-4'));
  assert.equal(JSON.parse(readFileSync(join(w.dest, dir, '.artifact.json'), 'utf8')).id, 1, 'our marker, not the artifact\'s file of that name');
  const line = index(w.dest).find((e) => e.id === 1);
  assert.equal(line.partial, true);
  assert.equal(line.dir, dir);
  assert.equal(line.quarantine, join('quarantine', '1-ingest-10-1.zip'));
  const m = manifestLines(w.dest).find((x) => x.artifact_id === 1);
  assert.equal(m.partial, true);
  assert.deepEqual(m.files.map((f) => f.name), ['ingest-a-0.tar.age', 'ingest-a-4.tar.age']);
  assert.equal(m.refused.length, 4);
  assert.equal(m.quarantine, join('quarantine', '1-ingest-10-1.zip'));
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.by_kind.ingest, '2026-03-02T11:00:00.000Z', 'not held back: the artifact is done');
  // the next run does not download it again
  const before = downloads(w.api).length;
  const again = await archivePull(w.opts);
  assert.deepEqual([again.failed, again.quarantined, again.pulled], [[], [], []]);
  assert.equal(downloads(w.api).length, before);
  assert.equal(manifestLines(w.dest).length, 2);
  w.cleanup();
});

test('R-ARC-04: an ingest zip past the inflated-size cap keeps the entries within it and quarantines the download', async () => {
  const w = world();
  const zip = makeZip([
    { name: 'ingest-b-0.tar.age', data: AGE('b-0'), method: 'store' },
    { name: 'ingest-b-1.tar.age', data: Buffer.concat([AGE('b-1'), Buffer.alloc(4096)]) },
    { name: 'ingest-b-2.tar.age', data: AGE('b-2'), method: 'store' },
  ]);
  w.add(1, 'ingest-20-1', zip);
  const out = await archivePull({ ...w.opts, zipLimits: { maxTotalBytes: 1024 } });
  assert.equal(out.quarantined.length, 1);
  const [m] = manifestLines(w.dest);
  assert.deepEqual(m.files.map((f) => f.name), ['ingest-b-0.tar.age', 'ingest-b-2.tar.age']);
  assert.deepEqual(m.refused.map((r) => r.name), ['ingest-b-1.tar.age']);
  assert.match(m.refused[0].reason, /more than 1024 bytes once inflated/);
  assert.deepEqual(readFileSync(join(w.dest, 'quarantine', '1-ingest-20-1.zip')), zip);
  w.cleanup();
});

test('R-ARC-04: an unreadable ingest zip is quarantined whole, with no folder, and indexed as partial', async () => {
  const w = world();
  const broken = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 7)]);
  w.add(1, 'ingest-30-1', broken);
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.equal(out.quarantined[0].kept, 0);
  assert.match(out.quarantined[0].problems[0], /the zip cannot be read: .*not a zip archive/);
  assert.equal(existsSync(join(w.dest, 'ingest', '2026-03-02', 'ingest-30-1')), false);
  const [m] = manifestLines(w.dest);
  assert.equal(m.dir, null);
  assert.deepEqual(m.files, []);
  assert.equal(m.partial, true);
  assert.deepEqual(readFileSync(join(w.dest, m.quarantine)), broken);
  // a run that died before indexing downloads it again and reuses the same quarantine copy
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  const again = await archivePull(w.opts);
  assert.equal(again.quarantined.length, 1);
  assert.deepEqual(quarantineFiles(w.dest), ['1-ingest-30-1.reason.json', '1-ingest-30-1.zip']);
  assert.equal(manifestLines(w.dest).length, 1);
  // and the index line carries the partial mark, so a later run fills a lost manifest line back in
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  await archivePull(w.opts);
  assert.equal(manifestLines(w.dest).length, 1);
  w.cleanup();
});

test('R-ARC-04: a partial artifact left in its folder by a run that died is recovered without a second quarantine copy', async () => {
  const w = world();
  w.add(1, 'ingest-40-1', makeZip([{ name: 'ingest-c-0.tar.age', data: AGE('c-0') }, { name: 'junk.txt', data: 'x' }]));
  await archivePull(w.opts);
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  const before = downloads(w.api).length;
  const out = await archivePull(w.opts);
  assert.deepEqual(out.recovered, ['ingest-40-1']);
  assert.equal(downloads(w.api).length, before);
  const [m] = manifestLines(w.dest);
  assert.equal(m.partial, true);
  assert.deepEqual(m.refused.map((r) => r.name), ['junk.txt']);
  assert.equal(quarantineFiles(w.dest).length, 2);
  w.cleanup();
});

test('R-ARC-04: a download in doubt (digest or size mismatch) is retried, not quarantined', async () => {
  const w = world();
  const bad = makeZip([{ name: 'ingest-d-0.tar.age', data: AGE('d') }, { name: 'x.tar', data: 'x' }]);
  w.add(1, 'ingest-50-1', bad, { hoursAgo: 2, digest: `sha256:${'e'.repeat(64)}` });
  w.add(2, 'ingest-51-1', bad, { hoursAgo: 1, size: bad.length + 100 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.name), ['ingest-50-1', 'ingest-51-1']);
  assert.match(out.failed[0].error, /does not match the artifact digest/);
  assert.match(out.failed[1].error, /downloaded \d+ bytes but the artifact is \d+/);
  assert.deepEqual(quarantineFiles(w.dest), []);
  assert.equal(existsSync(join(w.dest, 'index.ndjson')), false);
  w.cleanup();
});

test('R-ARC-04: readZipLenient refuses bad entries one by one and keeps the rest', async () => {
  const { readZip, readZipLenient } = await import('../scripts/lib/unzip.mjs');
  const zip = makeZip([
    { name: 'a.txt', data: 'a' },
    { name: 'b.txt', data: 'b' },
    { name: '../c.txt', data: 'c' },
    { name: 'd.txt', data: 'd'.repeat(100) },
    { name: 'e.txt', data: 'e' },
  ], { corruptCrc: ['b.txt'] });
  assert.throws(() => readZip(zip), /CRC/);
  const r = readZipLenient(zip, { maxTotalBytes: 50 });
  assert.deepEqual(r.entries.map((e) => e.name), ['a.txt', 'e.txt']);
  assert.deepEqual(r.refused.map((x) => x.name), ['b.txt', '../c.txt', 'd.txt']);
  assert.match(r.refused[0].reason, /CRC/);
  assert.match(r.refused[1].reason, /unsafe/);
  assert.match(r.refused[2].reason, /more than 50 bytes/);
  assert.throws(() => readZipLenient(Buffer.from('not a zip at all, not at all')), /not a zip/);
});

// ---- alerts ----

const runMain = (w, args = [], { env = {}, ...deps } = {}) => {
  const notes = [];
  const logs = [];
  const p = main(['--dest', w.dest, ...args], env, { ...w.opts, dest: undefined, notify: (m) => notes.push(m), log: (l) => logs.push(l), ...deps });
  return p.then((code) => ({ code, notes, logs }));
};
const variableCalls = (api) => api.calls.filter((r) => r.path.includes('/actions/variables'));

test('R-ARC-05: a failed run shows a notification, and says when the last good run was once that is over a day old', async () => {
  const w = world();
  w.add(1, 'registry-delta-bad', registryZip('b', { badHash: true }));
  writeFileSync(join(w.dest, '.last-ok.json'), `${JSON.stringify({ at: new Date(w.c.t - 2 * HOUR).toISOString() })}\n`);
  let r = await runMain(w);
  assert.equal(r.code, 1);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^Archive pull failed: 1 artifact\(s\) \(registry-delta-bad: .*sha256/);
  assert.doesNotMatch(r.notes[0], /No successful pull/);
  assert.equal(variableCalls(w.api).length, 0, 'no heartbeat after a failed run');
  writeFileSync(join(w.dest, '.last-ok.json'), `${JSON.stringify({ at: new Date(w.c.t - 25 * HOUR).toISOString() })}\n`);
  r = await runMain(w);
  assert.match(r.notes[0], /No successful pull since 2026-03-01T11:00:00\.000Z/);
  // a run that throws (here: the token is refused) is a failure too
  const denied = await main(['--dest', w.dest], {}, { ...w.opts, dest: undefined, notify: (m) => r.notes.push(m), apiUrl: 'https://api.github.test/nowhere' });
  assert.equal(denied, 1);
  assert.match(r.notes.at(-1), /^Archive pull failed: .*404.*No successful pull since/);
  w.cleanup();
});

test('R-ARC-05: a successful run records .last-ok.json and sets ARCHIVE_LAST_OK to the time and the counts', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('h', 1));
  let r = await runMain(w);
  assert.equal(r.code, 0);
  assert.deepEqual(r.notes, []);
  const ok = JSON.parse(readFileSync(join(w.dest, '.last-ok.json'), 'utf8'));
  assert.deepEqual(ok, { at: '2026-03-02T12:00:00.000Z', pulled: 1, recovered: 0, quarantined: 0, already: 0, refused_foreign: 0, failed: 0, listed: 1 });
  // the first heartbeat creates the variable, later ones update it
  assert.deepEqual(variableCalls(w.api).map((c) => c.method), ['PATCH', 'POST']);
  assert.deepEqual(JSON.parse(w.vars.get('ARCHIVE_LAST_OK')), ok);
  assert.equal(variableCalls(w.api)[1].headers.get('authorization'), 'Bearer ghs_synthetic_archive');
  w.c.t += HOUR;
  r = await runMain(w);
  assert.equal(r.code, 0);
  assert.deepEqual(variableCalls(w.api).map((c) => c.method), ['PATCH', 'POST', 'PATCH']);
  assert.equal(JSON.parse(w.vars.get('ARCHIVE_LAST_OK')).at, '2026-03-02T13:00:00.000Z');
  assert.equal(JSON.parse(w.vars.get('ARCHIVE_LAST_OK')).already, 1);
  w.cleanup();
});

test('R-ARC-05: a run that quarantines an artifact exits 0, sets the heartbeat and shows a notification', async () => {
  const w = world();
  w.add(1, 'ingest-60-1', makeZip([{ name: 'ingest-q-0.tar.age', data: AGE('q') }, { name: 'ingest-q-1.tar.age.tmp-9', data: AGE('q1') }]));
  const r = await runMain(w);
  assert.equal(r.code, 0);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /1 ingest artifact\(s\) quarantined in .*quarantine: ingest-60-1\./);
  assert.equal(JSON.parse(w.vars.get('ARCHIVE_LAST_OK')).quarantined, 1);
  w.cleanup();
});

test('R-ARC-05: a heartbeat that cannot be set is logged and notified, and the run still exits 0', async () => {
  const w = world();
  w.v.status = 403;
  w.add(1, 'ingest-1-1', ingestZip('h', 1));
  const r = await runMain(w);
  assert.equal(r.code, 0);
  assert.ok(r.logs.some((l) => /could not set the heartbeat variable ARCHIVE_LAST_OK: .*403/.test(l)));
  assert.match(r.notes[0], /heartbeat variable ARCHIVE_LAST_OK could not be set/);
  assert.ok(existsSync(join(w.dest, '.last-ok.json')), 'the local record still says the pull worked');
  w.cleanup();
});

test('R-ARC-05: no notification and no heartbeat in CI, on a dry run, or when turned off', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('h', 1));
  w.add(2, 'registry-delta-bad', registryZip('b', { badHash: true }));
  // CI: the run fails, but the default notifier stays quiet and no heartbeat is sent
  const spawned = [];
  const code = await main(['--dest', w.dest], { CI: 'true' }, { ...w.opts, dest: undefined, log: () => {} });
  assert.equal(code, 1);
  assert.equal(canNotify({ CI: 'true' }, 'darwin'), false);
  assert.equal(canNotify({ GITHUB_ACTIONS: 'true' }, 'darwin'), false);
  assert.equal(canNotify({}, 'linux'), false);
  assert.equal(canNotify({ ARCHIVE_PULL_NOTIFY: '0' }, 'darwin'), false);
  assert.equal(canNotify({}, 'darwin'), true);
  assert.equal(notifyMac('x', { env: { GITHUB_ACTIONS: 'true' }, platform: 'darwin', run: (...a) => spawned.push(a) }), false);
  assert.deepEqual(spawned, []);
  // on a Mac the text is an argument to osascript, never part of the script
  const msg = 'it said "hi" & do shell script "touch /tmp/x"';
  assert.equal(notifyMac(msg, { env: {}, platform: 'darwin', run: (...a) => (spawned.push(a), { status: 0 }) }), true);
  assert.equal(spawned[0][0], 'osascript');
  const args = spawned[0][1];
  assert.equal(args.filter((a, i) => args[i - 1] === '-e').join('\n'), 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run');
  assert.equal(args.at(-2), msg);
  // GITHUB_ACTIONS, --no-heartbeat and --dry-run: no variable calls
  w.artifacts.splice(w.artifacts.findIndex((a) => a.id === 2), 1);
  let r = await runMain(w, [], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 0);
  r = await runMain(w, ['--no-heartbeat']);
  assert.equal(r.code, 0);
  r = await runMain(w, ['--dry-run']);
  assert.equal(variableCalls(w.api).length, 0);
  // --no-notify: a failing run stays quiet
  w.add(3, 'registry-delta-bad2', registryZip('c', { badHash: true }));
  r = await runMain(w, ['--no-notify', '--no-heartbeat']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.notes, []);
  w.cleanup();
});

// ---- small fixes ----

test('R-ARC-06: an artifact listed twice is downloaded once and indexed once', async () => {
  const w = world();
  const zip = ingestZip('dup', 1);
  w.add(1, 'ingest-1-1', zip);
  w.add(1, 'ingest-1-1', zip);
  w.add(2, 'registry-delta-1', registryZip('a'));
  w.add(2, 'registry-delta-1', registryZip('a'));
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.pulled, ['ingest-1-1', 'registry-delta-1']);
  assert.equal(downloads(w.api).length, 2);
  assert.deepEqual(index(w.dest).map((e) => e.id), [1, 2]);
  assert.equal(manifestLines(w.dest).length, 1);
  w.cleanup();
});

test('R-ARC-07: a folder from an earlier run is trusted only if every file still has its sha256', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('r', 2));
  await archivePull(w.opts);
  const dir = join(w.dest, 'ingest', '2026-03-02', 'ingest-1-1');
  writeFileSync(join(dir, 'ingest-r-1.tar.age'), 'changed on disk');
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  const logs = [];
  const before = downloads(w.api).length;
  const out = await archivePull({ ...w.opts, log: (l) => logs.push(l) });
  assert.deepEqual(out.recovered, []);
  assert.deepEqual(out.pulled, ['ingest-1-1']);
  assert.equal(downloads(w.api).length - before, 1, 'downloaded again');
  assert.ok(logs.some((l) => /does not check out \(ingest-r-1\.tar\.age does not match its sha256\); left as it is/.test(l)));
  assert.equal(readFileSync(join(dir, 'ingest-r-1.tar.age'), 'utf8'), 'changed on disk', 'the bad folder is not touched');
  assert.deepEqual(readFileSync(join(`${dir}.1`, 'ingest-r-1.tar.age')), AGE('r-1'));
  assert.equal(index(w.dest)[0].dir, join('ingest', '2026-03-02', 'ingest-1-1.1'));
  // a missing file is caught the same way; with both names taken, nothing is overwritten
  rmSync(join(`${dir}.1`, 'ingest-r-0.tar.age'));
  rmSync(join(w.dest, 'index.ndjson'));
  const third = await archivePull(w.opts);
  assert.match(third.failed[0].error, /already exist and hold other data/);
  w.cleanup();
});

test('R-ARC-07: every file and folder is synced to disk before the folder is renamed into place', async () => {
  const w = world();
  w.add(1, 'history-packages-1', packagesZip());
  const final = join(w.dest, 'history-packages-1');
  const seen = [];
  await archivePull({ ...w.opts, fsync: () => seen.push(existsSync(final)) });
  // 3 files + the marker, the temporary folder and its pypi/ subfolder, then the parent after the rename
  // (the index line and the cursor follow: R-ARC-15)
  assert.deepEqual(seen.slice(0, 7), [false, false, false, false, false, false, true]);
  w.cleanup();
});

test('R-ARC-08: a second run while a live one holds the lock does nothing and exits 0', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('l', 1));
  mkdirSync(join(w.dest, '.lock'));
  const holder = { pid: 4242, host: hostname(), started_at: new Date(w.c.t - HOUR).toISOString() };
  writeFileSync(join(w.dest, '.lock', 'owner.json'), JSON.stringify(holder));
  const out = await archivePull({ ...w.opts, alive: (pid) => pid === 4242 });
  assert.deepEqual(out.locked, holder);
  assert.equal(w.api.calls.length, 0);
  assert.ok(existsSync(join(w.dest, '.lock', 'owner.json')), 'the holder keeps its lock');
  const r = await runMain(w, [], { alive: (pid) => pid === 4242 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.notes, []);
  // still locked a day after the last good run: say so
  writeFileSync(join(w.dest, '.last-ok.json'), `${JSON.stringify({ at: new Date(w.c.t - 25 * HOUR).toISOString() })}\n`);
  const late = await runMain(w, [], { alive: (pid) => pid === 4242 });
  assert.equal(late.code, 0);
  assert.match(late.notes[0], /locked by pid 4242 and has not succeeded since/);
  w.cleanup();
});

test('R-ARC-08: a lock from a dead run on this host, or from another host untouched for 12 hours, is taken over; a recent one from another host is not', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('l', 1));
  const lock = (owner) => {
    rmSync(join(w.dest, '.lock'), { recursive: true, force: true });
    mkdirSync(join(w.dest, '.lock'));
    if (owner) writeFileSync(join(w.dest, '.lock', 'owner.json'), JSON.stringify(owner));
  };
  const recent = new Date(w.c.t - HOUR).toISOString();
  lock({ pid: 4242, host: 'elsewhere', started_at: recent });
  assert.ok((await archivePull({ ...w.opts, alive: () => false })).locked, 'another host: its pid cannot be checked here');
  lock({ pid: 4242, host: hostname(), started_at: recent });
  let out = await archivePull({ ...w.opts, alive: () => false });
  assert.equal(out.locked, null);
  assert.deepEqual(out.pulled, ['ingest-1-1']);
  assert.equal(existsSync(join(w.dest, '.lock')), false, 'released after the run');
  lock({ pid: 4242, host: 'elsewhere', started_at: new Date(w.c.t - 13 * HOUR).toISOString() });
  out = await archivePull({ ...w.opts, alive: () => true });
  assert.equal(out.locked, null);
  assert.equal(out.already, 1);
  // a lock folder with no owner file: busy for a minute, then stale
  lock(null);
  const t = (w.c.t - 2 * 60_000) / 1000;
  utimesSync(join(w.dest, '.lock'), t, t);
  out = await archivePull({ ...w.opts, alive: () => true });
  assert.equal(out.locked, null);
  assert.equal(readdirSync(w.dest).filter((n) => n.startsWith('.lock')).length, 0);
  w.cleanup();
});

test('R-ARC-08: the lock is released when a run fails part way', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('l', 1));
  await assert.rejects(archivePull({ ...w.opts, apiUrl: 'https://api.github.test/nowhere' }), /404/);
  assert.equal(existsSync(join(w.dest, '.lock')), false);
  w.cleanup();
});

test('R-ARC-09: temporary folders left by a dead run are removed at start; a live run\'s are kept', async () => {
  const w = world();
  mkdirSync(join(w.dest, '.partial-5-111', 'sub'), { recursive: true });
  writeFileSync(join(w.dest, '.partial-5-111', 'sub', 'x.tar.age'), 'half');
  mkdirSync(join(w.dest, '.partial-6-222'));
  mkdirSync(join(w.dest, 'quarantine'));
  writeFileSync(join(w.dest, 'quarantine', '.partial-7-111.zip'), 'half');
  writeFileSync(join(w.dest, 'quarantine', '.partial-7-111.reason.json'), '{}');
  mkdirSync(join(w.dest, '.partial-notes'));
  const logs = [];
  await archivePull({ ...w.opts, alive: (pid) => pid === 222, log: (l) => logs.push(l) });
  assert.deepEqual(readdirSync(w.dest).filter((n) => n.startsWith('.partial')).sort(), ['.partial-6-222', '.partial-notes']);
  assert.deepEqual(readdirSync(join(w.dest, 'quarantine')), []);
  assert.ok(logs.some((l) => /removed 3 temporary folder\(s\)/.test(l)));
  w.cleanup();
});

test('R-ARC-10: an ingest artifact whose created_at is not a date fails with that message', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('t', 1), { createdAt: 'not-a-date' });
  w.add(2, 'ingest-2-1', ingestZip('u', 1));
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.error), ['created_at "not-a-date" is not a date']);
  assert.deepEqual(out.pulled, ['ingest-2-1']);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.by_kind.ingest, '2026-03-02T11:00:00.000Z', 'a bad time never becomes the cursor');
  // with a cursor in place, the next run still lists it and still fails it (R-ARC-18)
  const again = await archivePull(w.opts);
  assert.deepEqual(again.failed.map((f) => f.error), ['created_at "not-a-date" is not a date']);
  w.cleanup();
});

// ---- R-ARC-11..18: second review of #27 ----

/** A zip whose central directory lists `n` entries, all pointing at one local entry. */
function sharedDataZip(n, data, { badCrc = true } = {}) {
  const one = makeZip([{ name: 'e00.tar.age', data }], { corruptCrc: badCrc ? ['e00.tar.age'] : [] });
  const cdOffset = one.readUInt32LE(one.length - 22 + 16);
  const cdSize = one.readUInt32LE(one.length - 22 + 12);
  const local = one.subarray(0, cdOffset);
  const central = one.subarray(cdOffset, cdOffset + cdSize);
  const cds = Array.from({ length: n }, (_, i) => {
    const c = Buffer.from(central);
    c.write(`e${String(i).padStart(2, '0')}`, 46, 'utf8');
    return c;
  });
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, end]);
}

test('R-ARC-11: entries that fail after inflating still count toward the cap, and entries sharing local data are refused', async () => {
  const { readZip, readZipLenient } = await import('../scripts/lib/unzip.mjs');
  // The review's case: a small zip listing 30 entries of 64 MiB with bad CRCs, all on one local entry.
  const bomb = sharedDataZip(30, Buffer.alloc(64 * 1024 ** 2));
  assert.ok(bomb.length < 200_000, 'the archive itself is small');
  let r = readZipLenient(bomb, { maxTotalBytes: 100 * 1024 ** 2 });
  assert.deepEqual(r.entries, []);
  assert.equal(r.refused.filter((x) => /CRC/.test(x.reason)).length, 1, 'inflated once, not 30 times');
  assert.ok(r.refused.slice(1).every((x) => /points at the same data as an earlier entry|more than 104857600 bytes/.test(x.reason)));
  // Distinct entries that each inflate and then fail their CRC: every one is counted, so the cap stops the work.
  const bad = makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `b${i}.tar.age`, data: Buffer.alloc(1024 ** 2, i) })), {
    corruptCrc: Array.from({ length: 30 }, (_, i) => `b${i}.tar.age`),
  });
  r = readZipLenient(bad, { maxTotalBytes: 4 * 1024 ** 2 });
  assert.equal(r.refused.filter((x) => /CRC/.test(x.reason)).length, 4);
  assert.equal(r.refused.filter((x) => /more than 4194304 bytes once inflated/.test(x.reason)).length, 26);
  // readZip refuses shared data too, even with good CRCs
  assert.throws(() => readZip(sharedDataZip(2, Buffer.from('ok'), { badCrc: false })), /points at the same data/);
});

test('R-ARC-12: a live run on this host keeps its lock however long it runs; one on another host keeps it while it touches it', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('l', 1), { hoursAgo: 2 });
  w.add(2, 'ingest-2-1', ingestZip('m', 1), { hoursAgo: 1 });
  const lock = (owner) => {
    rmSync(join(w.dest, '.lock'), { recursive: true, force: true });
    mkdirSync(join(w.dest, '.lock'));
    writeFileSync(join(w.dest, '.lock', 'owner.json'), JSON.stringify(owner));
  };
  const longAgo = new Date(w.c.t - 30 * HOUR).toISOString();
  lock({ pid: 4242, host: hostname(), started_at: longAgo });
  assert.ok((await archivePull({ ...w.opts, alive: (pid) => pid === 4242 })).locked, 'a 30-hour backfill on this host is not stale');
  lock({ pid: 4242, host: 'elsewhere', started_at: longAgo, touched_at: new Date(w.c.t - HOUR).toISOString() });
  assert.ok((await archivePull({ ...w.opts, alive: () => false })).locked, 'touched an hour ago on another host: live');
  rmSync(join(w.dest, '.lock'), { recursive: true, force: true });
  // a run touches its lock after each artifact
  const touched = [];
  const fetch = async (url, init) => {
    if (String(url).startsWith('https://storage.test/')) {
      touched.push(JSON.parse(readFileSync(join(w.dest, '.lock', 'owner.json'), 'utf8')).touched_at);
      w.c.t += HOUR;
    }
    return w.api.fetch(url, init);
  };
  const out = await archivePull({ ...w.opts, fetch });
  assert.equal(out.pulled.length, 2);
  assert.equal(touched.length, 2);
  assert.ok(touched[1] > touched[0], `touched again before the second artifact: ${touched}`);
  w.cleanup();
});

test('R-ARC-13: two runs cannot both take over one stale lock, nor take one another run has just taken', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('l', 1));
  const lockDir = join(w.dest, '.lock');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 111, host: hostname(), started_at: new Date(w.c.t - HOUR).toISOString() }));
  // While this run decides pid 111 is dead, another run takes the lock over first.
  const winner = { pid: 222, host: hostname(), started_at: new Date(w.c.t).toISOString() };
  let swapped = false;
  const alive = (pid) => {
    if (pid === 111 && !swapped) {
      swapped = true;
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(winner));
      return false;
    }
    return pid === 222;
  };
  const out = await archivePull({ ...w.opts, alive });
  assert.deepEqual(out.locked, winner, 'it sees the new holder and backs off');
  assert.deepEqual(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')), winner, "the winner's lock is untouched");
  assert.equal(existsSync(join(w.dest, '.lock.takeover')), false);
  // a takeover in progress elsewhere (a fresh guard): back off, leave the stale lock alone
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 111, host: hostname(), started_at: new Date(w.c.t - HOUR).toISOString() }));
  mkdirSync(join(w.dest, '.lock.takeover'));
  const t = w.c.t / 1000;
  utimesSync(join(w.dest, '.lock.takeover'), t, t);
  assert.ok((await archivePull({ ...w.opts, alive: () => false })).locked);
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).pid, 111);
  // a guard left by a run that died in a takeover (over 10 minutes old) is cleared
  const old = (w.c.t - 11 * 60_000) / 1000;
  utimesSync(join(w.dest, '.lock.takeover'), old, old);
  const took = await archivePull({ ...w.opts, alive: () => false });
  assert.equal(took.locked, null);
  assert.deepEqual(took.pulled, ['ingest-1-1']);
  w.cleanup();
});

test('R-ARC-14: names that one disk folds together, and empty or "." parts, are refused; a name the disk cannot write sends the whole download to quarantine', async () => {
  const w = world();
  const zip = makeZip([
    { name: 'ingest-A.tar.age', data: AGE('A'), method: 'store' },
    { name: 'ingest-a.tar.age', data: AGE('a'), method: 'store' },
    { name: 'ingest-é.tar.age', data: AGE('nfc'), method: 'store' },
    { name: 'ingest-é.tar.age', data: AGE('nfd'), method: 'store' },
    { name: 'x/./y.tar.age', data: AGE('dot'), method: 'store' },
    { name: 'a//b.tar.age', data: AGE('empty'), method: 'store' },
    { name: '.ARTIFACT.json', data: AGE('marker'), method: 'store' },
  ]);
  w.add(1, 'ingest-1-1', zip, { hoursAgo: 2 });
  // a name too long for any common disk: writing fails the same way every time
  const long = makeZip([{ name: 'ingest-ok.tar.age', data: AGE('ok'), method: 'store' }, { name: `${'x'.repeat(300)}.tar.age`, data: AGE('long'), method: 'store' }]);
  w.add(2, 'ingest-2-1', long, { hoursAgo: 1 });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  const [m1, m2] = manifestLines(w.dest);
  assert.deepEqual(m1.files.map((f) => f.name), ['ingest-A.tar.age', 'ingest-é.tar.age']);
  assert.deepEqual(m1.refused.map((r) => [r.name, r.reason]), [
    ['ingest-a.tar.age', 'a second file with this name (ignoring case and Unicode form)'],
    ['ingest-é.tar.age', 'a second file with this name (ignoring case and Unicode form)'],
    ['x/./y.tar.age', 'its name has an empty, "." or ".." part'],
    ['a//b.tar.age', 'its name has an empty, "." or ".." part'],
    ['.ARTIFACT.json', '.artifact.json is a reserved name'],
  ]);
  assert.equal(m2.dir, null);
  assert.deepEqual(m2.files, []);
  assert.deepEqual(m2.refused.map((r) => r.name), ['ingest-ok.tar.age', `${'x'.repeat(300)}.tar.age`]);
  assert.match(m2.problems.at(-1), /could not be written under their names here \(ENAMETOOLONG/);
  assert.deepEqual(readFileSync(join(w.dest, m2.quarantine)), long);
  assert.deepEqual(readdirSync(w.dest).filter((n) => n.startsWith('.partial')), []);
  const again = await archivePull(w.opts);
  assert.deepEqual([again.failed, again.pulled, again.quarantined], [[], [], []], 'done, not retried');
  w.cleanup();
});

test('R-ARC-15: index and manifest lines are synced to disk, and the cursor is replaced whole only after them', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('s', 1));
  const index = join(w.dest, 'index.ndjson');
  const manifest = join(w.dest, 'ingest', 'manifest.ndjson');
  const cursor = join(w.dest, '.last-pull.json');
  const temp = join(w.dest, `.partial-0-${process.pid}.json`);
  const seen = [];
  await archivePull({ ...w.opts, fsync: () => seen.push({ index: existsSync(index), manifest: existsSync(manifest), cursor: existsSync(cursor), temp: existsSync(temp) }) });
  const firstIndex = seen.findIndex((x) => x.index);
  const firstManifest = seen.findIndex((x) => x.manifest);
  const tempSync = seen.findIndex((x) => x.temp && !x.cursor);
  const afterRename = seen.findIndex((x) => x.cursor);
  assert.ok(firstIndex >= 0 && firstManifest > firstIndex, 'the index line, then the manifest line, each synced');
  assert.ok(tempSync > firstManifest, 'the new cursor is written and synced to a temporary file after both');
  assert.equal(afterRename, seen.length - 1, 'then renamed over the old one, and the folder synced last');
  assert.equal(existsSync(temp), false);
  assert.equal(JSON.parse(readFileSync(cursor, 'utf8')).by_kind.ingest, '2026-03-02T11:00:00.000Z');
  w.cleanup();
});

test('R-ARC-16: an artifact not made by our own workflow on main is refused unread, not quarantined, and not a failure', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('fork', 1), { hoursAgo: 6, headRepo: 999 });
  w.add(2, 'ingest-2-1', ingestZip('branch', 1), { hoursAgo: 5, branch: 'feature' });
  w.add(4, 'registry-delta-x', registryZip('a'), { hoursAgo: 1.5, headRepo: 999, workflow: 'evil.yml' });
  w.add(6, 'ingest-6-1', ingestZip('ok', 1), { hoursAgo: 1, runId: 777 });
  w.add(7, 'ingest-manual.tar.age', AGE('manual'), { hoursAgo: 1, runId: 777, workflow: 'ingest.yml' });
  const logs = [];
  const r = await runMain(w, ['--no-heartbeat'], { log: (l) => logs.push(l) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.notes, [], 'a fork or another branch is not ours: nothing to tell');
  const out = await archivePull(w.opts);
  // the next run checks again those still inside its look-back, and still refuses them
  assert.deepEqual(out.foreign.map((f) => f.name), ['registry-delta-x']);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(index(w.dest).map((e) => e.id), [6, 7]);
  assert.equal(downloads(w.api).length, 2, 'only the two of ours were downloaded');
  assert.deepEqual(quarantineFiles(w.dest), []);
  const refused = logs.filter((l) => /REFUSED, not from our own workflow on main/.test(l));
  assert.equal(refused.length, 3);
  assert.match(refused[0], /ingest-1-1: .*another repository \(head repository 999\)/);
  assert.match(refused[1], /ingest-2-1: .*branch "feature"/);
  assert.match(refused[2], /registry-delta-x: .*another repository/);
  assert.match(logs.at(-1), /refused as not ours 3/);
  // one run, one lookup, however many artifacts it made
  assert.equal(w.api.calls.filter((c) => c.path.endsWith('/actions/runs/777')).length, 1);
  w.cleanup();
});

test('R-ARC-17: a quarantine recovered after a run died before indexing it is still reported and notified', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', makeZip([{ name: 'ingest-k-0.tar.age', data: AGE('k') }, { name: 'junk.txt', data: 'x' }]));
  let r = await runMain(w, ['--no-heartbeat']);
  assert.match(r.notes[0], /1 ingest artifact\(s\) quarantined/);
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  const out = await archivePull(w.opts);
  assert.deepEqual(out.recovered, ['ingest-1-1']);
  assert.equal(out.quarantined.length, 1);
  assert.equal(out.quarantined[0].recovered, true);
  rmSync(join(w.dest, 'index.ndjson'));
  rmSync(join(w.dest, 'ingest', 'manifest.ndjson'));
  r = await runMain(w, ['--no-heartbeat']);
  assert.equal(r.code, 0);
  assert.match(r.notes[0], /1 ingest artifact\(s\) quarantined in .*: ingest-1-1\./);
  w.cleanup();
});

test('R-ARC-18: an artifact whose created_at is not a date keeps failing visibly on later runs', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('t', 1), { createdAt: 'not-a-date' });
  w.add(2, 'ingest-2-1', ingestZip('u', 1));
  assert.equal((await runMain(w, ['--no-heartbeat'])).code, 1);
  w.c.t += 6 * HOUR;
  w.add(3, 'ingest-3-1', ingestZip('v', 1), { hoursAgo: 0.5 });
  const r = await runMain(w, ['--no-heartbeat']);
  assert.equal(r.code, 1, 'with a cursor in place it is still listed, and still fails');
  assert.match(r.notes[0], /Archive pull failed: 1 artifact\(s\) \(ingest-1-1: created_at "not-a-date" is not a date\)/);
  w.cleanup();
});

// ---- R-ARC-19..21: follow-up to #27 ----

test('R-ARC-19: a lock on this host from an earlier boot, or whose pid now runs another program, is taken over', () => {
  const dest = mkdtempSync(join(tmpdir(), 'archive-lock-'));
  const host = 'mac';
  const boot = '2026-03-02T08:00:00.000Z';
  const lock = (owner) => {
    rmSync(join(dest, '.lock'), { recursive: true, force: true });
    mkdirSync(join(dest, '.lock'));
    writeFileSync(join(dest, '.lock', 'owner.json'), JSON.stringify({ host, started_at: '2026-03-02T09:00:00.000Z', ...owner }));
  };
  const take = (o) => acquireLock(dest, { host, boot, alive: () => true, command: () => null, now: () => Date.parse('2026-03-02T12:00:00Z'), ...o });
  // after a reboot the pid may be anything, even pid 1, and alive
  lock({ pid: 1, boot: '2026-03-01T08:00:00.000Z' });
  let l = take();
  assert.equal(l.holder, undefined, 'taken over');
  assert.equal(JSON.parse(readFileSync(join(dest, '.lock', 'owner.json'), 'utf8')).boot, boot, 'our lock records our boot');
  l.release();
  // the same boot, read a minute apart, is the same boot
  lock({ pid: 4242, boot: '2026-03-02T08:01:00.000Z' });
  assert.ok(take().holder);
  // the pid is alive but runs something else now
  lock({ pid: 4242, boot });
  assert.ok(take({ command: () => 'node /Users/x/isokron-archive/tool-qa-code/scripts/archive-pull.mjs --dest /x' }).holder, 'still the archive pull');
  l = take({ command: () => '/usr/libexec/some-daemon' });
  assert.equal(l.holder, undefined);
  l.release();
  // a lock from before boot times were recorded is judged by its pid as before
  lock({ pid: 4242 });
  assert.ok(take().holder);
  // commandOf reads ps, and says null when it cannot
  assert.equal(commandOf(7, () => ({ status: 0, stdout: 'node archive-pull.mjs\n' })), 'node archive-pull.mjs');
  assert.equal(commandOf(7, () => ({ status: 1, stdout: '' })), null);
  assert.equal(commandOf(7, () => ({ error: new Error('ENOENT') })), null);
  rmSync(dest, { recursive: true, force: true });
});

test('R-ARC-20: our own artifact from a workflow SOURCES does not list is held, retried and notified, not passed over', async () => {
  const w = world();
  w.add(1, 'ingest-1-1', ingestZip('renamed', 1), { hoursAgo: 3, workflow: 'pump-v2.yml' });
  w.add(2, 'registry-delta-x', registryZip('a'), { hoursAgo: 2.5, workflow: 'history-packages.yml' });
  w.add(3, 'ingest-3-1', ingestZip('gone', 1), { hoursAgo: 2, runGone: true });
  w.add(4, 'ingest-4-1', ingestZip('ok', 1), { hoursAgo: 1 });
  const r = await runMain(w, ['--no-heartbeat']);
  assert.equal(r.code, 1);
  assert.match(r.notes[0], /^Archive pull failed: 3 artifact\(s\) \(ingest-1-1: held, not pulled: it was made on main by "\.github\/workflows\/pump-v2\.yml", which SOURCES does not list for this name \(it lists pump\.yml or ingest\.yml\); add the workflow to SOURCES/);
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed.map((f) => f.name), ['ingest-1-1', 'registry-delta-x', 'ingest-3-1']);
  assert.match(out.failed[2].error, /run 30 is gone/);
  assert.deepEqual(out.foreign, []);
  const cursor = JSON.parse(readFileSync(join(w.dest, '.last-pull.json'), 'utf8'));
  assert.equal(cursor.by_kind.ingest, '2026-03-02T09:00:00.000Z', 'held at the oldest held artifact');
  assert.equal(cursor.by_kind.history, '2026-03-02T09:30:00.000Z');
  assert.equal(downloads(w.api).length, 1, 'held artifacts are not downloaded');
  // once SOURCES lists the workflow (here: the run turns out to be from pump.yml), the next run pulls it
  w.runs.get(10).path = '.github/workflows/pump.yml';
  const fixed = await archivePull(w.opts);
  assert.deepEqual(fixed.pulled, ['ingest-1-1']);
  w.cleanup();
});

test('R-ARC-20: every artifact a workflow here uploads under an archived prefix is mapped in SOURCES to that workflow', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const lines = readFileSync(new URL(file, dir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/uses:\s*actions\/upload-artifact@/.test(line)) return;
      const nameLine = lines.slice(i + 1, i + 12).find((l) => /^\s+name:\s*\S/.test(l));
      assert.ok(nameLine, `${file}: an upload-artifact step with no name:`);
      const name = nameLine.replace(/^\s+name:\s*/, '').replace(/^['"]|['"]$/g, '');
      const prefix = name.split('${{')[0];
      if (!kindOf(prefix)) return;
      found.push(`${prefix} ${file}`);
      const allowed = SOURCES.find(([p]) => prefix.startsWith(p))?.[1] ?? [];
      assert.ok(allowed.includes(file), `${file} uploads ${name}, but SOURCES lists ${allowed.join(', ') || 'nothing'} for ${prefix}: its artifacts would be held`);
    });
  }
  assert.deepEqual(found.sort(), [
    'history-packages- history-packages.yml',
    'history-popularity- history-popularity.yml',
    'ingest- ingest.yml',
    'ingest- pump.yml',
    'registry- history-registry.yml',
  ]);
  const files = new Set(readdirSync(dir));
  for (const [, wfs] of SOURCES) for (const f of wfs) assert.ok(files.has(f), `SOURCES names ${f}, which does not exist`);
});

test('R-ARC-21: many runs are looked up from the run list a page at a time, with one GET for each run it does not find', async () => {
  const w = world();
  for (let i = 1; i <= 30; i++) w.add(i, `ingest-${i}-1`, ingestZip(`b${i}`, 1), { hoursAgo: 40 - i });
  w.add(31, 'ingest-31-1', ingestZip('late', 1), { hoursAgo: 0.5, inRunList: false });
  const out = await archivePull(w.opts);
  assert.deepEqual(out.failed, []);
  assert.equal(out.pulled.length, 31);
  const runCalls = w.api.calls.filter((c) => /\/actions\/runs(\/\d+)?$/.test(c.path));
  assert.equal(runCalls.filter((c) => c.path.endsWith('/actions/runs')).length, 1, 'one page of the run list');
  assert.deepEqual(runCalls.filter((c) => /\/runs\/\d+$/.test(c.path)).map((c) => c.path.split('/').pop()), ['310'], 'one GET, for the run not in the list');
  // a few runs: one GET each, no listing
  const v = world();
  for (let i = 1; i <= 3; i++) v.add(i, `ingest-${i}-1`, ingestZip(`s${i}`, 1));
  await archivePull(v.opts);
  assert.equal(v.api.calls.filter((c) => c.path.endsWith('/actions/runs')).length, 0);
  assert.equal(v.api.calls.filter((c) => /\/actions\/runs\/\d+$/.test(c.path)).length, 3);
  w.cleanup();
  v.cleanup();
});
