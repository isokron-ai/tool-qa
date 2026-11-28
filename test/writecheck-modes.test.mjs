// Writecheck modes: the write_backend facts in the state (schema v13), the
// pump's routing by mode (pump/modes.mjs: due list, run_keys, homogeneous
// shards, the dispatch inputs), coverage per mode and the watchdog item.
// docs/INTERFACES.md, "Writecheck modes".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openState, SCHEMA_VERSION } from '../state/db.mjs';
import { backendFacts, backendFactsFromFiles, MAX_ENV_NAMES } from '../state/backends.mjs';
import { applyModeSwitches, modeFor, modeInputs, modeProblems, modeSettings, modesOn, shardKey } from '../pump/modes.mjs';
import { computeDue, loadDueInputs, workflowProblems } from '../pump/due.mjs';
import { planShards, runTick } from '../pump/tick.mjs';
import { computeCoverage, renderCoverageMarkdown, RULES } from '../state/coverage.mjs';
import { laneChecks, readLaneData, LANE_THRESHOLDS } from '../watchdog/lanes.mjs';

const tiers = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8'));
const shipped = JSON.parse(readFileSync(new URL('../pump/workflows.json', import.meta.url), 'utf8')).workflows;
const NOW = Date.parse('2026-11-28T12:00:00Z');
const HOUR = 3_600_000;
const ON = { LANE_WRITECHECK_FULL_ENABLED: 'true', LANE_WRITECHECK_MIN_ENABLED: 'true' };

