import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createClient } from '../../pump/github.mjs';
import { fakeGh } from '../../snapshot/test/fake-github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { makeZip } from '../../test/lib/zip.mjs';
import { readTar } from '../../worker-kit/tar.mjs';
import { ASSET_LIMIT, TAG, newestRevision, partId, runKeepCopy } from '../copy.mjs';

const REPO = 'isokron-ai/tool-qa';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const AGE = 'age-encryption.org/v1\n';
const age = (tag) => Buffer.from(`${AGE}-> X25519 ${tag}\n--- body\n${tag.repeat(30)}`);
const catalogName = (c) => `catalog-${sha(Buffer.from(c)).slice(0, 64)}.tar.age`;
const keepZip = (n, catalogs = []) => makeZip([
  { name: `keep-${n}-0.tar.age`, data: age(`k${n}`) },
  ...catalogs.map((c) => ({ name: catalogName(c), data: age(`c${c}`) })),
]);
const historyZip = (n) => makeZip([{ name: 'manifest.json', data: `{"n":${n}}` }, { name: `data-${n}.ndjson.gz`, data: Buffer.from(`row${n}`) }]);

function world() {
  const c = fakeClock(Date.parse('2026-11-24T12:00:00Z'));
  const ago = (ms) => new Date(c.t - ms).toISOString();
  const artifacts = [];
  const blobs = new Map();
  const runs = new Map();
  const workflowFor = (name) => (name.startsWith('ingest-') ? 'pump.yml' : name.startsWith('registry-') ? 'history-registry.yml' : 'history-packages.yml');
  const add = (id, name, data, { ago: ms = HOUR, branch = 'main', headRepo = 1, workflow } = {}) => {
    artifacts.unshift({
      id, name, created_at: ago(ms), expired: false, size_in_bytes: data.length, digest: `sha256:${sha(data)}`,
      workflow_run: { id: id * 10, repository_id: 1, head_repository_id: headRepo, head_branch: branch, head_sha: 'abc' },
    });
    runs.set(id * 10, { id: id * 10, created_at: ago(ms + 1000), path: `.github/workflows/${workflow ?? workflowFor(name)}`, repository: { id: 1 }, head_repository: { id: headRepo } });
    blobs.set(`a${id}`, data);
  };
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/artifacts`, (req) => {
      const per = Number(req.query.get('per_page') ?? 30);
      const page = Number(req.query.get('page') ?? 1);
      return { body: { total_count: artifacts.length, artifacts: artifacts.slice((page - 1) * per, page * per) } };
    }],
    ['GET', `/repos/${REPO}/actions/runs`, () => ({ body: { workflow_runs: [...runs.values()] } })],
    ['GET', /^\/repos\/isokron-ai\/tool-qa\/actions\/runs\/\d+$/, (req) => {
      const run = runs.get(Number(req.path.split('/').pop()));
      return run ? { body: run } : { status: 404, body: { message: 'Not Found' } };
    }],
    ['GET', /\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://storage.test/blob/a${req.path.split('/')[6]}` } })],
    ['GET', /^\/blob\/a\d+$/, (req) => ({ body: blobs.get(req.path.split('/')[2]) })],
  ]);
  const rel = fakeGh({ repo: REPO });
  const client = createClient({ token: 'ghs_synthetic_keep', fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep });
  const gh = { client, fetch: api.fetch, sleep: c.sleep };
  const run = (over = {}) => runKeepCopy({ gh, release: rel.gh, repo: REPO, now: c.now, ...over });
  const assets = () => rel.assetsOf(TAG);
  const names = () => assets().map((a) => a.name).sort();
  const read = (name) => rel.blobs.get(assets().find((a) => a.name === name).id);
  const part = (name) => new Map(readTar(read(name)).map((e) => [e.path, e.data]));
  return { c, api, rel, add, run, assets, names, read, part };
}

const parts = (w) => w.names().filter((n) => /^keep-\d{4}-\d{2}-[0-9a-f]{12}\.tar$/.test(n));
const downloads = (w) => w.api.calls.filter((r) => r.url.startsWith('https://storage.test/'));

