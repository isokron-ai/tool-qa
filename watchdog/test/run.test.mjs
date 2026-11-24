import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchdog } from '../run.mjs';
import { parseBody } from '../health.mjs';
import { openState } from '../../state/db.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { backed, greenStatus } from '../../test/lib/conformance.mjs';

const REPO = 'isokron-ai/tool-qa';
const MIN = 60_000;

function world({ pumpAgeMin = 5, workflows = [], seed } = {}) {
  const c = fakeClock(Date.parse('2026-03-02T12:00:00Z'));
  const ago = (m) => new Date(c.t - m * MIN).toISOString();
  const issues = [];
  const api = fakeApi([
    ['GET', `/repos/${REPO}/actions/workflows`, () => ({ body: { total_count: workflows.length, workflows } })],
    ['GET', /\/actions\/workflows\/[^/]+\/runs$/, (req) => {
      if (req.path.includes('/pump.yml/')) {
        return { body: { workflow_runs: [{ id: 1, event: 'schedule', status: 'completed', conclusion: 'success', created_at: ago(pumpAgeMin), run_started_at: ago(pumpAgeMin), html_url: 'u' }] } };
      }
      return { body: { workflow_runs: [] } };
    }],
    ['GET', `/repos/${REPO}/actions/artifacts`, () => ({
      body: {
        artifacts: [
          { name: 'registry-delta-x', created_at: ago(10), expired: false },
          { name: 'registry-full-x', created_at: ago(300), expired: false },
          { name: 'history-packages-1', created_at: ago(300), expired: false },
          { name: 'history-popularity-1', created_at: ago(300), expired: false },
        ],
      },
    })],
    ['POST', `/repos/${REPO}/actions/workflows/pump.yml/dispatches`, () => ({ status: 204 })],
    ['PUT', /\/actions\/workflows\/\d+\/enable$/, () => ({ status: 204 })],
    ['GET', `/repos/${REPO}/issues`, () => ({ body: issues })],
    ['POST', `/repos/${REPO}/issues`, (req) => {
      const issue = { number: 1, node_id: 'I_1', title: req.json.title, body: req.json.body, labels: [{ name: 'loop-health' }], state: 'open' };
      issues.push(issue);
      return { status: 201, body: issue };
    }],
    ['PATCH', /\/issues\/1$/, (req) => {
      Object.assign(issues[0], req.json);
      return { body: issues[0] };
    }],
    ['POST', /\/issues\/1\/comments$/, () => ({ status: 201, body: {} })],
    ['POST', '/graphql', () => ({ body: { data: { pinIssue: { issue: { number: 1 } } } } })],
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  const mints = [];
  const opts = {
    env: {
      GITHUB_REPOSITORY: REPO, LOOP_SLOTS: '4', GITHUB_REF_NAME: 'main', GITHUB_TOKEN: 'ghs_synthetic_job_token',
      // a fresh heartbeat from the Mac archive pull (watchdog/archive.mjs)
      ARCHIVE_LAST_OK: JSON.stringify({ at: ago(60), pulled: 2, quarantined: 0, refused_foreign: 0 }),
      // the off-site backup has its own tests (watchdog/test/offsite.test.mjs)
      LANE_OFFSITE_ENABLED: 'false',
      // the keep-forever copy and the seal record have their own tests (keep/test/health.test.mjs)
      LANE_KEEP_FOREVER_ENABLED: 'false',
    },
    now: c.now,
    sleep: c.sleep,
    fetch: api.fetch,
    apiUrl: API,
    log: () => {},
    stateDir: dir,
    readConformance: async () => ({ status: greenStatus(c.t - 3_600_000) }),
    verifyConformanceRun: backed,
    mintToken: async (args) => {
      mints.push(args);
      return { token: 'ghs_synthetic_app_token', expiresAt: c.t + 3_600_000 };
    },
    readSnapshot: async () => ({ manifest: { version: 1, current_at: ago(40), snapshots: [{ name: 'state-20260302T112000Z-0123abcd.sqlite.age', created: ago(40), sha256: 'a'.repeat(64), size: 1 }] } }),
    pull: async ({ file }) => {
      if (!seed) return { status: 'absent' };
      const db = openState(file);
      seed(db, c);
      db.close();
      return { status: 'pulled' };
    },
  };
  return { c, api, issues, mints, opts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a healthy loop: one narrowed token, nothing dispatched, a green issue', async () => {
  const w = world({ seed: () => {} });
  const out = await runWatchdog(w.opts);
  assert.deepEqual(w.mints, [{ repositories: ['tool-qa'], permissions: { issues: 'write', actions: 'write' } }]);
  assert.equal(out.overall, 'green');
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/dispatches')).length, 0);
  assert.equal(parseBody(w.issues[0].body).overall, 'green');
  w.cleanup();
});

test('a stale pump is dispatched and an inactive workflow re-enabled', async () => {
  const w = world({
    pumpAgeMin: 30,
    seed: () => {},
    workflows: [{ id: 77, path: '.github/workflows/history-packages.yml', state: 'disabled_inactivity' }],
  });
  const out = await runWatchdog(w.opts);
  const dispatch = w.api.calls.find((r) => r.path.endsWith('/pump.yml/dispatches'));
  assert.deepEqual(dispatch.json, { ref: 'main' });
  assert.ok(w.api.calls.some((r) => r.method === 'PUT' && r.path.endsWith('/workflows/77/enable')));
  assert.equal(out.overall, 'amber');
  const state = parseBody(w.issues[0].body);
  assert.equal(state.checks.find((c) => c.id === 'pump').status, 'amber');
  w.cleanup();
});

test('stuck slots and a failed successor from the state asset are red', async () => {
  const w = world({
    seed: (db, c) => {
      db.acquireSlot('lost', { budget: 4, ttlMs: 10 * MIN, now: c.t - 60 * MIN });
      db.setKv('pump.successor', { ok: false, error: 'HTTP 502', at: new Date(c.t - 5 * MIN).toISOString() }, { now: c.t });
    },
  });
  const out = await runWatchdog(w.opts);
  assert.equal(out.overall, 'red');
  const ids = out.checks.filter((c) => c.status === 'red').map((c) => c.id).sort();
  assert.deepEqual(ids, ['pump-successor', 'slots']);
  w.cleanup();
});

test('no state asset yet is amber, not an error', async () => {
  const w = world();
  const out = await runWatchdog(w.opts);
  assert.equal(out.checks.find((c) => c.id === 'state').status, 'amber');
  w.cleanup();
});

test('a state asset that cannot be read is amber and the issue is still written', async () => {
  const w = world();
  w.opts.pull = async () => {
    throw new Error('asset state.sqlite checksum mismatch');
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'state');
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /could not read the state asset: .*checksum mismatch/);
  assert.equal(w.issues.length, 1);
  w.cleanup();
});

test('a pump lane switched off is reported as off and not dispatched', async () => {
  const w = world({ pumpAgeMin: 50, seed: () => {} });
  w.opts.env.LANE_PUMP_ENABLED = 'false';
  const out = await runWatchdog(w.opts);
  assert.equal(out.checks.find((c) => c.id === 'pump').status, 'off');
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/dispatches')).length, 0);
  w.cleanup();
});

test('a workflow that cannot be re-enabled is red', async () => {
  const w = world({
    seed: () => {},
    workflows: [{ id: 78, path: '.github/workflows/history-registry.yml', state: 'disabled_inactivity' }],
  });
  const orig = w.api.fetch;
  w.opts.fetch = async (url, init) => {
    if (String(url).endsWith('/workflows/78/enable')) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    return orig(url, init);
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'workflow:history-registry.yml');
  assert.equal(c.status, 'red');
  assert.match(c.summary, /403/);
  assert.equal(out.overall, 'red');
  w.cleanup();
});

test('a failed pump dispatch is reported in the issue instead of failing the run', async () => {
  const w = world({ pumpAgeMin: 50, seed: () => {} });
  const routes = w.api;
  const orig = routes.fetch;
  w.opts.fetch = async (url, init) => {
    if (String(url).endsWith('/pump.yml/dispatches')) return new Response(JSON.stringify({ message: 'Workflow does not have workflow_dispatch trigger' }), { status: 422 });
    return orig(url, init);
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'pump-dispatch');
  assert.equal(c.status, 'red');
  assert.match(c.summary, /422/);
  w.cleanup();
});

test('R-WD-01: the sandbox breaker is on the health issue: red while it holds an enabled lane, amber with none enabled, green when it passed', async () => {
  const lanes = (enabled) => ({
    'live-probe': { enabled, runs_untrusted: true, sandbox_sha: 'a'.repeat(40) },
    writecheck: { enabled: false, runs_untrusted: true, sandbox_sha: null },
    'scan-static': { enabled: true, runs_untrusted: false },
  });
  // Green.
  let w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(true);
  let out = await runWatchdog(w.opts);
  let b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'green');
  assert.match(b.summary, /^closed: sandbox conformance passed 60 minutes ago on ubuntu24\/20261117\.1, gVisor 20261116\.0$/);
  assert.equal(b.link, 'https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/1');
  w.cleanup();
  // Red: stale, with live-probe enabled.
  w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(true);
  w.opts.readConformance = async () => ({ status: greenStatus(w.c.t - 40 * 3_600_000) });
  out = await runWatchdog(w.opts);
  b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'red');
  assert.match(b.summary, /^open \(stale\): the pump holds live-probe: the last sandbox conformance pass is from 40\.0 hours ago/);
  assert.equal(out.overall, 'red');
  assert.equal(parseBody(w.issues[0].body).checks.find((c) => c.id === 'sandbox-breaker').status, 'red');
  w.cleanup();
  // Amber: unreadable, nothing untrusted enabled.
  w = world({ seed: () => {} });
  w.opts.workerWorkflows = lanes(false);
  w.opts.readConformance = async () => { throw new Error('socket hang up'); };
  out = await runWatchdog(w.opts);
  b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'amber');
  assert.match(b.summary, /^open \(unreadable\): would hold live-probe, writecheck \(none enabled\): the conformance status cannot be read: socket hang up/);
  w.cleanup();
});

