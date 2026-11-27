import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchdog } from '../run.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHIPPED = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows;
/** The sandbox commit the enabled runs_untrusted lanes pin (the shipped config unless a test gives its own lanes). */
function pinnedSandbox(lanes) {
  const pin = Object.values(lanes ?? SHIPPED).find((w) => w.enabled === true && w.runs_untrusted !== false && w.sandbox_sha)?.sandbox_sha;
  return pin ?? 'a'.repeat(40);
}
import { parseBody } from '../health.mjs';
import { openState } from '../../state/db.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { backed, greenStatus } from '../../test/lib/conformance.mjs';
import { seedLaneState, tick } from '../../test/lib/lane-state.mjs';

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
    // the state of a workflow file (the external-workflows item)
    ['GET', /\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\.ya?ml$/, () => ({ body: { state: 'active' } })],
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
    // A healthy nightly tested the commit the enabled lanes pin: the shipped config's, or a test's own lanes.
    readConformance: async () => ({ status: { ...greenStatus(c.t - 3_600_000), sandbox_sha: pinnedSandbox(opts.workerWorkflows) } }),
    verifyConformanceRun: backed,
    mintToken: async (args) => {
      mints.push(args);
      if (args.permissions.actions === 'read') {
        if (opts.logMintError) throw new Error(opts.logMintError);
        return { token: 'ghs_synthetic_log_token', expiresAt: c.t + 3_600_000 };
      }
      return { token: 'ghs_synthetic_app_token', expiresAt: c.t + 3_600_000 };
    },
    readSnapshot: async () => ({ manifest: { version: 1, current_at: ago(40), snapshots: [{ name: 'state-20260302T112000Z-0123abcd.sqlite.age', created: ago(40), sha256: 'a'.repeat(64), size: 1 }] } }),
    pull: async ({ file }) => {
      if (!seed) return { status: 'absent' };
      const db = openState(file);
      seed(db, c);
      // a healthy lane picture under every seed (watchdog/lanes.mjs); a test about the lanes sets opts.noLanes
      if (!opts.noLanes) seedLaneState(db, { now: c.t });
      db.close();
      return { status: 'pulled' };
    },
  };
  return { c, api, issues, mints, opts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a healthy loop: one narrowed token, nothing dispatched, a green issue', async () => {
  const w = world({ seed: () => {} });
  const out = await runWatchdog(w.opts);
  assert.deepEqual(w.mints[0], { repositories: ['tool-qa'], permissions: { issues: 'write', actions: 'write' } });
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
  w.opts.readConformance = async () => ({ status: greenStatus(w.c.t - 3_600_000) }); // the nightly tested aaaa…, not the pins
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


test('R-WD-15: a history capture that fell off the newest-300 artifact list is found through its workflow runs, not reported red', async () => {
  const w = world({ seed: () => {} });
  const ago = (m) => new Date(w.c.t - m * MIN).toISOString();
  // The global list is all lane results: no history capture in it.
  w.api.routes.unshift(['GET', `/repos/${REPO}/actions/artifacts`, () => ({ body: { artifacts: [{ id: 9, name: 'registry-delta-x', created_at: ago(10), expired: false }, { id: 10, name: 'result-abc', created_at: ago(1), expired: false }] } })]);
  w.api.routes.unshift(['GET', /\/actions\/workflows\/history-(registry|packages|popularity)\.yml\/runs$/, (req) => {
    if (req.path.includes('history-registry')) {
      return { body: { workflow_runs: [{ id: 501, display_title: 'history-registry delta' }, { id: 502, display_title: 'history-registry full' }] } };
    }
    return { body: { workflow_runs: [{ id: req.path.includes('packages') ? 601 : 701, display_title: 'x' }] } };
  }]);
  w.api.routes.unshift(['GET', /\/actions\/runs\/(502|601|701)\/artifacts$/, (req) => {
    const id = Number(req.path.match(/runs\/(\d+)\//)[1]);
    const name = { 502: 'registry-full-7', 601: 'history-packages-7', 701: 'history-popularity-7' }[id];
    return { body: { artifacts: [{ id: id * 10, name, created_at: ago(600), expired: false }] } };
  }]);
  const out = await runWatchdog(w.opts);
  const body = parseBody(w.issues[0].body);
  for (const id of ['history-registry-full', 'history-packages', 'history-popularity']) {
    const c = body.checks.find((x) => x.id === id);
    assert.equal(c.status, 'green', `${id}: ${c.summary}`);
  }
  // the delta run (501) is not opened for the full capture
  assert.equal(w.api.calls.some((r) => r.path.endsWith('/runs/501/artifacts')), false);
  assert.notEqual(out.overall, 'red');
  w.cleanup();
});

test('R-WD-15: when the history lookups fail, the check reads as before (red, no artifact found) and the watchdog still runs', async () => {
  const w = world({ seed: () => {} });
  w.api.routes.unshift(['GET', `/repos/${REPO}/actions/artifacts`, () => ({ body: { artifacts: [] } })]);
  w.api.routes.unshift(['GET', /\/actions\/workflows\/history-(registry|packages|popularity)\.yml\/runs$/, (req) => (req.query.get('status') === 'success' ? { status: 500, body: {} } : { body: { workflow_runs: [] } })]);
  await runWatchdog(w.opts);
  const body = parseBody(w.issues[0].body);
  assert.equal(body.checks.find((x) => x.id === 'history-packages').status, 'red');
  w.cleanup();
});


test('R-WD-15: the daily registry-full run is found under many pages of delta runs', async () => {
  const w = world({ seed: () => {} });
  const ago = (m) => new Date(w.c.t - m * MIN).toISOString();
  w.api.routes.unshift(['GET', `/repos/${REPO}/actions/artifacts`, () => ({ body: { artifacts: [{ id: 1, name: 'registry-delta-x', created_at: ago(5), expired: false }, { id: 2, name: 'history-packages-1', created_at: ago(60), expired: false }, { id: 3, name: 'history-popularity-1', created_at: ago(60), expired: false }] } })]);
  // 150 delta runs, then the full run on page 2.
  const runs = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, display_title: 'history-registry delta' }));
  runs.splice(130, 0, { id: 999, display_title: 'history-registry full' });
  w.api.routes.unshift(['GET', /\/actions\/workflows\/history-registry\.yml\/runs$/, (req) => {
    if (req.query.get('status') !== 'success') return { body: { workflow_runs: [] } };
    const page = Number(req.query.get('page') || 1);
    return { body: { workflow_runs: runs.slice((page - 1) * 100, page * 100) } };
  }]);
  w.api.routes.unshift(['GET', /\/actions\/runs\/999\/artifacts$/, () => ({ body: { artifacts: [{ id: 9990, name: 'registry-full-9', created_at: ago(20 * 60), expired: false }] } })]);
  await runWatchdog(w.opts);
  const c = parseBody(w.issues[0].body).checks.find((x) => x.id === 'history-registry-full');
  assert.equal(c.status, 'green', c.summary);
  const pages = w.api.calls.filter((r) => r.path.endsWith('/history-registry.yml/runs') && r.query.get('status') === 'success').map((r) => r.query.get('page'));
  assert.deepEqual(pages, ['1', '2']);
  w.cleanup();
});


