import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { drill, inspectDatabase, loopStopped } from '../restore.mjs';
import { encodeState } from '../../scripts/state-asset.mjs';
import { createReleaseClient } from '../github.mjs';
import { runSnapshot } from '../snapshot.mjs';
import { cipher, fakeGh, sha } from './fake-github.mjs';

const T0 = Date.parse('2026-11-24T12:41:00Z');
const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;

/** A small state-like database: { bytes, dir }. */
function makeDb({ subjects = 3, results = 5, rows = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'snap-db-'));
  const file = join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY);
           CREATE TABLE results (id INTEGER PRIMARY KEY, subject TEXT, body TEXT);
           CREATE INDEX results_subject ON results (subject);
           CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER);
           INSERT INTO counters VALUES ('fence', 42);
           PRAGMA user_version = 6;`);
  for (let i = 0; i < subjects; i++) db.prepare('INSERT INTO subjects VALUES (?)').run(`repo/${i}`);
  for (let i = 0; i < results + rows; i++) db.prepare('INSERT INTO results (subject, body) VALUES (?, ?)').run(`repo/${i % 3}`, 'x'.repeat(200));
  db.close();
  return { bytes: readFileSync(file), dir, file };
}

test('R-SNAP-07: inspectDatabase reports integrity, schema version, the fence and row counts, subjects and results first', () => {
  const { file, dir } = makeDb();
  try {
    const r = inspectDatabase(file);
    assert.equal(r.ok, true);
    assert.equal(r.integrity, 'ok');
    assert.equal(r.schema_version, 6);
    assert.equal(r.fence, 42);
    assert.deepEqual(Object.keys(r.counts).slice(0, 2), ['subjects', 'results']);
    assert.equal(r.counts.subjects, 3);
    assert.equal(r.counts.results, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-SNAP-07: the drill verifies, decrypts and checks a snapshot with the age identity, and leaves no plaintext behind', { skip: !haveAge && 'age is not installed' }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'snap-drill-'));
  const { bytes, dir } = makeDb({ subjects: 4, results: 9 });
  try {
    const keyFile = join(work, 'identity.key');
    assert.equal(spawnSync(KEYGEN, ['-o', keyFile]).status, 0);
    const pub = spawnSync(KEYGEN, ['-y', keyFile], { encoding: 'utf8' }).stdout.trim();
    const enc = spawnSync(AGE, ['-r', pub], { input: bytes });
    assert.equal(enc.status, 0);
    const f = fakeGh();
    f.pushState(enc.stdout);
    await runSnapshot({ gh: f.gh, now: () => T0 });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'snap-tmp-'));
    const lines = [];
    const r = await drill({ gh: f.gh, identityFile: keyFile, ageBin: AGE, tmpRoot, log: (m) => lines.push(m) });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.equal(r.sha256, sha(enc.stdout));
    assert.equal(r.counts.subjects, 4);
    assert.equal(r.counts.results, 9);
    assert.equal(r.decrypted_bytes, bytes.length);
    assert.deepEqual(readdirSync(tmpRoot), [], 'the decrypted copy is deleted');
    const key = readFileSync(keyFile, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'));
    assert.ok(!JSON.stringify(r).includes(key) && !lines.join('\n').includes(key), 'the key is never printed');
    rmSync(tmpRoot, { recursive: true, force: true });

    // The wrong identity fails, and still says nothing about the key.
    const wrong = join(work, 'wrong.key');
    spawnSync(KEYGEN, ['-o', wrong]);
    const wrongKey = readFileSync(wrong, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'));
    await assert.rejects(drill({ gh: f.gh, identityFile: wrong, ageBin: AGE }), (err) => !String(err.message).includes(wrongKey));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-SNAP-07: a snapshot whose bytes differ from the manifest is refused before it is decrypted', async () => {
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  const snap = f.assetsOf('state-snapshots').find((a) => a.name.startsWith('state-'));
  f.blobs.get(snap.id)[30] ^= 1;
  let decrypted = false;
  await assert.rejects(drill({ gh: f.gh, decrypt: () => { decrypted = true; } }), /failed verification: sha256/);
  assert.equal(decrypted, false);
});

test('R-SNAP-07: a snapshot that decrypts to a damaged database fails the drill', async () => {
  const { bytes, dir } = makeDb({ rows: 400 });
  rmSync(dir, { recursive: true, force: true });
  const damaged = Buffer.from(bytes);
  // Wipe the middle of the database: b-tree pages the schema points at.
  damaged.fill(0xa5, 4096 * 2, 4096 * 2 + 2048);
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  await assert.rejects(drill({ gh: f.gh, decrypt: () => damaged }), /integrity_check|malformed|not a database|corrupt/i);
});

test('R-SNAP-07: --apply needs the loop stopped: switched off, pump lane off, or paused for at least 10 more minutes', () => {
  const now = T0;
  assert.equal(loopStopped({ LOOP_ENABLED: 'true' }, { now }).stopped, false);
  assert.equal(loopStopped({ LOOP_ENABLED: 'false' }, { now }).stopped, true);
  assert.equal(loopStopped({ LOOP_ENABLED: 'true', LANE_PUMP_ENABLED: 'false' }, { now }).stopped, true);
  assert.equal(loopStopped({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: new Date(now + 5 * 60000).toISOString() }, { now }).stopped, false);
  assert.equal(loopStopped({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: new Date(now + 60 * 60000).toISOString() }, { now }).stopped, true);
  assert.equal(loopStopped({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: new Date(now - 60000).toISOString() }, { now }).stopped, false);
});

test('R-SNAP-07: --apply refuses while the loop runs or a pump run is active, and changes nothing', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  for (const [vars, active, why] of [
    [{ LOOP_ENABLED: 'true' }, {}, /the loop is running/],
    [{ LOOP_ENABLED: 'false' }, { 'pump.yml': [{ id: 1 }] }, /pump\.yml has 1 queued or running/],
    [{ LOOP_ENABLED: 'false' }, { 'ingest.yml': [{ id: 2 }] }, /ingest\.yml/],
  ]) {
    const f = fakeGh({ vars, active });
    const live = f.pushState(cipher('generation 1'));
    await runSnapshot({ gh: f.gh, now: () => T0 });
    await assert.rejects(drill({ gh: f.gh, decrypt: () => bytes, apply: true, now: () => T0 }), why);
    assert.equal(f.assetsOf('state').find((a) => a.name === 'state.sqlite').id, live.id);
  }
});

test('R-SNAP-07: --apply keeps the live state as a snapshot first, then puts the chosen snapshot back byte for byte', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: { LOOP_ENABLED: 'false' } });
  const good = cipher('generation 1');
  f.pushState(good);
  await runSnapshot({ gh: f.gh, now: () => T0 });
  const goodName = f.manifestOf().snapshots[0].name;
  // Later the live state is bad (but the hourly run has not copied it yet).
  const bad = cipher('generation 2, broken');
  f.pushState(bad);
  const r = await drill({ gh: f.gh, name: goodName, decrypt: () => bytes, apply: true, now: () => T0 + 3600_000 });
  assert.equal(r.applied, true);
  const live = f.assetsOf('state').filter((a) => a.name === 'state.sqlite');
  assert.equal(live.length, 1);
  assert.equal(live[0].label, `sha256:${sha(good)}`);
  assert.deepEqual(f.blobs.get(live[0].id), good);
  // The bad live state was kept, so the restore can be undone: as a snapshot,
  // and renamed on the state release under a name the pump never reads.
  assert.ok(f.manifestOf().snapshots.some((s) => s.sha256 === sha(bad) && s.name === r.saved_live_as));
  const kept = f.assetsOf('state').find((a) => a.name === r.replaced_kept_as);
  assert.match(r.replaced_kept_as, /^state\.sqlite\.replaced-\d{8}T\d{6}Z$/);
  assert.deepEqual(f.blobs.get(kept.id), bad);
  assert.equal(f.assetsOf('state').filter((a) => a.name.startsWith('state.sqlite.upload-')).length, 0);
});

test('R-SNAP-07: --apply replaces a live asset that cannot be copied, and keeps it renamed', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: { LOOP_ENABLED: 'false' } });
  const good = cipher('generation 1');
  f.pushState(good);
  await runSnapshot({ gh: f.gh, now: () => T0 });
  // The live asset is damaged: its bytes no longer match its label.
  const broken = f.pushState(cipher('generation 2'), { label: `sha256:${sha(Buffer.from('other'))}` });
  const r = await drill({ gh: f.gh, decrypt: () => bytes, apply: true, now: () => T0 + 3600_000 });
  assert.equal(r.applied, true);
  assert.equal(r.saved_live_as, null);
  assert.match(r.live_snapshot_error, /could not copy a stable state asset/);
  assert.equal(f.assetsOf('state').find((a) => a.name === r.replaced_kept_as).id, broken.id);
  assert.equal(f.assetsOf('state').find((a) => a.name === 'state.sqlite').label, `sha256:${sha(good)}`);
});

test('R-SNAP-07: --apply leaves the live state alone if it changes during the restore', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: { LOOP_ENABLED: 'false' } });
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  const name = f.manifestOf().snapshots[0].name;
  f.pushState(cipher('generation 2'));
  const origUpload = f.gh.upload;
  f.gh.upload = async (rel, n, data, label) => {
    const up = await origUpload(rel, n, data, label);
    if (n.startsWith('state.sqlite.upload-')) f.pushState(cipher('generation 3, a writer that should not exist'));
    return up;
  };
  await assert.rejects(drill({ gh: f.gh, name, decrypt: () => bytes, apply: true, now: () => T0 + 3600_000 }), /changed during the restore; nothing was replaced/);
  const live = f.assetsOf('state');
  assert.deepEqual(live.map((a) => a.name), ['state.sqlite']);
  assert.equal(live[0].label, `sha256:${sha(cipher('generation 3, a writer that should not exist'))}`);
});

/** A database that opens but fails PRAGMA integrity_check (an index entry no longer matches its row). */
function failingIntegrityDb() {
  const dir = mkdtempSync(join(tmpdir(), 'snap-ic-'));
  try {
    const file = join(dir, 'x.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE subjects (id TEXT PRIMARY KEY); CREATE TABLE results (id INTEGER PRIMARY KEY, subject TEXT); CREATE INDEX results_subject ON results (subject);');
    for (let i = 0; i < 50; i++) db.prepare('INSERT INTO results (subject) VALUES (?)').run(`MARK${String(i).padStart(4, '0')}`);
    db.close();
    const b = readFileSync(file);
    const at = b.lastIndexOf(Buffer.from('MARK0025'));
    b[at + 7] = '9'.charCodeAt(0);
    return b;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('R-SNAP-07: a snapshot that opens but fails PRAGMA integrity_check fails the drill with report.ok false', async () => {
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  let err;
  try {
    await drill({ gh: f.gh, decrypt: () => failingIntegrityDb() });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the drill fails');
  assert.match(err.message, /failed PRAGMA integrity_check: row \d+ missing from index results_subject/);
  assert.equal(err.report.ok, false);
  assert.notEqual(err.report.integrity, 'ok');
  assert.equal(err.report.counts.results, 50, 'the counts are still reported');
});

test('R-SNAP-11: --apply over an interrupted pump push keeps that upload (renamed), deletes only other stale uploads', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: { LOOP_ENABLED: 'false' } });
  const good = cipher('generation 1');
  f.pushState(good);
  await runSnapshot({ gh: f.gh, now: () => T0 });
  // The pump's push stopped between delete and rename: only uploads are left.
  // The newest is the live state as the pump reads it, and its label is wrong,
  // so the pre-restore snapshot of it fails too.
  f.gh.releases.get('state').assets = [];
  const stale = f.addAsset('state', 'state.sqlite.upload-20261124T010000Z', cipher('older upload'), `sha256:${sha(cipher('older upload'))}`);
  const live = f.addAsset('state', 'state.sqlite.upload-20261124T020000Z', cipher('generation 2'), `sha256:${sha(Buffer.from('mismatch'))}`);
  const r = await drill({ gh: f.gh, decrypt: () => bytes, apply: true, now: () => T0 + 3600_000 });
  assert.equal(r.applied, true);
  assert.equal(r.saved_live_as, null);
  const after = f.assetsOf('state');
  const kept = after.find((a) => a.id === live.id);
  assert.ok(kept, 'the live upload survives');
  assert.equal(kept.name, r.replaced_kept_as);
  assert.match(kept.name, /^state\.sqlite\.replaced-/);
  assert.deepEqual(f.blobs.get(live.id), cipher('generation 2'));
  assert.ok(!after.some((a) => a.id === stale.id), 'the older stale upload is deleted');
  assert.equal(after.find((a) => a.name === 'state.sqlite').label, `sha256:${sha(good)}`);
});

test('R-SNAP-13: --apply refuses when the loop switches cannot be read', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: new Error('HTTP 403') });
  const live = f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  await assert.rejects(drill({ gh: f.gh, decrypt: () => bytes, apply: true, now: () => T0 }), /could not read the loop switches \(HTTP 403\)/);
  assert.equal(f.assetsOf('state').find((a) => a.name === 'state.sqlite').id, live.id);
  // Only the three switches count, nothing else passed along.
  assert.equal(loopStopped({ LOOP_ENABLED: 'true', LANE_PUMP_ENABLED: undefined, OTHER: 'x' }).stopped, false);
});

function variablesApi(levels, { orgStatus = 200 } = {}) {
  const seen = [];
  const fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    let m = /\/environments\/loop\/variables\/(\w+)$/.exec(u.pathname);
    if (m) return levels.env?.[m[1]] !== undefined ? Response.json({ name: m[1], value: levels.env[m[1]] }) : new Response('{}', { status: 404 });
    m = /\/actions\/variables\/(\w+)$/.exec(u.pathname);
    if (m) return levels.repo?.[m[1]] !== undefined ? Response.json({ name: m[1], value: levels.repo[m[1]] }) : new Response('{}', { status: 404 });
    if (u.pathname.endsWith('/actions/organization-variables')) {
      if (orgStatus !== 200) return new Response('{"message":"no"}', { status: orgStatus });
      const all = Object.entries(levels.org ?? {}).map(([name, value]) => ({ name, value }));
      const page = Number(u.searchParams.get('page'));
      return Response.json({ total_count: all.length, variables: all.slice((page - 1) * 30, page * 30) });
    }
    return new Response('{}', { status: 500 });
  };
  return { gh: createReleaseClient({ repo: 'isokron-ai/tool-qa', token: 't', fetch, sleep: async () => {} }), seen };
}

test('R-SNAP-13: the loop switches are read as the pump job sees them: environment, then repository, then every organization page', async () => {
  const names = ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_PUMP_ENABLED'];
  // The environment overrides the repository: a repository "false" does not stop a pump whose environment says "true".
  let a = variablesApi({ env: { LOOP_ENABLED: 'true' }, repo: { LOOP_ENABLED: 'false' } });
  let v = await a.gh.effectiveVariables(names);
  assert.equal(v.LOOP_ENABLED, 'true');
  assert.equal(loopStopped(v, { now: T0 }).stopped, false);
  // An organization variable past the first 30 is found.
  const org = {};
  for (let i = 0; i < 45; i++) org[`X_${i}`] = 'v';
  org.LANE_PUMP_ENABLED = 'false';
  a = variablesApi({ repo: { LOOP_ENABLED: 'true' }, org });
  v = await a.gh.effectiveVariables(names);
  assert.equal(v.LANE_PUMP_ENABLED, 'false');
  assert.ok(a.seen.some((p) => p.includes('page=2')));
  // Unset everywhere is unset (the guard's real meaning: LOOP_ENABLED unset = off).
  a = variablesApi({ org: {} });
  v = await a.gh.effectiveVariables(names);
  assert.equal(v.LOOP_ENABLED, undefined);
  // Any error other than 404 throws: fail closed.
  a = variablesApi({ repo: {} }, { orgStatus: 403 });
  await assert.rejects(a.gh.effectiveVariables(names), /HTTP 403/);
});

test('R-SNAP-14: a run that has not finished in any state blocks --apply, a snapshot run in CI included', async () => {
  const statuses = [];
  const fetch = async (url) => {
    statuses.push(new URL(url).searchParams.get('status'));
    return Response.json({ workflow_runs: [] });
  };
  const gh = createReleaseClient({ repo: 'isokron-ai/tool-qa', token: 't', fetch });
  await gh.activeRuns('pump.yml');
  assert.deepEqual(statuses.sort(), ['in_progress', 'pending', 'queued', 'requested', 'waiting']);

  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh({ vars: { LOOP_ENABLED: 'false' }, active: { 'state-snapshot.yml': [{ id: 3 }] } });
  const live = f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  await assert.rejects(drill({ gh: f.gh, decrypt: () => bytes, apply: true, now: () => T0 }), /state-snapshot\.yml has 1 queued or running/);
  assert.equal(f.assetsOf('state').find((a) => a.name === 'state.sqlite').id, live.id);
});

test('R-SNAP-10: the drill can use a snapshot the manifest does not list, checked against its own label', async () => {
  const { bytes, dir } = makeDb();
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  await f.gh.deleteAsset(f.assetsOf('state-snapshots').find((a) => a.name === 'manifest.json').id);
  const r = await drill({ gh: f.gh, decrypt: () => bytes });
  assert.equal(r.in_manifest, false);
  assert.match(r.verified, /not in the manifest: .*asset label/);
  const snap = f.assetsOf('state-snapshots')[0];
  f.blobs.get(snap.id)[40] ^= 1;
  await assert.rejects(drill({ gh: f.gh, decrypt: () => bytes }), /failed verification: sha256/);
});


test('the drill reads both snapshot forms: gzip inside the envelope (since loop upgrade #14) and the plain database from before', async () => {
  const { bytes, dir } = makeDb({ rows: 50 });
  rmSync(dir, { recursive: true, force: true });
  const f = fakeGh();
  f.pushState(cipher('generation 1'));
  await runSnapshot({ gh: f.gh, now: () => T0 });
  const old = await drill({ gh: f.gh, decrypt: () => bytes });
  assert.equal(old.ok, true);
  assert.equal(old.compressed, false);
  assert.equal(old.database_bytes, bytes.length);
  const packed = encodeState(bytes);
  const neu = await drill({ gh: f.gh, decrypt: () => packed });
  assert.equal(neu.ok, true);
  assert.equal(neu.compressed, true);
  assert.equal(neu.decrypted_bytes, packed.length);
  assert.equal(neu.database_bytes, bytes.length);
  assert.deepEqual(neu.counts, old.counts);
  // A gzip cut short fails the drill.
  await assert.rejects(drill({ gh: f.gh, decrypt: () => packed.subarray(0, 60) }), /does not decompress/);
});
