import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '../../pump/github.mjs';
import { createReleaseClient } from '../../snapshot/github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { makeZip } from '../../test/lib/zip.mjs';
import { DEFAULTS, GB, artifactKey, main, readConfig, runBackup, snapshotKey } from '../backup.mjs';
import { fakeS3 } from './fake-s3.mjs';

const REPO = 'isokron-ai/tool-qa';
const HOUR = 3_600_000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const AGE = 'age-encryption.org/v1\n';

const ageFile = (tag) => Buffer.from(`${AGE}-> X25519 ${tag}\n--- body\n${tag.repeat(20)}`);
const ingestZip = (tag) => makeZip([
  { name: `ingest-${tag}-0.tar.age`, data: ageFile(`${tag}0`) },
  { name: `ingest-${tag}-1.tar.age`, data: ageFile(`${tag}1`) },
]);
const registryZip = (tag) => {
  const data = Buffer.from(`{"server":"${tag}"}\n`);
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify({ mode: 'delta', file: `registry-${tag}.ndjson`, sha256: sha(data) }) },
    { name: `registry-${tag}.ndjson`, data },
  ]);
};

/** A fake GitHub (artifacts, runs, the state-snapshots release) and a fake bucket. */
function world({ pageSize = 1000 } = {}) {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const ago = (h) => new Date(c.t - h * HOUR).toISOString();
  const artifacts = [];
  const blobs = new Map();
  const runs = new Map();
  const workflowFor = (name) => (name.startsWith('ingest-') ? 'pump.yml' : name.startsWith('registry-') ? 'history-registry.yml' : 'test.yml');
  const addArtifact = (id, name, data, { hoursAgo = 1, digest = true, branch = 'main', headRepo = 1, workflow, runId = id * 10 } = {}) => {
    artifacts.unshift({
      id, name, created_at: ago(hoursAgo), expired: false, size_in_bytes: data.length,
      workflow_run: { id: runId, repository_id: 1, head_repository_id: headRepo, head_branch: branch, head_sha: 'abc' },
      ...(digest ? { digest: `sha256:${sha(data)}` } : {}),
    });
    runs.set(runId, { id: runId, created_at: ago(hoursAgo + 0.1), path: `.github/workflows/${workflow ?? workflowFor(name)}`, repository: { id: 1 }, head_repository: { id: headRepo } });
    blobs.set(`a${id}`, data);
  };
  const assets = [];
  const snapshots = [];
  const addSnapshot = (id, hoursAgo, tag) => {
    const data = ageFile(`snap${tag}`);
    const s = sha(data);
    const t = new Date(c.t - hoursAgo * HOUR);
    const name = `state-${t.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${s.slice(0, 8)}.sqlite.age`;
    assets.push({ id, name, size: data.length, state: 'uploaded', label: `sha256:${s}` });
    snapshots.push({ name, asset_id: id, created: t.toISOString(), sha256: s, size: data.length, source: null });
    blobs.set(`r${id}`, data);
    return { name, data };
  };
  const writeManifest = () => {
    const data = Buffer.from(JSON.stringify({ version: 1, updated: new Date(c.t).toISOString(), current_at: new Date(c.t).toISOString(), snapshots }, null, 2));
    const i = assets.findIndex((a) => a.name === 'manifest.json');
    if (i >= 0) assets.splice(i, 1);
    assets.push({ id: 900 + snapshots.length, name: 'manifest.json', size: data.length, state: 'uploaded' });
    blobs.set(`r${900 + snapshots.length}`, data);
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
    ['GET', /\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://storage.test/blob/a${req.path.split('/')[6]}?sig=secret` } })],
    ['GET', `/repos/${REPO}/releases/tags/state-snapshots`, () => (assets.length ? { body: { id: 7, upload_url: 'https://uploads.test/x{?name,label}' } } : { status: 404, body: { message: 'Not Found' } })],
    ['GET', `/repos/${REPO}/releases/7/assets`, () => ({ body: assets })],
    ['GET', /^\/repos\/isokron-ai\/tool-qa\/releases\/assets\/\d+$/, (req) => ({ status: 302, headers: { location: `https://storage.test/blob/r${req.path.split('/').pop()}` } })],
    ['GET', /^\/blob\/[ar]\d+$/, (req) => {
      const b = blobs.get(req.path.split('/')[2]);
      return b ? { body: b } : { status: 404, body: 'gone' };
    }],
  ]);
  const s3 = fakeS3({ now: c.now, pageSize });
  const token = 'ghs_synthetic_offsite';
  const gh = {
    client: createClient({ token, fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep }),
    release: createReleaseClient({ repo: REPO, token, fetch: api.fetch, apiUrl: API, sleep: c.sleep }),
    fetch: api.fetch,
    sleep: c.sleep,
  };
  let n = 0;
  const run = (over = {}) => runBackup({ store: s3, gh, repo: REPO, runId: `r${++n}`, now: c.now, ...over });
  return { c, api, s3, gh, run, addArtifact, addSnapshot, writeManifest, artifacts };
}