test('R-WD-16: run.mjs declares every module-level const before its script entry, so running it as a script cannot hit a temporal dead zone', () => {
  const src = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8');
  const entry = src.indexOf('if (process.argv[1] && fileURLToPath(import.meta.url)');
  assert.ok(entry > 0, 'script entry found');
  const after = src.slice(entry);
  assert.doesNotMatch(after, /^(export )?(const|let|class) /m, 'a module-level binding after the script entry is not initialised when main() runs');
});

// R-WD-17: the lanes' own sandbox self tests.
const LOG = (version) => `﻿2026-11-26T02:55:09.8860752Z Current runner version: '2.338.2'\n2026-11-26T02:55:09.8885760Z ##[group]Runner Image Provisioner\n2026-11-26T02:55:09.8887245Z Version: 20261111.635\n2026-11-26T02:55:09.8889454Z ##[endgroup]\n2026-11-26T02:55:09.8896537Z ##[group]Runner Image\n2026-11-26T02:55:09.8897123Z Image: ubuntu-24.04\n2026-11-26T02:55:09.8897696Z Version: ${version}\n2026-11-26T02:55:09.8900549Z ##[endgroup]\n`;

/** A world whose lanes show `fails` self-test failures (minutes ago, image version) on live-probe. */
function selftestWorld(fails, { logStatus = 200 } = {}) {
  const w = world({ seed: () => {} });
  const ago = (m) => new Date(w.c.t - m * MIN).toISOString();
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/workflows\/live-probe\.yml\/runs$/, () => ({
    body: { workflow_runs: fails.map((f, i) => ({ id: 800 + i, status: 'completed', conclusion: f.conclusion ?? 'failure', html_url: `https://github.com/isokron-ai/mcp-check/actions/runs/${800 + i}`, updated_at: ago(f.min) })) },
  })]);
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/runs\/(\d+)\/jobs$/, (req) => {
    const i = Number(req.path.match(/runs\/(\d+)\//)[1]) - 800;
    return { body: { jobs: [
      { id: 7000 + i, name: 'live-probe-guard', conclusion: 'success', completed_at: ago(fails[i].min + 5) },
      { id: 9000 + i, name: fails[i].jobName ?? 'sandbox / sandbox-selftest', conclusion: 'failure', completed_at: ago(fails[i].min), html_url: `https://github.com/isokron-ai/mcp-check/actions/runs/${800 + i}/job/${9000 + i}` },
    ] } };
  }]);
  // The log: the API answers 302 to a second origin (the blob store), which serves the head as 206 (R-WD-19).
  w.blobCalls = [];
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/jobs\/(\d+)\/logs$/, (req) => {
    if (logStatus !== 200) return { status: logStatus, body: { message: 'x' } };
    return { status: 302, headers: { location: `https://blob.test/actions-results/${Number(req.path.match(/jobs\/(\d+)\//)[1]) - 9000}` } };
  }]);
  const apiFetch = w.api.fetch;
  w.opts.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'blob.test') return apiFetch(input, init);
    const h = new Headers(init.headers ?? {});
    w.blobCalls.push({ url: url.href, authorization: h.get('authorization'), range: h.get('range'), redirect: init.redirect });
    return new Response(LOG(fails[Number(url.pathname.split('/').pop())].image), { status: 206 });
  };
  return w;
}
const selftestOf = async (w) => {
  await runWatchdog(w.opts);
  return parseBody(w.issues[0].body).checks.find((x) => x.id === 'sandbox-selftest');
};
// greenStatus() says the nightly passed on ubuntu24/20261117.1, so the image to match is 20261117.1.

