import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openState } from '../state/db.mjs';
import {
  computeCoverage, compactCoverage, coverageChanged, RULES, recordTruth, recordCoverageDay, frameOf, renderCoverageMarkdown, NOT_MEASURABLE, HISTORY_KEY, TRUTH_KEY,
} from '../state/coverage.mjs';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const tiers = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8'));
const workflows = { 'scan-static': { enabled: true }, 'live-probe': { enabled: true }, writecheck: { enabled: true } };

/** A state with `n` subjects per tier given, and a helper to add results. */
function world(spec = { 0: 2, 1: 2, 2: 4 }) {
  const db = openState(':memory:');
  for (const [tier, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) db.setSubjectVersion({ id: `t${tier}-${i}`, kind: 'repo', source: 'seed-v1', tier: Number(tier), name: `o/t${tier}-${i}`, now: NOW - 5 * 86_400_000 });
  }
  let seq = 0;
  const result = (subject, workflow, coverage, over = {}) => {
    const run_key = over.run_key ?? `rk${++seq}`;
    db.raw.prepare('INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage, skip_codes) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(run_key, subject, workflow, `a${seq}`, 'ok', over.at ?? new Date(NOW - 3_600_000).toISOString(), coverage, over.codes ? JSON.stringify(over.codes) : null);
    return run_key;
  };
  return { db, result };
}
const lane = (c, id) => c.lanes.find((l) => l.id === id);

test('R-COV-20: assessment coverage is assessed eligible over all eligible, per lane, from the newest result of each pair', () => {
  const { db, result } = world();
  result('t0-0', 'live-probe', 'assessed');
  result('t0-1', 'live-probe', 'unassessed_tool');
  result('t1-0', 'live-probe', 'assessed');
  result('t1-0', 'live-probe', 'unassessed_infra', { at: new Date(NOW - 60_000).toISOString() }); // newer result wins
  const L = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.equal(L.frame, 8);
  assert.equal(L.eligible, 8);
  assert.equal(L.assessed, 1);
  assert.equal(L.assessment, 0.125);
  assert.deepEqual(L.unassessed, { not_reached: 5, tool: 1, infra: 1, unsupported: 0, legacy: 0 });
});

test('R-COV-21: excluded results leave the denominators; a tool-side skip never does', () => {
  const { db, result } = world();
  result('t0-0', 'live-probe', 'excluded');
  result('t0-1', 'live-probe', 'unassessed_tool');
  result('t1-0', 'live-probe', 'unassessed_unknown');
  result('t1-1', 'live-probe', 'subject');
  const L = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.equal(L.excluded, 1);
  assert.equal(L.eligible, L.frame - 1);
  assert.equal(L.unassessed.tool, 2, 'tool and unknown faults stay eligible and unassessed');
  assert.equal(L.unassessed.unsupported, 1);
});

test('R-COV-22: with no correct or incorrect judgment, conditional, frame and gross coverage are not yet measurable, never 100%', () => {
  const { db, result } = world();
  for (const id of ['t0-0', 't0-1', 't1-0']) result(id, 'live-probe', 'assessed');
  const c = computeCoverage(db, { tiers, workflows });
  const L = lane(c, 'live-probe');
  assert.equal(L.assessed, 3);
  assert.equal(L.measurable, false);
  assert.equal(L.conditional, null);
  assert.equal(L.frame_coverage, null);
  assert.equal(L.gross, null);
  assert.equal(c.milestones.m3.met, null);
  const md = renderCoverageMarkdown(c).join('\n');
  assert.match(md, /not yet measurable/);
  assert.doesNotMatch(md, /100\.0%/);
  assert.equal(NOT_MEASURABLE, 'not_yet_measurable');
});

test('R-COV-23: correct and incorrect come from judgments of the newest result; frame and gross are lower bounds over the frame', () => {
  const { db, result } = world();
  const a = result('t0-0', 'live-probe', 'assessed');
  const b = result('t0-1', 'live-probe', 'assessed');
  result('t1-0', 'live-probe', 'assessed');
  const r = recordTruth(db, [
    { run_key: a, state: 'correct', source: 'qa_gate' },
    { subject: 't0-1', workflow: 'live-probe', state: 'incorrect', source: 'resolved_disagreement' },
  ], { now: NOW });
  assert.deepEqual(r, { recorded: 2, rejected: [] });
  assert.ok(b);
  const L = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.deepEqual([L.judged, L.correct, L.incorrect], [2, 1, 1]);
  assert.equal(L.conditional, 0.5);
  assert.equal(L.frame_coverage, 0.125); // 1 correct of 8 eligible
  assert.equal(L.gross, 0.125);
  assert.equal(L.assessment, 0.375);
  // a newer result for the pair has another run_key: the old judgment no longer counts for it
  result('t0-0', 'live-probe', 'assessed', { at: new Date(NOW - 1000).toISOString() });
  const L2 = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.deepEqual([L2.judged, L2.correct], [1, 0]);
});

test('R-COV-24: a judgment is accepted only for an assessed result and only with a known state and source', () => {
  const { db, result } = world();
  const a = result('t0-0', 'live-probe', 'unassessed_tool');
  const b = result('t0-1', 'live-probe', 'assessed');
  const out = recordTruth(db, [
    { run_key: a, state: 'correct', source: 'qa_gate' },
    { run_key: b, state: 'perfect', source: 'qa_gate' },
    { run_key: b, state: 'correct', source: 'someone' },
    { run_key: 'nope', state: 'correct', source: 'qa_gate' },
  ], { now: NOW });
  assert.equal(out.recorded, 0);
  assert.deepEqual(out.rejected.map((x) => x.index), [0, 1, 2, 3]);
  assert.equal(db.getKv(TRUTH_KEY), undefined, 'nothing written');
});

test('R-COV-25: the frame is read from state: its size follows the subjects, a retired or merged subject leaves it, and no count is fixed in code', () => {
  const { db } = world({ 2: 3 });
  assert.equal(computeCoverage(db, { tiers, workflows }).frame.size, 3);
  db.setSubjectVersion({ id: 'extra', kind: 'repo', source: 'discover-v1', tier: 2, now: NOW });
  const c = computeCoverage(db, { tiers, workflows });
  assert.equal(c.frame.size, 4);
  assert.equal(lane(c, 'writecheck').frame, 4);
  db.raw.prepare("UPDATE subjects SET retired_at = ? WHERE id = 'extra'").run(new Date(NOW).toISOString());
  db.raw.prepare("UPDATE subjects SET alias_of = 't2-0' WHERE id = 't2-1'").run();
  assert.equal(computeCoverage(db, { tiers, workflows }).frame.size, 2);
  assert.doesNotMatch(readFileSync(new URL('../state/coverage.mjs', import.meta.url), 'utf8'), /\b997\b/);
});

test('R-COV-26: the frame is dated and versioned: kv frame.current wins, else a derived version that changes with the member set', () => {
  const { db } = world({ 2: 3 });
  const raw = db.raw;
  const f1 = frameOf(raw, [{ id: 'a', first_seen: '2026-11-20T00:00:00Z' }, { id: 'b', first_seen: '2026-11-22T00:00:00Z' }]);
  assert.equal(f1.source, 'derived');
  assert.equal(f1.dated, '2026-11-22');
  assert.match(f1.version, /^derived-[0-9a-f]{8}$/);
  const f2 = frameOf(raw, [{ id: 'a', first_seen: '2026-11-20T00:00:00Z' }, { id: 'c', first_seen: '2026-11-22T00:00:00Z' }]);
  assert.notEqual(f1.version, f2.version);
  db.setKv('frame.current', { version: 'frame-2026-11-27', dated: '2026-11-27' }, { now: NOW });
  const set = computeCoverage(db, { tiers, workflows }).frame;
  assert.deepEqual(set, { version: 'frame-2026-11-27', dated: '2026-11-27', size: 3, source: 'state' });
  db.setKv('frame.current', { version: 'bad version!', dated: 'x' }, { now: NOW });
  assert.equal(computeCoverage(db, { tiers, workflows }).frame.source, 'derived', 'a malformed record is ignored');
});

test('R-COV-27: a lane counts a tier only where its cell is not never; a sample cell stays in the frame, so an unopened tier reads as low coverage', () => {
  const { db, result } = world({ 1: 2, 2: 4 });
  result('t1-0', 'writecheck', 'assessed');
  const L = lane(computeCoverage(db, { tiers, workflows }), 'writecheck');
  assert.equal(tiers.tiers.T2.writecheck.mode, 'sample');
  assert.equal(L.frame, 6);
  assert.equal(L.assessed, 1);
  assert.deepEqual(Object.keys(L.tiers), ['T1', 'T2']);
  assert.equal(L.tiers.T2.assessed, 0);
  const never = structuredClone(tiers);
  never.tiers.T2.writecheck.mode = 'never';
  assert.equal(lane(computeCoverage(db, { tiers: never, workflows }), 'writecheck').frame, 2);
});

test('R-COV-28: results from before the coverage column count as unassessed and are shown as legacy, never as assessed', () => {
  const { db, result } = world({ 0: 2 });
  result('t0-0', 'live-probe', null);
  const L = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.equal(L.assessed, 0);
  assert.equal(L.unassessed.legacy, 1);
});

test('R-COV-29: milestones: M1 counts pairs reached on enabled lanes, M3 is met only when every enabled lane is measurable and at least 0.98 on T0 to T2', () => {
  const { db, result } = world({ 0: 2 });
  const keys = [];
  for (const w of ['scan-static', 'live-probe', 'writecheck']) for (const id of ['t0-0', 't0-1']) keys.push([id, w, result(id, w, 'assessed')]);
  assert.deepEqual(computeCoverage(db, { tiers, workflows }).milestones.m1, { reached: 6, total: 6 });
  assert.equal(computeCoverage(db, { tiers, workflows }).milestones.m3.met, null);
  recordTruth(db, keys.map(([, , run_key]) => ({ run_key, state: 'correct', source: 'qa_gate' })), { now: NOW });
  assert.equal(computeCoverage(db, { tiers, workflows }).milestones.m3.met, true);
  recordTruth(db, [{ run_key: keys[0][2], state: 'incorrect', source: 'hand_review' }], { now: NOW });
  assert.equal(computeCoverage(db, { tiers, workflows }).milestones.m3.met, false);
  assert.equal(computeCoverage(db, { tiers, workflows }).milestones.m2.status, 'outside_state');
});

test('R-COV-30: the daily history keeps one compact entry per UTC day against the frame of that day', () => {
  const { db } = world({ 2: 2 });
  const c = computeCoverage(db, { tiers, workflows });
  assert.equal(recordCoverageDay(db, c, { now: NOW }), true);
  assert.equal(recordCoverageDay(db, c, { now: NOW + 3_600_000 }), false, 'same day: no second entry');
  db.setKv('frame.current', { version: 'frame-b', dated: '2026-11-28' }, { now: NOW });
  assert.equal(recordCoverageDay(db, computeCoverage(db, { tiers, workflows }), { now: NOW + 86_400_000 }), true);
  const days = db.getKv(HISTORY_KEY).days;
  assert.deepEqual(days.map((d) => d.day), ['2026-11-27', '2026-11-28']);
  assert.notEqual(days[0].frame.version, days[1].frame.version);
});

test('R-COV-31: mutation check: with a counting rule switched off, the tests of that rule fail', () => {
  const { db, result } = world();
  result('t0-0', 'live-probe', 'assessed');
  result('t0-1', 'live-probe', 'excluded');
  result('t1-0', 'live-probe', 'unassessed_tool');
  // The assertions of R-COV-21 and R-COV-22 as one function.
  const holds = (rules) => {
    const L = lane(computeCoverage(db, { tiers, workflows, rules }), 'live-probe');
    return { excluded: L.eligible === L.frame - 1, unmeasured: L.conditional === null && L.gross === null && L.frame_coverage === null, tool: L.unassessed.tool === 1 && L.excluded === 1 };
  };
  assert.deepEqual(holds(RULES), { excluded: true, unmeasured: true, tool: true });
  assert.equal(holds({ ...RULES, excludedLeaveDenominator: false }).excluded, false, 'excluded kept in the denominator is noticed');
  assert.equal(holds({ ...RULES, unmeasuredIsNull: false }).unmeasured, false, 'an unmeasured number reading 100% is noticed');
  assert.equal(holds({ ...RULES, toolSkipStaysEligible: false }).tool, false, 'a tool-side skip leaving the frame is noticed');
});

test('R-COV-32: the compact form keeps only counts and the four numbers, and is small', () => {
  const { db, result } = world();
  result('t0-0', 'live-probe', 'assessed');
  const compact = compactCoverage(computeCoverage(db, { tiers, workflows }));
  assert.deepEqual(Object.keys(compact), ['schema', 'frame', 'lanes', 'milestones']);
  assert.deepEqual(Object.keys(compact.lanes[0]), ['id', 'frame', 'excluded', 'assessed', 'judged', 'correct', 'incorrect', 'assessment', 'conditional', 'frame_coverage', 'gross']);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 2500);
});

