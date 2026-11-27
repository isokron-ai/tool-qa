import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../checks.mjs';
import { t0LaneChecks } from '../t0-lanes.mjs';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const HOUR = 3_600_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const SUB = 'isokron-ai/mcp-write-safety.defect-matrix';
const subj = (over = {}) => ({ last_result_at: ago(5 * HOUR), failed_at: null, failed_attempt: null, failed: false, ...over });
const rec = ({ on = true, on_since = ago(100 * HOUR), subjects = { [SUB]: subj() } } = {}) => ({ on, on_since, subjects, failed: Object.values(subjects).some((x) => x.failed) });
const one = (r) => t0LaneChecks({ now: NOW, kv: { at: ago(0), lanes: { 't0-defects': r } } })[0];

test('R-CTL-07: a lane with a recent accepted result is green', () => {
  const c = one(rec());
  assert.equal(c.id, 't0:t0-defects');
  assert.equal(c.status, 'green');
});

test('R-CTL-07: amber when the lane has produced no accepted result in 36 hours, green just inside it', () => {
  assert.equal(one(rec({ subjects: { [SUB]: subj({ last_result_at: ago(35 * HOUR) }) } })).status, 'green');
  const c = one(rec({ subjects: { [SUB]: subj({ last_result_at: ago(37 * HOUR) }) } }));
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /36 hour/);
});

test('R-CTL-07: a lane switched on and still waiting for its first result is green for 36 hours, then amber', () => {
  assert.equal(one(rec({ on_since: ago(10 * HOUR), subjects: { [SUB]: subj({ last_result_at: null }) } })).status, 'green');
  const c = one(rec({ on_since: ago(40 * HOUR), subjects: { [SUB]: subj({ last_result_at: null }) } }));
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /no result since the lane was switched on/);
});

test('R-CTL-08: red when a seeded defect was missed, and red wins over a stale result', () => {
  const c = one(rec({ subjects: { [SUB]: subj({ failed: true, failed_at: ago(2 * HOUR), failed_attempt: 'att-1', last_result_at: ago(60 * HOUR) }) } }));
  assert.equal(c.status, 'red');
  assert.match(c.summary, /seeded defect was missed/);
  assert.match(c.summary, /our own tool, not the subject/);
});

test('R-CTL-08: a switched-off lane is off, whatever its last results say', () => {
  assert.equal(one(rec({ on: false, subjects: { [SUB]: subj({ failed: true }) } })).status, 'off');
});

test('R-CTL-07: with no record the lane is amber; with no control lanes there are no items; a bad record never throws', () => {
  assert.equal(t0LaneChecks({ now: NOW, kv: { lanes: { 't0-self': null } } })[0].status, 'amber');
  assert.deepEqual(t0LaneChecks({ now: NOW, kv: null }), []);
  assert.deepEqual(t0LaneChecks({ now: NOW, kv: { lanes: 5 } }), []);
  assert.equal(t0LaneChecks({ now: NOW, kv: { lanes: { a: 'x' } } })[0].status, 'amber');
});

test('R-CTL-09: evaluate() carries the t0 items from the state kv, one per lane, and none without the record', () => {
  const base = { now: NOW, slots: 5, state: { openSlots: [], openDispatches: [], kv: {} } };
  assert.equal(evaluate(base).checks.filter((c) => c.id.startsWith('t0:')).length, 0);
  const kv = { 't0.lanes': { at: ago(0), lanes: { 't0-defects': rec(), 't0-self': rec({ subjects: { [SUB]: subj({ failed: true, failed_at: ago(HOUR) }) } }) } } };
  const items = evaluate({ ...base, state: { ...base.state, kv } }).checks.filter((c) => c.id.startsWith('t0:'));
  assert.deepEqual(items.map((c) => [c.id, c.status]), [['t0:t0-defects', 'green'], ['t0:t0-self', 'red']]);
});

test('R-CTL-12: per subject: one failing subject is red although another subject has a fresh result; one stale subject is amber although another is fresh', () => {
  const two = (a, b) => one(rec({ subjects: { 'o/r.a': subj(a), 'o/r.b': subj(b) } }));
  const red = two({}, { failed: true, failed_at: ago(HOUR), failed_attempt: 'x', last_result_at: ago(HOUR * 30) });
  assert.equal(red.status, 'red');
  assert.match(red.summary, /for r\.b/);
  const fresh = two({ last_result_at: ago(HOUR) }, { failed: true, failed_at: ago(2 * HOUR), last_result_at: ago(3 * HOUR) });
  assert.equal(fresh.status, 'red', 'the other subject\'s newer result does not clear it');
  const amber = two({ last_result_at: ago(HOUR) }, { last_result_at: ago(40 * HOUR) });
  assert.equal(amber.status, 'amber');
  assert.match(amber.summary, /r\.b/);
  assert.equal(two({ last_result_at: ago(HOUR) }, { last_result_at: ago(2 * HOUR) }).status, 'green');
});

import { laneChecks } from '../lanes.mjs';
import { applyControlSwitches } from '../../pump/controls.mjs';
import { readFileSync } from 'node:fs';

const CFG = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows;

test('R-CTL-13: a switched-off control lane is not an enabled lane to lane-fresh; an on lane judges its daily result at 36 h amber and 72 h red, not 6 h and 24 h', () => {
  const data = (ageH) => ({ newest: { 't0-defects': ageH === null ? undefined : { at: ago(ageH * HOUR), n: 3 } }, oldestDispatch: {}, lanes: {}, subjects: {} });
  const run = (cfg, ageH) => laneChecks({ now: NOW, slots: 5, pumpOn: true, cfg, data: data(ageH), tick: null }).find((i) => i.id === 'lane-fresh:t0-defects');
  const off = applyControlSwitches(CFG, {});
  assert.equal(run(off, 30), undefined, 'switched off: no lane-fresh item at all');
  const on = applyControlSwitches(CFG, { LANE_T0_DEFECTS_ENABLED: 'true' });
  assert.equal(run(on, 30).status, 'green', '30 hours is fine for a daily lane');
  assert.equal(run(on, 37).status, 'amber');
  assert.equal(run(on, 73).status, 'red');
  assert.equal(run({ ...on, 'scan-static': on['scan-static'] }, 30).status, 'green');
});

test('R-CTL-15: a subject whose newest result only skipped on infrastructure is amber after 36 hours, and the item says so', () => {
  const c = one(rec({ subjects: { [SUB]: subj({ last_result_at: ago(50 * HOUR), infra_only_since: ago(2 * HOUR) }) } }));
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /only results that skipped on infrastructure/);
  assert.equal(one(rec({ subjects: { [SUB]: subj({ last_result_at: ago(5 * HOUR), infra_only_since: ago(1 * HOUR) }) } })).status, 'green', 'a measured result inside 36 hours still counts');
  const never = one(rec({ on_since: ago(50 * HOUR), subjects: { [SUB]: subj({ last_result_at: null, infra_only_since: ago(HOUR) }) } }));
  assert.equal(never.status, 'amber');
});