const keys = (s3, prefix = '') => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
const manifestLines = (s3) => keys(s3, 'manifest/').flatMap((k) => s3.objects.get(k).data.toString('utf8').trim().split('\n').map((l) => JSON.parse(l)));
const downloads = (api) => api.calls.filter((r) => r.url.startsWith('https://storage.test/'));

test('R-OFF-01: copies snapshots, the snapshot manifest, ingest and history artifacts byte for byte under kind/day keys, with a manifest part and a cursor', async () => {
  const w = world();
  const snap = w.addSnapshot(51, 3, 'a');
  w.writeManifest();
  const ing = ingestZip('x');
  const reg = registryZip('r');
  w.addArtifact(1, 'ingest-111-1', ing, { hoursAgo: 2, runId: 111 });
  w.addArtifact(2, 'registry-delta-20260302T1000Z', reg, { hoursAgo: 2 });
  w.addArtifact(3, 'something-else', Buffer.from('x'));
  const hb = await w.run();
  assert.equal(hb.status, 'ok', JSON.stringify(hb.failures));
  assert.deepEqual(hb.copied, { snapshots: 1, ingest: 1, history: 1, manifests: 1 });
  const ikey = 'ingest/2026-03-02/ingest-111-1/ingest-111-1.zip';
  assert.ok(w.s3.objects.get(ikey).data.equals(ing), 'the ingest zip as GitHub stores it');
  assert.ok(w.s3.objects.get('history/2026-03-02/registry-delta-20260302T1000Z/registry-delta-20260302T1000Z.zip').data.equals(reg));
  assert.ok(w.s3.objects.get(`snapshots/2026-03-02/${snap.name}`).data.equals(snap.data));
  assert.equal(keys(w.s3, 'snapshot-manifests/').length, 1);
  assert.equal(keys(w.s3).filter((k) => k.includes('something-else')).length, 0);
  // Every object carries its sha256 as metadata.
  for (const [k, o] of w.s3.objects) assert.equal(o.sha256, sha(o.data), k);
  const lines = manifestLines(w.s3);
  assert.equal(keys(w.s3, 'manifest/2026-03-02/').length, 1);
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['history', 'ingest', 'snapshot', 'snapshot-manifest']);
  const il = lines.find((l) => l.kind === 'ingest');
  assert.equal(il.key, ikey);
  assert.equal(il.sha256, sha(ing));
  assert.equal(il.source.workflow, '.github/workflows/pump.yml');
  assert.equal(il.source.digest_checked, true);
  assert.equal(il.source.run_id, 111);
  assert.deepEqual(il.contents.files.map((f) => f.name), ['ingest-x-0.tar.age', 'ingest-x-1.tar.age']);
  assert.deepEqual(il.contents.problems, []);
  const cursors = keys(w.s3, '_state/cursor/');
  assert.equal(cursors.length, 1);
  const cur = JSON.parse(w.s3.objects.get(cursors[0]).data);
  assert.equal(cur.last_ok_at, hb.at);
  assert.equal(cur.by_kind.ingest, w.artifacts.find((a) => a.id === 1).created_at);
  assert.equal(hb.last_ok_at, hb.at);
  assert.equal(hb.bucket_bytes, [...w.s3.objects.values()].reduce((s, o) => s + o.data.length, 0));
  assert.equal(hb.ops.put, w.s3.ops('put').length);
  // Nothing was decrypted: the stored ingest files still start as age files.
  assert.ok(w.s3.objects.get(`snapshots/2026-03-02/${snap.name}`).data.subarray(0, AGE.length).toString() === AGE);
});

