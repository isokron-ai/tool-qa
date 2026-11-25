import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, tick, pausedBy, parseIsoTime, parseSlots, WATCH, MAX_DISPATCHES } from '../worker.mjs';
import { evaluateGuard } from '../../scripts/guard.mjs';

const NOW = Date.parse('2026-11-25T17:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const PW = WATCH.slice(0, 2); // pump and watchdog: the original two, for the tests that predate the wider watch
function fakeGitHub({ loop = 'true', vars = {}, runs = {}, fail = {}, many = 0 } = {}) {
  const calls = []; const dispatches = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(init.method + ' ' + u.pathname);
    assert.equal(init.headers.authorization, 'Bearer t0ken');
    for (const [k, s] of Object.entries(fail)) if (u.pathname.includes(k) && (s.method || 'GET') === init.method) { if (s.throw) throw new TypeError('fetch failed'); return res(s.status, {}); }
    if (u.pathname.endsWith('/actions/variables')) {
      const all = { ...(loop === null ? {} : { LOOP_ENABLED: loop }), ...vars };
      for (let i = 0; i < many; i++) all['FILLER_' + i] = 'x';
      const names = Object.keys(all).filter((n) => all[n] !== undefined);
      const per = Number(u.searchParams.get('per_page')); const page = Number(u.searchParams.get('page'));
      return res(200, { total_count: names.length, variables: names.slice((page - 1) * per, page * per).map((name) => ({ name, value: all[name] })) });
    }
    const m = /\/workflows\/([^/]+)\/(runs|dispatches)$/.exec(u.pathname);
    if (m && m[2] === 'runs') return res(200, { workflow_runs: runs[m[1]] || [] });
    if (m && m[2] === 'dispatches') { dispatches.push({ workflow: m[1], body: JSON.parse(init.body) }); return res(204, null); }
    throw new Error('unexpected ' + url);
  };
  f.calls = calls; f.dispatches = dispatches; return f;
}
const run = (o) => tick({ token: 't0ken', enabled: 'true', now: NOW, watch: PW, ...o });

test('R-HB-01: a broken pump chain is restarted: nothing queued or running and the newest run is past its limit', async () => {
  const f = fakeGitHub({ runs: { 'pump.yml': [{ status: 'completed', created_at: ago(25) }], 'watchdog.yml': [{ status: 'completed', created_at: ago(10) }] } });
  const log = await run({ fetch: f });
  assert.ok(f.calls.includes('POST /repos/isokron-ai/tool-qa/actions/workflows/pump.yml/dispatches'));
  assert.ok(!f.calls.some((c) => c.includes('watchdog.yml/dispatches')));
  assert.match(log.join('\n'), /pump\.yml: dispatched/);
});

test('R-HB-02: a healthy chain is left alone: a run queued or running, or a recent one', () => {
  assert.equal(decide([{ status: 'completed', created_at: ago(60) }, { status: 'queued', created_at: ago(1) }], { staleMin: 15, now: NOW }).action, 'ok');
  assert.equal(decide([{ status: 'in_progress', created_at: ago(120) }], { staleMin: 15, now: NOW }).action, 'ok');
  assert.equal(decide([{ status: 'completed', created_at: ago(14) }], { staleMin: 15, now: NOW }).action, 'ok');
  assert.equal(decide([{ status: 'completed', created_at: ago(16) }], { staleMin: 15, now: NOW }).action, 'dispatch');
  assert.equal(decide([], { staleMin: 15, now: NOW }).action, 'dispatch');
  assert.deepEqual(PW.map((w) => w.workflow), ['pump.yml', 'watchdog.yml']);
});

