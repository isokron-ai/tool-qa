// The lane health items (watchdog/lanes.mjs): do the lanes produce? R-WD-23..28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readState } from '../run.mjs';
import { LANE_THRESHOLDS, externalCheck, externalWorkflows, laneChecks, readLaneData, readExternalWorkflows } from '../lanes.mjs';
import { openState } from '../../state/db.mjs';
import { computeCoverage } from '../../state/coverage.mjs';
import { seedLaneState, tick } from '../../test/lib/lane-state.mjs';

const CFG = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows;
const TIERS = JSON.parse(readFileSync(new URL('../../pump/tiers.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-27T20:55:00Z');
const MIN = 60_000;

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-'));
  const db = openState(join(dir, 's.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The state of 27 Nov 20:55Z: 997 subjects with no sha and no changed_at, due 0, nothing dispatched for 7.5 hours, 370 live-probe results our tool's fault. */
function idle27Nov(db, o = {}) {
  seedLaneState(db, {
    now: NOW, subjects: 997, versioned: false, dispatchAgeMin: 450,
    lanes: {
      'live-probe': { ageMin: 443, n: 600, assessed: 230, tool: 370 },
      'scan-static': { ageMin: 925, n: 900, assessed: 880 },
      'meta-github': { ageMin: 1236, n: 997, assessed: 997 },
      'meta-registry': { ageMin: 1236, n: 997, assessed: 997 },
      'release-diff': { ageMin: 1236, n: 997, assessed: 997 },
    },
    ...o,
  });
  tick(db, NOW, { due: 0, dispatched: 0 });
}
const run = (db, extra = {}) => laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg: CFG, data: readLaneData(db, NOW, { cfg: CFG, tiers: TIERS }), tick: db.getKv('pump.last_tick'), coverage: computeCoverage(db, { tiers: TIERS, workflows: CFG, skipLanes: ['scan-deep', 'build-probe'] }), ...extra });
const by = (items, id) => items.find((i) => i.id === id);

test('R-WD-23: in the 27 Nov state (due 0, nothing dispatched for 7.5 hours, 997 null shas) the lane items are amber or red, not green', () => withDb((db) => {
  idle27Nov(db);
  const items = run(db);
  for (const id of ['lane-fresh:live-probe', 'lane-fresh:scan-static', 'lane-fresh:meta-github', 'pump-idle']) assert.equal(by(items, id).status, 'amber', `${id}: ${by(items, id).summary}`);
  assert.equal(by(items, 'lane-fresh:writecheck').status, 'amber');
  assert.equal(by(items, 'coverage:live-probe').status, 'red');
  assert.equal(by(items, 'tool-failures:live-probe').status, 'red');
  assert.ok(items.some((i) => i.status === 'red' || i.status === 'amber'));
}));

test('R-WD-23: the newest result per lane is judged whatever is due: due 0 does not excuse a lane that is 8 hours or 25 hours old', () => withDb((db) => {
  idle27Nov(db, { lanes: { 'live-probe': { ageMin: 480, n: 3, assessed: 3 }, 'scan-static': { ageMin: 25 * 60, n: 3, assessed: 3 } } });
  const items = run(db);
  assert.equal(by(items, 'lane-fresh:live-probe').status, 'amber');
  assert.equal(by(items, 'lane-fresh:scan-static').status, 'red');
  assert.match(by(items, 'lane-fresh:live-probe').summary, /due now: 0/);
}));

test('R-WD-23: a lane with no result is amber, red once its first dispatch is over 24 hours old; a fresh lane is green; a disabled lane or a pump that is off is off', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 3, dispatchAgeMin: 26 * 60, lanes: { 'scan-static': { ageMin: 5, n: 3, assessed: 3 } } });
  const items = run(db);
  assert.equal(by(items, 'lane-fresh:scan-static').status, 'green');
  assert.equal(by(items, 'lane-fresh:live-probe').status, 'red', by(items, 'lane-fresh:live-probe').summary);
  assert.equal(by(items, 'lane-fresh:scan-deep'), undefined, 'a disabled lane has no item');
  const off = run(db, { pumpOn: false });
  assert.equal(by(off, 'lane-fresh:scan-static').status, 'off');
  const held = run(db, { breakerTripped: true });
  assert.equal(by(held, 'lane-fresh:live-probe').status, 'off', 'held by the breaker');
}));

