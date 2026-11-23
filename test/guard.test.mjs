import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateGuard, parseSlots, laneVariable, MAX_SLOTS } from '../scripts/guard.mjs';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const GUARD = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));

function run(env, opts = {}) {
  return evaluateGuard(env, { job: 'pump', now: NOW, ...opts });
}

test('LOOP_ENABLED unset stops the loop', () => {
  const r = run({});
  assert.equal(r.proceed, false);
  assert.equal(r.slots, 0);
  assert.equal(r.reason, 'disabled');
});

test('LOOP_ENABLED must be exactly "true"', () => {
  for (const v of ['', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']) {
    const r = run({ LOOP_ENABLED: v, LOOP_SLOTS: '5' });
    assert.equal(r.proceed, false, `value ${JSON.stringify(v)} must not enable the loop`);
    assert.equal(r.reason, 'disabled');
  }
});

test('enabled loop proceeds and reports slots', () => {
  const r = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '8' });
  assert.equal(r.proceed, true);
  assert.equal(r.slots, 8);
  assert.equal(r.reason, 'ok');
});

test('LOOP_SLOTS defaults to 0', () => {
  assert.equal(run({ LOOP_ENABLED: 'true' }).slots, 0);
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '' }).slots, 0);
});

test('LOOP_SLOTS above 15 is treated as 15', () => {
  assert.equal(MAX_SLOTS, 15);
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '16' }).slots, 15);
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '20' }).slots, 15);
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '99999999999999999999999' }).slots, 15);
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '15' }).slots, 15);
});

test('negative or malformed LOOP_SLOTS is treated as 0', () => {
  assert.deepEqual(parseSlots('-3'), { slots: 0, valid: true });
  for (const v of ['abc', '3.5', '5 slots', '0x5', '1e3', '+']) {
    assert.deepEqual(parseSlots(v), { slots: 0, valid: false }, v);
  }
  assert.deepEqual(parseSlots(' 7 '), { slots: 7, valid: true });
  assert.deepEqual(parseSlots('+4'), { slots: 4, valid: true });
});

test('a job that works in slots does nothing when slots are 0', () => {
  const r = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '0' }, { needsSlots: true });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'no_slots');
  const bad = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: 'many' }, { needsSlots: true });
  assert.equal(bad.proceed, false);
  assert.equal(bad.reason, 'no_slots');
  assert.match(bad.notice, /not a whole number/);
});

test('a job that does not use slots proceeds with 0 slots', () => {
  const r = run({ LOOP_ENABLED: 'true' }, { needsSlots: false });
  assert.equal(r.proceed, true);
  assert.equal(r.slots, 0);
});

test('LOOP_PAUSE_UNTIL in the future stops the loop', () => {
  const r = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '5', LOOP_PAUSE_UNTIL: '2026-11-23T13:00:00Z' });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'paused');
  assert.match(r.notice, /2026-11-23T13:00:00\.000Z/);
});

test('LOOP_PAUSE_UNTIL with an offset is honoured', () => {
  // 13:30+02:00 is 11:30Z, already past.
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-23T13:30:00+02:00' }).proceed, true);
  // 13:30-02:00 is 15:30Z, still ahead.
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-23T13:30:00-02:00' }).proceed, false);
});

test('LOOP_PAUSE_UNTIL as a date means midnight UTC', () => {
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-24' }).reason, 'paused');
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-23' }).proceed, true);
});

test('LOOP_PAUSE_UNTIL in the past is ignored', () => {
  const r = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '3', LOOP_PAUSE_UNTIL: '2026-11-23T11:59:59Z' });
  assert.equal(r.proceed, true);
  assert.equal(r.slots, 3);
});

