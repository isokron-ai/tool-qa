import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, overallStatus } from '../checks.mjs';

const NOW = Date.parse('2026-03-02T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();

const run = (over = {}) => ({
  id: 1, event: 'schedule', status: 'completed', conclusion: 'success',
  created_at: ago(5 * MIN), run_started_at: ago(5 * MIN), html_url: 'https://github.test/run/1', ...over,
});

const freshArtifacts = () => [
  { name: 'registry-delta-20260302T114500Z', created_at: ago(15 * MIN), expired: false },
  { name: 'registry-full-20260302T031700Z', created_at: ago(9 * HOUR), expired: false },
  { name: 'history-packages-111', created_at: ago(8 * HOUR), expired: false },
  { name: 'history-popularity-222', created_at: ago(7 * HOUR), expired: false },
];

function base(over = {}) {
  return {
    now: NOW,
    slots: 5,
    lanes: {},
    runs: { 'pump.yml': [run()], 'history-registry.yml': [run()] },
    artifacts: freshArtifacts(),
    state: { openSlots: [], openDispatches: [], kv: {} },
    workflows: [],
    expected: ['.github/workflows/pump.yml', '.github/workflows/watchdog.yml'],
    ...over,
  };
}

const byId = (out) => Object.fromEntries(out.checks.map((c) => [c.id, c]));

test('a healthy loop is all green and asks for nothing', () => {
  const out = evaluate(base());
  const c = byId(out);
  assert.equal(c.pump.status, 'green');
  assert.equal(c['history-registry-delta'].status, 'green');
  assert.equal(c['history-registry-full'].status, 'green');
  assert.equal(c['history-packages'].status, 'green');
  assert.equal(c['history-popularity'].status, 'green');
  assert.equal(c.slots.status, 'green');
  assert.equal(overallStatus(out.checks), 'green');
  assert.deepEqual(out.actions, { dispatchPump: false, enableWorkflows: [] });
});

test('a pump that has not started for 20 minutes is dispatched; after 40 it is red', () => {
  let out = evaluate(base({ runs: { 'pump.yml': [run({ run_started_at: ago(25 * MIN), created_at: ago(25 * MIN) })] } }));
  assert.equal(byId(out).pump.status, 'amber');
  assert.equal(out.actions.dispatchPump, true);
  out = evaluate(base({ runs: { 'pump.yml': [run({ run_started_at: ago(45 * MIN), created_at: ago(45 * MIN) })] } }));
  assert.equal(byId(out).pump.status, 'red');
  assert.equal(out.actions.dispatchPump, true);
  out = evaluate(base({ runs: { 'pump.yml': [] } }));
  assert.equal(byId(out).pump.status, 'red');
  assert.equal(out.actions.dispatchPump, true);
});

test('a pump run in progress counts as alive', () => {
  const out = evaluate(base({ runs: { 'pump.yml': [run({ status: 'in_progress', conclusion: null, run_started_at: ago(14 * MIN) }), run({ run_started_at: ago(50 * MIN) })] } }));
  assert.equal(byId(out).pump.status, 'green');
  assert.equal(out.actions.dispatchPump, false);
});

test('with LOOP_SLOTS=0 or the pump lane off, the pump check is off and nothing is dispatched', () => {
  for (const over of [{ slots: 0 }, { lanes: { pump: false } }]) {
    const out = evaluate(base({ ...over, runs: { 'pump.yml': [] } }));
    assert.equal(byId(out).pump.status, 'off');
    assert.equal(out.actions.dispatchPump, false);
  }
});

test('history freshness: green, amber, red by artifact age', () => {
  const arts = (deltaAge, fullAge) => [
    { name: 'registry-delta-a', created_at: ago(deltaAge), expired: false },
    { name: 'registry-full-a', created_at: ago(fullAge), expired: false },
    { name: 'history-packages-1', created_at: ago(fullAge), expired: false },
    { name: 'history-popularity-1', created_at: ago(fullAge), expired: false },
  ];
  let c = byId(evaluate(base({ artifacts: arts(60 * MIN, 30 * HOUR) })));
  assert.equal(c['history-registry-delta'].status, 'amber');
  assert.equal(c['history-registry-full'].status, 'amber');
  assert.equal(c['history-packages'].status, 'amber');
  c = byId(evaluate(base({ artifacts: arts(100 * MIN, 51 * HOUR) })));
  assert.equal(c['history-registry-delta'].status, 'red');
  assert.equal(c['history-registry-full'].status, 'red');
  assert.equal(c['history-popularity'].status, 'red');
  c = byId(evaluate(base({ artifacts: [] })));
  assert.equal(c['history-registry-delta'].status, 'red');
  assert.match(c['history-registry-delta'].summary, /no registry-delta/);
});

test('the newest artifact wins and expired ones are ignored', () => {
  const c = byId(evaluate(base({
    artifacts: [
      { name: 'registry-delta-old', created_at: ago(5 * HOUR), expired: false },
      { name: 'registry-delta-new', created_at: ago(10 * MIN), expired: true },
      ...freshArtifacts().filter((a) => !a.name.startsWith('registry-delta')),
    ],
  })));
  assert.equal(c['history-registry-delta'].status, 'red');
});

test('a lane switched off shows as off, not red', () => {
  const c = byId(evaluate(base({ lanes: { 'history-registry': false }, artifacts: [] })));
  assert.equal(c['history-registry-delta'].status, 'off');
  assert.equal(c['history-registry-full'].status, 'off');
  assert.equal(c['history-packages'].status, 'red');
});

test('slots or dispatches stuck past expiry plus 15 minutes are red', () => {
  let c = byId(evaluate(base({ state: { openSlots: [{ slot: 0, holder_run: 'a', expires: ago(10 * MIN) }], openDispatches: [], kv: {} } })));
  assert.equal(c.slots.status, 'green', 'within the grace period');
  c = byId(evaluate(base({
    state: {
      openSlots: [{ slot: 0, holder_run: 'a', expires: ago(20 * MIN) }],
      openDispatches: [{ attempt_id: 'a', workflow: 'live-probe', shard_id: 's', expires: ago(20 * MIN) }],
      kv: {},
    },
  })));
  assert.equal(c.slots.status, 'red');
  assert.match(c.slots.summary, /1 slot/);
  assert.equal(c.dispatches.status, 'red');
});

test('no state yet is amber', () => {
  const c = byId(evaluate(base({ state: null })));
  assert.equal(c.state.status, 'amber');
});

test('the latest failed scheduled or dispatched run is red; cancelled runs are skipped', () => {
  const runs = {
    'pump.yml': [run({ status: 'completed', conclusion: 'cancelled' }), run({ conclusion: 'failure', html_url: 'https://github.test/run/9' })],
    'history-registry.yml': [run({ conclusion: 'success' }), run({ conclusion: 'failure' })],
    'history-packages.yml': [run({ event: 'push', conclusion: 'failure' })],
  };
  const c = byId(evaluate(base({ runs })));
  assert.equal(c['run:pump'].status, 'red');
  assert.equal(c['run:pump'].link, 'https://github.test/run/9');
  assert.equal(c['run:history-registry'].status, 'green');
  assert.equal(c['run:history-packages'], undefined, 'push runs are not loop runs');
});

test('a failed successor dispatch recorded by the pump is red', () => {
  const c = byId(evaluate(base({ state: { openSlots: [], openDispatches: [], kv: { 'pump.successor': { ok: false, error: 'HTTP 502', at: ago(3 * MIN) } } } })));
  assert.equal(c['pump-successor'].status, 'red');
  assert.match(c['pump-successor'].summary, /502/);
  assert.equal(c['pump-successor'].at, ago(3 * MIN));
});

test('workflows disabled for inactivity are re-enabled if expected; hand-disabled ones are left alone', () => {
  const out = evaluate(base({
    workflows: [
      { id: 11, path: '.github/workflows/pump.yml', state: 'disabled_inactivity' },
      { id: 12, path: '.github/workflows/watchdog.yml', state: 'disabled_manually' },
      { id: 13, path: '.github/workflows/other.yml', state: 'disabled_inactivity' },
    ],
  }));
  assert.deepEqual(out.actions.enableWorkflows, [{ id: 11, path: '.github/workflows/pump.yml' }]);
  const c = byId(out);
  assert.equal(c['workflow:pump.yml'].status, 'amber');
  assert.equal(c['workflow:watchdog.yml'].status, 'off');
  assert.equal(c['workflow:other.yml'], undefined);
});

test('overall status: red beats amber beats green beats off', () => {
  assert.equal(overallStatus([{ status: 'off' }]), 'off');
  assert.equal(overallStatus([{ status: 'off' }, { status: 'green' }]), 'green');
  assert.equal(overallStatus([{ status: 'amber' }, { status: 'green' }]), 'amber');
  assert.equal(overallStatus([{ status: 'amber' }, { status: 'red' }]), 'red');
  assert.equal(overallStatus([]), 'off');
});

test('R-SUB-11: a seed the pump could not load is red on the health issue, with why; a loaded seed is green', () => {
  const failed = byId(evaluate(base({ state: { openSlots: [], openDispatches: [], kv: { 'pump.subjects': { ok: false, summary: 'seed not loaded, subjects left as they were: seed: size (the number of subjects) is required', at: ago(2 * MIN) } } } })));
  assert.equal(failed.subjects.status, 'red');
  assert.match(failed.subjects.summary, /could not load the seed subjects .*size \(the number of subjects\) is required/);
  assert.equal(failed.subjects.at, ago(2 * MIN));
  const fine = byId(evaluate(base({ state: { openSlots: [], openDispatches: [], kv: { 'pump.subjects': { ok: true, summary: 'seed-v1 already loaded (997 subjects)', at: ago(MIN) } } } })));
  assert.equal(fine.subjects.status, 'green');
  // No record yet (a pump older than this check): no item.
  assert.equal(byId(evaluate(base({ state: { openSlots: [], openDispatches: [], kv: {} } }))).subjects, undefined);
});

test('R-SNAP-09: state-snapshot.yml is a loop workflow: its failed run is red and its lane switch is read', () => {
  const failed = evaluate(base({ runs: { 'pump.yml': [run()], 'state-snapshot.yml': [run({ conclusion: 'failure' })] } }));
  assert.equal(byId(failed)['run:state-snapshot'].status, 'red');
  const off = evaluate(base({ lanes: { 'state-snapshot': false }, snapshot: { manifest: null } }));
  assert.equal(byId(off)['state-snapshot'].status, 'off');
  const none = evaluate(base({ snapshot: { manifest: null } }));
  assert.equal(byId(none)['state-snapshot'].status, 'amber');
  assert.equal(byId(evaluate(base()))['state-snapshot'], undefined, 'no item when nothing was read');
});


test('R-CHAOS-04: api-budget is amber while a saved rate-limit block holds or the latest tick stopped on the budget, and absent otherwise', () => {
  const st = (kv) => ({ openSlots: [], openDispatches: [], kv });
  let c = byId(evaluate(base({ state: st({ 'pump.api_budget': { blocked: { core: NOW + 20 * MIN } } }) })));
  assert.equal(c['api-budget'].status, 'amber');
  assert.match(c['api-budget'].summary, /held until/);
  c = byId(evaluate(base({ state: st({ 'pump.last_tick': { at: ago(5 * MIN), stopped: 'budget', ingest: null } }) })));
  assert.equal(c['api-budget'].status, 'amber');
  c = byId(evaluate(base({ state: st({ 'pump.last_tick': { at: ago(5 * MIN), stopped: null, ingest: { stopped: 'budget' } } }) })));
  assert.equal(c['api-budget'].status, 'amber');
  // A block that has passed, an old tick, or a tick stopped for another reason: no item.
  for (const kv of [
    { 'pump.api_budget': { blocked: { core: NOW - MIN } } },
    { 'pump.last_tick': { at: ago(45 * MIN), stopped: 'budget' } },
    { 'pump.last_tick': { at: ago(5 * MIN), stopped: 'deadline', ingest: { stopped: 'deadline' } } },
    {},
  ]) {
    assert.equal(byId(evaluate(base({ state: st(kv) })))['api-budget'], undefined, JSON.stringify(kv));
  }
});

test('R-WD-14: the health issue shows a failed keep-forever file whose gap marker artifact is missing as red, and the marker present as green', () => {
  const seal = { at: ago(2 * HOUR), sealed: 4, failures: { compress: 0, keep: 1 }, streak: 0, keep_gaps: [{ attempt: 'att-9-0', run: '55-1', at: ago(3 * HOUR) }] };
  const withSeal = (artifacts) => evaluate(base({ artifacts: [...freshArtifacts(), ...artifacts], state: { openSlots: [], openDispatches: [], kv: { 'retention.seal': seal } } }));
  const lost = byId(withSeal([]))['keep-markers'];
  assert.equal(lost.status, 'red');
  assert.match(lost.summary, /att-9-0 \(run 55-1\)/);
  assert.equal(overallStatus(withSeal([]).checks), 'red');
  assert.equal(byId(withSeal([{ name: 'ingest-keepgap-55-1', created_at: ago(2 * HOUR), expired: false }]))['keep-markers'].status, 'green');
  assert.equal(byId(evaluate(base({ state: null })))['keep-markers'], undefined, 'no state asset, no item: it is judged with the state');
  assert.equal(byId(evaluate(base({ state: { openSlots: [], openDispatches: [], kv: {} } })))['keep-markers'].status, 'green');
});

test('live-snapshot: off unless the switch is exactly true; green, amber over 20 minutes, red over 40 or when the scan blocked', () => {
  const kv = (v) => ({ openSlots: [], openDispatches: [], kv: { 'live.last_upload': v } });
  const item = (liveSwitch, v) => byId(evaluate(base({ liveSwitch, state: kv(v) })))['live-snapshot'];
  const okAgo = (ms) => ({ ok: true, at: ago(ms), last_ok_at: ago(ms), seq: 5, bytes: 100 });
  for (const sw of [undefined, '', 'false', 'TRUE', '1']) assert.equal(item(sw, okAgo(5 * MIN)).status, 'off', String(sw));
  assert.equal(item('true', okAgo(5 * MIN)).status, 'green');
  assert.equal(item('true', okAgo(25 * MIN)).status, 'amber');
  assert.equal(item('true', okAgo(45 * MIN)).status, 'red');
  assert.equal(item('true', { ok: false, blocked: 'scan', at: ago(MIN), last_ok_at: ago(2 * MIN) }).status, 'red', 'blocked by the scan is red at once');
  assert.equal(item('true', { ok: false, error: 'put', at: ago(MIN), last_ok_at: ago(5 * MIN) }).status, 'green', 'a failed attempt after a recent good one is not yet a problem');
  assert.equal(item('true', { ok: false, error: 'put', at: ago(MIN), last_ok_at: ago(30 * MIN) }).status, 'amber');
  assert.equal(item('true', null).status, 'amber', 'on, nothing uploaded yet');
  assert.match(item('true', { ok: false, blocked: 'scan', at: ago(MIN) }).summary, /scan/);
});