test('R-HB-03: the kill switches hold: LOOP_ENABLED off, HEARTBEAT_ENABLED off, or no token means no dispatch', async () => {
  const stale = { runs: { 'pump.yml': [{ status: 'completed', created_at: ago(300) }] } };
  for (const loop of ['false', '', 'TRUE']) {
    const f = fakeGitHub({ loop, ...stale });
    assert.match((await run({ fetch: f })).join('\n'), /kill switch is off/);
    assert.ok(!f.calls.some((c) => c.startsWith('POST')));
  }
  const g = fakeGitHub(stale);
  assert.match((await tick({ token: 't0ken', enabled: 'false', fetch: g, now: NOW })).join('\n'), /HEARTBEAT_ENABLED/);
  assert.match((await tick({ token: '', enabled: 'true', fetch: g, now: NOW })).join('\n'), /no GH_TOKEN/);
  assert.equal(g.calls.length, 0);
});

test('R-HB-04: during a GitHub outage nothing throws and nothing is dispatched blind; the next tick retries', async () => {
  // The kill switch cannot be read: no dispatch (it may be off).
  const a = fakeGitHub({ fail: { 'actions/variables': { status: 502 } }, runs: { 'pump.yml': [] } });
  assert.match((await run({ fetch: a })).join('\n'), /could not read the repository variables \(HTTP 502\)/);
  assert.ok(!a.calls.some((c) => c.startsWith('POST')));
  // Runs cannot be listed: no dispatch for that workflow (it may be running).
  const b = fakeGitHub({ fail: { 'pump.yml/runs': { throw: true } }, runs: { 'watchdog.yml': [{ status: 'completed', created_at: ago(5) }] } });
  assert.match((await run({ fetch: b })).join('\n'), /pump\.yml: could not list runs \(HTTP network\)/);
  assert.ok(!b.calls.some((c) => c.startsWith('POST')));
  // The dispatch itself fails: logged, no throw.
  const c = fakeGitHub({ fail: { 'pump.yml/dispatches': { status: 500, method: 'POST' } }, runs: { 'pump.yml': [], 'watchdog.yml': [{ status: 'completed', created_at: ago(5) }] } });
  assert.match((await run({ fetch: c })).join('\n'), /pump\.yml: dispatch failed \(HTTP 500/);
});

const pumpDispatched = (f) => f.calls.some((c) => c.includes('pump.yml/dispatches'));
const STALE = { 'pump.yml': [{ status: 'completed', created_at: ago(300), updated_at: ago(290) }], 'watchdog.yml': [{ status: 'completed', created_at: ago(5), updated_at: ago(5) }] };

test('R-HB-05: the other pause switches hold: LOOP_PAUSE_UNTIL, LANE_PUMP_ENABLED, LOOP_SLOTS=0; an unset variable is the default', async () => {
  const future = new Date(NOW + 3600_000).toISOString();
  for (const vars of [{ LOOP_PAUSE_UNTIL: future }, { LOOP_PAUSE_UNTIL: 'next week' }, { LANE_PUMP_ENABLED: 'false' }, { LANE_PUMP_ENABLED: 'TRUE' }, { LOOP_SLOTS: '0' }, { LOOP_SLOTS: 'many' }]) {
    const f = fakeGitHub({ vars, runs: STALE });
    const log = (await run({ fetch: f })).join('\n');
    assert.ok(!pumpDispatched(f), JSON.stringify(vars));
    assert.match(log, /pump\.yml: not started/);
  }
  // A paused loop also holds the watchdog; the pump's own lane and slots do not.
  const w = fakeGitHub({ vars: { LANE_PUMP_ENABLED: 'false', LOOP_SLOTS: '0' }, runs: { 'watchdog.yml': [{ status: 'completed', created_at: ago(300), updated_at: ago(300) }], 'pump.yml': [{ status: 'in_progress', created_at: ago(1) }] } });
  await run({ fetch: w });
  assert.ok(w.calls.some((c) => c.includes('watchdog.yml/dispatches')));
  // Unset (404), empty, past pause and slots above zero all leave the pump on.
  for (const vars of [{}, { LOOP_PAUSE_UNTIL: '', LANE_PUMP_ENABLED: '', LOOP_SLOTS: '' }, { LOOP_PAUSE_UNTIL: new Date(NOW - 1000).toISOString() }, { LOOP_SLOTS: '3', LANE_PUMP_ENABLED: 'true' }]) {
    const f = fakeGitHub({ vars, runs: STALE });
    await run({ fetch: f });
    assert.ok(pumpDispatched(f), JSON.stringify(vars));
  }
  // An unreadable variable (401) is never "unset": nothing is dispatched.
  const u = fakeGitHub({ fail: { 'actions/variables': { status: 401 } }, runs: STALE });
  assert.match((await run({ fetch: u })).join('\n'), /could not read the repository variables \(HTTP 401\)/);
  assert.ok(!u.calls.some((c) => c.startsWith('POST')));
  // A 401 on the variables: nothing done. LOOP_ENABLED not set at all is "not true": off.
  const k = fakeGitHub({ fail: { 'actions/variables': { status: 401 } }, runs: STALE });
  assert.match((await run({ fetch: k })).join('\n'), /could not read the repository variables \(HTTP 401\)/);
  const n = fakeGitHub({ loop: null, runs: STALE });
  assert.match((await run({ fetch: n })).join('\n'), /kill switch is off/);
  assert.ok(!n.calls.some((c) => c.startsWith('POST')));
});

test('R-HB-06: the switches are read as scripts/guard.mjs reads them', () => {
  const future = new Date(NOW + 3600_000).toISOString(); const past = new Date(NOW - 3600_000).toISOString();
  const cases = [{}, { LOOP_PAUSE_UNTIL: future }, { LOOP_PAUSE_UNTIL: past }, { LOOP_PAUSE_UNTIL: '2026-11-26' }, { LOOP_PAUSE_UNTIL: '2026-02-30' }, { LOOP_PAUSE_UNTIL: 'soon' }, { LOOP_PAUSE_UNTIL: '  ' },
    { LANE_PUMP_ENABLED: 'false' }, { LANE_PUMP_ENABLED: '' }, { LANE_PUMP_ENABLED: 'true' }, { LANE_PUMP_ENABLED: 'True' }, { LOOP_SLOTS: '0' }, { LOOP_SLOTS: '-2' }, { LOOP_SLOTS: 'x' }, { LOOP_SLOTS: '4' }];
  for (const vars of cases) {
    const guard = evaluateGuard({ LOOP_ENABLED: 'true', ...vars }, { job: 'pump', now: NOW });
    // The pump's guard does not stop on slots (it just does not chain), so compare the guard's stop for pause and lane,
    // and the Worker's own slots rule against parseSlots.
    const mine = pausedBy({ ...vars, LOOP_SLOTS: undefined }, { lane: 'LANE_PUMP_ENABLED', usesSlots: false, now: NOW });
    assert.equal(mine === null, guard.proceed, JSON.stringify(vars));
    assert.equal(pausedBy(vars, { lane: 'LANE_PUMP_ENABLED', usesSlots: true, now: NOW }) === null, guard.proceed && (vars.LOOP_SLOTS === undefined || evaluateGuard({ LOOP_ENABLED: 'true', ...vars }, { job: 'pump', needsSlots: true, now: NOW }).proceed), JSON.stringify(vars));
  }
  assert.ok(Number.isNaN(parseIsoTime('soon')));
  assert.equal(parseSlots('99'), 15);
});

test('R-HB-07: a run stuck waiting is not healthy forever; action_required is not running', () => {
  const o = { staleMin: 15, stuckMin: 40, now: NOW };
  assert.equal(decide([{ status: 'queued', created_at: ago(39) }], o).action, 'ok');
  for (const status of ['queued', 'waiting', 'pending', 'requested']) {
    const d = decide([{ status, created_at: ago(41) }], o);
    assert.equal(d.action, 'dispatch', status); assert.equal(d.warn, true);
  }
  // action_required (approval needed) never counts as a run in progress, even a new one.
  assert.equal(decide([{ status: 'action_required', created_at: ago(1), run_started_at: ago(1) }], o).action, 'ok', 'recent: counts as recent activity only');
  assert.equal(decide([{ status: 'action_required', created_at: ago(100) }], o).action, 'dispatch');
  assert.equal(decide([{ status: 'in_progress', created_at: ago(500), run_started_at: ago(400) }], o).action, 'ok', 'a running run is healthy');
});

test('R-HB-08: age comes from when the run started or last finished, not when it was created', async () => {
  const o = { staleMin: 15, stuckMin: 40, now: NOW };
  // Created 3 h ago, finished 5 min ago.
  assert.equal(decide([{ status: 'completed', created_at: ago(180), run_started_at: ago(30), updated_at: ago(5) }], o).action, 'ok');
  // Queued for 3 h and just completed: its completion time counts, so no early or late dispatch is based on the creation time.
  assert.equal(decide([{ status: 'completed', created_at: ago(180), run_started_at: ago(10), updated_at: ago(2) }], o).action, 'ok');
  assert.equal(decide([{ status: 'completed', created_at: ago(5), run_started_at: ago(60), updated_at: ago(50) }], o).action, 'dispatch');
  // A stuck queued run is measured from its creation (it has no start).
  assert.equal(decide([{ status: 'queued', created_at: ago(50), run_started_at: ago(1) }], o).action, 'dispatch');
});

// ---- the wider watch (every scheduled workflow) ----

const HOUR = 60;
const done = (min, conclusion = 'success', extra = {}) => ({ status: 'completed', conclusion, created_at: ago(min + 2), run_started_at: ago(min + 1), updated_at: ago(min), ...extra });
const entry = (wf) => WATCH.find((w) => w.workflow === wf);
const allHealthy = () => Object.fromEntries(WATCH.map((w) => [w.workflow, [done(1, 'success', w.workflow === 'history-registry.yml' ? { display_title: 'history-registry full' } : {})]]));
const wfOf = (f) => f.dispatches.map((d) => d.workflow);

test('R-HB-09: every scheduled workflow that should keep running is watched, with thresholds from its schedule and timeout', () => {
  const table = Object.fromEntries(WATCH.map((w) => [w.workflow, [w.staleMin, w.stuckMin]]));
  assert.deepEqual(table, {
    'pump.yml': [15, 40], 'watchdog.yml': [40, 20], 'state-snapshot.yml': [90, 20], 'keep-forever.yml': [420, 80], 'offsite-backup.yml': [420, 80],
    'ledger.yml': [1560, 20], 'history-packages.yml': [1560, 180], 'history-popularity.yml': [1560, 90], 'history-registry.yml': [1560, 60],
    'perf-baselines.yml': [11520, 40], 'chaos-soak.yml': [11520, 120],
  });
  // Every workflow file with a schedule is either watched or listed here with the reason it is not.
  const wfDir = new URL('../../.github/workflows/', import.meta.url);
  const scheduled = ['chaos-soak', 'history-registry', 'history-popularity', 'history-packages', 'keep-forever', 'ledger', 'offsite-backup', 'perf-baselines', 'pump', 'watchdog', 'publish-results', 'state-snapshot'];
  const notWatched = { 'publish-results.yml': 'off by design (RESULTS_PUBLISH_ENABLED)' };
  for (const n of scheduled) {
    const text = readFileSync(new URL(n + '.yml', wfDir), 'utf8');
    assert.match(text, /^\s+schedule:/m, n);
    assert.ok(WATCH.some((w) => w.workflow === n + '.yml') || notWatched[n + '.yml'], n);
  }
  // stuckMin is twice the largest timeout-minutes of the workflow (perf: its measuring job's 20).
  for (const w of WATCH) {
    const text = readFileSync(new URL(w.workflow, wfDir), 'utf8');
    const max = Math.max(...[...text.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1])));
    // offsite's backup job is 40, its prune job 15: 80 is twice 40. ledger's longest is 10: 20.
    assert.ok(w.stuckMin >= 2 * max || w.workflow === 'pump.yml' || w.workflow === 'watchdog.yml', `${w.workflow}: stuckMin ${w.stuckMin} vs timeout ${max}`);
  }
});

