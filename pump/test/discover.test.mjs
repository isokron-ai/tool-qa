// The discover lane, pump side (pump/discover.mjs, design audit A2). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { openState } from '../../state/db.mjs';
import { BudgetExceededError } from '../budgets.mjs';
import { applyDiscovery, buildLookupQuery, DISCOVER_KV_KEY, discoverEnabled, EXCLUDED_KV_KEY, FRAME_KV_KEY, loadDiscoverConfig, walkFrom } from '../discover.mjs';
import { cleanKeys, cleanSubfolder, MAX_KEYS, validKey } from '../../discover/extract.mjs';
import { runPump } from '../run.mjs';
import { loadConfig } from '../due.mjs';
import { ApiBudget } from '../budgets.mjs';
import { fakeApi, fakeClock, API } from '../../test/lib/fake-api.mjs';

globalThis.fetch = async (url) => { throw new Error(`discover tests: no network (${url})`); };

const DAY = 86_400_000;
const T = Date.parse('2026-11-28T06:00:00Z');
const hash = (n) => createHash('sha256').update(n.toLowerCase()).digest('hex');
const cand = (name, { cls = 0, keys = [{ subfolder: '', purl: `pkg:npm/${name.split('/')[1]}`, feed: 'registry' }] } = {}) => ({ name, class: cls, hash: hash(name), feeds: ['registry'], keys });
const doc = (cands) => ({ version: 1, frame: 'discover-v1', generated_at: '2026-11-28T05:45:00Z', candidates: [...cands].sort((a, b) => a.class - b.class || (a.hash < b.hash ? -1 : 1)) });
const cfg = (over = {}) => ({ ...loadDiscoverConfig(), ...over });

/** A fake GraphQL by owner/name: repos {name: {id, fork, nameWithOwner}}. */
function fakeGraph(repos) {
  const calls = [];
  const answer = ({ variables }) => {
    const data = { rateLimit: { cost: 1, remaining: 4000 } };
    const errors = [];
    for (let i = 0; variables[`o${i}`] !== undefined; i++) {
      const want = `${variables[`o${i}`]}/${variables[`n${i}`]}`.toLowerCase();
      const hit = Object.entries(repos).find(([k]) => k.toLowerCase() === want);
      if (!hit) { data[`r${i}`] = null; errors.push({ type: 'NOT_FOUND', path: [`r${i}`] }); continue; }
      const [k, r] = hit;
      data[`r${i}`] = { databaseId: r.id, id: `R_${r.id}`, nameWithOwner: r.nameWithOwner ?? k, createdAt: '2025-01-01T00:00:00Z', isFork: r.fork === true };
    }
    return errors.length ? { data, errors } : { data };
  };
  return { calls, client: { async request(m, p, o) { calls.push(o); return { status: 200, data: answer(o.body) }; } }, api: () => fakeApi([['POST', '/graphql', (req) => ({ body: answer(req.json) })]]) };
}

function seeded(now = T - 30 * DAY) {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'seed/known', kind: 'github', source: 'seed-v1', tier: 3, now });
  db.applyIdentityLookup('seed/known', { status: 'ok', via: 'name', node: { databaseId: 500, id: 'R_500', nameWithOwner: 'seed/known', createdAt: '2025-01-01T00:00:00Z' } }, { now });
  return db;
}

test('R-DISC-03: new candidates become discover-v1 T3 subjects, bound to their repository id at once, with their subfolder and purl keys; the frame version moves', async () => {
  const db = seeded();
  const g = fakeGraph({ 'mono/repo': { id: 11 }, 'b/two': { id: 12 } });
  const keys = [{ subfolder: 'servers/a', purl: 'pkg:npm/a', feed: 'registry' }, { subfolder: 'servers/b', purl: 'pkg:pypi/b', feed: 'registry' }];
  const out = await applyDiscovery(db, { client: g.client, getCandidates: async () => ({ artifact_id: 9, doc: doc([cand('mono/repo', { keys }), cand('b/two')]) }), config: cfg(), now: () => T });
  assert.equal(out.added, 2);
  const s = db.getSubject('mono/repo');
  assert.deepEqual([s.source, s.tier, s.repo_id, s.id_status, s.name], ['discover-v1', 3, 11, 'ok', 'mono/repo']);
  assert.ok(db.listSubjectEvents('mono/repo').some((e) => e.kind === 'id_bound'));
  assert.deepEqual(db.listDiscoveryKeys('mono/repo').map((k) => [k.repo_id, k.subfolder, k.purl, k.feeds]), [[11, 'servers/a', 'pkg:npm/a', 'registry'], [11, 'servers/b', 'pkg:pypi/b', 'registry']]);
  const frame = db.getKv(FRAME_KV_KEY);
  assert.equal(frame.version, 1);
  assert.deepEqual(frame.sources, { 'discover-v1': 2, 'seed-v1': 1 });
  assert.equal(db.listEvents().filter((e) => e.type === 'frame_grew').at(-1).n, 2);
  db.close();
});

