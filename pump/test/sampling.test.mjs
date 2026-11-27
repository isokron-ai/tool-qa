import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isoWeek, weekStartMs, sampleScore, parseRate, parseCap, samplingFromEnv, pickedSet, createCellSampler, samplingHooks, DEFAULT_CAP,
} from '../sampling.mjs';
import { computeDue, NO_HOOKS, runKey, runKeyFields } from '../due.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;
const MON = Date.parse('2026-11-23T00:00:00Z'); // a Monday, ISO week 2026-W48
const ids = (n, p = 's') => Array.from({ length: n }, (_, i) => `${p}${i}`);
const population = (n, tier = 2) => () => ids(n).map((id) => ({ id, tier }));
const ctxOf = (now, last = null) => ({ now, cell: { mode: 'sample' }, last });

/** What the sampler must satisfy; empty when it does. The mutation test feeds it broken scorers. */
function problems(score, pick = pickedSet) {
  const out = [];
  const all = ids(4000);
  const w = '2026-W48';
  if (pick({ ids: all, workflow: 'writecheck', week: w, rate: 0, cap: 1e9, score }).size !== 0) out.push('rate 0 picked something');
  const n = pick({ ids: all, workflow: 'writecheck', week: w, rate: 0.1, cap: 1e9, score }).size;
  if (Math.abs(n / all.length - 0.1) > 0.02) out.push(`rate 0.1 picked ${n / all.length}`);
  const a = [...pickedSet({ ids: all, workflow: 'writecheck', week: '2026-W48', rate: 0.1, cap: 1e9, score })].sort().join();
  const b = [...pickedSet({ ids: all, workflow: 'writecheck', week: '2026-W49', rate: 0.1, cap: 1e9, score })].sort().join();
  if (a === b) out.push('the pick does not move with the week');
  const c = [...pickedSet({ ids: all, workflow: 'build-probe', week: '2026-W48', rate: 0.1, cap: 1e9, score })].sort().join();
  if (a === c) out.push('the pick does not depend on the workflow');
  if (pick({ ids: all, workflow: 'writecheck', week: w, rate: 1, cap: 7, score }).size > 7) out.push('the cap is not kept');
  return out;
}

test('R-SAMP-01: rate 0 (the shipped state) selects nothing, however many subjects and weeks', () => {
  const hooks = samplingHooks({ env: {}, population: population(1000) });
  for (let wk = 0; wk < 10; wk++) {
    for (const id of ids(1000)) assert.equal(hooks.cellSample({ id, tier: 2 }, 'writecheck', ctxOf(MON + wk * 7 * DAY)), false);
  }
  const zero = samplingHooks({ env: { SAMPLE_RATE_T2: '0' }, population: population(1000) });
  assert.equal(ids(1000).some((id) => zero.cellSample({ id, tier: 2 }, 'writecheck', ctxOf(MON))), false);
});

test('R-SAMP-02: rate r selects about r of the subjects', () => {
  for (const r of [0.05, 0.1, 0.5]) {
    const hook = createCellSampler({ rates: { 2: r }, caps: { 2: 1e9 }, population: population(5000) });
    const n = ids(5000).filter((id) => hook({ id, tier: 2 }, 'writecheck', ctxOf(MON))).length;
    assert.ok(Math.abs(n / 5000 - r) < 0.02, `rate ${r}: picked ${n / 5000}`);
  }
  const all = createCellSampler({ rates: { 2: 1 }, caps: { 2: 1e9 }, population: population(50) });
  assert.equal(ids(50).filter((id) => all({ id, tier: 2 }, 'writecheck', ctxOf(MON))).length, 50);
});

test('R-SAMP-03: the selection is stable inside a week and moves with the week', () => {
  const mk = () => createCellSampler({ rates: { 2: 0.2 }, caps: { 2: 1e9 }, population: population(500) });
  const pick = (hook, t) => ids(500).filter((id) => hook({ id, tier: 2 }, 'writecheck', ctxOf(t))).join();
  const first = pick(mk(), MON);
  assert.equal(pick(mk(), MON + 6 * DAY + 23 * 3_600_000), first, 'Sunday evening, new process');
  const same = mk();
  assert.equal(pick(same, MON + 2 * DAY), first);
  assert.equal(pick(same, MON + 4 * DAY), first);
  assert.notEqual(pick(same, MON + 7 * DAY), first, 'the next week is another sample');
  assert.equal(sampleScore('a', 'writecheck', '2026-W48'), sampleScore('a', 'writecheck', '2026-W48'));
});