test('LOOP_PAUSE_UNTIL equal to now has ended', () => {
  assert.equal(run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-23T12:00:00Z' }).proceed, true);
});

test('an unreadable LOOP_PAUSE_UNTIL stops the loop (fail safe)', () => {
  for (const v of ['tomorrow', '2026-11-23T13:00:00', '23/11/2026', '2026-13-01', '2026-02-30', '2026-11-23 13:00Z']) {
    const r = run({ LOOP_ENABLED: 'true', LOOP_SLOTS: '5', LOOP_PAUSE_UNTIL: v });
    assert.equal(r.proceed, false, v);
    assert.equal(r.reason, 'invalid_pause', v);
  }
});

test('LOOP_ENABLED is checked before the pause', () => {
  assert.equal(run({ LOOP_ENABLED: 'false', LOOP_PAUSE_UNTIL: 'garbage' }).reason, 'disabled');
});

test('lane variable is derived from the job name', () => {
  assert.equal(laneVariable('history'), 'LANE_HISTORY_ENABLED');
  assert.equal(laneVariable('meta-github'), 'LANE_META_GITHUB_ENABLED');
  assert.equal(laneVariable('Live probe.v2'), 'LANE_LIVE_PROBE_V2_ENABLED');
});

test('a lane variable that is set but not "true" stops that job only', () => {
  const env = { LOOP_ENABLED: 'true', LOOP_SLOTS: '5', LANE_HISTORY_ENABLED: 'false' };
  const h = evaluateGuard(env, { job: 'history', now: NOW });
  assert.equal(h.proceed, false);
  assert.equal(h.reason, 'lane_disabled');
  assert.equal(evaluateGuard(env, { job: 'pump', now: NOW }).proceed, true);
});

test('an unset or empty lane variable leaves the job on', () => {
  const on = { LOOP_ENABLED: 'true', LOOP_SLOTS: '2', LANE_HISTORY_ENABLED: '' };
  assert.equal(evaluateGuard(on, { job: 'history', now: NOW }).proceed, true);
  const on2 = { LOOP_ENABLED: 'true', LOOP_SLOTS: '2', LANE_HISTORY_ENABLED: 'true' };
  assert.equal(evaluateGuard(on2, { job: 'history', now: NOW }).proceed, true);
});

test('job name is required', () => {
  assert.throws(() => evaluateGuard({ LOOP_ENABLED: 'true' }, { now: NOW }), /job name/);
});

test('notice is a single line and names the job', () => {
  const r = run({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: 'x\ny' });
  assert.ok(!r.notice.includes('\n'));
  assert.match(r.notice, /^pump: /);
});

// ---- CLI ----

function cli(args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const out = join(dir, 'output');
  writeFileSync(out, 'existing=1\n');
  const res = spawnSync(process.execPath, [GUARD, ...args], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
    encoding: 'utf8',
  });
  return { ...res, output: readFileSync(out, 'utf8') };
}

test('CLI: disabled loop exits 0 with proceed=false and one notice line', () => {
  const r = cli(['--job', 'pump'], { LOOP_ENABLED: 'false', GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 0);
  assert.match(r.output, /^existing=1\nproceed=false\nslots=0\nreason=disabled\n$/);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::notice title=Loop guard::pump: /);
});

test('CLI: enabled loop writes proceed=true and clamped slots', () => {
  const r = cli(['--job', 'pump', '--slots'], { LOOP_ENABLED: 'true', LOOP_SLOTS: '40' });
  assert.equal(r.status, 0);
  assert.match(r.output, /proceed=true\nslots=15\nreason=ok\n$/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('CLI: --slots with zero slots exits 0 with proceed=false', () => {
  const r = cli(['--job=live-probe', '--slots'], { LOOP_ENABLED: 'true' });
  assert.equal(r.status, 0);
  assert.match(r.output, /proceed=false\nslots=0\nreason=no_slots\n$/);
});

test('CLI: job name falls back to LOOP_JOB then GITHUB_JOB', () => {
  const r = cli([], { LOOP_ENABLED: 'true', GITHUB_JOB: 'watchdog' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^watchdog: /);
  const r2 = cli([], { LOOP_ENABLED: 'true', GITHUB_JOB: 'x', LOOP_JOB: 'history' });
  assert.match(r2.stdout, /^history: /);
});

test('CLI: without GITHUB_OUTPUT the outputs go to stdout', () => {
  const res = spawnSync(process.execPath, [GUARD, '--job', 'pump'], {
    env: { PATH: process.env.PATH, LOOP_ENABLED: 'true', LOOP_SLOTS: '2' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /proceed=true\nslots=2\nreason=ok\n$/);
});

test('CLI: unknown argument is a usage error', () => {
  const r = cli(['--bogus'], { LOOP_ENABLED: 'true' });
  assert.equal(r.status, 2);
});