test('R-WD-17: no self test failure in the last 6 hours is green, and costs one run list per lane that runs third-party code', async () => {
  const w = selftestWorld([]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'green', c.summary);
  const reads = w.api.calls.filter((r) => /isokron-ai\/(mcp-check|mcp-writecheck-action)\/actions\/(workflows\/[^/]+\/runs|runs\/|jobs\/)/.test(r.path));
  assert.deepEqual(reads.map((r) => r.path).sort(), ['/repos/isokron-ai/mcp-check/actions/workflows/live-probe.yml/runs', '/repos/isokron-ai/mcp-writecheck-action/actions/workflows/corpus.yml/runs']);
  // the minted actions: read token (not the tool-qa App token, not the job token) reads the other repositories
  assert.equal(reads[0].headers.get('authorization'), 'Bearer ghs_synthetic_log_token');
  // completed runs of the last 7 hours (the API takes one status, so the conclusions are filtered here: R-WD-20), 100 a page
  assert.equal(reads[0].query.get('status'), 'completed');
  assert.equal(reads[0].query.get('created'), '>=2026-03-02T05:00:00Z');
  assert.equal(reads[0].query.get('per_page'), '100');
  w.cleanup();
});

test('R-WD-17: one failure on the image the nightly passed on is green; a failure on another image is amber, with the count, the image and the run link', async () => {
  const same = await selftestOf(selftestWorld([{ min: 30, image: '20261117.1' }]));
  assert.equal(same.status, 'green', same.summary);
  assert.match(same.summary, /1 sandbox self test failure in the last 6 hours/);
  const other = await selftestOf(selftestWorld([{ min: 30, image: '20261122.23.1' }]));
  assert.equal(other.status, 'amber', other.summary);
  assert.match(other.summary, /1 sandbox self test failure .* on runner image 20261122\.23\.1; the nightly last passed on 20261117\.1/);
  assert.equal(other.link, 'https://github.com/isokron-ai/mcp-check/actions/runs/800/job/9000');
});

