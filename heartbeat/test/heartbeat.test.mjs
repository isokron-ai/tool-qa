import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, tick, WATCH } from '../worker.mjs';

const NOW = Date.parse('2026-11-25T17:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
function fakeGitHub({ loop = 'true', runs = {}, fail = {} } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(init.method + ' ' + u.pathname);
    assert.equal(init.headers.authorization, 'Bearer t0ken');
    for (const [k, s] of Object.entries(fail)) if (u.pathname.includes(k) && (s.method || 'GET') === init.method) { if (s.throw) throw new TypeError('fetch failed'); return res(s.status, {}); }
    if (u.pathname.endsWith('/variables/LOOP_ENABLED')) return res(200, { name: 'LOOP_ENABLED', value: loop });
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