test('R-OFF-02: dedupe: a second run copies nothing new; a key with the same sha256 is skipped by HEAD without a download; other bytes under a key are never overwritten', async () => {
  const w = world();
  w.addSnapshot(51, 3, 'a');
  w.writeManifest();
  w.addArtifact(1, 'ingest-111-1', ingestZip('x'), { hoursAgo: 0.5 });
  assert.equal((await w.run()).status, 'ok');
  const puts = w.s3.ops('put').length;
  const before = downloads(w.api).length;
  w.c.t += HOUR / 2;
  const hb = await w.run();
  assert.equal(hb.status, 'ok');
  assert.deepEqual(hb.copied, { snapshots: 0, ingest: 0, history: 0, manifests: 0 });
  assert.ok(hb.already >= 3);
  // Only the release manifest was read again; the artifact and the snapshot were judged by HEAD.
  assert.equal(downloads(w.api).length - before, 1);
  // The second run writes only its own cursor (no manifest part: it copied nothing).
  assert.deepEqual(w.s3.calls.slice(-2 * 1).map((x) => x.op), ['put', 'head']);
  assert.equal(w.s3.ops('put').length, puts + 1);

  // A key that holds other bytes: the copy goes beside it; the run reports it.
  const w2 = world();
  const ing = ingestZip('y');
  w2.addArtifact(2, 'ingest-222-1', ing, { hoursAgo: 1 });
  const key = artifactKey(w2.artifacts[0], true);
  w2.s3.seed(key, Buffer.from('someone else'));
  const hb2 = await w2.run();
  assert.equal(hb2.status, 'verify_failed');
  assert.ok(w2.s3.objects.get(key).data.equals(Buffer.from('someone else')), 'never overwritten');
  const alt = `${key}.sha256-${sha(ing).slice(0, 12)}`;
  assert.ok(w2.s3.objects.get(alt).data.equals(ing));
  assert.equal(manifestLines(w2.s3).find((l) => l.key === alt).conflict_with, key);
  // The next run finds the copy beside it and is clean.
  w2.c.t += HOUR;
  const hb3 = await w2.run();
  assert.equal(hb3.status, 'ok', JSON.stringify(hb3.failures));
  assert.equal(hb3.copied.ingest, 0);
});

test('R-OFF-03: a HEAD after the PUT that does not show the bytes sent is a verification failure: red status, exit code 1, and the cursor holds', async () => {
  const w = world();
  w.addArtifact(1, 'ingest-111-1', ingestZip('x'), { hoursAgo: 3 });
  w.addArtifact(2, 'ingest-222-1', ingestZip('y'), { hoursAgo: 2 });
  const bad = artifactKey(w.artifacts.find((a) => a.id === 1), true);
  w.s3.faults.headEtag.add(bad);
  const hb = await w.run();
  assert.equal(hb.status, 'verify_failed');
  assert.equal(hb.verify_failures, 1);
  assert.match(hb.failures[0].error, /ETag 0{32} is not the MD5/);
  assert.equal(hb.failures[0].verify, true);
  const cur = JSON.parse(w.s3.objects.get(keys(w.s3, '_state/cursor/')[0]).data);
  assert.equal(cur.by_kind.ingest, undefined, 'held before the failed item');
  assert.equal(cur.last_ok_at, null);
  // Size and sha256 metadata are checked too.
  for (const fault of ['headSize', 'headSha']) {
    const v = world();
    v.addArtifact(1, 'ingest-111-1', ingestZip('x'));
    v.s3.faults[fault].add(artifactKey(v.artifacts[0], true));
    const r = await v.run();
    assert.equal(r.status, 'verify_failed', fault);
  }
});