test('R-WD-24: nothing dispatched for over 3 hours while the frame is incomplete is amber, over 12 hours red, with the counts', () => withDb((db) => {
  idle27Nov(db, { dispatchAgeMin: 4 * 60 });
  let p = by(run(db), 'pump-idle');
  assert.equal(p.status, 'amber');
  assert.match(p.summary, /997 subjects with no sha or digest, 997 subjects with no changed_at/);
  assert.match(p.summary, /never assessed: .*live-probe 397/);
  assert.match(p.summary, /stale: /);
  db.raw.exec("UPDATE dispatches SET created = '2026-11-27T07:00:00.000Z'");
  p = by(run(db), 'pump-idle');
  assert.equal(p.status, 'red', p.summary);
}));

test('R-WD-24: stale subjects are counted by the tier cadence, and a result older than its tier\'s max age makes the frame incomplete on its own', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 4, dispatchAgeMin: 5 * 60, lanes: { 'scan-static': { ageMin: 31 * 24 * 60, n: 4, assessed: 4 } } });
  const items = run(db);
  const p = by(items, 'pump-idle');
  assert.equal(p.status, 'amber', p.summary);
  assert.match(p.summary, /scan-static 4/);
  assert.match(p.summary, /0 subjects with no sha or digest/);
}));

test('R-WD-24: the pump\'s tick with subjects due and none dispatched, nothing in flight, is amber; with work in flight, or a complete frame and a recent dispatch, green', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 3, dispatchAgeMin: 20 });
  tick(db, NOW, { due: 12, dispatched: 0 });
  assert.equal(by(run(db), 'pump-idle').status, 'amber');
  assert.match(by(run(db), 'pump-idle').summary, /12 subjects due and dispatched none/);
  db.raw.exec("UPDATE dispatches SET status = 'dispatched'");
  assert.equal(by(run(db), 'pump-idle').status, 'green');
  tick(db, NOW, { due: 0, dispatched: 0 });
  assert.equal(by(run(db), 'pump-idle').status, 'green');
  // a stale tick or a held pump says nothing
  tick(db, NOW - 2 * 3_600_000, { due: 12, dispatched: 0 });
  db.raw.exec("UPDATE dispatches SET status = 'done'");
  assert.equal(by(run(db), 'pump-idle').status, 'green');
}));

test('R-WD-25: coverage is the assessed share of the whole frame, not of the last 24 hours: a lane that skips most servers reads red', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 100, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 100, assessed: 40 }, 'live-probe': { ageMin: 5, n: 100, assessed: 70 }, 'meta-github': { ageMin: 5, n: 100, assessed: 100 }, 'meta-registry': { ageMin: 5, n: 100, assessed: 100 }, 'release-diff': { ageMin: 5, n: 100, assessed: 100 }, writecheck: { ageMin: 5, n: 1, assessed: 1 } } });
  const items = run(db);
  assert.equal(by(items, 'coverage:scan-static').status, 'red');
  assert.equal(by(items, 'coverage:live-probe').status, 'amber');
  assert.equal(by(items, 'coverage:meta-github').status, 'green');
  assert.match(by(items, 'coverage:scan-static').summary, /40 of 100 eligible subjects \(40%\)/);
}));