test('R-DISC-04: dedupe by repository id and name, forks left out, a name that is not found adds nothing and blames no one', async () => {
  const db = seeded();
  const g = fakeGraph({ 'old/name-of-known': { id: 500, nameWithOwner: 'seed/known' }, 'f/fork': { id: 13, fork: true }, 'n/new': { id: 14 } });
  const out = await applyDiscovery(db, {
    client: g.client, config: cfg(), now: () => T,
    getCandidates: async () => ({ artifact_id: 1, doc: doc([cand('SEED/Known'), cand('old/name-of-known'), cand('f/fork'), cand('gone/away'), cand('n/new')]) }),
  });
  assert.deepEqual([out.known, out.duplicate, out.fork_excluded, out.not_found, out.added], [1, 1, 1, 1, 1]);
  const looked = g.calls.flatMap((c) => Object.keys(c.body.variables).filter((k) => k.startsWith('o')).map((k) => `${c.body.variables[k]}/${c.body.variables[`n${k.slice(1)}`]}`));
  assert.ok(!looked.map((x) => x.toLowerCase()).includes('seed/known'), 'a known name is not looked up');
  assert.deepEqual(db.listSubjects().map((s) => s.id).sort(), ['n/new', 'seed/known']);
  assert.ok(db.listDiscoveryKeys('seed/known').length >= 1, 'keys of a known or renamed name go to the subject that holds the repository');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, 0);
  assert.equal(db.listSubjectEvents().filter((e) => e.kind === 'not_found').length, 0);
  db.close();
});

test('R-DISC-05: at most daily_cap new subjects a rolling day; a full day reads nothing; the walk resumes from its cursor and wraps', async () => {
  const db = seeded();
  const names = Array.from({ length: 7 }, (_, i) => `o/r${i}`);
  const g = fakeGraph(Object.fromEntries(names.map((n, i) => [n, { id: 100 + i }])));
  let reads = 0;
  const getCandidates = async () => { reads += 1; return { artifact_id: 2, doc: doc(names.map((n) => cand(n))) }; };
  let out = await applyDiscovery(db, { client: g.client, getCandidates, config: cfg({ daily_cap: 3 }), now: () => T });
  assert.equal(out.added, 3);
  out = await applyDiscovery(db, { client: g.client, getCandidates, config: cfg({ daily_cap: 3 }), now: () => T + 3_600_000 });
  assert.deepEqual([out.added, out.stopped, reads], [0, 'daily_cap', 1], 'no room: the artifact is not even read');
  out = await applyDiscovery(db, { client: g.client, getCandidates, config: cfg({ daily_cap: 3 }), now: () => T + DAY + 1 });
  assert.equal(out.added, 3);
  assert.equal(out.known, 0, 'the walk resumed after the cursor, not from the top');
  out = await applyDiscovery(db, { client: g.client, getCandidates, config: cfg({ daily_cap: 3 }), now: () => T + 2 * DAY + 2 });
  assert.equal(out.added, 1, 'the last one; the rest are known');
  assert.equal(db.listSubjects().filter((s) => s.source === 'discover-v1').length, 7);
  assert.equal(db.getKv(FRAME_KV_KEY).version, 3);
  // walkFrom wraps after the cursor.
  const list = names.map((n) => cand(n)).sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const w = walkFrom(list, `0:${list[4].hash}`, 10);
  assert.deepEqual(w.map((x) => x.name), [...list.slice(5), ...list.slice(0, 5)].map((x) => x.name));
  db.close();
});

