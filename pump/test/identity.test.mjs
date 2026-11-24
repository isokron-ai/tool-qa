// Subject ids (pump/identity.mjs, state schema v8): the GraphQL lookups, how
// the pump runs them, and how the seed finds a renamed subject. No network:
// every call goes to a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../../state/db.mjs';
import { ApiBudget, BudgetExceededError } from '../budgets.mjs';
import { dueFromState, loadConfig } from '../due.mjs';
import { workerInputs } from '../dispatch.mjs';
import { BATCH, buildIdQuery, buildNameQuery, IDENTITY_KV_KEY, identityEnabled, MAX_QUERIES, parseAnswer, refreshIdentities, RETRY_MS } from '../identity.mjs';
import { runPump } from '../run.mjs';
import { identityCheck } from '../../watchdog/identity.mjs';
import { resolveSeedSubjects, syncSeedSubjects } from '../subjects.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

globalThis.fetch = async (url) => {
  throw new Error(`identity tests: no network (${url})`);
};

const DAY = 86_400_000;
const T = Date.parse('2026-11-24T00:00:00Z');

/** A fake GitHub GraphQL for repositories: {name -> {databaseId, createdAt}}, following renames. */
function fakeGraph(repos) {
  const list = Object.entries(repos).map(([name, r]) => ({ name, old: [], visible: true, createdAt: '2025-01-01T00:00:00Z', ...r, nodeId: `R_${r.databaseId}` }));
  const asNode = (r) => ({ __typename: 'Repository', databaseId: r.databaseId, id: r.nodeId, nameWithOwner: r.name, createdAt: r.createdAt });
  const calls = [];
  const answer = ({ query, variables }) => {
    const data = { rateLimit: { cost: 1, remaining: 4999 } };
    const errors = [];
    if (/nodes\(ids:/.test(query)) {
      data.nodes = variables.ids.map((id, i) => {
        const r = list.find((x) => x.visible && x.nodeId === id);
        if (!r) errors.push({ type: 'NOT_FOUND', path: ['nodes', i] });
        return r ? asNode(r) : null;
      });
    } else {
      for (let i = 0; variables[`o${i}`] !== undefined; i++) {
        const want = `${variables[`o${i}`]}/${variables[`n${i}`]}`.toLowerCase();
        const live = list.filter((x) => x.visible);
        const r = live.find((x) => x.name.toLowerCase() === want) ?? live.find((x) => x.old.includes(want));
        data[`r${i}`] = r ? asNode(r) : null;
        if (!r) errors.push({ type: 'NOT_FOUND', path: [`r${i}`] });
      }
    }
    return errors.length ? { data, errors } : { data };
  };
  return {
    list,
    calls,
    rename(from, to) {
      const r = list.find((x) => x.name === from);
      r.old.push(from.toLowerCase());
      r.name = to;
    },
    client: {
      async request(method, path, opts) {
        calls.push({ method, path, ...opts });
        return { status: 200, data: answer(opts.body) };
      },
    },
    api: () => fakeApi([['POST', '/graphql', (req) => ({ body: answer(req.json) })]]),
  };
}

function seedSubjects(db, names, { tier = 3, source = 'seed-v1' } = {}) {
  for (const id of names) db.setSubjectVersion({ id, kind: 'github', source, tier, now: T });
}

const names = (n, prefix = 'org/repo-') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('the GraphQL queries pass names and ids as variables, never in the query text', () => {
  const q = buildNameQuery(['acme/one', 'x-y/z.z']);
  assert.match(q.query, /r0: repository\(owner: \$o0, name: \$n0\) \{ databaseId id nameWithOwner createdAt \}/);
  assert.deepEqual(q.variables, { o0: 'acme', n0: 'one', o1: 'x-y', n1: 'z.z' });
  assert.ok(!q.query.includes('acme'));
  assert.throws(() => buildNameQuery(['acme/one"){ viewer { login } }']), /not owner\/name/);
  const i = buildIdQuery(['R_1', 'R_2']);
  assert.match(i.query, /nodes\(ids: \$ids\)/);
  assert.deepEqual(i.variables, { ids: ['R_1', 'R_2'] });
  assert.equal(BATCH, 100);
  assert.equal(MAX_QUERIES, 4);
  assert.equal(RETRY_MS.ok, DAY);
});

test('parseAnswer: found, NOT_FOUND and a broken answer, per entry and as a whole', () => {
  const n = { databaseId: 1, id: 'R_1', nameWithOwner: 'a/b', createdAt: '2025-01-01T00:00:00Z' };
  assert.deepEqual(parseAnswer({ data: { r0: n, r1: null }, errors: [{ type: 'NOT_FOUND', path: ['r1'] }] }, 2, 'name').map((a) => a.status), ['ok', 'not_found']);
  assert.deepEqual(parseAnswer({ data: { r0: null } }, 1, 'name').map((a) => a.status), ['error'], 'null with no NOT_FOUND is not taken as gone');
  assert.deepEqual(parseAnswer({ errors: [{ type: 'RATE_LIMITED', message: 'x' }] }, 2, 'name').map((a) => a.status), ['error', 'error']);
  assert.deepEqual(parseAnswer({ data: { nodes: [n, null] }, errors: [{ type: 'NOT_FOUND', path: ['nodes', 1] }] }, 2, 'id').map((a) => a.status), ['ok', 'not_found']);
  assert.deepEqual(parseAnswer({ data: { nodes: [{ __typename: 'Issue' }] } }, 1, 'id').map((a) => a.status), ['not_found']);
  assert.deepEqual(parseAnswer({ data: { nodes: [n] } }, 2, 'id').map((a) => a.status), ['error', 'error'], 'a short nodes list is not trusted');
  assert.deepEqual(parseAnswer(null, 1, 'id').map((a) => a.status), ['error']);
});

test('R-SUBJ-08: the backfill binds 250 subjects in 3 queries of up to 100 within the per-run cap, then waits a day before looking again by id', async () => {
  const db = openState(':memory:');
  const all = names(250);
  seedSubjects(db, all);
  const g = fakeGraph(Object.fromEntries(all.map((n, i) => [n, { databaseId: 100 + i }])));
  const out = await refreshIdentities(db, { client: g.client, now: () => T });
  assert.equal(out.queries, 3);
  assert.equal(out.looked_up, 250);
  assert.deepEqual(out.events, { id_bound: 250 });
  assert.equal(out.unbound, 0);
  assert.equal(out.cost, 3);
  assert.ok(g.calls.every((c) => c.method === 'POST' && c.path === '/graphql' && c.family === 'graphql'));
  assert.equal(db.getSubject('org/repo-7').repo_id, 107);
  assert.equal(db.getKv(IDENTITY_KV_KEY).queries, 3);
  assert.match(out.summary, /^3 lookup queries \(250 repositories, 3 points\): id_bound 250; 250 active, 0 without an id yet, 0 not found, 0 in conflict, 0 merged$/);

  g.calls.length = 0;
  assert.equal((await refreshIdentities(db, { client: g.client, now: () => T + 60_000 })).queries, 0, 'nothing to do within the day');
  g.rename('org/repo-3', 'other/repo-3');
  const next = await refreshIdentities(db, { client: g.client, now: () => T + DAY + 1 });
  assert.equal(next.queries, 3, 'by node id, 100 a query');
  assert.ok(g.calls.every((c) => /nodes\(ids:/.test(c.body.query)));
  assert.deepEqual(next.events, { transferred: 1 });
  assert.equal(db.getSubject('org/repo-3').name, 'other/repo-3');
  // At most MAX_QUERIES a run: 500 unbound take two runs.
  const db2 = openState(':memory:');
  seedSubjects(db2, names(500, 'big/r-'));
  const g2 = fakeGraph(Object.fromEntries(names(500, 'big/r-').map((n, i) => [n, { databaseId: 5000 + i }])));
  assert.equal((await refreshIdentities(db2, { client: g2.client, now: () => T })).queries, 4);
  assert.equal(db2.getKv(IDENTITY_KV_KEY).unbound, 100);
  db.close();
  db2.close();
});

test('R-SUBJ-08: a failed lookup never throws or holds the pump: budget, outage, a rate-limited answer and no token are each a stop, and kv says why', async () => {
  const db = openState(':memory:');
  seedSubjects(db, names(150));
  const g = fakeGraph(Object.fromEntries(names(150).map((n, i) => [n, { databaseId: 100 + i }])));
  let n = 0;
  const budgeted = {
    async request(...args) {
      n += 1;
      if (n === 2) throw new BudgetExceededError('graphql: hourly budget of 30 calls is used', { family: 'graphql', reason: 'hourly' });
      return g.client.request(...args);
    },
  };
  let out = await refreshIdentities(db, { client: budgeted, now: () => T });
  assert.equal(out.stopped, 'budget');
  assert.equal(out.looked_up, 100, 'the first batch is kept');
  assert.equal(out.unbound, 50);
  assert.equal(db.getKv(IDENTITY_KV_KEY).stopped, 'budget');

  out = await refreshIdentities(db, { client: { request: async () => { const e = new Error('GET /graphql: network error'); e.name = 'GitHubError'; throw e; } }, now: () => T + 1 });
  assert.equal(out.stopped, 'api_error');

  out = await refreshIdentities(db, { client: { request: async () => ({ status: 200, data: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } }) }, now: () => T + 2 });
  assert.equal(out.stopped, 'bad_answer');
  const left = db.listSubjects().filter((x) => x.repo_id === null);
  assert.equal(left.length, 50);
  assert.ok(left.every((x) => x.id_status === 'error'), 'tried again in an hour');

  out = await refreshIdentities(db, { client: null, now: () => T + 3 });
  assert.equal(out.stopped, 'no_token');
  // A broken state store is reported, not thrown.
  const broken = { identityCandidates() { throw new Error('disk I/O error'); }, raw: db.raw, setKv: () => {}, applyIdentityLookup() {}, tx: (f) => f() };
  out = await refreshIdentities(broken, { client: g.client, now: () => T + 4 });
  assert.equal(out.stopped, 'error');
  assert.match(out.error, /disk I\/O/);
  // Subjects not looked up are still due, under their names.
  const due = dueFromState(db, { now: T + 5, ...scanStatic() });
  assert.equal(due.length, 150);
  db.close();
});

test('identityEnabled: unset, empty or "true" runs the lookups; anything else stops them', () => {
  assert.equal(identityEnabled({}), true);
  assert.equal(identityEnabled({ LANE_SUBJECT_IDS_ENABLED: '' }), true);
  assert.equal(identityEnabled({ LANE_SUBJECT_IDS_ENABLED: 'true' }), true);
  assert.equal(identityEnabled({ LANE_SUBJECT_IDS_ENABLED: 'false' }), false);
  assert.equal(identityEnabled({ LANE_SUBJECT_IDS_ENABLED: 'TRUE' }), false);
});

function scanStatic() {
  const cfg = loadConfig();
  const workflows = {};
  for (const [name, w] of Object.entries(cfg.workflows)) workflows[name] = { ...w, enabled: false };
  workflows['scan-static'] = { ...cfg.workflows['scan-static'], enabled: true, versions: { tool: { 'mcp-check': 'ec3c801' }, oracle: {}, probe: {} } };
  return { tiers: cfg.tiers, workflows };
}

test('R-SUBJ-02: the due list names the subject by its key and carries the current name; workers are sent the name', () => {
  const db = openState(':memory:');
  seedSubjects(db, ['acme/server']);
  db.applyIdentityLookup('acme/server', { status: 'ok', via: 'name', node: { databaseId: 5, id: 'R_5', nameWithOwner: 'acme/server', createdAt: '2025-01-01T00:00:00Z' } }, { now: T });
  const [before] = dueFromState(db, { now: T, ...scanStatic() });
  db.applyIdentityLookup('acme/server', { status: 'ok', via: 'id', node: { databaseId: 5, id: 'R_5', nameWithOwner: 'newco/server', createdAt: '2025-01-01T00:00:00Z' } }, { now: T + 1 });
  const [after] = dueFromState(db, { now: T + 2, ...scanStatic() });
  assert.deepEqual([after.subject, after.name, after.repo_id], ['acme/server', 'newco/server', 5]);
  assert.equal(after.run_key, before.run_key, 'a rename does not move the run_key');
  const inputs = workerInputs({ shardId: 's', attemptId: 'a', items: [{ subject: after.subject, subject_name: after.name, run_key: after.run_key, fence: 3 }] });
  assert.deepEqual(JSON.parse(inputs.items), [{ subject: 'newco/server', run_key: after.run_key, fence: 3 }]);
  // A dispatch item from before v8 (no name) still sends its key.
  assert.equal(JSON.parse(workerInputs({ shardId: 's', attemptId: 'a', items: [{ subject: 'acme/server', run_key: after.run_key, fence: 3 }] }).items)[0].subject, 'acme/server');
  db.close();
});

test('R-SUBJ-09: the seed finds a renamed subject by its current name, its key or an old name, case aside; a reused old name becomes a new key', () => {
  const db = openState(':memory:');
  seedSubjects(db, ['acme/server', 'Acme/Tool', 'solo/x']);
  const bind = (key, id, name) => db.applyIdentityLookup(key, { status: 'ok', via: 'name', node: { databaseId: id, id: `R_${id}`, nameWithOwner: name, createdAt: '2025-01-01T00:00:00Z' } }, { now: T });
  bind('acme/server', 1, 'acme/server');
  bind('acme/server', 1, 'newco/server'); // transferred
  bind('solo/x', 3, 'solo/x');
  bind('solo/x', 3, 'solo/y');
  bind('solo/x', 3, 'solo/z'); // renamed twice
  const r = resolveSeedSubjects(db, ['newco/server', 'acme/tool', 'solo/y', 'acme/server', 'brand/new']);
  assert.deepEqual(Object.fromEntries([...r].map(([k, v]) => [k, v.key])), {
    'newco/server': 'acme/server', // by current name
    'acme/tool': 'Acme/Tool', // by key, case aside
    'solo/y': 'solo/x', // by an old name
    'acme/server': 'acme/server#2', // the old name, listed beside the new one: another repository
    'brand/new': 'brand/new',
  });
  assert.deepEqual([...r.values()].map((v) => v.isNew), [false, false, false, true, true]);
});

test('R-SUBJ-09: a rebuilt seed that spells a renamed repository by its new name keeps its subject, history and run_keys: nothing retired, nothing new', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-ids-'));
  try {
    const file = join(dir, 'seed.json');
    const write = (ids, version) => writeFileSync(file, JSON.stringify({ version, size: ids.length, subjects: ids.map((id) => ({ id, tier: 'sample', star_bucket: '0-9' })) }));
    const ids = names(20);
    write(ids, 1);
    const db = openState(':memory:');
    assert.equal(syncSeedSubjects(db, { now: T, file }).loaded, true);
    db.applyIdentityLookup('org/repo-4', { status: 'ok', via: 'name', node: { databaseId: 44, id: 'R_44', nameWithOwner: 'moved/repo-4', createdAt: '2025-01-01T00:00:00Z' } }, { now: T });
    const keyBefore = dueFromState(db, { now: T, ...scanStatic() }).find((d) => d.subject === 'org/repo-4').run_key;
    write(ids.map((id) => (id === 'org/repo-4' ? 'moved/repo-4' : id)), 2);
    const out = syncSeedSubjects(db, { now: T + 1, file });
    assert.equal(out.loaded, true);
    assert.equal(out.retired, 0);
    assert.equal(db.listSubjects().length, 20, 'no second subject');
    const d = dueFromState(db, { now: T + 2, ...scanStatic() }).find((x) => x.subject === 'org/repo-4');
    assert.deepEqual([d.name, d.run_key], ['moved/repo-4', keyBefore]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-SUBJ-08: in a pump run the lookups run after the seed load and before the first tick; a GraphQL outage holds nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pump-ids-'));
  try {
    const file = join(dir, 'seed.json');
    const ids = names(30);
    writeFileSync(file, JSON.stringify({ version: 1, size: ids.length, subjects: ids.map((id) => ({ id, tier: 'sample', star_bucket: '0-9' })) }));
    const g = fakeGraph(Object.fromEntries(ids.map((n, i) => [n, { databaseId: 700 + i }])));
    g.rename('org/repo-2', 'org/repo-two');
    const c = fakeClock(T);
    const sent = [];
    const lines = [];
    const run = (fetch, extra = {}) => runPump({
      env: { GITHUB_REPOSITORY: 'isokron-ai/tool-qa', GITHUB_TOKEN: 'ghs_synthetic', LOOP_SLOTS: '3', GITHUB_API_URL: API, ...extra },
      now: c.now, sleep: c.sleep, log: (l) => lines.push(l), stateFile: join(dir, 'state.sqlite'), seedFile: file, config: scanStatic(),
      fetch, budget: new ApiBudget({ now: c.now, sleep: c.sleep }),
      pull: async () => ({ status: 'pulled' }), push: async () => ({ status: 'pushed' }),
      dispatcher: { async dispatch(req) { sent.push(req); return { runId: 10 + sent.length, runUrl: null, correlatedBy: 'response' }; } },
      newId: (() => { let i = 0; return () => `att-${extra.tag ?? ''}${++i}`; })(), ingest: null, maxRunMs: 60_000,
    });
    const api = g.api();
    const out = await run(api.fetch);
    assert.equal(out.ok, true);
    const iSubj = lines.findIndex((l) => l.startsWith('pump: subjects: loaded 30'));
    const iIds = lines.findIndex((l) => l.startsWith('pump: subject ids: 1 lookup queries (30 repositories, 1 points): id_bound 30, renamed 1'));
    const iTick = lines.findIndex((l) => l.startsWith('pump: tick 1'));
    assert.ok(iSubj >= 0 && iIds > iSubj && iTick > iIds, lines.join('\n'));
    assert.ok(api.calls.every((x) => x.path === '/graphql' && x.headers.get('authorization') === 'Bearer ghs_synthetic'));
    const items = sent.flatMap((r) => JSON.parse(r.inputs.items).map((i) => i.subject));
    assert.ok(items.includes('org/repo-two') && !items.includes('org/repo-2'), 'the renamed subject is sent under its new name');

    // An outage: the run is still ok.
    const down = fakeApi([['POST', '/graphql', () => ({ status: 502, body: { message: 'Bad Gateway' } })]]);
    c.t += 2 * DAY;
    lines.length = 0;
    const out2 = await run(down.fetch, { tag: 'b' });
    assert.equal(out2.ok, true);
    assert.ok(lines.some((l) => /^pump: subject ids: 1 lookup queries .*stopped \(api_error/.test(l)), lines.join('\n'));
    // Switched off: no lookup at all.
    const off = fakeApi([]);
    lines.length = 0;
    await run(off.fetch, { LANE_SUBJECT_IDS_ENABLED: 'false', tag: 'c' });
    assert.equal(off.calls.length, 0);
    assert.ok(lines.includes('pump: subject ids: lookups are off (LANE_SUBJECT_IDS_ENABLED); ids already found are still used'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-SUBJ-11: old and new name in the same batch, the newcomer applied first: the subject with the history ends up bound, the newcomer merged into it', async () => {
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 'acme/zz-old', kind: 'github', source: 'seed-v1', tier: 3, now: T });
  db.recordAttempt({ subject: 'acme/zz-old', holder: 'h', fence: 1, now: T });
  db.setSubjectVersion({ id: 'acme/aa-new', kind: 'github', source: 'seed-v2', tier: 3, now: T + DAY });
  const g = fakeGraph({ 'acme/zz-old': { databaseId: 31 } });
  g.rename('acme/zz-old', 'acme/aa-new');
  const out = await refreshIdentities(db, { client: g.client, now: () => T + 2 * DAY });
  assert.equal(out.queries, 1);
  assert.deepEqual(db.listSubjectEvents().map((e) => [e.subject, e.kind]), [
    ['acme/aa-new', 'id_bound'], ['acme/aa-new', 'merged'], ['acme/zz-old', 'id_bound'], ['acme/zz-old', 'renamed'],
  ]);
  assert.deepEqual([db.getSubject('acme/zz-old').repo_id, db.getSubject('acme/zz-old').name], [31, 'acme/aa-new']);
  assert.equal(db.getSubject('acme/aa-new').alias_of, 'acme/zz-old');
  assert.equal(out.merged, 1);
  const due = dueFromState(db, { now: T + 2 * DAY, ...scanStatic() });
  assert.deepEqual(due.map((d) => [d.subject, d.name]), [['acme/zz-old', 'acme/aa-new']]);
  db.close();
});

test('R-SUBJ-13: a batch mostly NOT_FOUND (a token or permission change) marks nothing gone: errors, retried in an hour, the pass stops, and the watchdog shows it red', async () => {
  const db = openState(':memory:');
  const all = names(30);
  seedSubjects(db, all);
  const g = fakeGraph(Object.fromEntries(all.map((n, i) => [n, { databaseId: 100 + i }])));
  await refreshIdentities(db, { client: g.client, now: () => T });
  for (const r of g.list) r.visible = false; // the token can no longer see them
  const out = await refreshIdentities(db, { client: g.client, now: () => T + DAY + 1 });
  assert.equal(out.stopped, 'mass_not_found');
  assert.equal(out.suspect_not_found, 30);
  assert.equal(out.gone, 0);
  assert.ok(db.listSubjects().every((x) => x.gone_at === null && x.id_status === 'error'));
  assert.equal(dueFromState(db, { now: T + DAY + 2, ...scanStatic() }).length, 30, 'still dispatched');
  assert.equal(identityCheck(db.getKv(IDENTITY_KV_KEY)).status, 'red');
  // Five or fewer, or 20% or less, is believed: those are gone.
  for (const r of g.list) r.visible = true;
  for (const r of g.list.slice(0, 5)) r.visible = false;
  const few = await refreshIdentities(db, { client: g.client, now: () => T + DAY + 2 * 3_600_000 });
  assert.equal(few.stopped, null);
  assert.equal(few.gone, 5);
  assert.equal(identityCheck(db.getKv(IDENTITY_KV_KEY)).status, 'green');
  db.close();
});

test('R-SUBJ-13: the watchdog item: red on a mass NOT_FOUND pass or many gone, amber on any conflict, green with the counts, absent before any pass', () => {
  assert.equal(identityCheck(null), null);
  assert.equal(identityCheck({ stopped: 'mass_not_found', error: '30 of 30 answered NOT_FOUND', active: 30 }).status, 'red');
  assert.equal(identityCheck({ gone: 6, active: 20, conflicts: 0 }).status, 'red');
  assert.equal(identityCheck({ gone: 6, active: 100, conflicts: 0 }).status, 'green', '6% gone is believed');
  assert.equal(identityCheck({ gone: 5, active: 10, conflicts: 0 }).status, 'green', 'five or fewer is never mass');
  const amber = identityCheck({ gone: 0, active: 997, conflicts: 1, merged: 2 });
  assert.equal(amber.status, 'amber');
  assert.match(amber.summary, /0 not found, 1 in conflict, 2 merged of 997 active/);
  assert.equal(identityCheck({ gone: 1, active: 997, conflicts: 0, merged: 0 }).id, 'subject-ids');
});
