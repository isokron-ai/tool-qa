// Change detection (pump/heads.mjs, design audit A3): the head poll writes
// subjects' sha and changed_at, so a new commit or release makes them due.
// No network: every call goes to a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../../state/db.mjs';
import { ApiBudget, BudgetExceededError } from '../budgets.mjs';
import { dueFromState, loadConfig } from '../due.mjs';
import { BATCH, buildHeadsQuery, HEADS_KV_KEY, headsEnabled, headsRoom, ID_PASS_CALLS, MAX_QUERIES, MAX_TIER_SHARE, parseHeads, pickHeads, pollHours, refreshHeads } from '../heads.mjs';
import { runPump } from '../run.mjs';
import { headsCheck, HEADS_AMBER_HOURS, HEADS_RED_HOURS } from '../../watchdog/heads.mjs';
import { evaluate } from '../../watchdog/checks.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

globalThis.fetch = async (url) => {
  throw new Error(`heads tests: no network (${url})`);
};

const HOUR = 3_600_000;
const T = Date.parse('2026-11-28T00:00:00Z');
const sha = (n) => n.toString(16).padStart(40, '0');

function scanStatic() {
  const cfg = loadConfig();
  const workflows = {};
  for (const [name, w] of Object.entries(cfg.workflows)) workflows[name] = { ...w, enabled: false };
  workflows['scan-static'] = { ...cfg.workflows['scan-static'], enabled: true, pin_check: 'label', versions: { tool: { 'mcp-check': 'ec3c801' }, oracle: {}, probe: {} } };
  return { tiers: cfg.tiers, workflows };
}

/** Bound subjects: {key: {tier, repo_id}} -> rows with node ids R_<repo_id>. */
function seed(db, subjects, now = T) {
  for (const [id, s] of Object.entries(subjects)) {
    db.setSubjectVersion({ id, kind: 'github', source: 'seed-v1', tier: s.tier ?? 3, now });
    db.raw.prepare("UPDATE subjects SET repo_id = ?, node_id = ?, id_status = 'ok', id_checked_at = ? WHERE id = ?").run(s.repo_id, `R_${s.repo_id}`, new Date(now).toISOString(), id);
  }
}

/** A fake GraphQL answering heads by node id: repos {repo_id: {oid, release, empty, missing, other}}. */
function fakeHeads(repos, { remaining = 4999 } = {}) {
  const calls = [];
  const answer = ({ variables }) => {
    const errors = [];
    const nodes = variables.ids.map((id, i) => {
      const r = repos[Number(id.slice(2))];
      if (!r || r.missing) { errors.push({ type: 'NOT_FOUND', path: ['nodes', i] }); return null; }
      if (r.forbidden) { errors.push({ type: 'FORBIDDEN', path: ['nodes', i], message: 'Resource not accessible' }); return null; }
      if (r.releaseError) errors.push({ type: 'INTERNAL', path: ['nodes', i, 'latestRelease'], message: 'Something went wrong' });
      return {
        __typename: 'Repository', databaseId: r.other ?? Number(id.slice(2)), isEmpty: r.empty === true,
        ...(r.nameWithOwner ? { nameWithOwner: r.nameWithOwner } : {}),
        defaultBranchRef: r.empty ? null : { target: { oid: r.oid } },
        latestRelease: r.releaseError ? null : r.release ? { tagName: r.release.tag ?? 'v1', publishedAt: r.release.at } : null,
      };
    });
    const data = { rateLimit: { cost: 1, remaining }, nodes };
    return errors.length ? { data, errors } : { data };
  };
  return {
    calls,
    client: { async request(method, path, opts) { calls.push({ method, path, ...opts }); return { status: 200, data: answer(opts.body) }; } },
    api: () => fakeApi([['POST', '/graphql', (req) => ({ body: answer(req.json) })]]),
  };
}

const due = (db, now) => dueFromState(db, { now, ...scanStatic() });