test('R-WD-01: the watchdog fetches the conformance status itself, with no token', async () => {
  const w = world({ seed: () => {} });
  delete w.opts.readConformance;
  w.opts.workerWorkflows = { 'live-probe': { enabled: true, runs_untrusted: true, sandbox_sha: 'a'.repeat(40) } };
  const seen = [];
  const inner = w.opts.fetch;
  w.opts.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'github.com') {
      seen.push({ url: url.href, auth: new Headers(init.headers ?? {}).get('authorization') });
      return new Response(JSON.stringify(greenStatus(w.c.t - 2 * 3_600_000)), { status: 200 });
    }
    return inner(input, init);
  };
  const out = await runWatchdog(w.opts);
  assert.deepEqual(seen, [{ url: 'https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json', auth: null }]);
  assert.equal(out.checks.find((c) => c.id === 'sandbox-breaker').status, 'green');
  w.cleanup();
});

test('R-WD-03: the health issue shows amber while an enabled lane pins another sandbox commit than the nightly tested', async () => {
  const w = world({ seed: () => {} });
  w.opts.workerWorkflows = { 'live-probe': { enabled: true, runs_untrusted: true, sandbox_sha: 'b'.repeat(40) }, writecheck: { enabled: true, runs_untrusted: true, sandbox_sha: null } };
  const out = await runWatchdog(w.opts);
  const b = out.checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(b.status, 'amber');
  assert.match(b.summary, /^closed, but the nightly tested sandbox aaaaaaaaaaaa and live-probe pins bbbbbbbbbbbb, writecheck pins none: sandbox conformance passed/);
  w.cleanup();
});