test('R-RET-10: the keep-forever files and the history zips are copied into a part per month, with a manifest per month, a catalog index and a status', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1, ['A']), { ago: HOUR });
  w.add(2, 'history-packages-20261124', historyZip(2), { ago: 2 * HOUR });
  w.add(3, 'something-else', Buffer.from('x'));
  w.add(4, 'ingest-111-1', makeZip([{ name: 'ingest-x-0.tar.age', data: age('full') }]));
  const s = await w.run();
  assert.equal(s.status, 'ok', JSON.stringify(s.failures));
  assert.deepEqual(s.copied, { artifacts: 2, files: 3, bytes: s.copied.bytes, parts: 1 });
  const [p] = parts(w);
  assert.match(p, /^keep-2026-11-/);
  const inside = w.part(p);
  assert.deepEqual([...inside.keys()].sort(), ['history/history-packages-20261124.zip', `ingest-keep/ingest-keep-111-1/${catalogName('A')}`, 'ingest-keep/ingest-keep-111-1/keep-1-0.tar.age']);
  assert.ok(inside.get('ingest-keep/ingest-keep-111-1/keep-1-0.tar.age').equals(age('k1')), 'the sealed bytes, untouched');
  assert.ok(inside.get('history/history-packages-20261124.zip').equals(historyZip(2)));
  const man = JSON.parse(w.read('manifest-2026-11.r0001.json'));
  assert.equal(Object.keys(man.artifacts).length, 2);
  assert.equal(man.artifacts['ingest-keep-111-1'].part, p);
  assert.equal(man.artifacts['ingest-keep-111-1'].files[0].sha256, sha(age('k1')));
  assert.deepEqual(JSON.parse(w.read('catalogs.r0001.json')).catalogs, [sha(Buffer.from('A'))]);
  assert.equal(JSON.parse(w.read('status.r0001.json')).last_ok_at, s.at);
  assert.ok(w.assets().every((a) => a.size < ASSET_LIMIT));
});

test('R-RET-10: a second run copies nothing, uploads nothing and downloads nothing; a new artifact makes a second part, and the old part is not rewritten', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1));
  await w.run();
  const before = w.names();
  const dl = downloads(w).length;
  const again = await w.run();
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.copied, { artifacts: 0, files: 0, bytes: 0, parts: 0 });
  assert.equal(again.already, 1);
  assert.equal(downloads(w).length, dl, 'no download for what the manifest lists');
  assert.deepEqual(w.names().filter((n) => !n.startsWith('status.')), before.filter((n) => !n.startsWith('status.')));
  w.add(2, 'ingest-keep-112-1', keepZip(2));
  await w.run();
  assert.equal(parts(w).length, 2);
  assert.equal(Object.keys(JSON.parse(w.read('manifest-2026-11.r0002.json')).artifacts).length, 2);
  // Only the newest two revisions of each index stay.
  assert.deepEqual(w.names().filter((n) => n.startsWith('status.')).length, 2);
});

test('R-RET-11: a tool list already copied is not copied again, in the same run or a later one', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1, ['A', 'B']), { ago: 3 * HOUR });
  w.add(2, 'ingest-keep-112-1', keepZip(2, ['A', 'C']), { ago: 2 * HOUR });
  const s = await w.run();
  assert.equal(s.skipped_catalogs, 1, 'A is in the second artifact too');
  const files = [...w.part(parts(w)[0]).keys()].filter((k) => k.includes('catalog-'));
  assert.equal(files.length, 3, 'A, B and C once each');
  w.add(3, 'ingest-keep-113-1', keepZip(3, ['A', 'B', 'C']), { ago: HOUR });
  const later = await w.run();
  assert.equal(later.skipped_catalogs, 3);
  const second = parts(w).find((p) => p !== parts(w)[0]) ?? parts(w)[1];
  assert.deepEqual([...w.part(second).keys()].filter((k) => k.includes('catalog-')), []);
});

test('R-RET-12: artifacts roll by the month they were made; each month has its own manifest', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1), { ago: 40 * DAY }); // October
  w.add(2, 'ingest-keep-112-1', keepZip(2), { ago: HOUR }); // November
  await w.run();
  assert.deepEqual(parts(w).map((n) => n.slice(0, 12)), ['keep-2026-10', 'keep-2026-11']);
  assert.ok(w.names().includes('manifest-2026-10.r0001.json') && w.names().includes('manifest-2026-11.r0001.json'));
});

test('R-RET-13: a part uploaded by a run that died before its manifest is found again by name and not uploaded twice', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1));
  const real = w.rel.gh.upload;
  let died = false;
  w.rel.gh.upload = async (rel, name, data, label) => {
    if (name.startsWith('manifest-') && !died) {
      died = true;
      throw new Error('the runner was lost');
    }
    return real(rel, name, data, label);
  };
  const first = await w.run();
  assert.equal(first.status, 'error');
  assert.equal(parts(w).length, 1, 'the part is up');
  assert.equal(first.pending.count, 1, 'and the artifact still counts as waiting');
  const second = await w.run();
  assert.equal(second.status, 'ok');
  assert.equal(parts(w).length, 1, 'same content, same name, no second part');
  assert.equal(w.names().filter((n) => n.startsWith('manifest-2026-11.')).length, 1);
});