test('R-CHG-01: the first poll fills sha and changed_at of every bound subject, and their pairs become due as new_version', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/a': { tier: 3, repo_id: 11 }, 'org/b': { tier: 1, repo_id: 12 } });
  // A result for each pair at the unknown version: nothing is due.
  for (const d of due(db, T)) {
    db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: T });
    db.raw.prepare("INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, ?, ?, 'x', 1, 'ok', ?, 'assessed')").run(d.run_key, d.subject, d.workflow, new Date(T).toISOString());
  }
  assert.equal(due(db, T + HOUR).length, 0);
  const g = fakeHeads({ 11: { oid: sha(1) }, 12: { oid: sha(2) } });
  const out = await refreshHeads(db, { client: g.client, tiers: scanStatic().tiers, now: () => T + HOUR });
  assert.equal(out.changes.head_first_seen, 2);
  const a = db.getSubject('org/a');
  assert.equal(a.sha, sha(1));
  assert.equal(a.changed_at, new Date(T + HOUR).toISOString());
  assert.equal(a.change_reason, 'head_first_seen');
  const list = due(db, T + HOUR + 1);
  assert.deepEqual(list.map((d) => [d.subject, d.reasons.join()]).sort(), [['org/a', 'new_version'], ['org/b', 'new_version']]);
  assert.equal(db.getKv(HEADS_KV_KEY).with_sha, 2);
  db.close();
});

test('R-CHG-02: a new head moves sha and changed_at (new_sha); the same head writes nothing', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/a': { tier: 0, repo_id: 11 } });
  const repos = { 11: { oid: sha(1) } };
  const g = fakeHeads(repos);
  await refreshHeads(db, { client: g.client, now: () => T });
  const first = db.getSubject('org/a');
  // Same head an hour later: nothing written.
  await refreshHeads(db, { client: g.client, now: () => T + HOUR });
  assert.deepEqual(db.getSubject('org/a'), first);
  repos[11].oid = sha(2);
  const out = await refreshHeads(db, { client: g.client, now: () => T + 2 * HOUR });
  assert.equal(out.changes.new_sha, 1);
  const s = db.getSubject('org/a');
  assert.deepEqual([s.sha, s.change_reason, s.changed_at], [sha(2), 'new_sha', new Date(T + 2 * HOUR).toISOString()]);
  assert.throws(() => db.noteHead('org/a', { sha: 'main', reason: 'new_sha', now: T }), /full commit sha/);
  // The writer itself refuses to move changed_at for the sha it holds.
  assert.equal(db.noteHead('org/a', { sha: sha(2), reason: 'new_sha', now: T + 5 * HOUR }), false);
  assert.equal(db.getSubject('org/a').changed_at, new Date(T + 2 * HOUR).toISOString());
  db.close();
});

test('R-CHG-03: a release published after the last change at the same head is a change_event, seen once; a release dated in the future is not believed', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/a': { tier: 0, repo_id: 11 } });
  const repos = { 11: { oid: sha(1), release: { at: new Date(T - HOUR).toISOString() } } };
  const g = fakeHeads(repos);
  // First sight: the head, not the older release.
  let out = await refreshHeads(db, { client: g.client, now: () => T });
  assert.deepEqual(out.changes, { head_first_seen: 1, new_sha: 0, new_release: 0 });
  // A result after first sight: not due.
  const [d] = due(db, T + 1);
  db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: T + 1 });
  db.raw.prepare("INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, ?, ?, 'x', 1, 'ok', ?, 'assessed')").run(d.run_key, d.subject, d.workflow, new Date(T + 1).toISOString());
  assert.equal(due(db, T + 2).length, 0);
  // A release on the same commit.
  repos[11].release = { tag: 'v2', at: new Date(T + HOUR).toISOString() };
  out = await refreshHeads(db, { client: g.client, now: () => T + 2 * HOUR });
  assert.equal(out.changes.new_release, 1);
  assert.equal(db.getSubject('org/a').change_reason, 'new_release');
  assert.deepEqual(due(db, T + 2 * HOUR + 1).map((x) => x.reasons.join()), ['change_event']);
  // Seen once.
  out = await refreshHeads(db, { client: g.client, now: () => T + 3 * HOUR });
  assert.equal(out.changes.new_release, 0);
  // A release time ahead of our clock is not believed.
  repos[11].release = { tag: 'v3', at: new Date(T + 30 * HOUR).toISOString() };
  out = await refreshHeads(db, { client: g.client, now: () => T + 4 * HOUR });
  assert.equal(out.changes.new_release, 0);
  db.close();
});

