import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickFullRun, refreshHistoryTimes, historyList } from '../history-times.mjs';
import { runPump } from '../run.mjs';
import { createClient } from '../github.mjs';
import { openState } from '../../state/db.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const REPO = 'isokron-ai/tool-qa';
const NOW = Date.parse('2026-11-26T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const LIVE_ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN_HIST', LIVE_R2_SECRET_ACCESS_KEY: 'syn-hist-secret-abc', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };
const run = (title, event, created, updated) => ({ id: 1, display_title: title, event, created_at: created, updated_at: updated, conclusion: 'success' });

// Fake API: each workflow's list is a function of the call, so a test can change it between runs.
function world(state = {}) {
  const s = {
    packages: [run('history-packages', 'schedule', '2026-11-26T05:00:00Z', '2026-11-26T05:04:00Z')],
    popularity: [run('history-popularity', 'schedule', '2026-11-26T06:00:00Z', '2026-11-26T06:09:00Z')],
    registry: [
      run('history-registry delta', 'schedule', '2026-11-26T09:45:00Z', '2026-11-26T09:47:00Z'),
      run('history-registry full', 'workflow_dispatch', '2026-11-26T04:00:00Z', '2026-11-26T04:30:00Z'),
    ],
    fail: new Set(),
    ...state,
  };
  const route = (key, file) => ['GET', `/repos/${REPO}/actions/workflows/${file}/runs`, () => (s.fail.has(key) ? { status: 422, body: { message: 'nope' } } : { body: { workflow_runs: s[key] } })];
  const api = fakeApi([route('packages', 'history-packages.yml'), route('popularity', 'history-popularity.yml'), route('registry', 'history-registry.yml')]);
  return { api, s, runCalls: () => api.calls.filter((r) => /\/workflows\/history-/.test(r.path)) };
}

