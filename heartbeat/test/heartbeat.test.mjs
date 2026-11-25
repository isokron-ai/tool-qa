import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, tick, pausedBy, parseIsoTime, parseSlots, WATCH } from '../worker.mjs';
import { evaluateGuard } from '../../scripts/guard.mjs';

const NOW = Date.parse('2026-11-25T17:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
function fakeGitHub({ loop = 'true', vars = {}, runs = {}, fail = {} } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(init.method + ' ' + u.pathname);
    assert.equal(init.headers.authorization, 'Bearer t0ken');
    for (const [k, s] of Object.entries(fail)) if (u.pathname.includes(k) && (s.method || 'GET') === init.method) { if (s.throw) throw new TypeError('fetch failed'); return res(s.status, {}); }
    const vm = /\/variables\/([A-Z_]+)$/.exec(u.pathname);
    if (vm) { const val = vm[1] === 'LOOP_ENABLED' ? loop : vars[vm[1]]; return val === undefined ? res(404, {}) : res(200, { name: vm[1], value: val }); }
    const m = /\/workflows\/([^/]+)\/(runs|dispatches)$/.exec(u.pathname);
    if (m && m[2] === 'runs') return res(200, { workflow_runs: runs[m[1]] || [] });
    if (m && m[2] === 'dispatches') { assert.deepEqual(JSON.parse(init.body), { ref: 'main' }); return res(204, null); }
    throw new Error('unexpected ' + url);
  };
  f.calls = calls; return f;
}
const run = (o) => tick({ token: 't0ken', enabled: 'true', now: NOW, ...o });

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
  assert.deepEqual(WATCH.map((w) => w.workflow), ['pump.yml', 'watchdog.yml']);
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
  const a = fakeGitHub({ fail: { LOOP_ENABLED: { status: 502 } }, runs: { 'pump.yml': [] } });
  assert.match((await run({ fetch: a })).join('\n'), /could not read LOOP_ENABLED \(HTTP 502\)/);
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
  const u = fakeGitHub({ fail: { LOOP_PAUSE_UNTIL: { status: 401 } }, runs: STALE });
  assert.match((await run({ fetch: u })).join('\n'), /could not read LOOP_PAUSE_UNTIL \(HTTP 401\)/);
  assert.ok(!u.calls.some((c) => c.startsWith('POST')));
  // A 401 on the kill switch itself: nothing done. A 404 on it is "not true": off.
  const k = fakeGitHub({ fail: { LOOP_ENABLED: { status: 401 } }, runs: STALE });
  assert.match((await run({ fetch: k })).join('\n'), /could not read LOOP_ENABLED \(HTTP 401\)/);
  const n = fakeGitHub({ fail: { LOOP_ENABLED: { status: 404 } }, runs: STALE });
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
    const mine = pausedBy({ ...vars, LOOP_SLOTS: undefined }, { job: 'pump', usesSlots: false, now: NOW });
    assert.equal(mine === null, guard.proceed, JSON.stringify(vars));
    assert.equal(pausedBy(vars, { job: 'pump', usesSlots: true, now: NOW }) === null, guard.proceed && (vars.LOOP_SLOTS === undefined || evaluateGuard({ LOOP_ENABLED: 'true', ...vars }, { job: 'pump', needsSlots: true, now: NOW }).proceed), JSON.stringify(vars));
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