test('R-WD-17: two failures in 6 hours are amber even on the nightly image; one older than 6 hours does not count', async () => {
  const two = await selftestOf(selftestWorld([{ min: 20, image: '20261117.1' }, { min: 200, image: '20261117.1' }]));
  assert.equal(two.status, 'amber', two.summary);
  assert.match(two.summary, /2 sandbox self test failures/);
  const old = await selftestOf(selftestWorld([{ min: 20, image: '20261117.1' }, { min: 7 * 60, image: '20261117.1' }]));
  assert.equal(old.status, 'green', old.summary);
});

test('R-WD-17: a log that cannot be read leaves the image unknown, which counts as an image the nightly has not passed on', async () => {
  const c = await selftestOf(selftestWorld([{ min: 30, image: 'x' }], { logStatus: 403 }));
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /on runner image unknown/);
});

test('R-WD-17: a failed lookup reads amber (could not read), never red, and the watchdog still writes the issue', async () => {
  const w = world({ seed: () => {} });
  w.api.routes.unshift(['GET', /\/actions\/workflows\/(live-probe|corpus)\.yml\/runs$/, () => ({ status: 500, body: {} })]);
  const out = await runWatchdog(w.opts);
  const c = parseBody(w.issues[0].body).checks.find((x) => x.id === 'sandbox-selftest');
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /could not read/);
  assert.notEqual(out.overall, 'red');
  w.cleanup();
});

test('R-WD-17: with no lane that runs third-party code enabled the item is off and nothing is read', async () => {
  const w = world({ seed: () => {} });
  w.opts.workerWorkflows = Object.fromEntries(Object.entries(SHIPPED).map(([k, v]) => [k, { ...v, enabled: v.runs_untrusted === false }]));
  const c = await selftestOf(w);
  assert.equal(c.status, 'off');
  assert.equal(w.api.calls.some((r) => /(mcp-check|mcp-writecheck-action)\/actions\/(workflows\/[^/]+\/runs|runs\/|jobs\/)/.test(r.path)), false);
  w.cleanup();
});

test('R-WD-17: the watchdog starts as a script with a stubbed environment (no module-level binding is used before it is initialised)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd17-'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../run.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: dir, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'x', APP_ID: '1', APP_INSTALLATION_ID: '1', APP_PRIVATE_KEY: 'not a key', GITHUB_API_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8', timeout: 20_000,
  });
  rmSync(dir, { recursive: true, force: true });
  assert.doesNotMatch(r.stderr, /before initialization|ReferenceError|SyntaxError|Cannot find module/, r.stderr);
  assert.equal(r.status, 1, 'it gets as far as minting the token, which the stub key refuses');
});