function pump(w, { env = {}, at = NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-hist-'));
  const stateFile = join(dir, 'state.sqlite');
  const c = fakeClock(at);
  const configs = [];
  const lines = [];
  const minted = [];
  const mk = (clock = c) => ({
    env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_synthetic_state', GITHUB_API_URL: API, LOOP_SLOTS: '0', ...LIVE_ENV, ...env },
    now: clock.now, sleep: clock.sleep, log: (l) => lines.push(l), stateFile, seedFile: null, config: { tiers: {}, workflows: {} },
    pull: async () => ({ status: 'pulled' }), push: async () => ({ status: 'pushed' }), ingest: null, registryDelta: null,
    readConformance: async () => ({ status: null }), fetch: w.api.fetch,
    mintToken: async (a) => { minted.push(a); return { token: `ghs_synthetic_hist_${minted.length}`, expiresAt: clock.t + 3_600_000 }; },
    live: { deadlineMs: 80, scan: () => ({ ok: true, hits: [] }), put: async () => ({ status: 200 }), build: async (db, a) => { configs.push(a.config); return { snapshot: { schema: 'isokron-loop-live/1', seq: configs.length, generated_at: iso(a.now), recent: [] }, hourEvents: [], problems: [] }; } },
  });
  return { dir, stateFile, c, configs, lines, minted, go: (clock = c) => runPump(mk(clock)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const times = (cfg) => Object.fromEntries(cfg.history.map((h) => [h.kind, h.last_capture_at]));

test('R-LIVE-46: the newest successful capture of registry-full, packages and popularity flows into config.history, three small reads once', async () => {
  const w = world();
  const p = pump(w);
  assert.equal((await p.go()).ok, true);
  assert.ok(p.configs.length >= 2, 'a tick and the end of the run');
  assert.deepEqual(times(p.configs[0]), { 'registry-full': '2026-11-26T04:30:00Z', packages: '2026-11-26T05:04:00Z', popularity: '2026-11-26T06:09:00Z' });
  assert.deepEqual(times(p.configs.at(-1)), times(p.configs[0]), 'the end of the run uses the kept values');
  const calls = w.runCalls();
  assert.equal(calls.length, 3, 'one round of three reads, not one per snapshot');
  for (const c of calls) {
    assert.equal(c.query.get('status'), 'success');
    assert.equal(c.query.get('branch'), 'main');
  }
  assert.deepEqual(calls.map((c) => [c.path.split('/').at(-2), c.query.get('per_page')]).sort(), [['history-packages.yml', '1'], ['history-popularity.yml', '1'], ['history-registry.yml', '50']]);
  assert.deepEqual(p.minted.map((m) => m.permissions), [{ actions: 'read' }]);
  const db = openState(p.stateFile);
  assert.equal(db.getKv('pump.history_times').kinds.packages.last_capture_at, '2026-11-26T05:04:00Z');
  db.close();
  p.cleanup();
});

test('R-LIVE-46: the answer is reused for 30 minutes and read again after, on the same state', async () => {
  const w = world();
  const p = pump(w);
  await p.go();
  assert.equal(w.runCalls().length, 3);
  w.s.packages = [run('history-packages', 'schedule', '2026-11-26T09:00:00Z', '2026-11-26T09:03:00Z')];
  p.c.t = NOW + 29 * MIN;
  await p.go();
  assert.equal(w.runCalls().length, 3, 'under 30 minutes: no reads');
  assert.equal(times(p.configs.at(-1)).packages, '2026-11-26T05:04:00Z', 'the cached value is shown');
  p.c.t = NOW + 31 * MIN;
  await p.go();
  assert.equal(w.runCalls().length, 6, 'past 30 minutes: one more round');
  assert.equal(times(p.configs.at(-1)).packages, '2026-11-26T09:03:00Z');
  p.cleanup();
});

test('R-LIVE-46: a failing read keeps the cached value, the other kinds still update, and the pump goes on', async () => {
  const w = world();
  const p = pump(w);
  await p.go();
  w.s.fail.add('packages');
  w.s.popularity = [run('history-popularity', 'schedule', '2026-11-26T10:00:00Z', '2026-11-26T10:05:00Z')];
  p.c.t = NOW + 40 * MIN;
  const out = await p.go();
  assert.equal(out.ok, true);
  const t = times(p.configs.at(-1));
  assert.equal(t.packages, '2026-11-26T05:04:00Z', 'kept');
  assert.equal(t.popularity, '2026-11-26T10:05:00Z', 'updated');
  assert.ok(p.lines.some((l) => /history time for packages not read \(keeping 2026-11-26T05:04:00Z\)/.test(l)), p.lines.join('\n'));
  // With nothing cached and everything failing: null, and still ok.
  const bad = world({ fail: new Set(['packages', 'popularity', 'registry']) });
  const q = pump(bad);
  assert.equal((await q.go()).ok, true);
  assert.deepEqual(times(q.configs[0]), { 'registry-full': null, packages: null, popularity: null });
  p.cleanup();
  q.cleanup();
});

test('R-LIVE-46: registry-full picks a "full" titled run and a scheduled 03:xx run, never a delta', () => {
  const delta = run('history-registry delta', 'schedule', '2026-11-26T09:45:00Z', '2026-11-26T09:47:00Z');
  const delta03 = run('history-registry delta', 'schedule', '2026-11-26T03:15:00Z', '2026-11-26T03:17:00Z');
  const titled = run('history-registry full', 'workflow_dispatch', '2026-11-25T14:00:00Z', '2026-11-25T14:40:00Z');
  const cron = run('history-registry', 'schedule', '2026-11-26T03:17:30Z', '2026-11-26T03:50:00Z');
  const sched10 = run('history-registry', 'schedule', '2026-11-26T10:00:00Z', '2026-11-26T10:01:00Z');
  assert.equal(pickFullRun([delta]), null);
  assert.equal(pickFullRun([delta, delta03, sched10]), null, 'a delta, even one in the 03 hour, and a scheduled run at another hour');
  assert.equal(pickFullRun([delta, titled]), Date.parse('2026-11-25T14:40:00Z'));
  assert.equal(pickFullRun([delta, cron, titled]), Date.parse('2026-11-26T03:50:00Z'), 'the newest of the full ones');
  assert.equal(pickFullRun([run('history-registry', 'workflow_dispatch', '2026-11-26T03:10:00Z', '2026-11-26T03:30:00Z')]), null, 'a manual run in the 03 hour is not the cron');
  assert.equal(pickFullRun(undefined), null);
});

test('R-LIVE-46: with the switch off the pump makes no call, mints nothing and passes no history', async () => {
  for (const v of ['false', 'TRUE', '', undefined]) {
    const w = world();
    const p = pump(w, { env: { LANE_LIVE_SNAPSHOT_ENABLED: v } });
    assert.equal((await p.go()).ok, true);
    assert.equal(w.api.calls.length, 0, `switch ${v}`);
    assert.equal(p.minted.length, 0);
    assert.equal(p.configs.length, 0, 'nothing is built either');
    const db = openState(p.stateFile);
    assert.equal(db.getKv('pump.history_times') ?? null, null);
    db.close();
    p.cleanup();
  }
});

test('R-LIVE-46: a lookup cut by the tick deadline keeps what it has and tries again next run; the refresh helper never throws', async () => {
  const w = world();
  const c = fakeClock(NOW);
  const client = createClient({ token: 'ghs_synthetic_x', fetch: w.api.fetch, apiUrl: API, sleep: c.sleep, now: c.now, random: () => 0.5 });
  const lines = [];
  // The clock is already at the deadline: no read at all.
  const cut = await refreshHistoryTimes({ client, repo: REPO, now: NOW, until: NOW, clock: c.now, log: (l) => lines.push(l) });
  assert.equal(cut.called, 0);
  assert.equal(cut.complete, false);
  assert.equal(cut.record.at, null, 'not marked as refreshed');
  assert.deepEqual(historyList(cut.record).map((h) => h.last_capture_at), [null, null, null]);
  const boom = { request: async () => { throw new Error('exploded'); } };
  const r = await refreshHistoryTimes({ client: boom, repo: REPO, now: NOW, cached: { at: iso(NOW - 31 * MIN), kinds: { packages: { last_capture_at: '2026-11-26T01:00:00Z' } } }, log: (l) => lines.push(l) });
  assert.equal(r.record.kinds.packages.last_capture_at, '2026-11-26T01:00:00Z');
  assert.equal(w.api.calls.length, 0);
});