test('R-WD-26: our tool\'s failures show as absolute counts: 370 results now is amber even when the 24 hour share is low, red at half of the last 24 hours', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 997, dispatchAgeMin: 5, lanes: { 'live-probe': { ageMin: 5, n: 997, assessed: 600, tool: 370 } } });
  // all 997 results are within 24 hours: 370 of 997 = 37%
  let t = by(run(db), 'tool-failures:live-probe');
  assert.equal(t.status, 'amber', t.summary);
  assert.match(t.summary, /370 results now \(370 of 997 in the last 24 hours/);
  // the tool-fault results age out of the 24 hour window: the share is 0, the count now is still 370
  db.raw.exec("UPDATE results SET accepted_at = '2026-11-20T00:00:00.000Z' WHERE fault = 'tool'");
  t = by(run(db), 'tool-failures:live-probe');
  assert.equal(t.status, 'amber', t.summary);
  assert.match(t.summary, /370 results now \(0 of 627 in the last 24 hours/);
  // fewer than 50 now and a small share: green and quiet
  db.raw.exec("UPDATE results SET fault = NULL, coverage = 'subject' WHERE fault = 'tool' AND rowid % 10 <> 0");
  t = by(run(db), 'tool-failures:live-probe');
  assert.equal(t.status, 'green', t.summary);
  // half of the last 24 hours: red
  db.raw.exec("UPDATE results SET fault = 'tool', coverage = 'unassessed_tool', accepted_at = '2026-11-27T20:00:00.000Z' WHERE fault IS NULL AND rowid % 2 = 1");
  t = by(run(db), 'tool-failures:live-probe');
  assert.equal(t.status, 'red', t.summary);
}));

test('R-WD-27: open oracle disagreements are counted; one open over 14 days is amber', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 2, dispatchAgeMin: 5 });
  assert.equal(by(run(db), 'oracle-disagreements').status, 'green');
  assert.match(by(run(db), 'oracle-disagreements').summary, /^0 open oracle disagreements/);
  const ins = (s, at) => db.raw.prepare("INSERT INTO oracle_disagreements (subject, status, kinds, signature, opened_at, updated_at) VALUES (?, 'open', '[]', 'x', ?, ?)").run(s, at, at);
  ins('o/s0', '2026-11-26T00:00:00.000Z');
  assert.equal(by(run(db), 'oracle-disagreements').status, 'green');
  ins('o/s1', '2026-11-01T00:00:00.000Z');
  const d = by(run(db), 'oracle-disagreements');
  assert.equal(d.status, 'amber');
  assert.match(d.summary, /2 open oracle disagreements; the oldest has been open 27 days/);
}));

test('R-WD-27: ingest rejects for pins and schema are amber when each of the two newest worker runs had one, green with one run or none', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 2, dispatchAgeMin: 5 });
  const at = (m) => new Date(NOW - m * MIN).toISOString();
  const att = (run, reason, m, accepted = 0) => db.raw.prepare("INSERT INTO attempts (subject, holder, fence, run_id, run_key, received, accepted, reason, attempt_id) VALUES ('o/s0', 'h', 1, ?, 'k', ?, ?, ?, 'a')").run(run, at(m), accepted, reason);
  assert.equal(by(run(db), 'ingest-rejects').status, 'green');
  att('r1', 'pin_mismatch', 60);
  att('r2', null, 30, 1);
  assert.equal(by(run(db), 'ingest-rejects').status, 'green', 'the newest run had none');
  att('r2', 'manifest_invalid', 20);
  const r = by(run(db), 'ingest-rejects');
  assert.equal(r.status, 'amber', r.summary);
  assert.match(r.summary, /pin_mismatch 1/);
  assert.match(r.summary, /manifest_invalid 1/);
  att('r3', 'no_artifact', 5);
  assert.equal(by(run(db), 'ingest-rejects').status, 'green', 'a reject that is not ours to fix does not count');
}));