test('R-OFF-04: the cost cap: nothing is uploaded past OFFSITE_MAX_BYTES (status over_cap); per-run byte and operation caps defer to the next run', async () => {
  // Already at the cap: no GitHub call, no PUT.
  const w = world();
  w.addArtifact(1, 'ingest-111-1', ingestZip('x'));
  w.s3.seed('history/2026-01-01/old/old.zip', Buffer.alloc(5000));
  const hb = await w.run({ limits: { ...DEFAULTS, maxBytes: 5000 } });
  assert.equal(hb.status, 'over_cap');
  assert.equal(w.s3.ops('put').length, 0);
  assert.equal(w.api.calls.length, 0);
  // An upload that would pass the cap is refused; earlier ones stand.
  const w2 = world();
  const a = ingestZip('a');
  w2.addArtifact(1, 'ingest-111-1', a, { hoursAgo: 2 });
  w2.addArtifact(2, 'ingest-222-1', ingestZip('b'), { hoursAgo: 1 });
  w2.s3.seed('history/2026-01-01/old/old.zip', Buffer.alloc(10_000_000));
  const cap = 10_000_000 + 1_000_000 + a.length + Math.floor(a.length / 2);
  const hb2 = await w2.run({ limits: { ...DEFAULTS, maxBytes: cap } });
  assert.equal(hb2.status, 'over_cap');
  assert.match(hb2.reason, /over the cap/);
  assert.equal(hb2.copied.ingest, 1);
  assert.ok(hb2.bucket_bytes <= cap);
  assert.equal(hb2.near_cap, true);
  // Per-run bytes: the second artifact waits for the next run; not a failure.
  const w3 = world();
  w3.addArtifact(1, 'ingest-111-1', ingestZip('a'), { hoursAgo: 2 });
  w3.addArtifact(2, 'ingest-222-1', ingestZip('b'), { hoursAgo: 1 });
  const hb3 = await w3.run({ limits: { ...DEFAULTS, maxRunBytes: 10 } });
  assert.equal(hb3.status, 'ok');
  assert.equal(hb3.copied.ingest, 1);
  assert.equal(hb3.deferred, 1);
  assert.match(hb3.deferred_reason, /OFFSITE_MAX_RUN_BYTES/);
  w3.c.t += HOUR;
  assert.equal((await w3.run()).copied.ingest, 1, 'the next run carries on');
  // Class A operations: refused past the cap, the bookkeeping still written.
  const w4 = world();
  for (let i = 1; i <= 5; i++) w4.addArtifact(i, `ingest-${i}00-1`, ingestZip(`c${i}`), { hoursAgo: 6 - i });
  const hb4 = await w4.run({ limits: { ...DEFAULTS, maxClassA: 3 } });
  assert.equal(hb4.status, 'ok');
  assert.match(hb4.deferred_reason, /Class A/);
  assert.equal(hb4.copied.ingest, 2);
  assert.equal(keys(w4.s3, '_state/cursor/').length, 1);
  // The configured cap cannot be set past the free tier.
  assert.deepEqual(readConfig({ OFFSITE_MAX_BYTES: String(11 * GB) }).problems, [`OFFSITE_MAX_BYTES is ${11 * GB}, above the free tier's ${10 * GB}`]);
  assert.equal(readConfig({}).limits.maxBytes, 8 * GB);
});