test('R-RET-14: an artifact from a fork or another branch is left alone; one of ours from a workflow SOURCES does not list is held and fails the run', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1), { branch: 'evil' });
  w.add(2, 'ingest-keep-112-1', keepZip(2), { headRepo: 99 });
  const s = await w.run();
  assert.equal(s.status, 'ok');
  assert.equal(s.foreign.length, 2);
  assert.equal(downloads(w).length, 0);
  assert.equal(parts(w).length, 0);
  const w2 = world();
  w2.add(1, 'ingest-keep-111-1', keepZip(1), { workflow: 'mystery.yml' });
  const held = await w2.run();
  assert.equal(held.status, 'error');
  assert.match(held.reason, /held, not copied/);
  assert.equal(held.pending.count, 1);
});

test('R-RET-15: a file that is not a sealed keep or catalog file is refused and listed, the rest are copied, and the artifact is not retried forever', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', makeZip([{ name: 'keep-1-0.tar.age', data: age('k1') }, { name: 'notes.txt', data: 'plain' }, { name: 'keep-2-0.tar.age', data: Buffer.from('not age') }]));
  const s = await w.run();
  assert.equal(s.status, 'ok');
  const man = JSON.parse(w.read('manifest-2026-11.r0001.json'));
  assert.equal(man.artifacts['ingest-keep-111-1'].files.length, 1);
  assert.equal(man.artifacts['ingest-keep-111-1'].refused.length, 2);
  assert.equal((await w.run()).already, 1);
});

test('R-RET-16: a run stops taking artifacts at its byte limit, says what is waiting and since when, and the next run carries on', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1), { ago: 3 * HOUR });
  w.add(2, 'ingest-keep-112-1', keepZip(2), { ago: 2 * HOUR });
  w.add(3, 'ingest-keep-113-1', keepZip(3), { ago: HOUR });
  const first = await w.run({ maxRunBytes: 1 });
  assert.equal(first.copied.artifacts, 1);
  assert.equal(first.deferred, true);
  assert.equal(first.pending.count, 2);
  assert.equal(first.pending.oldest_at, new Date(w.c.t - 2 * HOUR).toISOString());
  const second = await w.run({ maxRunBytes: 1 });
  const third = await w.run({ maxRunBytes: 1 });
  assert.equal(second.copied.artifacts + third.copied.artifacts, 2);
  assert.equal(third.pending.count, 0);
});

test('partId names the contents, not the order; newestRevision takes the highest revision', () => {
  const a = { path: 'x', sha256: '1' };
  const b = { path: 'y', sha256: '2' };
  assert.equal(partId([a, b]), partId([b, a]));
  assert.notEqual(partId([a]), partId([a, b]));
  assert.equal(newestRevision([{ name: 'status.r0002.json' }, { name: 'status.r0010.json' }, { name: 'statusx.r0099.json' }], 'status').rev, 10);
});

test('R-RET-24: a tool list also staged for an earlier month whose write fails is still copied with the later month', async () => {
  const w = world();
  w.add(1, 'ingest-keep-111-1', keepZip(1, ['A']), { ago: 40 * DAY }); // October
  w.add(2, 'ingest-keep-112-1', keepZip(2, ['A']), { ago: HOUR }); // November
  const real = w.rel.gh.upload;
  let failed = false;
  w.rel.gh.upload = async (rel, name, data, label) => {
    if (name.startsWith('manifest-2026-10') && !failed) {
      failed = true;
      throw new Error('GitHub 502');
    }
    return real(rel, name, data, label);
  };
  const first = await w.run();
  assert.equal(first.status, 'error');
  const nov = parts(w).filter((p) => p.startsWith('keep-2026-11-'));
  assert.equal(nov.length, 1);
  assert.ok([...w.part(nov[0]).keys()].some((k) => k.endsWith(catalogName('A'))), 'catalog A is in the November part');
  assert.deepEqual(JSON.parse(w.read('catalogs.r0001.json')).catalogs, [sha(Buffer.from('A'))]);
  const second = await w.run();
  assert.equal(second.status, 'ok');
  const count = (p) => [...w.part(p).keys()].filter((k) => k.endsWith(catalogName('A'))).length;
  assert.equal(parts(w).reduce((n, p) => n + count(p), 0), 2, 'once in each part that holds it; none new after the November write succeeded');
});