test('R-WD-28: the external workflows are the nightly conformance and each enabled lane\'s file; disabled for inactivity or missing is amber, disabled by hand off', async () => {
  const list = externalWorkflows(CFG, [{ repo: 'o/r', path: '.github/workflows/x.yml', why: 'extra' }]);
  const names = list.map((w) => `${w.repo}/${w.file}`);
  assert.ok(names.includes('isokron-ai/mcp-surface-corpus/conformance-nightly.yml'));
  assert.ok(names.includes('isokron-ai/mcp-check/live-probe.yml'));
  assert.ok(names.includes('isokron-ai/mcp-writecheck-action/corpus.yml'));
  assert.ok(names.includes('o/r/x.yml'));
  assert.ok(!names.some((n) => n.endsWith('/scan-deep.yml')), 'a disabled lane is not expected');
  const read = list.map((w) => ({ ...w, state: 'active' }));
  assert.equal(externalCheck(read).status, 'green');
  read[0].state = 'disabled_inactivity';
  const c = externalCheck(read);
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /conformance-nightly\.yml.*disabled by GitHub for inactivity/);
  assert.equal(externalCheck([{ ...list[0], state: 'not_found' }]).status, 'amber');
  assert.equal(externalCheck([{ ...list[0], state: 'disabled_manually' }]).status, 'off');
  const api = { request: async (_m, path) => (path.endsWith('/live-probe.yml') ? { status: 404 } : path.endsWith('/corpus.yml') ? Promise.reject(new Error('boom')) : { status: 200, data: { state: 'active' } }) };
  const got = await readExternalWorkflows(api, list);
  assert.equal(got.find((w) => w.file === 'live-probe.yml').state, 'not_found');
  assert.equal(got.find((w) => w.file === 'corpus.yml').state, 'error');
});

test('R-WD-28: the expected workflows list names the capture workflows (ledger, perf, chaos, publish)', () => {
  const expected = JSON.parse(readFileSync(new URL('../expected-workflows.json', import.meta.url), 'utf8')).workflows;
  for (const f of ['ledger.yml', 'perf-baselines.yml', 'chaos-soak.yml', 'publish-results.yml']) {
    assert.ok(expected.includes(`.github/workflows/${f}`), f);
    assert.ok(readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8').length > 0);
  }
});

test('R-WD-23: a state that cannot be read for the lanes is one amber item, never a failed run', () => {
  const items = laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg: CFG, data: null, tick: null });
  assert.deepEqual(items.map((i) => [i.id, i.status]), [['lane-health', 'amber']]);
  assert.ok(LANE_THRESHOLDS.freshAmberMs < LANE_THRESHOLDS.freshRedMs);
});

test('R-WD-31: the last dispatch is the newest one that started a run: a failed or expired dispatch is not work going out', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 3, dispatchAgeMin: 5 * 60 });
  const at = new Date(NOW - 10 * MIN).toISOString();
  for (const [i, status] of ['failed', 'expired', 'pending'].entries()) {
    db.raw.prepare("INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status) VALUES (?, ?, 'live-probe', 'o/r', 'f.yml', 'main', ?, ?, ?)").run(`x${i}`, `sx${i}`, at, at, status);
  }
  db.raw.exec("UPDATE subjects SET sha = NULL");
  const p = by(run(db), 'pump-idle');
  assert.equal(p.status, 'amber', p.summary);
  assert.match(p.summary, /nothing dispatched for 5\.0 hours/);
}));