test('R-WD-07: the watchdog judges with what the pump remembered: a rollback is unreadable, and a run already verified is not looked up again', async () => {
  const at = Date.parse('2026-03-02T11:00:00Z');
  const lanes = { 'live-probe': { enabled: true, runs_untrusted: true, sandbox_sha: 'a'.repeat(40) } };
  const t = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const remembered = { newest: { run_id: 9, run_attempt: 1, checked_at: t, started_at: t, updated_at: t }, verified: { run_id: 9, run_attempt: 1, checked_at: t, started_at: t, updated_at: t } };
  // Remembered run 9; the file now says run 1: a rollback.
  let w = world({ seed: (db, c) => db.setKv('pump.conformance', remembered, { now: c.t }) });
  w.opts.workerWorkflows = lanes;
  const rolled = (await runWatchdog(w.opts)).checks.find((c) => c.id === 'sandbox-breaker');
  assert.equal(rolled.status, 'red');
  assert.match(rolled.summary, /open \(unreadable\): the pump holds live-probe: the conformance status went back to run 1 attempt 1, older than run 9 attempt 1/);
  w.cleanup();
  // Run 9 itself: verified already, so no lookup.
  w = world({ seed: (db, c) => db.setKv('pump.conformance', remembered, { now: c.t }) });
  w.opts.workerWorkflows = lanes;
  w.opts.readConformance = async () => ({ status: { ...greenStatus(at), run_id: 9, run_attempt: 1 } });
  w.opts.verifyConformanceRun = async () => { throw new Error('must not be looked up'); };
  const out = await runWatchdog(w.opts);
  assert.equal(out.checks.find((c) => c.id === 'sandbox-breaker').status, 'green');
  w.cleanup();
});