const PG = { class: 'local_full', backend: { id: 'postgres', kind: 'sql' }, stand_in: { id: 'postgres', product: 'PostgreSQL', fidelity: 'real' }, spec_url: null, spec_format: null, env_names: ['DATABASE_URL', 'PORT'], base_url_env: ['DATABASE_URL'], confidence: 'high', reason: null };
const GH = { class: 'mock_min', backend: { id: 'github', kind: 'hosted_api' }, stand_in: null, spec_url: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json', spec_format: 'openapi3', env_names: ['GITHUB_TOKEN'], base_url_env: [], confidence: 'high', reason: null };
const NONE = { class: 'none', reason: 'hosted_without_spec', backend: { id: 'telegram', kind: 'hosted_api' }, stand_in: null, spec_url: null, env_names: [], base_url_env: [], confidence: 'medium' };

/** writecheck as shipped, trimmed to what the due list needs, with only this lane. */
const writecheck = (over = {}) => ({ ...shipped.writecheck, enabled: true, slots_max: 10, shard_size: 3, ...over });

function world(classes) {
  const db = openState(':memory:');
  Object.keys(classes).forEach((id) => db.setSubjectVersion({ id, kind: 'github', source: 'seed-v1', tier: 1, sha: 'c'.repeat(40), name: id, now: NOW - 10 * 86_400_000 }));
  for (const [id, v] of Object.entries(classes)) if (v) db.noteWriteBackend(id, `rk-${id}`, backendFacts(v), { now: NOW - HOUR, observedAt: NOW - HOUR });
  return db;
}

// ---------------------------------------------------------------- the state

test('R-WB-10: schema 13 keeps each subject\'s write_backend facts; a malformed value is dropped field by field; a late result changes nothing', () => {
  assert.equal(SCHEMA_VERSION, 13);
  const db = openState(':memory:');
  assert.equal(db.schemaVersion(), 13);
  const f = backendFacts({ ...PG, env_names: ['DATABASE_URL', 'bad name', 'PORT', ...Array.from({ length: 40 }, (_, i) => `X_${i}`)], backend: { id: 'Post Gres!', kind: 'sql' }, stand_in: { id: 'postgres' } });
  assert.equal(f.backend, null, 'an id outside the contract is not kept');
  assert.equal(f.mode, 'full');
  assert.equal(f.env_names[0], 'DATABASE_URL');
  assert.ok(f.env_names.length <= MAX_ENV_NAMES && !f.env_names.includes('bad name'));
  assert.equal(backendFacts({ class: 'maybe' }), null);
  assert.equal(backendFacts({ ...GH, spec_url: 'http://insecure.example/spec' }).spec_url, null, 'only an https URL with no query goes to a worker');
  assert.equal(backendFacts({ ...GH, spec_url: 'https://x.example/s.json?token=1' }).spec_url, null);
  db.setSubjectVersion({ id: 'o/a', kind: 'github', source: 'seed-v1', tier: 1, now: NOW });
  assert.equal(db.noteWriteBackend('o/a', 'rk1', backendFacts(PG), { now: NOW, observedAt: NOW }), true);
  assert.equal(db.noteWriteBackend('o/a', 'rk0', backendFacts(GH), { now: NOW, observedAt: NOW - HOUR }), false, 'observed before the stored facts');
  assert.deepEqual(db.listWriteBackends().map((r) => [r.subject, r.class, r.stand_in, r.env_names]), [['o/a', 'local_full', 'postgres', ['DATABASE_URL', 'PORT']]]);
  const files = new Map([['observations/meta-backend.ndjson', Buffer.from(`${JSON.stringify({ field: 'write_backend', value: GH })}\n`)]]);
  assert.equal(backendFactsFromFiles('meta-backend', files).backend, 'github');
  assert.equal(backendFactsFromFiles('writecheck', files), null, 'only the meta-backend lane classifies');
  assert.equal(backendFactsFromFiles('meta-backend', new Map([['observations/meta-backend.ndjson', Buffer.from('{"field":"write_backend","value":null,"why":"x"}\n')]])), null);
});

// ---------------------------------------------------------------- the pump

test('R-WB-11: the shipped writecheck lane declares both modes, each behind its own switch, unmatched subjects as before', () => {
  assert.deepEqual(modeProblems(shipped), []);
  assert.deepEqual(workflowProblems(shipped), []);
  assert.deepEqual(shipped.writecheck.modes, { fact: 'write_backend', unmatched: 'default', list: { full: { class: 'local_full', switch: 'LANE_WRITECHECK_FULL_ENABLED' }, min: { class: 'mock_min', switch: 'LANE_WRITECHECK_MIN_ENABLED' } } });
  const pump = readFileSync(new URL('../.github/workflows/pump.yml', import.meta.url), 'utf8');
  for (const v of ['LANE_WRITECHECK_FULL_ENABLED', 'LANE_WRITECHECK_MIN_ENABLED']) assert.match(pump, new RegExp(`${v}: \\$\\{\\{ vars\\.${v} \\}\\}`));
  assert.match(modeProblems({ w: { modes: { fact: 'write_backend', unmatched: 'default', list: { full: { class: 'mock_min', switch: 'LANE_X_ENABLED' } } } } }).join(), /takes class local_full/);
  assert.match(modeProblems({ w: { modes: { fact: 'write_backend', unmatched: 'maybe', list: { full: { class: 'local_full', switch: 'X' } } } } }).join(), /unmatched[\s\S]*switch/);
  // Off unless exactly "true".
  for (const v of [undefined, '', 'TRUE', '1', 'yes']) assert.equal(modesOn(applyModeSwitches(shipped, { LANE_WRITECHECK_FULL_ENABLED: v }).writecheck), false, String(v));
  assert.deepEqual(Object.keys(applyModeSwitches(shipped, { LANE_WRITECHECK_MIN_ENABLED: 'true' }).writecheck.active_modes), ['min']);
  assert.equal(applyModeSwitches(shipped, ON).scan_static, undefined);
  assert.equal(applyModeSwitches(shipped, ON)['scan-static'], shipped['scan-static'], 'a lane without modes is passed as it is');
});

test('R-WB-11: with every mode off nothing changes: the same run_keys, no mode on any due pair', () => {
  const db = world({ 'o/pg': PG, 'o/gh': GH, 'o/no': NONE, 'o/un': null });
  const off = applyModeSwitches({ writecheck: writecheck() }, {});
  const plain = { writecheck: (() => { const { modes, ...rest } = writecheck(); void modes; return rest; })() };
  const a = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows: off }));
  const b = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows: plain }));
  assert.deepEqual(a.map((d) => [d.subject, d.run_key]), b.map((d) => [d.subject, d.run_key]));
  assert.ok(a.every((d) => !('mode' in d)));
});

test('R-WB-11: with the modes on, local_full goes to full and mock_min to min under their own run_keys; none and unclassified go as before (or not at all with skip)', () => {
  const db = world({ 'o/pg': PG, 'o/gh': GH, 'o/no': NONE, 'o/un': null });
  const wfs = applyModeSwitches({ writecheck: writecheck() }, ON);
  const due = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows: wfs }));
  const by = Object.fromEntries(due.map((d) => [d.subject, d]));
  assert.equal(by['o/pg'].mode.mode, 'full');
  assert.equal(by['o/pg'].mode.stand_in, 'postgres');
  assert.equal(by['o/pg'].fields.settings_state, 'default+mode=full+backend=postgres');
  assert.equal(by['o/gh'].mode.mode, 'min');
  assert.equal(by['o/gh'].fields.settings_state, 'default+mode=min+backend=github');
  assert.equal(by['o/no'].mode, undefined);
  assert.equal(by['o/no'].fields.settings_state, 'default');
  assert.equal(by['o/un'].mode, undefined);
  const onlyFull = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows: applyModeSwitches({ writecheck: writecheck() }, { LANE_WRITECHECK_FULL_ENABLED: 'true' }) }));
  assert.equal(onlyFull.find((d) => d.subject === 'o/gh').mode, undefined, 'min off: the mock_min subject goes as before');
  const skip = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows: applyModeSwitches({ writecheck: writecheck({ modes: { ...shipped.writecheck.modes, unmatched: 'skip' } }) }, ON) }));
  assert.deepEqual(skip.map((d) => d.subject).sort(), ['o/gh', 'o/pg']);
  // A mode without its routing fact (no stand-in for full) is not a mode: the subject goes as before.
  assert.equal(modeFor(wfs.writecheck, { ...backendFacts(PG), stand_in: null }), null);
  assert.equal(modeSettings(wfs.writecheck, null), 'default');
});