test('R-WD-17: the self-test reads use a second App token for the lanes\' repositories with actions: read only, and the job log read carries it', async () => {
  const w = selftestWorld([{ min: 30, image: '20261122.23.1' }]);
  const c = await selftestOf(w);
  assert.deepEqual(w.mints[1], { repositories: ['mcp-check', 'mcp-writecheck-action'], permissions: { actions: 'read' } });
  assert.equal(w.mints.length, 2);
  const log = w.api.calls.find((r) => r.path.endsWith('/logs'));
  assert.equal(log.headers.get('authorization'), 'Bearer ghs_synthetic_log_token');
  assert.match(c.summary, /runner image 20261122\.23\.1/);
  w.cleanup();
});

test('R-WD-17: when the log token cannot be minted the reads fall back to the job token and the item is amber with the reason (never red)', async () => {
  const w = selftestWorld([]);
  w.opts.logMintError = 'installation does not cover mcp-check';
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /installation does not cover mcp-check/);
  assert.equal(w.api.calls.find((r) => r.path.includes('/mcp-check/') && r.path.endsWith('/runs')).headers.get('authorization'), 'Bearer ghs_synthetic_job_token');
  w.cleanup();
});

test('R-WD-17: with no lane enabled no log token is minted', async () => {
  const w = world({ seed: () => {} });
  w.opts.workerWorkflows = Object.fromEntries(Object.entries(SHIPPED).map(([k, v]) => [k, { ...v, enabled: v.runs_untrusted === false }]));
  await runWatchdog(w.opts);
  assert.equal(w.mints.length, 1);
  w.cleanup();
});

const readsOf = (w) => w.api.calls.filter((r) => /isokron-ai\/(mcp-check|mcp-writecheck-action)\/actions\/(workflows\/[^/]+\/runs|runs\/|jobs\/)/.test(r.path));

test('R-WD-18: no failure found in a truncated run list is amber (list truncated), not green; a complete list stays green', async () => {
  const w = selftestWorld([]);
  // three full pages of finished, passing runs: the list is cut off at the page limit
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/workflows\/live-probe\.yml\/runs$/, () => ({
    body: { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, status: 'completed', conclusion: 'success' })) },
  })]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /truncated/);
  assert.equal(w.api.calls.filter((r) => r.path.endsWith('/live-probe.yml/runs')).length, 3, 'three pages, then it stops');
  w.cleanup();
});

test('R-WD-18: more failed runs than are examined and none showing a self-test failure is amber (list truncated)', async () => {
  const w = selftestWorld(Array.from({ length: 12 }, () => ({ min: 30, image: '20261117.1', jobName: 'sandbox / sandbox-selftest' })));
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/runs\/(\d+)\/jobs$/, () => ({ body: { jobs: [{ id: 1, name: 'sandbox / sandbox-selftest', conclusion: 'success', completed_at: new Date(w.c.t - 30 * MIN).toISOString() }] } })]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /truncated/);
  w.cleanup();
});

test('R-WD-19: the job log is read over two origins: the token goes to the API host only, the blob store gets no Authorization, and Range is sent on both hops', async () => {
  const w = selftestWorld([{ min: 30, image: '20261122.23.1' }]);
  const c = await selftestOf(w);
  const api = w.api.calls.find((r) => r.path.endsWith('/logs'));
  assert.match(api.headers.get('authorization'), /^Bearer ghs_synthetic_log_token$/);
  assert.match(api.headers.get('range'), /^bytes=0-\d+$/);
  assert.equal(w.blobCalls.length, 1);
  assert.equal(w.blobCalls[0].authorization, null, 'no token to the blob store');
  assert.match(w.blobCalls[0].range, /^bytes=0-\d+$/);
  assert.equal(w.blobCalls[0].redirect, 'error', 'the blob hop does not follow further redirects');
  assert.match(c.summary, /runner image 20261122\.23\.1/);
  w.cleanup();
});