test('R-DISC-06: a malformed candidates file is refused whole; a budget refusal adds nothing and keeps the cursor; switched off, nothing is read', async () => {
  const db = seeded();
  const g = fakeGraph({ 'a/b': { id: 20 } });
  let out = await applyDiscovery(db, { client: g.client, config: cfg(), now: () => T, getCandidates: async () => ({ artifact_id: 3, doc: { version: 1, frame: 'discover-v1', candidates: [{ name: '../etc', class: 0, hash: 'x', keys: [] }] } }) });
  assert.equal(out.stopped, 'error');
  assert.match(out.error, /candidates refused/);
  assert.equal(db.listSubjects().length, 1);
  const refusing = { async request() { throw new BudgetExceededError('graphql: hourly', { family: 'graphql', reason: 'hourly' }); } };
  out = await applyDiscovery(db, { client: refusing, config: cfg(), now: () => T, getCandidates: async () => ({ artifact_id: 4, doc: doc([cand('a/b')]) }) });
  assert.deepEqual([out.stopped, out.added, out.cursor], ['budget', 0, null]);
  assert.equal(db.getKv(DISCOVER_KV_KEY).cursor, null);
  assert.equal(discoverEnabled({}), false);
  assert.equal(discoverEnabled({ LANE_DISCOVER_ENABLED: 'TRUE' }), false);
  assert.equal(discoverEnabled({ LANE_DISCOVER_ENABLED: 'true' }), true);
  const yml = readFileSync(new URL('../../.github/workflows/discover.yml', import.meta.url), 'utf8');
  assert.match(yml, /if \[ "\$\{LANE_DISCOVER_ENABLED\}" != "true" \]; then/);
  assert.match(readFileSync(new URL('../../.github/workflows/pump.yml', import.meta.url), 'utf8'), /LANE_DISCOVER_ENABLED: \$\{\{ vars\.LANE_DISCOVER_ENABLED \}\}/);
  // In a pump run: off reads nothing; on adds subjects before the first tick.
  const dir = mkdtempSync(join(tmpdir(), 'pump-discover-'));
  try {
    const stateFile = join(dir, 'state.sqlite');
    seeded().close();
    const c = fakeClock(T);
    const lines = [];
    let asked = 0;
    const run = (extra) => runPump({
      env: { GITHUB_REPOSITORY: 'isokron-ai/tool-qa', GITHUB_TOKEN: 'ghs_synthetic', LOOP_SLOTS: '0', GITHUB_API_URL: API, ...extra },
      now: c.now, sleep: c.sleep, log: (l) => lines.push(l), stateFile, seedFile: null, config: loadConfig(), identity: null,
      discover: { getCandidates: async () => { asked += 1; return { artifact_id: 5, doc: doc([cand('a/b')]) }; } },
      fetch: g.api().fetch, budget: new ApiBudget({ now: c.now, sleep: c.sleep }),
      pull: async () => ({ status: 'pulled' }), push: async () => ({ status: 'pushed' }), ingest: null, maxRunMs: 60_000,
    });
    await run({});
    assert.equal(asked, 0);
    await run({ LANE_DISCOVER_ENABLED: 'true' });
    assert.equal(asked, 1);
    const iD = lines.findIndex((l) => l.startsWith('pump: discover: room 100; walked 1 (0 known), looked up 1 in 1 queries (1 points): added 1'));
    const iT = lines.findIndex((l, i) => i > iD && l.startsWith('pump: tick 1'));
    assert.ok(iD >= 0 && iT > iD, lines.join('\n'));
    const db2 = openState(stateFile);
    assert.equal(db2.getSubject('a/b').source, 'discover-v1');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('R-DISC-07: the v11 migration of a v10 state keeps every row and adds discovery_keys, one row per subject, subfolder and purl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v11-'));
  try {
    const file = join(dir, 's.sqlite');
    const db = openState(file);
    db.setSubjectVersion({ id: 'a/b', kind: 'github', source: 'seed-v1', tier: 3, now: T });
    db.close();
    // Back to v10 as the live state is: drop what v11 (and v12, the leads tables) added.
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE write_backends; DROP TABLE lead_subjects; DROP TABLE leads; DROP TABLE discovery_keys; PRAGMA user_version = 10;');
    raw.close();
    const db2 = openState(file);
    assert.equal(db2.schemaVersion(), 12);
    assert.equal(db2.getSubject('a/b').source, 'seed-v1');
    assert.equal(db2.noteDiscoveryKey({ subject: 'a/b', subfolder: 'x', purl: 'pkg:npm/x', feed: 'registry', now: T }), true);
    assert.equal(db2.noteDiscoveryKey({ subject: 'a/b', subfolder: 'x', purl: 'pkg:npm/x', feed: 'npm', now: T + 1 }), false);
    assert.deepEqual(db2.listDiscoveryKeys('a/b').map((k) => k.feeds), ['npm,registry']);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lookup query passes names as variables and asks for isFork', () => {
  const q = buildLookupQuery(['acme/one']);
  assert.deepEqual(q.variables, { o0: 'acme', n0: 'one' });
  assert.ok(!q.query.includes('acme'));
  assert.match(q.query, /databaseId id nameWithOwner createdAt isFork/);
});

test('R-DISC-08: only the current name of an active subject is known; a frozen key that now names a re-created repository is looked up and becomes its own subject', async () => {
  const db = seeded();
  // seed/known was renamed to seed/renamed (same repository, id 500); someone then created a new seed/known (id 900).
  db.applyIdentityLookup('seed/known', { status: 'ok', via: 'id', node: { databaseId: 500, id: 'R_500', nameWithOwner: 'seed/renamed', createdAt: '2025-01-01T00:00:00Z' } }, { now: T - DAY });
  assert.equal(db.getSubject('seed/known').name, 'seed/renamed');
  // A gone subject's name is not known either.
  db.setSubjectVersion({ id: 'g/gone', kind: 'github', source: 'seed-v1', tier: 3, now: T - 30 * DAY });
  db.raw.prepare("UPDATE subjects SET gone_at = ? WHERE id = 'g/gone'").run(new Date(T - DAY).toISOString());
  const g = fakeGraph({ 'seed/known': { id: 900 }, 'seed/renamed': { id: 500 }, 'g/gone': { id: 901 } });
  const out = await applyDiscovery(db, { client: g.client, config: cfg(), now: () => T, getCandidates: async () => ({ artifact_id: 8, doc: doc([cand('seed/known'), cand('seed/renamed'), cand('g/gone')]) }) });
  assert.equal(out.known, 1, 'only seed/renamed, the current name');
  const looked = g.calls.flatMap((c) => Object.keys(c.body.variables).filter((k) => k.startsWith('o')).map((k) => `${c.body.variables[k]}/${c.body.variables[`n${k.slice(1)}`]}`));
  assert.deepEqual(looked.sort(), ['g/gone', 'seed/known']);
  const fresh = db.listSubjects().find((s) => s.repo_id === 900);
  assert.ok(fresh && fresh.id !== 'seed/known' && fresh.source === 'discover-v1', 'the re-created repository is a new subject, not the old one');
  assert.equal(db.getSubject('seed/known').repo_id, 500);
  db.close();
});

test('R-DISC-09: feed data is checked in the pump as well: a malformed key is dropped (control characters, newlines, backslashes, spaces, an unknown feed, a bad purl), at most MAX_KEYS a candidate, and the rest of the file is used', async () => {
  assert.equal(MAX_KEYS, 50);
  for (const sub of ['a\nb', 'a\\b', 'a b', 'a\u0000', '../x', 'x/../y', '/abs']) assert.equal(validKey({ subfolder: sub, purl: '', feed: 'registry' }), false, JSON.stringify(sub));
  assert.equal(validKey({ subfolder: 'packages/@scope/srv', purl: 'pkg:npm/%40scope/srv', feed: 'npm' }), true);
  assert.equal(validKey({ subfolder: '', purl: '', feed: 'docker' }), false);
  assert.equal(validKey({ subfolder: '', purl: 'pkg:npm/x y', feed: 'npm' }), false);
  assert.equal(cleanSubfolder('a b'), '');
  assert.equal(cleanSubfolder('servers/one'), 'servers/one');
  const many = Array.from({ length: 70 }, (_, i) => ({ subfolder: `s${i}`, purl: '', feed: 'registry' }));
  assert.equal(cleanKeys(many).keys.length, 50);
  const db = seeded();
  const g = fakeGraph({ 'a/b': { id: 20 } });
  const keys = [{ subfolder: 'ok', purl: 'pkg:npm/ok', feed: 'registry' }, { subfolder: 'bad\nline', purl: '', feed: 'registry' }, { subfolder: '', purl: '', feed: 'docker' }];
  const out = await applyDiscovery(db, { client: g.client, config: cfg(), now: () => T, getCandidates: async () => ({ artifact_id: 9, doc: doc([cand('a/b', { keys })]) }) });
  assert.deepEqual([out.added, out.keys_dropped], [1, 2]);
  assert.deepEqual(db.listDiscoveryKeys('a/b').map((k) => k.subfolder), ['ok']);
  db.close();
});

test('R-DISC-10: a fork left out is remembered and not looked up again', async () => {
  const db = seeded();
  const g = fakeGraph({ 'f/fork': { id: 13, fork: true }, 'n/one': { id: 14 }, 'n/two': { id: 15 } });
  const get = (names) => async () => ({ artifact_id: 10, doc: doc(names.map((n) => cand(n))) });
  let out = await applyDiscovery(db, { client: g.client, config: cfg(), now: () => T, getCandidates: get(['f/fork', 'n/one']) });
  assert.equal(out.fork_excluded, 1);
  assert.equal(db.getKv(EXCLUDED_KV_KEY)['f/fork'].why, 'fork');
  g.calls.length = 0;
  db.setKv(DISCOVER_KV_KEY, { cursor: null }, { now: T });
  out = await applyDiscovery(db, { client: g.client, config: cfg(), now: () => T + DAY + 1, getCandidates: get(['f/fork', 'n/one', 'n/two']) });
  assert.equal(out.excluded_before, 1);
  const looked = g.calls.flatMap((c) => Object.keys(c.body.variables).filter((k) => k.startsWith('o')).map((k) => `${c.body.variables[k]}/${c.body.variables[`n${k.slice(1)}`]}`));
  assert.deepEqual(looked, ['n/two']);
  db.close();
});