test('R-CHG-04: a head that cannot be read (not found, another repository id, empty, a bad oid) writes nothing and never marks the subject gone or at fault', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/gone': { repo_id: 11 }, 'org/moved': { repo_id: 12 }, 'org/empty': { repo_id: 13 }, 'org/bad': { repo_id: 14 }, 'org/ok': { repo_id: 15 } });
  const g = fakeHeads({ 11: { missing: true }, 12: { oid: sha(2), other: 99 }, 13: { empty: true }, 14: { oid: 'not-a-sha' }, 15: { oid: sha(5) } });
  const before = db.listSubjects();
  const out = await refreshHeads(db, { client: g.client, now: () => T });
  assert.deepEqual(out.skipped, { not_found: 1, mismatch: 1, renamed: 0, empty: 1, error: 1 });
  const after = db.listSubjects();
  for (const s of after.filter((x) => x.id !== 'org/ok')) assert.deepEqual(s, before.find((x) => x.id === s.id), `${s.id} unchanged`);
  assert.ok(after.every((s) => s.gone_at === null));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, 0, 'no result, so no fault, is recorded');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM subject_events').get().n, 0);
  assert.equal(db.getSubject('org/ok').sha, sha(5));
  db.close();
});

test('R-CHG-05: the budget guard: at most MAX_QUERIES a run, a budget refusal or a low point count stops the pass, and the cursor moves only past applied answers', async () => {
  assert.equal(MAX_QUERIES, 3);
  assert.equal(BATCH, 100);
  const db = openState(':memory:');
  const subjects = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`org/r${String(i).padStart(3, '0')}`, { tier: 3, repo_id: 1000 + i }]));
  seed(db, subjects);
  const repos = Object.fromEntries(Object.values(subjects).map((s) => [s.repo_id, { oid: sha(s.repo_id) }]));
  const g = fakeHeads(repos);
  let out = await refreshHeads(db, { client: g.client, now: () => T });
  assert.equal(g.calls.length, 3);
  assert.equal(out.polled, 300);
  assert.ok(g.calls.every((c) => c.family === 'graphql' && !c.body.query.includes('R_1')), 'ids go as variables');
  assert.equal(out.tiers.T3.cursor, 'org/r299');
  // The budget refuses the next query: nothing applied, cursor kept.
  const refusing = { async request() { throw new BudgetExceededError('graphql cap', { family: 'graphql', reason: 'hourly' }); } };
  out = await refreshHeads(db, { client: refusing, now: () => T + 60_000 });
  assert.equal(out.stopped, 'budget');
  assert.equal(db.getKv(HEADS_KV_KEY).tiers.T3.cursor, 'org/r299');
  // GitHub says few points left: one query, then stop.
  const low = fakeHeads(repos, { remaining: 150 });
  out = await refreshHeads(db, { client: low.client, now: () => T + 120_000 });
  assert.equal(low.calls.length, 1);
  assert.equal(out.stopped, 'points_reserve');
  assert.equal(out.tiers.T3.cursor, 'org/r399');
  // Through the real budget: 30 an hour is shared with the id pass.
  const c = fakeClock(T);
  const bud = new ApiBudget({ now: c.now, sleep: c.sleep });
  for (let i = 0; i < 30; i++) await bud.take('graphql');
  const api = g.api();
  const { createClient } = await import('../github.mjs');
  const client = createClient({ token: 'ghs_synthetic', fetch: api.fetch, apiUrl: API, budget: bud, now: c.now, sleep: c.sleep });
  out = await refreshHeads(db, { client, now: c.now });
  assert.equal(out.stopped, 'id_reserve', 'the hourly graphql calls are used up: none is taken');
  assert.equal(api.calls.length, 0);
  db.close();
});