test('R-WB-11: shards are homogeneous per mode and backend, and a mode shard carries the INTERFACES.md inputs with env_names aligned to items', async () => {
  const classes = { 'o/pg1': PG, 'o/pg2': PG, 'o/gh1': GH, 'o/rd': { ...PG, backend: { id: 'redis', kind: 'kv' }, stand_in: { id: 'redis', product: 'Redis', fidelity: 'real' }, env_names: ['REDIS_URL'], base_url_env: ['REDIS_URL'] }, 'o/un': null };
  const db = world(classes);
  const workflows = applyModeSwitches({ writecheck: writecheck() }, ON);
  const due = computeDue(loadDueInputs(db, { now: NOW, tiers, workflows }));
  const shards = planShards(due, workflows);
  for (const s of shards) assert.equal(new Set(s.items.map((it) => shardKey(it.mode))).size, 1, 'one mode, backend and stand-in or spec per shard');
  assert.equal(shards.length, 4, 'postgres, redis, github, and the default shard');
  const calls = [];
  let n = 0;
  const dispatcher = {
    async dispatch(req) { calls.push(req); return { runId: 1000 + calls.length, runUrl: null, correlatedBy: 'response' }; },
    async resolveRef() { return 'f'.repeat(40); },
    async resolveCommit({ sha }) { return sha.padEnd(40, '0'); },
  };
  const s = await runTick({ db, now: () => NOW, config: { tiers, workflows }, workerSlots: 10, dispatcher, newId: () => `att-${++n}` });
  assert.equal(s.dispatched, 4);
  const full = calls.find((c) => c.inputs.backend === 'postgres');
  const items = JSON.parse(full.inputs.items);
  assert.deepEqual([full.inputs.mode, full.inputs.backend_kind, full.inputs.stand_in, full.inputs.spec_url, full.inputs.spec_format], ['full', 'sql', 'postgres', '', '']);
  assert.deepEqual(JSON.parse(full.inputs.env_names), items.map(() => ['DATABASE_URL', 'PORT']));
  const min = calls.find((c) => c.inputs.mode === 'min');
  assert.deepEqual([min.inputs.backend, min.inputs.stand_in, min.inputs.spec_url, min.inputs.spec_format], ['github', '', GH.spec_url, 'openapi3']);
  const plain = calls.find((c) => !('mode' in c.inputs));
  assert.ok(plain, 'unclassified subjects are sent as before');
  for (const k of ['mode', 'backend', 'backend_kind', 'stand_in', 'spec_url', 'spec_format', 'env_names']) assert.equal(k in plain.inputs, false, `${k}: never sent to a worker outside a mode`);
  assert.ok(Object.keys(full.inputs).length <= 25, 'GitHub takes at most 25 workflow_dispatch inputs');
  assert.throws(() => modeInputs([{ mode: modeFor(workflows.writecheck, backendFacts(PG)) }, { mode: modeFor(workflows.writecheck, backendFacts(GH)) }]), /homogeneous/);
});

// ---------------------------------------------------------------- coverage