test('R-HB-10: each workflow maps to the lane variable its own guard step reads', () => {
  const wfDir = new URL('../../.github/workflows/', import.meta.url);
  const expected = { 'pump.yml': 'LANE_PUMP_ENABLED', 'watchdog.yml': 'LANE_WATCHDOG_ENABLED', 'state-snapshot.yml': 'LANE_STATE_SNAPSHOT_ENABLED', 'keep-forever.yml': 'LANE_KEEP_FOREVER_ENABLED', 'offsite-backup.yml': 'LANE_OFFSITE_ENABLED', 'ledger.yml': 'LANE_LEDGER_ENABLED', 'history-packages.yml': 'LANE_HISTORY_PACKAGES_ENABLED', 'history-popularity.yml': 'LANE_HISTORY_POPULARITY_ENABLED', 'history-registry.yml': 'LANE_HISTORY_REGISTRY_ENABLED', 'perf-baselines.yml': 'LANE_PERF_ENABLED', 'chaos-soak.yml': null };
  for (const w of WATCH) {
    assert.equal(w.lane, expected[w.workflow], w.workflow);
    const text = readFileSync(new URL(w.workflow, wfDir), 'utf8');
    // The variable the workflow passes to its guard step (the first guard step's env).
    if (w.lane) assert.ok(text.includes(`${w.lane}: \${{ vars.${w.lane} }}`), `${w.workflow} does not read ${w.lane}`);
    else assert.ok(!/LANE_[A-Z_]+_ENABLED/.test(text) && !text.includes('guard.mjs'), `${w.workflow} has a guard now: give it a lane`);
  }
  // Behaviour: perf is held by LANE_PERF_ENABLED, not a name derived from its file.
  assert.match(pausedBy({ LANE_PERF_ENABLED: 'false' }, { lane: entry('perf-baselines.yml').lane, now: NOW }), /LANE_PERF_ENABLED/);
  assert.equal(pausedBy({ LANE_PERF_BASELINES_ENABLED: 'false' }, { lane: entry('perf-baselines.yml').lane, now: NOW }), null);
  assert.equal(pausedBy({ LANE_PUMP_ENABLED: 'false' }, { lane: null, now: NOW }), null, 'a workflow with no lane variable is held by LOOP_ENABLED and the pause only');
});