test('R-COV-33: coverage-truth: the QA table makes judgments for matched subjects with an assessed result; a dry run writes nothing, --apply records them', async () => {
  const { main, parseCsv, judgmentsFromQa } = await import('../scripts/coverage-truth.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  const file = join(dir, 'state.sqlite');
  const csv = join(dir, 'qa.csv');
  const w = world({ 2: 4 });
  w.db.close();
  const db0 = openState(file);
  for (let i = 0; i < 4; i++) db0.setSubjectVersion({ id: `t2-${i}`, kind: 'repo', source: 'seed-v1', tier: 2, name: `Org/Repo${i}`, now: NOW });
  for (const [i, cov] of [[0, 'assessed'], [1, 'assessed'], [2, 'unassessed_tool']]) {
    db0.raw.prepare('INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(`rk-${i}`, `t2-${i}`, 'scan-static', `a${i}`, 'ok', new Date(NOW).toISOString(), cov);
  }
  db0.close();
  writeFileSync(csv, 'id,repo,truth_count,missed,phantom,error,qa_note\n'
    + 'a,org/repo0,10,0,0,,"fine, ""quoted"" note"\n'   // correct
    + 'b,org/repo1,10,2,0,,\n'                            // incorrect
    + 'c,org/repo2,10,0,0,,\n'                            // result not assessed: rejected
    + 'd,org/repo3,0,0,0,,\n'                             // no truth: skipped
    + 'e,org/nowhere,5,0,0,,\n'                           // no subject
    + 'f,org/repo3,5,0,0,boom,\n');                       // errored row: skipped
  assert.equal(parseCsv('a,b\n"x,1","y ""z"""\n')[0].b, 'y "z"');
  const lines = [];
  assert.equal(main(['--state', file, '--qa-csv', csv], (l) => lines.push(l)), 0);
  assert.match(lines[0], /would record 2 judgment\(s\); 1 rejected; 1 QA row\(s\) matched no subject/);
  assert.equal(openState(file).getKv(TRUTH_KEY), undefined, 'a dry run writes nothing');
  assert.equal(main(['--state', file, '--qa-csv', csv, '--apply'], (l) => lines.push(l)), 0);
  const kv = openState(file).getKv(TRUTH_KEY);
  assert.deepEqual(Object.entries(kv.entries).map(([k, v]) => [k, v.state, v.source]).sort(), [['rk-0', 'correct', 'qa_gate'], ['rk-1', 'incorrect', 'qa_gate']]);
  assert.equal(judgmentsFromQa([{ repo: 'x/y', truth_count: '3', missed: '0', phantom: '1', error: '' }], new Map([['x/y', 's']])).judgments[0].state, 'incorrect');
  assert.equal(main(['--state', file], () => {}), 2, 'no input is a usage error');
});

test('R-COV-48: the health issue is rewritten for a new frame, a lane, a number turning measurable, or a ratio moving 0.1 point, and not for counts that drift', () => {
  const lane = (o = {}) => ({ id: 'l', on: true, judged: 0, assessment: 0.5, conditional: null, frame_coverage: null, gross: null, ...o });
  const cov = (lanes, over = {}) => ({ frame: { version: 'f1' }, lanes, milestones: { m3: { met: null } }, ...over });
  const base = cov([lane()]);
  assert.equal(coverageChanged(base, structuredClone(base)), false);
  assert.equal(coverageChanged(base, cov([lane({ assessment: 0.5004, assessed: 999 })])), false, 'under 0.1 point');
  assert.equal(coverageChanged(base, cov([lane({ assessment: 0.501 })])), true, '0.1 point');
  assert.equal(coverageChanged(base, cov([lane()], { frame: { version: 'f2' } })), true, 'new frame');
  assert.equal(coverageChanged(base, cov([lane(), lane({ id: 'm' })])), true, 'a lane came');
  assert.equal(coverageChanged(base, cov([lane({ conditional: 0.9, judged: 3 })])), true, 'became measurable');
  assert.equal(coverageChanged(base, cov([lane()], { milestones: { m3: { met: false } } })), true, 'M3 flipped');
  assert.equal(coverageChanged(null, base), true);
  assert.equal(coverageChanged(null, null), false);
});

test('R-COV-50: the tool and policy counts are broken down by skip code, and no existing number changes', () => {
  const fill = (withCodes) => {
    const { db, result } = world();
    const c = (codes) => (withCodes ? { codes } : {});
    result('t0-0', 'live-probe', 'unassessed_tool', c([{ fault: 'tool', code: 'go_install_not_supported' }]));
    result('t0-1', 'live-probe', 'unassessed_tool', c([{ fault: 'tool', code: 'go_install_not_supported' }, { fault: 'policy', code: 'hosted_saas' }]));
    result('t1-0', 'live-probe', 'unassessed_unknown', c([{ fault: 'tool', code: 'mock_gap' }]));
    result('t1-1', 'live-probe', 'unassessed_tool'); // no code: uncoded
    result('t2-0', 'live-probe', 'excluded', c([{ fault: 'policy', code: 'hosted_saas' }]));
    result('t2-1', 'live-probe', 'excluded');
    result('t2-2', 'live-probe', 'unassessed_infra', c([{ fault: 'infra', code: 'rate_gh' }]));
    result('t2-3', 'live-probe', 'assessed');
    return lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  };
  const coded = fill(true);
  const plain = fill(false);
  const { unassessed_codes: codes, ...rest } = coded;
  const { unassessed_codes: none, ...restPlain } = plain;
  assert.deepEqual(rest, restPlain, 'every existing number is the same with and without codes');
  assert.deepEqual(codes, { tool: { go_install_not_supported: 2, mock_gap: 1, uncoded: 1 }, policy: { hosted_saas: 1, uncoded: 1 } });
  assert.deepEqual(none, { tool: { uncoded: 4 }, policy: { uncoded: 2 } }, 'old rows with no codes are all uncoded');
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(codes.tool), coded.unassessed.tool, 'the tool codes add up to the tool count');
  assert.equal(sum(codes.policy), coded.excluded, 'the policy codes add up to the excluded count');
  assert.equal(coded.unassessed.tool, 4);
});

test('R-COV-50: a state copy from before schema 13 (no skip_codes column) still reads, every code uncoded', () => {
  const { db, result } = world();
  result('t0-0', 'live-probe', 'unassessed_tool', { codes: [{ fault: 'tool', code: 'x_y' }] });
  db.raw.exec('ALTER TABLE results DROP COLUMN skip_codes');
  const L = lane(computeCoverage(db, { tiers, workflows }), 'live-probe');
  assert.deepEqual(L.unassessed_codes, { tool: { uncoded: 1 }, policy: {} });
  assert.equal(L.unassessed.tool, 1);
});