test('R-CHG-06: cadence by tier: T0 every run, T3 once a day, a cycle resumes from its cursor and one query mixes tiers', async () => {
  const tiers = scanStatic().tiers;
  assert.deepEqual([pollHours(tiers, 'T0'), pollHours(tiers, 'T1'), pollHours(tiers, 'T3')], [0, 1, 24]);
  const subjects = [
    { id: 'a/t0', tier: 0 }, { id: 'b/t1', tier: 1 }, ...Array.from({ length: 5 }, (_, i) => ({ id: `c/t3-${i}`, tier: 3 })),
  ];
  let p = pickHeads({ subjects, cursors: {}, tiers, now: T, limit: 4 });
  assert.deepEqual(p.picks.map((x) => x.subject.id), ['a/t0', 'b/t1', 'c/t3-0', 'c/t3-1']);
  assert.equal(p.plan.T3.ends, false);
  // T3 in mid-cycle resumes; T0 starts again; T1 waits its hour.
  const cursors = { T0: { cursor: null, started_at: new Date(T).toISOString() }, T1: { cursor: null, started_at: new Date(T).toISOString() }, T3: { cursor: 'c/t3-1', started_at: new Date(T).toISOString() } };
  p = pickHeads({ subjects, cursors, tiers, now: T + 10 * 60_000, limit: 100 });
  assert.deepEqual(p.picks.map((x) => x.subject.id), ['a/t0', 'c/t3-2', 'c/t3-3', 'c/t3-4']);
  assert.equal(p.plan.T3.ends, true);
  // A finished T3 cycle waits 24 hours from its start.
  cursors.T3 = { cursor: null, started_at: new Date(T).toISOString() };
  p = pickHeads({ subjects, cursors, tiers, now: T + 23 * HOUR, limit: 100 });
  assert.deepEqual(p.picks.map((x) => x.subject.id), ['a/t0', 'b/t1']);
  p = pickHeads({ subjects, cursors, tiers, now: T + 24 * HOUR, limit: 100 });
  assert.equal(p.picks.length, 7);
  // In the pass: one query for all three tiers; the cycles close.
  const db = openState(':memory:');
  seed(db, Object.fromEntries(subjects.map((s, i) => [s.id, { tier: s.tier, repo_id: 50 + i }])));
  const g = fakeHeads(Object.fromEntries(subjects.map((_, i) => [50 + i, { oid: sha(50 + i) }])));
  const out = await refreshHeads(db, { client: g.client, tiers, now: () => T });
  assert.equal(g.calls.length, 1);
  assert.deepEqual(Object.values(out.tiers).map((c) => c.cursor), [null, null, null]);
  // A cursor left past every subject (they were retired) closes the cycle instead of sticking.
  p = pickHeads({ subjects, cursors: { T3: { cursor: 'z/zz', started_at: new Date(T).toISOString() } }, tiers, now: T, limit: 100 });
  assert.deepEqual(p.plan.T3, { started_at: new Date(T).toISOString(), ends: true, picked: [] });
  db.setKv(HEADS_KV_KEY, { tiers: { T3: { cursor: 'z/zz', started_at: new Date(T).toISOString() } } }, { now: T });
  const out2 = await refreshHeads(db, { client: g.client, tiers, now: () => T + HOUR });
  assert.equal(out2.tiers.T3.cursor, null);
  db.close();
});