test('R-WD-13: a workflows.json the pump cannot load is a red config check; the watchdog still writes the issue', async () => {
  const w = world({ seed: () => {} });
  w.opts.workerWorkflows = undefined;
  w.opts.loadWorkerConfig = () => {
    throw new Error('pump/workflows.json: live-probe: enabled must be true or false');
  };
  const out = await runWatchdog(w.opts);
  const c = out.checks.find((x) => x.id === 'config');
  assert.equal(c.status, 'red');
  assert.match(c.summary, /the pump cannot load its config, so it dispatches nothing: pump\/workflows\.json: live-probe: enabled must be true or false/);
  assert.equal(out.overall, 'red');
  assert.equal(w.issues.length, 1, 'the issue is still written');
  w.cleanup();
});

test('R-ARC-22: the watchdog shows the archive heartbeat from vars.ARCHIVE_LAST_OK: amber after 12 hours, red after 24 or when it is empty or unreadable', async () => {
  const { archiveCheck } = await import('../archive.mjs');
  const now = Date.parse('2026-03-02T12:00:00Z');
  const hb = (hoursAgo, extra = {}) => JSON.stringify({ at: new Date(now - hoursAgo * 3_600_000).toISOString(), pulled: 3, quarantined: 1, refused_foreign: 0, ...extra });
  const status = (raw) => archiveCheck({ now, raw }).status;
  assert.equal(status(hb(1)), 'green');
  assert.match(archiveCheck({ now, raw: hb(1) }).summary, /^last good archive pull 60 minutes ago \(pulled 3, quarantined 1, refused as not ours 0\)$/);
  assert.equal(status(hb(12)), 'green');
  assert.equal(status(hb(12.1)), 'amber');
  assert.equal(status(hb(24)), 'amber');
  assert.equal(status(hb(24.1)), 'red');
  assert.match(archiveCheck({ now, raw: hb(30) }).summary, /no good archive pull for 30\.0 hours/);
  for (const raw of [undefined, '', '   ']) assert.equal(status(raw), 'red', JSON.stringify(raw));
  assert.match(archiveCheck({ now, raw: '' }).summary, /ARCHIVE_LAST_OK is empty/);
  assert.match(archiveCheck({ now, raw: '2026-03-02T11:00:00Z' }).summary, /is not JSON/);
  for (const raw of ['{}', '{"at":"yesterday"}', '{"at":12345}', 'null', '[1]']) assert.equal(status(raw), 'red', raw);
  assert.match(archiveCheck({ now, raw: '{"at":"yesterday"}' }).summary, /no valid date/);
  assert.equal(status(hb(-1)), 'amber', 'an hour in the future: the Mac clock');
  assert.equal(status(hb(-0.1)), 'green', 'a few minutes of clock skew is fine');
  assert.equal(status('off'), 'off');

  // end to end: the item is on the health issue, and a stale heartbeat makes the issue red
  const w = world();
  w.opts.env.ARCHIVE_LAST_OK = JSON.stringify({ at: new Date(w.c.t - 30 * 3_600_000).toISOString(), pulled: 0 });
  const out = await runWatchdog(w.opts);
  const item = out.checks.find((c) => c.id === 'archive');
  assert.equal(item.status, 'red');
  assert.equal(out.overall, 'red');
  assert.match(w.issues[0].body, /archive/);
  // the run reads no repository variable through the API
  assert.equal(w.api.calls.filter((c) => c.path.includes('/actions/variables')).length, 0);
  w.cleanup();
});