test('R-SAMP-04: the per-tier cap keeps the lowest scores, and a tier only reads its own rate and cap', () => {
  const week = isoWeek(MON);
  const full = pickedSet({ ids: ids(1000), workflow: 'writecheck', week, rate: 0.5, cap: 1e9 });
  const capped = pickedSet({ ids: ids(1000), workflow: 'writecheck', week, rate: 0.5, cap: 10 });
  assert.equal(capped.size, 10);
  const lowest = [...full].sort((a, b) => sampleScore(a, 'writecheck', week) - sampleScore(b, 'writecheck', week)).slice(0, 10);
  assert.deepEqual([...capped].sort(), lowest.sort());
  assert.equal(pickedSet({ ids: ids(1000), workflow: 'writecheck', week, rate: 1, cap: 0 }).size, 0, 'cap 0 picks nothing');
  const hook = createCellSampler({ rates: { 2: 1 }, caps: { 2: 1e9 }, population: () => [...ids(20).map((id) => ({ id, tier: 2 })), ...ids(20, 't3-').map((id) => ({ id, tier: 3 }))] });
  assert.equal(hook({ id: 't3-1', tier: 3 }, 'writecheck', ctxOf(MON)), false, 'T3 has rate 0 while T2 is 1');
  assert.equal(hook({ id: 's1', tier: 2 }, 'writecheck', ctxOf(MON)), true);
});

test('R-SAMP-05: a picked pair is due once a week: a result accepted this week is the sample', () => {
  const hook = createCellSampler({ rates: { 2: 1 }, caps: { 2: 1e9 }, population: population(5) });
  const s = { id: 's1', tier: 2 };
  assert.equal(hook(s, 'writecheck', ctxOf(MON + 3 * DAY, { accepted_at: new Date(MON + 1 * DAY).toISOString() })), false);
  assert.equal(hook(s, 'writecheck', ctxOf(MON + 3 * DAY, { accepted_at: new Date(MON - 1 * DAY).toISOString() })), true);
  assert.equal(hook(s, 'writecheck', ctxOf(MON + 3 * DAY, null)), true);
  assert.equal(hook(s, 'writecheck', { now: MON, cell: { mode: 'always' }, last: null }), false, 'only sample cells');
});

const wf = { enabled: true, repo: 'isokron-ai/mcp-check', file: 'writecheck.yml', ref: 'main', shard_size: 5, setup_minutes: 4, minutes_per_subject: 2, slots_max: 4,
  versions: { tool: { 'mcp-check': '1.0.0' }, oracle: {}, probe: {} }, image_digest: 'sha256:' + '1'.repeat(64), settings_state: 'default' };
const dueInput = (hooks, subjects) => ({ now: MON + DAY, subjects, workflows: { writecheck: wf }, tiers, lastResults: new Map(), resultKeys: new Set(), inFlight: new Set(), parked: new Set(), hooks });

test('R-SAMP-06: T2 writecheck (mode sample) is due only when the sampler picks it; T1 (mode always) is not touched', () => {
  const subjects = [...ids(40).map((id) => ({ id, tier: 2, sha: 'a'.repeat(40) })), { id: 'one', tier: 1, sha: 'a'.repeat(40) }];
  const t2 = (due) => due.filter((d) => d.tier === 2);
  assert.equal(t2(computeDue(dueInput(NO_HOOKS, subjects))).length, 0, 'before: nothing');
  const off = samplingHooks({ env: {}, population: () => subjects });
  assert.equal(t2(computeDue(dueInput(off, subjects))).length, 0, 'rate 0: nothing');
  const on = samplingHooks({ env: { SAMPLE_RATE_T2: '1', SAMPLE_CAP_T2: '100' }, population: () => subjects });
  const due = computeDue(dueInput(on, subjects));
  assert.equal(t2(due).length, 40);
  assert.ok(t2(due).every((d) => d.reasons.join() === 'cell_sample'));
  assert.deepEqual(due.filter((d) => d.tier === 1).map((d) => d.reasons.join()), ['first_sight'], 'T1 is due as before, not as a sample');
});

test('R-SAMP-07: unreadable rates are 0 (a rate over 1, hex or exponent forms too); unreadable caps are the default', () => {
  for (const bad of [undefined, null, '', ' ', 'abc', '-1', '0', 'NaN', 'Infinity-', '0,5']) assert.equal(parseRate(bad), 0, String(bad));
  assert.equal(parseRate('0.25'), 0.25);
  for (const bad of ['7', '10', '1.5', '1.0001', '0x10', '1e0', '5e-1', '+0.5', '0.5.1', '1/2', '50%']) assert.equal(parseRate(bad), 0, `${bad} must not open a tier`);
  for (const [good, v] of [['1', 1], ['1.0', 1], ['0', 0], ['.5', 0.5], ['0.05', 0.05], [' 0.25 ', 0.25]]) assert.equal(parseRate(good), v, good);
  for (const bad of [undefined, '', 'x', '-3', '2.5', '1e3']) assert.equal(parseCap(bad), DEFAULT_CAP, String(bad));
  assert.equal(parseCap('0'), 0);
  assert.equal(parseCap('12'), 12);
  const { rates, caps } = samplingFromEnv({ SAMPLE_RATE_T2: '0.1', SAMPLE_CAP_T2: '30' });
  assert.deepEqual([rates[2], rates[3], caps[2], caps[3]], [0.1, 0, 30, DEFAULT_CAP]);
});