test('R-CHG-07: the head poll is off unless LANE_HEADS_ENABLED is exactly "true"; in a pump run it runs after the id pass and before the first tick', async () => {
  assert.equal(headsEnabled({}), false);
  assert.equal(headsEnabled({ LANE_HEADS_ENABLED: '' }), false);
  assert.equal(headsEnabled({ LANE_HEADS_ENABLED: 'TRUE' }), false);
  assert.equal(headsEnabled({ LANE_HEADS_ENABLED: 'true' }), true);
  const dir = mkdtempSync(join(tmpdir(), 'pump-heads-'));
  try {
    const file = join(dir, 'seed.json');
    writeFileSync(file, JSON.stringify({ version: 1, size: 2, subjects: [{ id: 'org/a', tier: 'sample', star_bucket: '0-9' }, { id: 'org/b', tier: 'sample', star_bucket: '0-9' }] }));
    const stateFile = join(dir, 'state.sqlite');
    const db0 = openState(stateFile);
    seed(db0, { 'org/a': { repo_id: 11 }, 'org/b': { repo_id: 12 } });
    db0.close();
    const c = fakeClock(T);
    const lines = [];
    const g = fakeHeads({ 11: { oid: sha(1) }, 12: { oid: sha(2) } });
    const run = (api, extra = {}) => runPump({
      env: { GITHUB_REPOSITORY: 'isokron-ai/tool-qa', GITHUB_TOKEN: 'ghs_synthetic', LOOP_SLOTS: '0', GITHUB_API_URL: API, ...extra },
      now: c.now, sleep: c.sleep, log: (l) => lines.push(l), stateFile, seedFile: file, config: scanStatic(), identity: null,
      fetch: api.fetch, budget: new ApiBudget({ now: c.now, sleep: c.sleep }),
      pull: async () => ({ status: 'pulled' }), push: async () => ({ status: 'pushed' }), ingest: null, maxRunMs: 60_000,
    });
    // Off: no call, kv says off.
    const off = fakeApi([]);
    await run(off);
    assert.equal(off.calls.length, 0);
    let db = openState(stateFile);
    assert.equal(db.getKv(HEADS_KV_KEY).off, true);
    assert.equal(db.getSubject('org/a').sha, null);
    db.close();
    // On.
    const api = g.api();
    await run(api, { LANE_HEADS_ENABLED: 'true' });
    assert.equal(api.calls.length, 1);
    const iHeads = lines.findIndex((l) => l.startsWith('pump: subject heads: 1 head queries (2 repositories, 1 points'));
    const iTick = lines.findIndex((l, i) => i > iHeads && l.startsWith('pump: tick 1'));
    assert.ok(iHeads >= 0 && iTick > iHeads, lines.join('\n'));
    db = openState(stateFile);
    assert.equal(db.getSubject('org/a').sha, sha(1));
    assert.equal(db.getKv(HEADS_KV_KEY).off, false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-CHG-08: the watchdog subject-heads item: green while polls are written, amber after 6 hours or on an error stop, red after 24, off when switched off', () => {
  assert.equal(HEADS_AMBER_HOURS, 6);
  assert.equal(HEADS_RED_HOURS, 24);
  const at = new Date(T).toISOString();
  const base = { at, last_write_at: at, active: 997, with_sha: 990, stopped: null };
  assert.equal(headsCheck({ now: T, heads: null }), null);
  assert.equal(headsCheck({ now: T + HOUR, heads: base }).status, 'green');
  assert.equal(headsCheck({ now: T + 6 * HOUR + 1, heads: base }).status, 'amber');
  assert.equal(headsCheck({ now: T + 24 * HOUR + 1, heads: base }).status, 'red');
  // A first pass that has never written is amber, and red only once it is a day old.
  assert.equal(headsCheck({ now: T, heads: { ...base, last_write_at: null, first_at: at } }).status, 'amber');
  assert.equal(headsCheck({ now: T + 25 * HOUR, heads: { ...base, last_write_at: null, first_at: at } }).status, 'red');
  assert.equal(headsCheck({ now: T + HOUR, heads: { ...base, stopped: 'id_reserve' } }).status, 'green', 'holding calls for the id pass is the guard working');
  assert.equal(headsCheck({ now: T + HOUR, heads: { ...base, stopped: 'api_error', error: 'HTTP 502' } }).status, 'amber');
  assert.equal(headsCheck({ now: T + HOUR, heads: { ...base, stopped: 'points_reserve' } }).status, 'green', 'leaving points for others is the guard working');
  assert.equal(headsCheck({ now: T + 48 * HOUR, heads: { ...base, off: true } }).status, 'off');
  // Registered: evaluate() shows it from kv pump.heads.
  const { checks } = evaluate({ now: T + 7 * HOUR, slots: 0, state: { openSlots: [], openDispatches: [], kv: { 'pump.heads': base } } });
  assert.equal(checks.find((x) => x.id === 'subject-heads')?.status, 'amber');
});

test('the heads query passes node ids as a variable and asks for the head, the release and the repository id', () => {
  const q = buildHeadsQuery(['R_1', 'R_2']);
  assert.deepEqual(q.variables, { ids: ['R_1', 'R_2'] });
  assert.ok(!q.query.includes('R_1'));
  assert.match(q.query, /databaseId nameWithOwner isEmpty defaultBranchRef \{ target \{ oid \} \} latestRelease \{ tagName publishedAt \}/);
});

test('R-CHG-09: one bad node never wedges the poll: a FORBIDDEN node is an error for that entry only, an error under latestRelease loses only the release, an error with no node path fails the batch', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/a': { tier: 0, repo_id: 11 }, 'org/b': { tier: 0, repo_id: 12 }, 'org/c': { tier: 0, repo_id: 13 } });
  const repos = { 11: { oid: sha(1) }, 12: { forbidden: true }, 13: { oid: sha(3), releaseError: true } };
  const g = fakeHeads(repos);
  for (let run = 0; run < 3; run++) await refreshHeads(db, { client: g.client, now: () => T + run * HOUR });
  assert.equal(db.getSubject('org/a').sha, sha(1));
  assert.equal(db.getSubject('org/b').sha, null);
  assert.equal(db.getSubject('org/c').sha, sha(3), 'the head is kept when only the release errored');
  const kv = db.getKv(HEADS_KV_KEY);
  assert.equal(kv.skipped.error, 1);
  assert.equal(kv.tiers.T0.cursor, null, 'the cycle ended past the bad node');
  assert.ok(kv.last_write_at);
  // Pure checks of the parse.
  const list = [{ repo_id: 1 }, { repo_id: 2 }];
  const nodes = [{ databaseId: 1, defaultBranchRef: { target: { oid: sha(1) } }, latestRelease: null }, null];
  assert.deepEqual(parseHeads({ data: { nodes }, errors: [{ type: 'FORBIDDEN', path: ['nodes', 1] }] }, list).map((a) => a.status), ['ok', 'error']);
  assert.deepEqual(parseHeads({ data: { nodes }, errors: [{ type: 'RATE_LIMITED', message: 'no path' }] }, list).map((a) => a.status), ['error', 'error']);
  assert.deepEqual(parseHeads({ data: { nodes }, errors: [{ type: 'X', path: ['nodes', 7] }] }, list).map((a) => a.status), ['error', 'error'], 'a path outside the list is a whole-answer problem');
  db.close();
});

test('R-CHG-10: only subjects the id pass vouches for (id_status ok) are polled, and a node renamed since then is skipped as renamed', async () => {
  const db = openState(':memory:');
  seed(db, { 'org/ok': { repo_id: 11 }, 'org/conflict': { repo_id: 12 }, 'org/err': { repo_id: 13 }, 'org/moved': { repo_id: 14 } });
  db.raw.prepare("UPDATE subjects SET id_status = 'conflict' WHERE id = 'org/conflict'").run();
  db.raw.prepare("UPDATE subjects SET id_status = 'error' WHERE id = 'org/err'").run();
  const g = fakeHeads({ 11: { oid: sha(1), nameWithOwner: 'org/ok' }, 12: { oid: sha(2) }, 13: { oid: sha(3) }, 14: { oid: sha(4), nameWithOwner: 'neworg/moved' } });
  const out = await refreshHeads(db, { client: g.client, now: () => T });
  assert.deepEqual(g.calls[0].body.variables.ids.sort(), ['R_11', 'R_14']);
  assert.equal(out.skipped.renamed, 1);
  assert.equal(db.getSubject('org/ok').sha, sha(1));
  assert.equal(db.getSubject('org/moved').sha, null, 'left for the id pass to rename first');
  assert.equal(db.getSubject('org/conflict').sha, null);
  db.close();
});

test('R-CHG-11: the budget is checked before the first query (points reserve, calls held for the id pass), and T0 takes at most a quarter of a run', async () => {
  assert.equal(ID_PASS_CALLS, 8);
  assert.equal(MAX_TIER_SHARE.T0, 0.25);
  const db = openState(':memory:');
  seed(db, { 'org/a': { tier: 3, repo_id: 11 } });
  const g = fakeHeads({ 11: { oid: sha(1) } });
  // GitHub said 150 points left at the last call, reset an hour away: no query at all.
  const c = fakeClock(T);
  const low = new ApiBudget({ now: c.now, sleep: c.sleep });
  low.resources.set('graphql', { limit: 1000, remaining: 150, reset: T + HOUR });
  let out = await refreshHeads(db, { client: { ...g.client, budget: low }, now: c.now });
  assert.deepEqual([out.queries, out.stopped, g.calls.length], [0, 'points_reserve', 0]);
  // Past the reset the old count is not believed.
  assert.equal(headsRoom(low, T + 2 * HOUR).points, null);
  // The count is carried to the next pump run with the budget (kv pump.api_budget), so its first query is checked too.
  const next = new ApiBudget({ now: () => T + 60_000, sleep: c.sleep }).restore(JSON.parse(JSON.stringify(low.snapshot())));
  assert.equal(headsRoom(next, T + 60_000).points, 150);
  assert.equal(new ApiBudget({ now: () => T + 2 * HOUR }).restore(JSON.parse(JSON.stringify(low.snapshot()))).resources.has('graphql'), false, 'a window that has reset is not carried');
  out = await refreshHeads(db, { client: { ...g.client, budget: next }, now: () => T + 60_000 });
  assert.deepEqual([out.queries, out.stopped, g.calls.length], [0, 'points_reserve', 0]);
  // 22 of the 30 hourly calls used: the last 8 are the id pass's.
  const busy = new ApiBudget({ now: c.now, sleep: c.sleep });
  for (let i = 0; i < 22; i++) await busy.take('graphql');
  assert.equal(headsRoom(busy, c.now()).calls, 0);
  out = await refreshHeads(db, { client: { ...g.client, budget: busy }, now: c.now });
  assert.deepEqual([out.queries, out.stopped, g.calls.length], [0, 'id_reserve', 0]);
  // 20 used: 2 left for heads, so at most 2 queries.
  const some = new ApiBudget({ now: c.now, sleep: c.sleep });
  for (let i = 0; i < 20; i++) await some.take('graphql');
  assert.equal(headsRoom(some, c.now()).calls, 2);
  // T0 share: 300 T0 subjects and 50 T3 ones, one run of 3 x 100.
  const subjects = [...Array.from({ length: 300 }, (_, i) => ({ id: `a/t0-${String(i).padStart(3, '0')}`, tier: 0 })), ...Array.from({ length: 50 }, (_, i) => ({ id: `c/t3-${i}`, tier: 3 }))];
  const p = pickHeads({ subjects, cursors: {}, tiers: scanStatic().tiers, now: T, limit: 300 });
  assert.equal(p.picks.filter((x) => x.tier === 'T0').length, 75);
  assert.equal(p.picks.filter((x) => x.tier === 'T3').length, 50);
  assert.equal(p.plan.T0.ends, false, 'T0 resumes from its cursor next run');
  db.close();
});