test('R-ARC-22: watchdog.yml passes vars.ARCHIVE_LAST_OK to the watchdog step through env', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../../.github/workflows/watchdog.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Watchdog'));
  assert.match(step, /\n\s+ARCHIVE_LAST_OK: \$\{\{ vars\.ARCHIVE_LAST_OK \}\}\n/);
  assert.ok(step.indexOf('ARCHIVE_LAST_OK') < step.indexOf('run: node watchdog/run.mjs'));
});
test('R-SNAP-09: the watchdog shows the state snapshots on the health issue: amber after 3 hours, red after 6, off with the lane off', async () => {
  for (const [hours, env, want] of [[1, {}, 'green'], [4, {}, 'amber'], [7, {}, 'red'], [7, { LANE_STATE_SNAPSHOT_ENABLED: 'false' }, 'off']]) {
    const w = world({ seed: () => {} });
    Object.assign(w.opts.env, env);
    const at = new Date(w.c.t - hours * 60 * MIN).toISOString();
    w.opts.readSnapshot = async () => ({ manifest: { version: 1, current_at: at, snapshots: [{ name: 'state-20260302T010000Z-0123abcd.sqlite.age', created: at, sha256: 'a'.repeat(64), size: 1 }] } });
    const out = await runWatchdog(w.opts);
    const item = parseBody(w.issues[0].body).checks.find((c) => c.id === 'state-snapshot');
    assert.equal(item.status, want, `${hours} hours ${JSON.stringify(env)}`);
    assert.equal(out.overall, want === 'off' ? 'green' : want);
    w.cleanup();
  }
});

test('R-SNAP-09: the watchdog reads the snapshot manifest from the release with the job token; an unreadable one is amber, not a failed run', async () => {
  const w = world({ seed: () => {} });
  delete w.opts.readSnapshot;
  const manifest = { version: 1, current_at: new Date(w.c.t - 30 * MIN).toISOString(), snapshots: [{ name: 'state-20260302T113000Z-0123abcd.sqlite.age', created: '2026-03-02T11:30:00Z', sha256: `0123abcd${'a'.repeat(56)}`, size: 1 }] };
  const seen = [];
  const orig = w.opts.fetch;
  w.opts.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/releases/')) {
      seen.push({ url: u, auth: init.headers?.Authorization ?? null });
      if (u.endsWith('/releases/tags/state-snapshots')) return new Response(JSON.stringify({ id: 7, tag_name: 'state-snapshots', assets: [] }), { status: 200 });
      if (u.includes('/releases/7/assets')) return new Response(JSON.stringify([{ id: 8, name: 'manifest.json', state: 'uploaded' }]), { status: 200 });
      if (u.endsWith('/releases/assets/8')) return new Response(JSON.stringify(manifest), { status: 200 });
    }
    return orig(url, init);
  };
  await runWatchdog(w.opts);
  assert.equal(parseBody(w.issues[0].body).checks.find((c) => c.id === 'state-snapshot').status, 'green');
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((r) => r.auth === 'Bearer ghs_synthetic_job_token'), 'the job token, not the App token');
  w.cleanup();

  const w2 = world({ seed: () => {} });
  w2.opts.readSnapshot = async () => { throw new Error('HTTP 502 ghs_synthetic_job_token'); };
  const out = await runWatchdog(w2.opts);
  const item = parseBody(w2.issues[0].body).checks.find((c) => c.id === 'state-snapshot');
  assert.equal(item.status, 'amber');
  assert.doesNotMatch(item.summary, /ghs_synthetic/);
  assert.equal(out.overall, 'amber');
  w2.cleanup();
});