test('R-HB-11: per-entry decisions: a healthy loop dispatches nothing; each stale workflow is dispatched on its own limit', async () => {
  const f0 = fakeGitHub({ runs: allHealthy() });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f0 });
  assert.equal(f0.dispatches.length, 0);
  // Just inside and just past each limit.
  for (const w of WATCH) {
    if (w.workflow === 'history-registry.yml') continue; // see R-HB-12
    for (const [age, want] of [[w.staleMin - 1, false], [w.staleMin + 1, true]]) {
      const f = fakeGitHub({ runs: { ...allHealthy(), [w.workflow]: [done(age)] } });
      await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
      assert.deepEqual(wfOf(f), want ? [w.workflow] : [], `${w.workflow} at ${age} min`);
    }
  }
  // A paused lane holds only its own workflow.
  const f = fakeGitHub({ vars: { LANE_LEDGER_ENABLED: 'false' }, runs: { ...allHealthy(), 'ledger.yml': [done(3000)], 'keep-forever.yml': [done(3000)] } });
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
  assert.deepEqual(wfOf(f), ['keep-forever.yml']);
  assert.match(log.join('\n'), /ledger\.yml: not started: this lane is off \(LANE_LEDGER_ENABLED/);
  // LOOP_PAUSE_UNTIL holds all of them.
  const p = fakeGitHub({ vars: { LOOP_PAUSE_UNTIL: new Date(NOW + 3600_000).toISOString() }, runs: Object.fromEntries(WATCH.map((w) => [w.workflow, []])) });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: p });
  assert.equal(p.dispatches.length, 0);
  // LOOP_SLOTS=0 stops only the pump.
  const s = fakeGitHub({ vars: { LOOP_SLOTS: '0' }, runs: { ...allHealthy(), 'pump.yml': [done(300)], 'ledger.yml': [done(3000)] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: s });
  assert.deepEqual(wfOf(s), ['ledger.yml']);
});