test('R-OFF-05: the origin filter: artifacts from a fork, another branch or another workflow are never copied; ours from an unlisted workflow are held', async () => {
  const w = world();
  w.addArtifact(1, 'ingest-111-1', ingestZip('fork'), { headRepo: 2, hoursAgo: 4 });
  w.addArtifact(2, 'ingest-222-1', ingestZip('branch'), { branch: 'feature', hoursAgo: 3 });
  w.addArtifact(3, 'registry-delta-x', registryZip('t'), { workflow: 'test.yml', hoursAgo: 2 });
  w.addArtifact(4, 'ingest-444-1', ingestZip('ok'), { hoursAgo: 1 });
  const hb = await w.run();
  assert.deepEqual(hb.foreign.map((f) => f.id).sort(), [1, 2]);
  assert.equal(hb.copied.ingest, 1);
  assert.equal(keys(w.s3, 'ingest/').length, 1);
  assert.ok(keys(w.s3, 'ingest/')[0].includes('ingest-444-1'));
  assert.equal(keys(w.s3, 'history/').length, 0);
  assert.equal(hb.status, 'error');
  assert.match(hb.failures[0].error, /held, not copied: .*SOURCES/);
  // Foreign artifacts were never downloaded.
  assert.equal(downloads(w.api).filter((r) => /blob\/a[12]\b/.test(r.url)).length, 0);
  const cur = JSON.parse(w.s3.objects.get(keys(w.s3, '_state/cursor/')[0]).data);
  assert.equal(cur.by_kind.history, undefined, 'the history cursor holds at the held artifact');
  assert.ok(cur.by_kind.ingest);
});

test('R-OFF-06: the cursor: the next run lists artifacts only back to an hour before it, and downloads only what is new', async () => {
  const w = world({ pageSize: 2 });
  for (let i = 1; i <= 350; i++) w.addArtifact(i, `registry-delta-${String(i).padStart(3, '0')}`, registryZip(`t${i}`), { hoursAgo: 400 - i });
  const first = await w.run();
  assert.equal(first.status, 'ok', JSON.stringify(first.failures));
  assert.equal(first.copied.history, 350);
  // The bucket is listed in pages to the end.
  assert.ok(w.s3.ops('list').length >= 1);
  const listed = () => w.api.calls.filter((r) => r.path === `/repos/${REPO}/actions/artifacts`).length;
  const l1 = listed();
  assert.equal(l1, 4, 'the first run lists everything');
  w.c.t += 6 * HOUR;
  w.addArtifact(351, 'registry-delta-351', registryZip('new'), { hoursAgo: 1 });
  const d0 = downloads(w.api).length;
  const second = await w.run();
  assert.equal(second.copied.history, 1);
  assert.equal(listed() - l1, 2, 'the list stops at the first page older than the cursor');
  assert.equal(downloads(w.api).length - d0, 1, 'only the new artifact is downloaded');
  assert.ok(w.s3.ops('list').length > 2, 'the bucket listing follows its continuation tokens');
});