test('R-WD-19: a blob answer that is not 200 or 206 leaves the image unknown', async () => {
  const w = selftestWorld([{ min: 30, image: '20261122.23.1' }]);
  const apiFetch = w.opts.fetch;
  w.opts.fetch = async (input, init) => (new URL(typeof input === 'string' ? input : input.url).host === 'blob.test' ? new Response('nope', { status: 403 }) : apiFetch(input, init));
  const c = await selftestOf(w);
  assert.match(c.summary, /runner image unknown/);
  w.cleanup();
});

test('R-WD-20: runs that timed out, failed to start or were cancelled are read too; a passing run is not', async () => {
  const w = selftestWorld([{ min: 10, image: '20261117.1', conclusion: 'timed_out' }, { min: 20, image: '20261117.1', conclusion: 'startup_failure' }, { min: 30, image: '20261117.1', conclusion: 'cancelled' }, { min: 40, image: '20261117.1', conclusion: 'success' }]);
  const c = await selftestOf(w);
  assert.match(c.summary, /3 sandbox self test failures/);
  const jobsRead = w.api.calls.filter((r) => /\/runs\/\d+\/jobs$/.test(r.path)).map((r) => r.path.match(/runs\/(\d+)/)[1]).sort();
  assert.deepEqual(jobsRead, ['800', '801', '802']);
  w.cleanup();
});

test('R-WD-20: the self-test job name pattern matches the real reusable-workflow job and not its siblings', async () => {
  const { SELFTEST } = await import('../selftest.mjs');
  // names from mcp-check run 45745127857
  assert.equal(SELFTEST.job.test('sandbox / sandbox-selftest'), true);
  // names from mcp-writecheck-action corpus.yml (the reusable workflow is called as `conformance`)
  assert.equal(SELFTEST.job.test('conformance / sandbox-selftest'), true);
  for (const other of ['x sandbox / sandbox-selftest', 'sandbox / sandbox-selftest-2', 'conformance / verdict', 'writecheck-guard', 'writecheck', 'live-probe-guard', 'sandbox / selftest-mutation (${{ matrix.disable }})', 'sandbox / verdict', 'live-probe']) assert.equal(SELFTEST.job.test(other), false, other);
});

test('R-WD-20: failed runs on a lane with no self-test job among their jobs read amber (self-test job not found), never green', async () => {
  const w = selftestWorld([{ min: 30, image: '20261117.1', jobName: 'sandbox / renamed-check' }]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /self-test job not found/);
  w.cleanup();
});

test('R-WD-21: a log token that cannot be minted with GITHUB_TOKEN unset reads amber with the reason, and the tool-qa App token is never used for the lanes\' repositories', async () => {
  const w = selftestWorld([{ min: 30, image: '20261117.1' }]);
  w.opts.logMintError = 'installation does not cover mcp-check';
  delete w.opts.env.GITHUB_TOKEN;
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /no token to read the lanes' runs/);
  assert.match(c.summary, /installation does not cover mcp-check/);
  assert.equal(readsOf(w).length, 0, 'nothing was read with the narrowed App token');
  w.cleanup();
});

test('R-WD-21: a 404 on a lane\'s runs list is amber (could not read), not an empty list', async () => {
  const w = selftestWorld([]);
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/workflows\/live-probe\.yml\/runs$/, () => ({ status: 404, body: { message: 'Not Found' } })]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /404/);
  w.cleanup();
});