test('R-SAMP-08: ISO weeks turn on Monday UTC, including the 53-week year 2026', () => {
  assert.equal(isoWeek(Date.parse('2026-11-23T00:00:00Z')), '2026-W48');
  assert.equal(isoWeek(Date.parse('2026-11-22T23:59:59Z')), '2026-W47');
  assert.equal(isoWeek(Date.parse('2026-12-31T12:00:00Z')), '2026-W53');
  assert.equal(isoWeek(Date.parse('2027-01-01T12:00:00Z')), '2026-W53');
  assert.equal(isoWeek(Date.parse('2027-01-04T00:00:00Z')), '2027-W01');
  assert.equal(weekStartMs(Date.parse('2026-11-26T15:00:00Z')), MON);
});

test('R-SAMP-09: mutation check: a sampler that ignores the week, the workflow, the rate or the cap fails the property checks', () => {
  assert.deepEqual(problems(sampleScore), []);
  const mutants = {
    'ignores the week': (id, wf) => sampleScore(id, wf, 'fixed'),
    'ignores the workflow': (id, _wf, w) => sampleScore(id, 'x', w),
    'constant score': () => 0.05,
    'scores near 0': (id, wf, w) => sampleScore(id, wf, w) / 100,
  };
  for (const [name, score] of Object.entries(mutants)) assert.notDeepEqual(problems(score), [], `mutant "${name}" went unnoticed`);
  assert.notDeepEqual(problems(sampleScore, (o) => pickedSet({ ...o, cap: 1e9 })), [], 'mutant "ignores the cap" went unnoticed');
  assert.notDeepEqual(problems(sampleScore, (o) => pickedSet({ ...o, rate: o.rate > 0 ? 1 : 0 })), [], 'mutant "ignores the rate" went unnoticed');
  assert.notDeepEqual(problems(sampleScore, (o) => pickedSet({ ...o, rate: 0.5 })), [], 'mutant "rate 0 still picks" went unnoticed');
});

test('R-SAMP-10: pump.yml passes every tier variable and sets no default, so the shipped rate is 0', () => {
  const yml = readFileSync(new URL('../../.github/workflows/pump.yml', import.meta.url), 'utf8');
  for (const t of [1, 2, 3, 4]) {
    assert.match(yml, new RegExp(`SAMPLE_RATE_T${t}: \\$\\{\\{ vars\\.SAMPLE_RATE_T${t} \\}\\}`));
    assert.match(yml, new RegExp(`SAMPLE_CAP_T${t}: \\$\\{\\{ vars\\.SAMPLE_CAP_T${t} \\}\\}`));
  }
  assert.doesNotMatch(yml, /SAMPLE_RATE_T\d: '?[0-9.]/);
  assert.ok(tiers.priority.cell_sample > 0);
});

test('R-SAMP-11: the sampling hook is never consulted for a pair that is mode never, on a disabled workflow, or parked', () => {
  const subjects = ids(3).map((id) => ({ id, tier: 2, sha: 'a'.repeat(40) }));
  const asked = [];
  const hooks = { ...NO_HOOKS, cellSample: (s, name) => { asked.push(`${s.id}:${name}`); return true; } };
  const never = structuredClone(tiers);
  never.tiers.T2.writecheck.mode = 'never';
  computeDue({ ...dueInput(hooks, subjects), tiers: never });
  assert.deepEqual(asked, [], 'mode never');
  computeDue({ ...dueInput(hooks, subjects), workflows: { writecheck: { ...wf, enabled: false } } });
  assert.deepEqual(asked, [], 'disabled workflow');
  const parked = new Set(subjects.map((s) => runKey(runKeyFields(s, 'writecheck', wf))));
  computeDue({ ...dueInput(hooks, subjects), parked });
  assert.deepEqual(asked, [], 'parked run keys');
  const due = computeDue(dueInput(hooks, subjects));
  assert.equal(asked.length, 3, 'consulted when the pair is eligible');
  assert.equal(due.length, 3);
  const withInFlight = computeDue({ ...dueInput(hooks, subjects), inFlight: new Set(subjects.map((s) => `${s.id}\u0000writecheck`)) });
  assert.equal(withInFlight.length, 0);
  assert.equal(asked.length, 3, 'not consulted for in-flight pairs either');
});