test('R-HB-12: history-registry is watched for its full capture only: the 15-minute deltas do not hide a missing full run', async () => {
  const delta = (min) => done(min, 'success', { display_title: 'history-registry delta' });
  const full = (min, extra) => done(min, 'success', { display_title: 'history-registry full', ...extra });
  const base = { ...allHealthy() };
  // Deltas are all recent, the last full run is 30 h old: dispatch, with mode full.
  const f = fakeGitHub({ runs: { ...base, 'history-registry.yml': [delta(2), delta(17), delta(32), full(30 * HOUR)] } });
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
  assert.deepEqual(f.dispatches, [{ workflow: 'history-registry.yml', body: { ref: 'main', inputs: { mode: 'full' } } }]);
  assert.match(log.join('\n'), /history-registry\.yml \(full\): dispatched/);
  // A full run 20 h ago: ok, however old the deltas are.
  const g = fakeGitHub({ runs: { ...base, 'history-registry.yml': [delta(500), full(20 * HOUR)] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: g });
  assert.equal(g.dispatches.length, 0);
  // A full run queued or running makes it ok, a queued delta does not.
  const h = fakeGitHub({ runs: { ...base, 'history-registry.yml': [{ status: 'in_progress', display_title: 'history-registry full', created_at: ago(5) }, delta(1)] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: h });
  assert.equal(h.dispatches.length, 0);
  const i = fakeGitHub({ runs: { ...base, 'history-registry.yml': [{ status: 'in_progress', display_title: 'history-registry delta', created_at: ago(5) }, full(40 * HOUR)] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: i });
  assert.equal(i.dispatches.length, 1);
  // No full run in the list at all, or runs without a run name: dispatch.
  const j = fakeGitHub({ runs: { ...base, 'history-registry.yml': [delta(3), done(4, 'success', { display_title: 'history-registry' })] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: j });
  assert.equal(j.dispatches.length, 1);
  // It lists 100 runs, so a day of deltas still shows the full run.
  assert.ok(f.calls.length > 0 && entry('history-registry.yml').perPage === 100);
});

test('R-HB-13: inputs sent with a dispatch: mode full for the registry, stars (all on Monday UTC) for popularity, none elsewhere', async () => {
  const stale = Object.fromEntries(WATCH.map((w) => [w.workflow, []]));
  const f = fakeGitHub({ runs: stale });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f, watch: WATCH.slice(2).filter((w) => ['history-popularity.yml', 'history-registry.yml', 'ledger.yml'].includes(w.workflow)) });
  const by = Object.fromEntries(f.dispatches.map((d) => [d.workflow, d.body]));
  assert.deepEqual(by['history-registry.yml'], { ref: 'main', inputs: { mode: 'full' } });
  assert.equal(new Date(NOW).getUTCDay(), 3, 'the fixture day is a Wednesday');
  assert.deepEqual(by['history-popularity.yml'], { ref: 'main', inputs: { mode: 'stars' } });
  assert.deepEqual(by['ledger.yml'], { ref: 'main' });
  const mon = Date.parse('2026-11-23T17:00:00Z');
  const g = fakeGitHub({ runs: stale });
  await tick({ token: 't0ken', enabled: 'true', now: mon, fetch: g, watch: [entry('history-popularity.yml')] });
  assert.deepEqual(g.dispatches[0].body, { ref: 'main', inputs: { mode: 'all' } });
});

test('R-HB-14: at most MAX_DISPATCHES dispatches per tick; the rest wait for the next tick, in WATCH order', async () => {
  assert.equal(MAX_DISPATCHES, 4);
  const f = fakeGitHub({ runs: {} }); // every workflow has no runs: all 11 want a dispatch
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
  assert.deepEqual(wfOf(f), WATCH.slice(0, 4).map((w) => w.workflow));
  assert.equal(log.filter((l) => /already sent this tick/.test(l)).length, WATCH.length - 4);
  // The next tick, with those four now running, sends the next four.
  const runs = Object.fromEntries(WATCH.slice(0, 4).map((w) => [w.workflow, [{ status: 'queued', created_at: ago(1) }]]));
  const g = fakeGitHub({ runs });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: g });
  assert.deepEqual(wfOf(g), WATCH.slice(4, 8).map((w) => w.workflow));
});