test('R-WD-22: a failure found on one lane does not hide that another lane could not be read or was truncated: the item is amber', async () => {
  const flake = [{ min: 30, image: '20261117.1' }];
  // lane B (writecheck) 404s
  const a = selftestWorld(flake);
  a.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-writecheck-action\/actions\/workflows\/corpus\.yml\/runs$/, () => ({ status: 404, body: { message: 'Not Found' } })]);
  const ca = await selftestOf(a);
  assert.equal(ca.status, 'amber', ca.summary);
  assert.match(ca.summary, /could not read/);
  // lane B truncated: three full pages of passing runs
  const b = selftestWorld(flake);
  b.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-writecheck-action\/actions\/workflows\/corpus\.yml\/runs$/, () => ({ body: { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: 6000 + i, status: 'completed', conclusion: 'success' })) } })]);
  const cb = await selftestOf(b);
  assert.equal(cb.status, 'amber', cb.summary);
  assert.match(cb.summary, /at least/);
  // and with neither, the single flake on the nightly's image stays green
  const ok = await selftestOf(selftestWorld(flake));
  assert.equal(ok.status, 'green', ok.summary);
  a.cleanup(); b.cleanup();
});

test('R-WD-22: cancelled runs with no jobs are not evidence of a renamed self-test job', async () => {
  const w = selftestWorld([{ min: 30, image: '20261117.1', conclusion: 'cancelled' }]);
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/runs\/(\d+)\/jobs$/, () => ({ body: { jobs: [] } })]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'green', c.summary);
  w.cleanup();
});

test('R-WD-22: a 404 on a run\'s jobs call is amber (could not read)', async () => {
  const w = selftestWorld([{ min: 30, image: '20261117.1' }]);
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/runs\/(\d+)\/jobs$/, () => ({ status: 404, body: { message: 'Not Found' } })]);
  const c = await selftestOf(w);
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /jobs of run \d+ answered 404/);
  w.cleanup();
});

test('R-WD-22: a log redirect that is relative, http or missing leaves the image unknown and the blob store is not called', async () => {
  for (const location of ['/actions-results/0', 'http://blob.test/actions-results/0', null]) {
    const w = selftestWorld([{ min: 30, image: '20261122.23.1' }]);
    w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/jobs\/(\d+)\/logs$/, () => ({ status: 302, headers: location ? { location } : {} })]);
    const c = await selftestOf(w);
    assert.match(c.summary, /runner image unknown/, String(location));
    assert.equal(w.blobCalls.length, 0, String(location));
    w.cleanup();
  }
});

test('R-WD-23: the health issue is not green in the 27 Nov state (due 0, nothing dispatched for 7.5 hours, null shas), and shows the lane items', async () => {
  const w = world({ seed: (db, c) => {
    seedLaneState(db, { now: c.t, subjects: 60, versioned: false, dispatchAgeMin: 450, lanes: { 'live-probe': { ageMin: 443, n: 50, assessed: 20, tool: 30 }, 'scan-static': { ageMin: 925, n: 55, assessed: 50 } } });
    tick(db, c.t, { due: 0, dispatched: 0 });
  } });
  w.opts.noLanes = true;
  const out = await runWatchdog(w.opts);
  const checks = parseBody(w.issues[0].body).checks;
  const st = (id) => checks.find((x) => x.id === id)?.status;
  assert.notEqual(out.overall, 'green');
  for (const id of ['lane-fresh:live-probe', 'lane-fresh:scan-static', 'pump-idle', 'coverage:live-probe']) assert.ok(['amber', 'red'].includes(st(id)), `${id}: ${st(id)}`);
  assert.equal(st('external-workflows'), 'green');
  assert.equal(st('ingest-rejects'), 'green');
  assert.equal(st('oracle-disagreements'), 'green');
  w.cleanup();
});

test('R-WD-28: a disabled external workflow, and a failing read of one, show on the health issue (amber) without failing the run', async () => {
  const w = world({ seed: () => {} });
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-surface-corpus\/actions\/workflows\/conformance-nightly\.yml$/, () => ({ body: { state: 'disabled_inactivity' } })]);
  w.api.routes.unshift(['GET', /\/repos\/isokron-ai\/mcp-check\/actions\/workflows\/live-probe\.yml$/, () => ({ status: 500, body: {} })]);
  const out = await runWatchdog(w.opts);
  const c = parseBody(w.issues[0].body).checks.find((x) => x.id === 'external-workflows');
  assert.equal(c.status, 'amber');
  assert.match(c.summary, /conformance-nightly\.yml .*disabled by GitHub for inactivity/);
  assert.match(c.summary, /live-probe\.yml .*unreadable/);
  assert.notEqual(out.overall, 'red');
  w.cleanup();
});