test('R-SNAP-17: a snapshot manifest with null entries, one that throws, or a time in the future is amber; the watchdog run still writes the issue', async () => {
  const cases = [
    ['null entries', async () => ({ manifest: { version: 1, current_at: '2026-03-02T11:50:00Z', snapshots: [null, null, null] } })],
    ['a hostile object', async () => ({ manifest: { version: 1, get snapshots() { throw new Error('boom'); } } })],
    ['the future', async () => ({ manifest: { version: 1, current_at: '2026-03-02T15:00:00Z', snapshots: [{ name: 'state-20260302T113000Z-0123abcd.sqlite.age', created: '2026-03-02T11:30:00Z', sha256: 'a'.repeat(64), size: 1 }] } })],
    ['no manifest', async () => ({ manifest: null, missing: 'manifest' })],
  ];
  for (const [what, readSnapshot] of cases) {
    const w = world({ seed: () => {} });
    w.opts.readSnapshot = readSnapshot;
    const out = await runWatchdog(w.opts);
    const item = parseBody(w.issues[0].body).checks.find((c) => c.id === 'state-snapshot');
    assert.equal(item.status, 'amber', what);
    assert.equal(out.overall, 'amber', what);
    if (what === 'no manifest') assert.match(item.summary, /has no manifest\.json/);
    w.cleanup();
  }
});


test('R-RET-19: the health issue carries the keep-forever copy and the seal record: a stalled copy and a failed compression are amber and red', async () => {
  const w = world({
    seed: (db, c) => {
      db.setKv('retention.seal', { at: new Date(c.t).toISOString(), sealed: 5, bytes_in: 500, bytes_out: 50, failures: { compress: 3, keep: 0 }, streak: 3, last_failure: { kind: 'compress', what: 'x', error: 'zstd exploded' } }, { now: c.t });
    },
  });
  delete w.opts.env.LANE_KEEP_FOREVER_ENABLED;
  const at = (ms) => new Date(w.c.t - ms).toISOString();
  w.opts.readKeep = async () => ({ status: { version: 1, at: at(MIN), status: 'ok', last_ok_at: at(MIN), copied: { artifacts: 1, bytes: 1 }, pending: { count: 4, oldest_at: at(45 * 24 * 60 * MIN) } } });
  const out = await runWatchdog(w.opts);
  const keep = out.checks.find((c) => c.id === 'keep-forever');
  assert.equal(keep.status, 'amber');
  assert.match(keep.summary, /4 artifact\(s\) wait/);
  assert.equal(out.checks.find((c) => c.id === 'retention-seal').status, 'red');
  assert.equal(out.overall, 'red');
  // Switched off by its lane variable: off, not amber.
  const off = world({ seed: () => {} });
  const done = await runWatchdog(off.opts);
  assert.equal(done.checks.find((c) => c.id === 'keep-forever').status, 'off');
  assert.equal(done.checks.find((c) => c.id === 'retention-seal').status, 'green');
  w.cleanup();
  off.cleanup();
});
