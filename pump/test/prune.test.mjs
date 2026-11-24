// Pruning inside the pump (pump/prune.mjs): stage an archive, delete only what
// an archive that reads back holds, give up safely, record the state size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ABANDON_MS, LAST_KEY, SIZE_KEY, STAGED_KEY, artifactFetcher, archiveNames, pruneEnabled, pruneStep, recordStateSize,
} from '../prune.mjs';
import { PRUNE_MIN_AGE_MS, readArchive, stateSize } from '../../state/prune.mjs';
import { fakeDecrypt, fakeEncrypt } from '../../ingest/testkit.mjs';
import { ApiBudget } from '../budgets.mjs';
import { API, fakeApi } from '../../test/lib/fake-api.mjs';
import { makeZip } from '../../test/lib/zip.mjs';
import { DAY, HOUR, MIN, buildHistory } from '../../test/lib/state-history.mjs';

const CRYPTO = { encrypt: (b) => fakeEncrypt(b), decrypt: (b) => fakeDecrypt(b) };
const REPO = 'isokron-ai/tool-qa';

function setup({ seed = 2, days = 14 } = {}) {
  const { db, now } = buildHistory({ seed, days });
  const dir = mkdtempSync(join(tmpdir(), 'pump-prune-'));
  return { db, now, dir, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** The archive a run staged, served as GitHub would: raw (archive: false) or zipped. */
function served(dir, staged, { zip = false } = {}) {
  const bytes = readFileSync(join(dir, staged.file));
  return zip ? makeZip([{ name: staged.file, data: bytes }]) : bytes;
}

const step = (o) => pruneStep({ repo: REPO, crypto: CRYPTO, lateMs: 6 * HOUR, log: () => {}, ...o });

for (const zip of [false, true]) {
  test(`stage, then delete once the artifact reads back (${zip ? 'zipped' : 'raw'} download)`, async () => {
    const { db, now, dir, done } = setup();
    try {
      const before = stateSize(db).rows;
      const r1 = await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2' }, archiveDir: dir, fetchArchive: async () => null });
      assert.equal(r1.status, 'staged');
      const staged = db.getKv(STAGED_KEY);
      assert.equal(staged.artifact, 'ingest-state-archive-41-2');
      assert.equal(staged.file, 'state-archive-41-2.tar.age');
      assert.deepEqual(readdirSync(dir), [staged.file]);
      assert.deepEqual(stateSize(db).rows, { ...before, kv: before.kv + 2 }, 'staging deletes nothing (it adds the staged note and the result)');
      // The archive is age ciphertext of the rows, readable with the identity.
      const archive = readArchive(fakeDecrypt(readFileSync(join(dir, staged.file))));
      assert.equal(archive.meta.staged_id, staged.id);
      assert.equal(archive.rows.length, staged.rows);
      // The next run finds it and deletes.
      let asked = null;
      const later = now + 15 * MIN;
      const r2 = await step({ db, now: () => later, env: { GITHUB_RUN_ID: '42' }, archiveDir: join(dir, 'next'), fetchArchive: async (s) => { asked = s; return served(dir, s, { zip }); } });
      assert.equal(asked.id, staged.id);
      assert.equal(r2.complete.status, 'pruned');
      assert.equal(r2.complete.total, staged.rows);
      assert.equal(r2.status, 'pruned');
      const after = stateSize(db).rows;
      assert.equal(after.attempts, before.attempts - archive.meta.counts.attempts);
      // Nothing more was old enough, so nothing new is staged, and the note is gone.
      assert.equal(r2.stage.status, 'nothing');
      assert.equal(db.getKv(STAGED_KEY), undefined);
      assert.equal(db.getKv(LAST_KEY).status, 'pruned');
    } finally {
      done();
    }
  });
}

test('an archive not on its run yet: nothing is deleted and nothing new is staged until it shows up or is given up', async () => {
  const { db, now, dir, done } = setup();
  try {
    await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41' }, archiveDir: dir, fetchArchive: async () => null });
    const staged = db.getKv(STAGED_KEY);
    const rows = stateSize(db).rows;
    const w = await step({ db, now: () => now + ABANDON_MS - MIN, env: { GITHUB_RUN_ID: '42' }, archiveDir: join(dir, 'b'), fetchArchive: async () => null });
    assert.equal(w.complete.status, 'waiting');
    assert.equal(w.stage, null);
    assert.deepEqual(db.getKv(STAGED_KEY), staged);
    assert.deepEqual(stateSize(db).rows.attempts, rows.attempts);
    assert.equal(existsSync(join(dir, 'b')), false);
    // Past ABANDON_MS: given up, nothing deleted, and the rows are staged again in a new archive.
    const g = await step({ db, now: () => now + ABANDON_MS + MIN, env: { GITHUB_RUN_ID: '43' }, archiveDir: join(dir, 'c'), fetchArchive: async () => null });
    assert.equal(g.complete.status, 'abandoned');
    assert.equal(g.stage.status, 'staged');
    assert.equal(stateSize(db).rows.attempts, rows.attempts);
    assert.equal(db.getKv(STAGED_KEY).artifact, 'ingest-state-archive-43-1');
  } finally {
    done();
  }
});

for (const [label, tamper] of [
  ['bytes that are not the staged archive', (buf) => Buffer.concat([buf, Buffer.from('x')])],
  ['a zip holding another file name', (buf) => makeZip([{ name: 'other.tar.age', data: buf }])],
  ['an archive of another staging', null],
]) {
  test(`an artifact with ${label} is given up and nothing is deleted`, async () => {
    const { db, now, dir, done } = setup();
    try {
      await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41' }, archiveDir: dir, fetchArchive: async () => null });
      const staged = db.getKv(STAGED_KEY);
      const rows = stateSize(db).rows;
      let fetchArchive;
      if (tamper) fetchArchive = async (s) => tamper(served(dir, s));
      else {
        // Same name and bytes as a real archive, from a staging the state no longer has.
        db.setKv(STAGED_KEY, { ...staged, id: 'another' }, { now });
        fetchArchive = async (s) => served(dir, s);
      }
      const r = await step({ db, now: () => now + MIN, env: {}, archiveDir: join(dir, 'b'), fetchArchive });
      assert.equal(r.complete.status, 'abandoned');
      assert.equal(stateSize(db).rows.attempts, rows.attempts);
      assert.equal(db.getKv(STAGED_KEY), undefined);
    } finally {
      done();
    }
  });
}

test('a failing download is an error result, never a throw, and keeps the staged note for the next run', async () => {
  const { db, now, dir, done } = setup();
  try {
    await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41' }, archiveDir: dir, fetchArchive: async () => null });
    const staged = db.getKv(STAGED_KEY);
    const r = await step({ db, now: () => now + MIN, env: { GITHUB_RUN_ID: '42' }, archiveDir: join(dir, 'b'), fetchArchive: async () => { throw new Error('HTTP 502'); } });
    assert.equal(r.status, 'error');
    assert.match(r.error, /HTTP 502/);
    assert.deepEqual(db.getKv(STAGED_KEY), staged);
    assert.equal(db.getKv(LAST_KEY).status, 'error');
  } finally {
    done();
  }
});

test('the lane switch stops pruning; without a run id (a local run) nothing is staged', async () => {
  assert.equal(pruneEnabled({}), true);
  assert.equal(pruneEnabled({ LANE_STATE_PRUNE_ENABLED: 'true' }), true);
  assert.equal(pruneEnabled({ LANE_STATE_PRUNE_ENABLED: 'false' }), false);
  const { db, now, dir, done } = setup();
  try {
    const off = await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41', LANE_STATE_PRUNE_ENABLED: 'false' }, archiveDir: dir, fetchArchive: async () => null });
    assert.equal(off.status, 'off');
    const local = await step({ db, now: () => now, env: {}, archiveDir: dir, fetchArchive: async () => null });
    assert.equal(local.stage, null);
    assert.equal(db.getKv(STAGED_KEY), undefined);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    done();
  }
});

test('a prune age below the late window is raised to the late window plus an hour', async () => {
  const { db, now, dir, done } = setup({ days: 3 });
  try {
    const r = await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41' }, archiveDir: dir, fetchArchive: async () => null, minAgeMs: MIN });
    assert.equal(r.stage.cutoff, new Date(now - 7 * HOUR).toISOString());
    const d = await step({ db: (() => { db.deleteKv(STAGED_KEY); return db; })(), now: () => now, env: { GITHUB_RUN_ID: '42' }, archiveDir: join(dir, 'b'), fetchArchive: async () => null });
    assert.equal(d.stage.status, 'nothing', 'by default nothing under 7 days old goes');
    assert.equal(d.stage.cutoff, new Date(now - PRUNE_MIN_AGE_MS).toISOString());
  } finally {
    done();
  }
});

test('recordStateSize keeps the size, rows, asset size and the last prune result', () => {
  const { db, now, done } = setup({ days: 2 });
  try {
    const v = recordStateSize(db, { now, assetBytes: 1234, prune: { status: 'pruned', at: 'x', complete: { total: 9 }, stage: { rows: 3 } } });
    assert.deepEqual(db.getKv(SIZE_KEY), v);
    assert.equal(v.asset_bytes, 1234);
    assert.equal(v.bytes, stateSize(db).bytes);
    assert.ok(v.rows.attempts > 0);
    assert.deepEqual(v.prune, { status: 'pruned', at: 'x', error: null, deleted: 9, staged: 3 });
  } finally {
    done();
  }
});

test('archiveNames refuses anything but a numeric run id and attempt', () => {
  assert.deepEqual(archiveNames({ runId: 7, runAttempt: 1 }), { artifact: 'ingest-state-archive-7-1', file: 'state-archive-7-1.tar.age' });
  for (const bad of ['', '1/../2', '12a', '1\n2']) assert.throws(() => archiveNames({ runId: bad }));
});

test('artifactFetcher finds the artifact on the staging run by name, skips other runs and expired ones, and sends no token to storage', async () => {
  const body = Buffer.from('age-encryption.org/v1\nfake');
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/runs/41/artifacts`, (req) => {
      assert.equal(req.query.get('name'), 'ingest-state-archive-41-1');
      return {
        body: {
          artifacts: [
            { id: 1, name: 'ingest-state-archive-41-1', expired: true, size_in_bytes: 10, workflow_run: { id: 41 } },
            { id: 2, name: 'ingest-41-1', expired: false, size_in_bytes: 10, workflow_run: { id: 41 } },
            { id: 3, name: 'ingest-state-archive-41-1', expired: false, size_in_bytes: 10, workflow_run: { id: 40 } },
            { id: 4, name: 'ingest-state-archive-41-1', expired: false, size_in_bytes: 10, workflow_run: { id: 41 } },
          ],
        },
      };
    }],
    ['GET', `/repos/${REPO}/actions/runs/43/artifacts`, () => ({ body: { artifacts: [] } })],
    ['GET', /\/actions\/artifacts\/4\/zip$/, () => ({ status: 302, headers: { location: 'https://storage.test/blob/4' } })],
    ['GET', '/blob/4', (req) => {
      assert.equal(req.headers.get('authorization'), null, 'no token to the storage host');
      return { body: body };
    }],
  ]);
  const minted = [];
  const fetchArchive = artifactFetcher({
    repo: REPO, fetch: api.fetch, apiUrl: API, budget: new ApiBudget({ now: () => 0, sleep: async () => {} }), now: () => 0, sleep: async () => {},
    mintToken: async (args) => { minted.push(args); return { token: 'ghs_test' }; },
  });
  const got = await fetchArchive({ run_id: 41, artifact: 'ingest-state-archive-41-1' });
  assert.deepEqual(got, body);
  assert.deepEqual(minted[0], { repositories: ['tool-qa'], permissions: { actions: 'read' } });
  assert.equal(await fetchArchive({ run_id: 43, artifact: 'ingest-state-archive-43-1' }), null);
});

test('after a prune and a VACUUM the database is smaller and the size metric says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pump-prune-'));
  try {
    const { db, now } = buildHistory({ seed: 8, days: 30, file: join(dir, 's.sqlite') });
    const before = stateSize(db).bytes;
    await step({ db, now: () => now, env: { GITHUB_RUN_ID: '41' }, archiveDir: dir, fetchArchive: async () => null });
    const r = await step({ db, now: () => now + MIN, env: { GITHUB_RUN_ID: '42' }, archiveDir: join(dir, 'b'), fetchArchive: async (s) => served(dir, s) });
    assert.equal(r.complete.status, 'pruned');
    assert.ok(r.vacuum, 'VACUUM was considered');
    const size = recordStateSize(db, { now: now + MIN, prune: r });
    assert.ok(size.bytes < before || !r.vacuum.vacuumed, `${size.bytes} < ${before}`);
    assert.equal(size.prune.deleted, r.complete.total);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the archive pull and the off-site backup take a staged archive as an ingest artifact of the pump, with no change to them', async () => {
  const { kindOf, ingestEntryProblem, SOURCES, ingestRun } = await import('../../scripts/archive-pull.mjs');
  const { artifact, file } = archiveNames({ runId: 45333001390, runAttempt: 1 });
  assert.equal(kindOf(artifact), 'ingest');
  assert.ok(SOURCES.find(([p]) => artifact.startsWith(p))[1].includes('pump.yml'));
  assert.equal(ingestEntryProblem({ name: file, data: fakeEncrypt(Buffer.from('x')) }), null);
  assert.deepEqual(ingestRun({ name: artifact, workflow_run: { id: 45333001390 } }), { run_id: 45333001390, run_attempt: null, attempt_id: 'state-archive-45333001390-1' });
});