test('R-WD-32: a red lane item never acts: the pump is not dispatched, no workflow is enabled or touched, no POST but the health issue', async () => {
  const w = world({ seed: (db, c) => {
    seedLaneState(db, { now: c.t, subjects: 20, versioned: false, dispatchAgeMin: 24 * 60, lanes: { 'scan-static': { ageMin: 30 * 60, n: 20, assessed: 2 } } });
    tick(db, c.t, { due: 3, dispatched: 0 });
  } });
  w.opts.noLanes = true;
  const out = await runWatchdog(w.opts);
  const checks = parseBody(w.issues[0].body).checks;
  assert.ok(checks.some((x) => x.id.startsWith('lane-fresh:') && x.status === 'red'), 'a lane item is red');
  assert.equal(out.actions.dispatchPump, false);
  assert.deepEqual(out.actions.enableWorkflows, []);
  const writes = w.api.calls.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(writes.filter((x) => !/\/issues(\/\d+)?(\/comments)?$/.test(x.split(' ')[1]) && !x.endsWith('/graphql')), []);
  w.cleanup();
});

test('R-WD-33: without GITHUB_TOKEN the external workflows are not read with the tool-qa App token: amber with the reason', async () => {
  const w = world({ seed: () => {} });
  delete w.opts.env.GITHUB_TOKEN;
  await runWatchdog(w.opts);
  const c = parseBody(w.issues[0].body).checks.find((x) => x.id === 'external-workflows');
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /GITHUB_TOKEN is unset/);
  assert.equal(w.api.calls.some((r) => /\/(mcp-check|mcp-writecheck-action|mcp-surface-corpus)\/actions\/workflows\/[^/]+\.ya?ml$/.test(r.path)), false);
  w.cleanup();
});

test('R-COV-46: the watchdog reads coverage from the state copy, and a config it cannot read gives null instead of stopping the run', async () => {
  const { readCoverage } = await import('../run.mjs');
  const { openState } = await import('../../state/db.mjs');
  const { loadConfig } = await import('../../pump/due.mjs');
  const db = openState(':memory:');
  db.setSubjectVersion({ id: 's1', kind: 'repo', source: 'seed-v1', tier: 0, name: 'o/s1', now: Date.parse('2026-11-27T00:00:00Z') });
  const cov = readCoverage(db, loadConfig());
  assert.equal(cov.schema, 'isokron-loop-coverage/1');
  assert.ok(cov.lanes.every((l) => l.id !== 'scan-deep' && l.id !== 'build-probe'), 'lanes not built are left out');
  assert.equal(readCoverage(db, { get tiers() { throw new Error('bad config'); }, workflows: {} }), null);
});

test('R-WD-34: through the whole watchdog, a tool-side skip holds the coverage item down: 7 assessed and 3 tool-side skips of 10 read 70%, not 100%', async () => {
  const w = world({ seed: (db, c) => {
    seedLaneState(db, { now: c.t, subjects: 10, dispatchAgeMin: 5, lanes: { 'scan-static': { ageMin: 5, n: 10, assessed: 7, tool: 3 } } });
  } });
  w.opts.noLanes = true;
  await runWatchdog(w.opts);
  const body = parseBody(w.issues[0].body);
  const c = body.checks.find((x) => x.id === 'coverage:scan-static');
  assert.equal(c.status, 'amber', c.summary);
  assert.match(c.summary, /^7 of 10 eligible subjects \(70%\)/);
  // the health issue's coverage table says the same number
  assert.equal(body.coverage.lanes.find((l) => l.id === 'scan-static').assessment, 0.7);
  w.cleanup();
});
