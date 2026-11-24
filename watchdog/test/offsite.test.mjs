import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createClient } from '../../pump/github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { judgeOffsite, offsiteCheck } from '../offsite.mjs';

const REPO = 'isokron-ai/tool-qa';
const HOUR = 3_600_000;

/** Runs of offsite-backup.yml, each with an optional heartbeat artifact. */
function world(runs) {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/workflows/offsite-backup.yml/runs`, () => ({ body: { workflow_runs: runs.map((r) => r.run) } })],
    ['GET', /^\/repos\/isokron-ai\/tool-qa\/actions\/runs\/\d+\/artifacts$/, (req) => {
      const id = Number(req.path.split('/')[6]);
      const r = runs.find((x) => x.run.id === id);
      const name = req.query.get('name');
      const list = r?.hb ? [{ id: id * 7, name: `offsite-heartbeat-${id}-1.json`, size_in_bytes: 300, expired: false, workflow_run: { id: r.forgedRunId ?? id } }] : [];
      return { body: { total_count: list.length, artifacts: list.filter((a) => a.name === name) } };
    }],
    ['GET', /\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://storage.test/hb/${Number(req.path.split('/')[6]) / 7}` } })],
    ['GET', /^\/hb\/\d+$/, (req) => ({ body: JSON.stringify(runs.find((x) => x.run.id === Number(req.path.split('/')[2])).hb) })],
  ]);
  const client = createClient({ token: 'ghs_synthetic_app', fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep });
  const check = (env = {}) => offsiteCheck({ client, repo: REPO, now: c.t, env, fetch: api.fetch, sleep: c.sleep });
  return { c, api, check };
}

const run = (id, hoursAgo, { conclusion = 'success', event = 'schedule', branch = 'main', headRepo = 1, path = '.github/workflows/offsite-backup.yml' } = {}) => ({
  id, run_attempt: 1, status: 'completed', conclusion, event, head_branch: branch, path,
  created_at: new Date(Date.parse('2026-03-02T12:00:00Z') - hoursAgo * HOUR).toISOString(),
  repository: { id: 1 }, head_repository: { id: headRepo }, html_url: `https://github.test/run/${id}`,
});
const hb = (status, lastOkHoursAgo, extra = {}) => ({
  version: 1, status, at: '2026-03-02T11:00:00Z', reason: status === 'ok' ? null : `why ${status}`,
  last_ok_at: lastOkHoursAgo == null ? null : new Date(Date.parse('2026-03-02T12:00:00Z') - lastOkHoursAgo * HOUR).toISOString(),
  bucket_bytes: 1e9, cap_bytes: 8e9, ...extra,
});

test('R-OFF-09: the watchdog item: green under 12 hours, amber to 24 or when not configured, red after 24, over the cap or on a verification failure, off with the lane off', async () => {
  const status = async (runs, env) => (await world(runs).check(env)).status;
  assert.equal(await status([{ run: run(5, 1), hb: hb('ok', 1) }]), 'green');
  assert.equal(await status([{ run: run(5, 13), hb: hb('ok', 13) }]), 'amber');
  assert.equal(await status([{ run: run(5, 25), hb: hb('ok', 25) }]), 'red');
  assert.equal(await status([{ run: run(5, 1), hb: hb('unconfigured', null) }]), 'amber');
  assert.equal(await status([{ run: run(5, 1, { conclusion: 'failure' }), hb: hb('over_cap', 2) }]), 'red');
  assert.equal(await status([{ run: run(5, 1, { conclusion: 'failure' }), hb: hb('verify_failed', 2) }]), 'red');
  // A failed run with a recent good one is amber until the good one is 24 hours old.
  assert.equal(await status([{ run: run(5, 1, { conclusion: 'failure' }), hb: hb('error', 3) }]), 'amber');
  assert.equal(await status([{ run: run(5, 1, { conclusion: 'failure' }), hb: hb('error', 30) }]), 'red');
  assert.equal(await status([{ run: run(5, 1, { conclusion: 'failure' }), hb: hb('error', null) }]), 'red');
  // Near the cap, or a run that stopped early: amber.
  assert.equal(await status([{ run: run(5, 1), hb: hb('ok', 1, { near_cap: true, bucket_bytes: 7e9 }) }]), 'amber');
  assert.equal(await status([{ run: run(5, 1), hb: hb('ok', 1, { deferred: 1, deferred_reason: 'OFFSITE_MAX_RUN_BYTES' }) }]), 'amber');
  // No run yet; a newest run that died without a heartbeat; the lane off.
  assert.equal(await status([]), 'amber');
  assert.equal(await status([{ run: run(6, 1, { conclusion: 'failure' }) }, { run: run(5, 7), hb: hb('ok', 7) }]), 'amber');
  assert.equal(await status([{ run: run(6, 1, { conclusion: 'failure' }) }]), 'red');
  assert.equal(await status([{ run: run(5, 1), hb: hb('ok', 1) }], { LANE_OFFSITE_ENABLED: 'false' }), 'off');
  const w = world([{ run: run(5, 1), hb: hb('ok', 1) }]);
  const item = await w.check();
  assert.match(item.summary, /^last good off-site backup 60 minutes ago, bucket 1\.00 GB of 8\.00 GB$/);
});

test('R-OFF-09: the watchdog trusts only heartbeats from offsite-backup.yml runs on main in this repository, scheduled or dispatched', async () => {
  for (const bad of [{ branch: 'feature' }, { headRepo: 2 }, { event: 'pull_request' }, { path: '.github/workflows/test.yml' }]) {
    const w = world([{ run: run(5, 1, bad), hb: hb('ok', 1) }]);
    const item = await w.check();
    assert.equal(item.status, 'amber', JSON.stringify(bad));
    assert.match(item.summary, /no finished offsite-backup\.yml run on main yet/);
  }
  // A heartbeat artifact that names another run is not taken.
  const w = world([{ run: run(5, 1), hb: hb('ok', 1), forgedRunId: 99 }]);
  assert.equal((await w.check()).status, 'amber');
  // The check never throws: a failing API is an amber item.
  const broken = fakeApi([]);
  const client = createClient({ token: 'ghs_x', fetch: broken.fetch, apiUrl: API, maxAttempts: 1 });
  const item = await offsiteCheck({ client, repo: REPO, now: Date.now(), fetch: broken.fetch });
  assert.equal(item.status, 'amber');
  assert.equal(judgeOffsite({ now: 0, hb: null, latest: null }).status, 'amber');
});

test('R-OFF-09: the watchdog run pushes the offsite item and watchdog.yml passes the lane switch', () => {
  const src = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8');
  assert.match(src, /checks\.push\(await offsiteCheck\(\{ client, repo, now: now\(\), env, fetch, sleep \}\)\)/);
  const yml = readFileSync(new URL('../../.github/workflows/watchdog.yml', import.meta.url), 'utf8');
  assert.match(yml, /\n\s+LANE_OFFSITE_ENABLED: \$\{\{ vars\.LANE_OFFSITE_ENABLED \}\}\n/);
});