test('R-HB-15: the variables are read in one call, and a tick stays far under the 50-subrequest limit even in the worst case', async () => {
  // Normal tick: 1 variables call + one runs call per workflow.
  const f = fakeGitHub({ runs: allHealthy() });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
  assert.equal(f.calls.filter((c) => c.includes('/variables')).length, 1);
  assert.equal(f.calls.length, 1 + WATCH.length);
  assert.ok(!f.calls.some((c) => /\/variables\//.test(c)), 'no per-variable call');
  // Worst case: 350 variables (4 pages), every workflow stale, every dispatch attempted.
  const w = fakeGitHub({ many: 350, runs: {} });
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: w });
  assert.equal(w.calls.filter((c) => c.includes('/variables')).length, 4);
  assert.equal(w.calls.length, 4 + WATCH.length + MAX_DISPATCHES);
  assert.ok(w.calls.length <= 40, String(w.calls.length));
  assert.equal(log.filter((l) => /: dispatched/.test(l)).length, 4);
  // Pagination: LOOP_ENABLED on the second page is still found; variables beyond five pages: nothing done.
  const p = fakeGitHub({ many: 150, runs: {} });
  assert.equal((await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: p })).filter((l) => /: dispatched/.test(l)).length, 4);
  const big = fakeGitHub({ many: 900, runs: {} });
  assert.match((await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: big })).join('\n'), /could not read the repository variables/);
  assert.equal(big.dispatches.length, 0);
  // Every call failing (a GitHub outage) makes one call only.
  const o = fakeGitHub({ fail: { 'actions/variables': { status: 500 } } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: o });
  assert.equal(o.calls.length, 1);
});