test('R-WD-34: coverage:<lane> is the assessment number of state/coverage.mjs: the same value, with policy-excluded results out of the denominator; without it the item says so', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 10, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 10, assessed: 6 } } });
  // 2 of the 4 unassessed results are policy-excluded: they leave the denominator, as in computeCoverage
  db.raw.exec("UPDATE results SET coverage = 'excluded' WHERE workflow = 'scan-static' AND rowid IN (SELECT rowid FROM results WHERE workflow = 'scan-static' AND coverage <> 'assessed' LIMIT 2)");
  const cov = computeCoverage(db, { tiers: TIERS, workflows: CFG, skipLanes: ['scan-deep', 'build-probe'] });
  const L = cov.lanes.find((x) => x.id === 'scan-static');
  assert.equal(L.assessment, 0.75, '6 of 8 eligible');
  const item = by(laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg: CFG, data: readLaneData(db, NOW, { cfg: CFG, tiers: TIERS }), tick: null, coverage: cov }), 'coverage:scan-static');
  assert.equal(item.status, 'amber', item.summary);
  assert.match(item.summary, /6 of 8 eligible subjects \(75%\).*2 excluded/);
  // thresholds on the assessment number: under 80% amber, under 50% red, otherwise green
  for (const [a, status] of [[0.9, 'green'], [0.79, 'amber'], [0.49, 'red']]) {
    const c = { ...cov, lanes: cov.lanes.map((x) => (x.id === 'scan-static' ? { ...x, assessment: a } : x)) };
    assert.equal(by(laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg: CFG, data: readLaneData(db, NOW, { cfg: CFG, tiers: TIERS }), tick: null, coverage: c }), 'coverage:scan-static').status, status);
  }
  const none = laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg: CFG, data: readLaneData(db, NOW, { cfg: CFG, tiers: TIERS }), tick: null, coverage: null });
  assert.equal(by(none, 'coverage').status, 'amber');
  assert.equal(by(none, 'coverage:scan-static'), undefined);
}));

const cover = (db, cfg = CFG) => computeCoverage(db, { tiers: TIERS, workflows: cfg, skipLanes: ['scan-deep', 'build-probe'] });
const lanesOf = (db, coverage, cfg = CFG) => laneChecks({ now: NOW, slots: 4, pumpOn: true, cfg, data: readLaneData(db, NOW, { cfg, tiers: TIERS }), tick: null, coverage });

test('R-WD-35: an enabled lane with no coverage number is amber with the reason, not silence: all results excluded, or a lane the coverage block skips', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 4, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 4, assessed: 4 }, 'live-probe': { ageMin: 5, n: 4, assessed: 4 } } });
  db.raw.exec("UPDATE results SET coverage = 'excluded' WHERE workflow = 'scan-static'");
  const items = lanesOf(db, cover(db));
  const a = by(items, 'coverage:scan-static');
  assert.equal(a.status, 'amber', a.summary);
  assert.match(a.summary, /no assessment number: 0 eligible subjects of a frame of 4 \(4 excluded\)/);
  assert.equal(by(items, 'coverage:live-probe').status, 'green', 'a lane with a number is judged on it');
  // build-probe is enabled in this config but the coverage block skips it as not built
  const cfg = { ...CFG, 'build-probe': { ...CFG['build-probe'], enabled: true } };
  const b = by(lanesOf(db, cover(db, cfg), cfg), 'coverage:build-probe');
  assert.equal(b.status, 'amber', b.summary);
  assert.match(b.summary, /not in the coverage block/);
}));

test('R-WD-36: readState reads coverage against the config and tiers it is given, the one the lane checks read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-'));
  try {
    const file = join(dir, 's.sqlite');
    const db = openState(file);
    seedLaneState(db, { now: NOW, subjects: 4, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 4, assessed: 4 } } });
    db.close();
    const given = readState(file, NOW, { cfg: { 'scan-static': CFG['scan-static'] }, tiers: TIERS });
    assert.deepEqual(given.coverage.lanes.map((l) => l.id), ['scan-static'], 'the config given, not the pump\'s own');
    const own = readState(file, NOW);
    assert.ok(own.coverage === null || own.coverage.lanes.length > 1, 'with none given, the pump\'s own config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-WD-34: a tool-side skip holds the watchdog item\'s share down: the coverage item reads the same number as computeCoverage, and a lane that counted tool skips as assessed would read 100%', () => withDb((db) => {
  seedLaneState(db, { now: NOW, subjects: 10, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 10, assessed: 7, tool: 3 } } });
  const cov = cover(db);
  assert.equal(cov.lanes.find((l) => l.id === 'scan-static').assessment, 0.7);
  const c = by(lanesOf(db, cov), 'coverage:scan-static');
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /^7 of 10 eligible subjects \(70%\)/);
}));