function coverageWorld() {
  const db = world({ 'o/pg': PG, 'o/gh': GH, 'o/no1': NONE, 'o/no2': { ...NONE, reason: 'no_write_tools_seen' }, 'o/un': null });
  const add = (subject, settings, coverage) => {
    const rk = `r-${subject}-${settings}`;
    db.raw.prepare('INSERT INTO run_keys (run_key, subject, workflow, fields, first_seen) VALUES (?, ?, ?, ?, ?)').run(rk, subject, 'writecheck', JSON.stringify({ settings_state: settings }), new Date(NOW).toISOString());
    db.raw.prepare('INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, accepted_at, coverage) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(rk, subject, 'writecheck', 'a', 'ok', new Date(NOW - HOUR).toISOString(), coverage);
  };
  add('o/pg', 'default+mode=full+backend=postgres', 'assessed');
  add('o/gh', 'default', 'assessed');
  add('o/no1', 'default', 'subject');
  return db;
}

test('R-WB-12: writecheck\'s denominator is the servers classified local_full or mock_min, per mode; none is counted apart as not testable, never as a failure', () => {
  const db = coverageWorld();
  const workflows = { writecheck: { ...shipped.writecheck, enabled: true } };
  const c = computeCoverage(db, { tiers, workflows, resultModes: true });
  const L = c.lanes.find((l) => l.id === 'writecheck');
  assert.equal(L.by_backend, true);
  assert.equal(L.frame, 2, 'o/pg and o/gh only');
  assert.equal(L.eligible, 2);
  assert.equal(L.assessed, 2);
  assert.deepEqual(L.not_testable, { total: 2, reasons: { hosted_without_spec: 1, no_write_tools_seen: 1 } });
  assert.equal(L.unclassified, 1);
  assert.deepEqual([L.modes.full.frame, L.modes.full.assessed_in_mode, L.modes.full.assessment], [1, 1, 1]);
  assert.deepEqual([L.modes.min.frame, L.modes.min.assessed, L.modes.min.assessed_in_mode, L.modes.min.assessment], [1, 1, 0, 0], 'a default-mode result is not a min-mode one');
  const md = renderCoverageMarkdown(c).join('\n');
  assert.match(md, /2 servers are not testable here[\s\S]*never counted as failures; 1 are not classified yet/);
  // Without resultModes (the live snapshot) run_keys are not read, and the in-mode counts say so.
  const live = computeCoverage(db, { tiers, workflows }).lanes.find((l) => l.id === 'writecheck');
  assert.equal(live.modes.full.assessed_in_mode, null);
  // A lane with no modes is counted as before, and reads no write_backends.
  const before = computeCoverage(db, { tiers, workflows: { writecheck: { enabled: true } } }).lanes.find((l) => l.id === 'writecheck');
  assert.equal(before.frame, 5);
  assert.equal(before.modes, undefined);
});

test('R-WB-12: mutation check: with notTestableLeavesDenominator off, none and unclassified servers come back into the denominator (and the test above would fail)', () => {
  const db = coverageWorld();
  const workflows = { writecheck: { ...shipped.writecheck, enabled: true } };
  const off = computeCoverage(db, { tiers, workflows, rules: { ...RULES, notTestableLeavesDenominator: false } }).lanes.find((l) => l.id === 'writecheck');
  assert.equal(off.frame, 5);
  assert.equal(off.by_backend, false);
  assert.notEqual(off.frame, 2);
  // With no classification at all, the denominator is still the whole frame: nothing drops out unseen.
  const empty = world({ 'o/a': null, 'o/b': null });
  const e = computeCoverage(empty, { tiers, workflows }).lanes.find((l) => l.id === 'writecheck');
  assert.deepEqual([e.frame, e.by_backend, e.unclassified], [2, false, 2]);
});

// ---------------------------------------------------------------- the watchdog

const cfgOn = { 'meta-backend': { ...shipped['meta-backend'], enabled: true }, writecheck: shipped.writecheck };
const item = (items) => items.find((i) => i.id === 'backend-classified');

test('R-WB-13: the watchdog goes amber when meta-backend has classified nothing new within 24 hours while servers wait; green with counts; off with the lane', () => {
  const db = world({ 'o/pg': PG, 'o/gh': GH, 'o/un': null });
  const data = readLaneData(db, NOW, { cfg: cfgOn, tiers });
  assert.deepEqual([data.backends.classified, data.backends.unclassified], [2, 1]);
  const run = (now, d = data, cfg = cfgOn) => item(laneChecks({ now, slots: 3, pumpOn: true, cfg, data: d, tick: null }));
  assert.equal(run(NOW).status, 'green');
  assert.match(run(NOW).summary, /2 classified \(local_full 1, mock_min 1\), 1 not yet/);
  const late = run(NOW + LANE_THRESHOLDS.backendFreshMs + HOUR);
  assert.equal(late.status, 'amber');
  assert.match(late.summary, /no subject classified for 26\.0 hours/);
  assert.equal(run(NOW + 48 * HOUR, { ...data, backends: { ...data.backends, unclassified: 0 } }).status, 'green', 'nothing waits: an old newest is fine');
  assert.equal(run(NOW, { ...data, backends: { classified: 0, unclassified: 3, newest: null, by_class: {} } }).status, 'amber');
  assert.equal(run(NOW, data, { ...cfgOn, 'meta-backend': { ...cfgOn['meta-backend'], enabled: false } }).status, 'off');
  assert.equal(item(laneChecks({ now: NOW, slots: 3, pumpOn: true, cfg: { writecheck: shipped.writecheck }, data, tick: null })), undefined, 'no lane, no item');
  assert.notEqual(run(NOW + 30 * 24 * HOUR).status, 'red', 'an unclassified server is untested, not failed');
});