test('R-OFF-07: missing R2 settings: exit 0, an unconfigured heartbeat, no store and no GitHub call; the workflow keeps the secrets in the backup step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offsite-'));
  try {
    const file = join(dir, 'hb', 'offsite-heartbeat-1-1.json');
    const env = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_x', R2_BUCKET: 'isokron-loop-backup', OFFSITE_HEARTBEAT_FILE: file, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
    let made = false;
    const code = await main([], env, { get store() { made = true; return null; } });
    assert.equal(code, 0);
    assert.equal(made, false);
    const hb = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(hb.status, 'unconfigured');
    assert.deepEqual(hb.missing, ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
    const { judgeOffsite } = await import('../../watchdog/offsite.mjs');
    assert.equal(judgeOffsite({ now: Date.now(), hb, latest: { id: 1, conclusion: 'success' } }).status, 'amber');
    // A wrong setting is an error, not "not configured".
    const bad = { ...env, R2_ACCOUNT_ID: 'not-hex', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };
    assert.equal(await main([], bad, { store: {} }), 1);
    assert.match(JSON.parse(readFileSync(file, 'utf8')).reason, /R2_ACCOUNT_ID is not/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const yml = readFileSync(new URL('../../.github/workflows/offsite-backup.yml', import.meta.url), 'utf8');
  const steps = yml.split(/\n\s+- name: /);
  const withSecrets = steps.filter((s) => s.includes('secrets.'));
  assert.deepEqual(withSecrets.map((s) => s.split('\n')[0]), ['Back up', 'Prune']);
  assert.match(yml, /\npermissions: \{\}\n/);
  assert.match(yml, /concurrency:\n {2}group: offsite-backup\n/);
  assert.match(yml, /contents: read[^\n]*\n {6}actions: read/);
  // GitHub prints a step's env in its public log: the account ID comes only from a secret (R-OFF-13).
  assert.equal((yml.match(/R2_ACCOUNT_ID: \$\{\{ secrets\.R2_ACCOUNT_ID \}\}/g) ?? []).length, 2);
  assert.ok(!yml.includes('vars.R2_ACCOUNT_ID'));
  assert.match(yml, /runs-on: ubuntu-24\.04\n {4}timeout-minutes: 40/);
  assert.match(yml, /if: >-\n {6}!cancelled\(\) && github\.ref == 'refs\/heads\/main' && \(/);
  // The guard runs before anything else that does work, in both jobs.
  for (const job of yml.split(/\n {2}[a-z]+:\n {4}name: /).slice(1)) {
    const names = job.split(/\n\s+- name: /).slice(1).map((s) => s.split('\n')[0]);
    assert.deepEqual(names.slice(0, 2), ['Check out', 'Kill switch']);
    assert.match(job, /node scripts\/guard\.mjs --job offsite --no-slots/);
  }
});

test('R-OFF-08: a failed bucket read is an error heartbeat, not a crash, and the credentials never reach the heartbeat', async () => {
  const w = world();
  const failing = { ...w.s3, list: async () => { throw Object.assign(new Error('R2 LIST failed: AccessDenied for AKIA_SYNTHETIC_KEY in bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), { status: 403 }); } };
  const dir = mkdtempSync(join(tmpdir(), 'offsite-'));
  try {
    const file = join(dir, 'hb.json');
    const code = await main([], {
      GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_x', R2_ACCOUNT_ID: 'b'.repeat(32), R2_BUCKET: 'isokron-loop-backup',
      R2_ACCESS_KEY_ID: 'AKIA_SYNTHETIC_KEY', R2_SECRET_ACCESS_KEY: 'synthetic-secret-value', OFFSITE_HEARTBEAT_FILE: file,
    }, { store: failing });
    assert.equal(code, 1);
    const text = readFileSync(file, 'utf8');
    const hb = JSON.parse(text);
    assert.equal(hb.status, 'error');
    assert.match(hb.reason, /could not read the bucket/);
    assert.ok(!text.includes('AKIA_SYNTHETIC_KEY') && !text.includes('b'.repeat(32)), 'scrubbed');
    assert.match(text, /\*\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-OFF-01: snapshot keys and artifact keys are by kind and UTC day', () => {
  assert.equal(snapshotKey({ name: 'state-20261124T023500Z-1c891cb4.sqlite.age', created: '2026-11-24T02:35:00Z' }), 'snapshots/2026-11-24/state-20261124T023500Z-1c891cb4.sqlite.age');
  assert.equal(artifactKey({ name: 'ingest-45312591667-1', created_at: '2026-11-24T02:48:55Z' }, true), 'ingest/2026-11-24/ingest-45312591667-1/ingest-45312591667-1.zip');
  assert.equal(artifactKey({ name: 'ingest-abc.tar.age', created_at: '2026-11-24T23:59:59Z' }, false), 'ingest/2026-11-24/ingest-abc.tar.age/ingest-abc.tar.age');
  assert.equal(artifactKey({ name: 'history-packages-9', created_at: '2026-11-25T00:00:00Z' }, true), 'history/2026-11-25/history-packages-9/history-packages-9.zip');
});

test('R-OFF-12: a PUT stored but answered "exists" on retry counts as copied with its manifest line; a run that died before its manifest part is recovered next run; one kind past its run bytes does not stop the others; the time limit defers', async () => {
  // Lost answers, for an artifact and for the run's own cursor.
  const w = world();
  const ing = ingestZip('x');
  w.addArtifact(1, 'ingest-111-1', ing, { hoursAgo: 1 });
  w.s3.faults.lostAnswer.add('ingest/');
  w.s3.faults.lostAnswer.add('_state/cursor/');
  const hb = await w.run();
  assert.equal(hb.status, 'ok', JSON.stringify(hb));
  assert.equal(hb.copied.ingest, 1);
  assert.equal(hb.copied_bytes, ing.length);
  assert.ok(hb.bucket_bytes >= ing.length);
  assert.equal(manifestLines(w.s3).filter((l) => l.kind === 'ingest').length, 1);

  // A run that copied but could not write its manifest part or cursor.
  const v = world();
  assert.equal((await v.run()).status, 'ok');
  v.c.t += HOUR;
  v.addArtifact(2, 'ingest-222-1', ingestZip('y'), { hoursAgo: 0.5 });
  v.s3.faults.putError = (key) => (key.startsWith('manifest/') ? new Error('R2 PUT failed: InternalError (HTTP 500)') : null);
  const crashed = await v.run();
  assert.equal(crashed.status, 'error');
  assert.equal(manifestLines(v.s3).length, 0);
  v.s3.faults.putError = () => null;
  v.c.t += HOUR;
  const next = await v.run();
  assert.equal(next.status, 'ok');
  const lines = manifestLines(v.s3);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].recovered, true);
  assert.equal(lines[0].source.artifact, 'ingest-222-1');
  // and only once: the run after that does not write it again.
  v.c.t += HOUR;
  await v.run();
  assert.equal(manifestLines(v.s3).length, 1);

  // Ingest past its run bytes; history still goes.
  const u = world();
  const ia = ingestZip('a');
  const rz = makeZip([{ name: 'x.ndjson', data: '1' }]);
  u.addArtifact(1, 'ingest-111-1', ia, { hoursAgo: 3 });
  u.addArtifact(2, 'ingest-222-1', ingestZip('b'), { hoursAgo: 2 });
  u.addArtifact(3, 'registry-delta-x', rz, { hoursAgo: 1 });
  assert.ok(ia.length > rz.length + 1);
  const hu = await u.run({ limits: { ...DEFAULTS, maxRunBytes: ia.length + rz.length + 1 } });
  assert.equal(hu.status, 'ok');
  assert.equal(hu.copied.ingest, 1);
  assert.equal(hu.copied.history, 1);
  assert.equal(hu.deferred, 1);

  // The time limit: nothing new is taken, the cursor is still written.
  const t = world();
  t.addArtifact(1, 'ingest-111-1', ingestZip('a'));
  const ht = await t.run({ maxRunMs: -1 });
  assert.equal(ht.status, 'ok');
  assert.equal(ht.copied.ingest, 0);
  assert.match(ht.deferred_reason, /time limit/);
  assert.equal(keys(t.s3, '_state/cursor/').length, 1);
  assert.equal(JSON.parse(t.s3.objects.get(keys(t.s3, '_state/cursor/')[0]).data).by_kind.ingest, undefined);
});

test('R-OFF-13: the account ID only from a secret, both jobs only on main; retries count against the operation caps; a PUT that failed every attempt counts as possibly stored; a truncated listing is an error', async () => {
  const yml = readFileSync(new URL('../../.github/workflows/offsite-backup.yml', import.meta.url), 'utf8');
  assert.ok(!yml.includes('vars.R2_ACCOUNT_ID'));
  const jobs = yml.split(/\n {2}(?=[a-z]+:\n {4}name: )/).slice(1);
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.match(job, /\n {4}if: (>-\n\s+!cancelled\(\) && )?github\.ref == 'refs\/heads\/main'/, job.split('\n')[0]);

  // One failed attempt, then success: two PUTs counted.
  const w = world();
  w.addArtifact(1, 'ingest-111-1', ingestZip('x'));
  let fails = 1;
  w.s3.faults.putError = (key) => (key.startsWith('ingest/') && fails-- > 0 ? Object.assign(new Error('R2 PUT failed: InternalError (HTTP 500)'), { status: 500 }) : null);
  const hb = await w.run();
  assert.equal(hb.status, 'ok', JSON.stringify(hb.failures));
  assert.equal(w.s3.ops('put').filter((c) => c.key.startsWith('ingest/')).length, 2);
  assert.equal(hb.ops.put, w.s3.ops('put').length);

  // Every attempt fails: the bytes count against the cap as possibly stored, and the cap sees them.
  const v = world();
  const ing = ingestZip('y');
  v.addArtifact(1, 'ingest-111-1', ing, { hoursAgo: 2 });
  v.addArtifact(2, 'ingest-222-1', ingestZip('z'), { hoursAgo: 1 });
  v.s3.faults.putError = (key) => (key.includes('ingest-111-1') ? Object.assign(new Error('R2 PUT failed: InternalError (HTTP 500)'), { status: 500 }) : null);
  const hv = await v.run({ limits: { ...DEFAULTS, maxBytes: 1_000_000 + ing.length + 10 } });
  assert.equal(v.s3.ops('put').filter((c) => c.key.includes('ingest-111-1')).length, 3);
  assert.equal(hv.possibly_stored_bytes, ing.length);
  assert.equal(hv.status, 'over_cap', 'the second artifact no longer fits once the first may be stored');
  // A 4xx refusal is not retried.
  const u = world();
  u.addArtifact(1, 'ingest-111-1', ingestZip('q'));
  u.s3.faults.putError = (key) => (key.startsWith('ingest/') ? Object.assign(new Error('R2 PUT failed: AccessDenied (HTTP 403)'), { status: 403 }) : null);
  await u.run();
  assert.equal(u.s3.ops('put').filter((c) => c.key.startsWith('ingest/')).length, 1);

  // A listing marked truncated with no token: an error, nothing copied.
  const t = world();
  t.s3.seed('history/a', Buffer.from('a'));
  t.s3.seed('history/b', Buffer.from('b'));
  t.s3.faults.truncateAt = 1;
  t.addArtifact(1, 'ingest-111-1', ingestZip('t'));
  const ht = await t.run();
  assert.equal(ht.status, 'error');
  assert.match(ht.reason, /cut short/);
  assert.equal(t.s3.ops('put').length, 0);
});

test('R-RET-22: the keep-forever part of the pump outputs gets its own key prefix, so the prune can never mistake it for full data; the Mac archive names its kind', async () => {
  const { isKeepArtifact } = await import('../backup.mjs');
  const { ingestKind, ingestRun } = await import('../../scripts/archive-pull.mjs');
  const keep = { name: 'ingest-keep-111-2', created_at: '2026-03-02T01:00:00Z' };
  const full = { name: 'ingest-111-2', created_at: '2026-03-02T01:00:00Z' };
  assert.equal(artifactKey(keep, true), 'keep/2026-03-02/ingest-keep-111-2/ingest-keep-111-2.zip');
  assert.equal(artifactKey(full, true), 'ingest/2026-03-02/ingest-111-2/ingest-111-2.zip');
  assert.equal(isKeepArtifact('ingest-keep-1-1'), true);
  assert.equal(isKeepArtifact('ingest-keep-x'), false);
  assert.equal(isKeepArtifact('ingest-1-1'), false);
  assert.equal(ingestKind('ingest-keep-111-2'), 'keep');
  assert.equal(ingestKind('ingest-111-2'), 'pump');
  assert.deepEqual(ingestRun({ name: 'ingest-keep-111-2', workflow_run: { id: 111 } }), { run_id: 111, run_attempt: 2, attempt_id: null });
});