test('R-HB-16: a failing daily or weekly run is not re-dispatched in a loop; state-snapshot retries a failed run after 30 minutes', async () => {
  // Failed ledger run 2 h ago: newest run counts whatever its conclusion, so no retry until staleMin.
  const o = { staleMin: 1560, stuckMin: 20, now: NOW };
  assert.equal(decide([done(120, 'failure')], o).action, 'ok');
  assert.equal(decide([done(1561, 'failure')], o).action, 'dispatch');
  assert.equal(decide([done(120, 'timed_out'), done(1500, 'success')], o).action, 'ok');
  // With retryFailedAfterMin: 30.
  const s = { staleMin: 90, stuckMin: 20, retryFailedAfterMin: 30, now: NOW };
  assert.equal(decide([done(29, 'failure')], s).action, 'ok');
  const d = decide([done(31, 'failure')], s);
  assert.equal(d.action, 'dispatch'); assert.match(d.why, /failure 31 min ago \(retry after 30 min\)/);
  for (const c of ['timed_out', 'startup_failure', 'cancelled']) assert.equal(decide([done(31, c)], s).action, 'dispatch', c);
  assert.equal(decide([done(31, 'success')], s).action, 'ok', 'a good run is fine until staleMin');
  assert.equal(decide([done(31, 'skipped')], s).action, 'ok');
  assert.equal(decide([done(91, 'success')], s).action, 'dispatch');
  // Only the newest run decides: an old failure behind a newer success is ignored; a running retry is left alone.
  assert.equal(decide([done(10, 'success'), done(40, 'failure')], s).action, 'ok');
  assert.equal(decide([{ status: 'in_progress', created_at: ago(5), run_started_at: ago(4) }, done(40, 'failure')], s).action, 'ok');
  // Through tick: only state-snapshot has the entry.
  assert.equal(entry('state-snapshot.yml').retryFailedAfterMin, 30);
  assert.deepEqual(WATCH.filter((w) => w.retryFailedAfterMin !== undefined).map((w) => w.workflow), ['state-snapshot.yml']);
  const f = fakeGitHub({ runs: { ...allHealthy(), 'state-snapshot.yml': [done(35, 'failure')], 'ledger.yml': [done(35, 'failure')] } });
  await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: f });
  assert.deepEqual(wfOf(f), ['state-snapshot.yml']);
});
