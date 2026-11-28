import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BREAKER, CONFORMANCE_URL, allowedWorkflows, breakerFrom, compareRuns, judgeConformance, pinMismatches, readCapped, readConformance, runProblems, runsUntrusted, statusProblems, untrustedWorkflows, verifyRun } from '../breaker.mjs';
import { backed, greenStatus } from '../../test/lib/conformance.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const workflows = JSON.parse(readFileSync(new URL('../workflows.json', import.meta.url), 'utf8')).workflows;

test('R-WD-01: workflows.json marks every lane: live-probe, writecheck, build-probe and scan-deep run third-party code; scan-static, meta-* and release-diff do not', () => {
  for (const [name, wf] of Object.entries(workflows)) assert.equal(typeof wf.runs_untrusted, 'boolean', `${name} says runs_untrusted`);
  assert.deepEqual(untrustedWorkflows(workflows), ['build-probe', 'live-probe', 'scan-deep', 't0-dogfood', 'writecheck']);
  assert.deepEqual(Object.keys(allowedWorkflows(workflows, { tripped: true })).sort(), ['meta-github', 'meta-registry', 'release-diff', 'scan-static', 't0-defects', 't0-self']);
  assert.equal(allowedWorkflows(workflows, { tripped: false }), workflows);
  assert.equal(runsUntrusted({}), true, 'unsaid is untrusted');
  assert.equal(runsUntrusted({ runs_untrusted: 'false' }), true, 'only the boolean false is trusted');
  assert.deepEqual(untrustedWorkflows({ a: { enabled: true }, b: { enabled: false }, c: { enabled: true, runs_untrusted: false } }, { enabledOnly: true }), ['a']);
});

test('R-WD-01: the breaker is closed only on a well-formed, passing status checked within 36 hours', () => {
  const at = (h) => greenStatus(NOW - h * HOUR);
  assert.equal(breakerFrom({ read: { status: at(1) }, now: NOW }).tripped, false);
  assert.match(breakerFrom({ read: { status: at(1) }, now: NOW }).summary, /passed 60 minutes ago on ubuntu24\/20261117\.1, gVisor 20261116\.0/);
  assert.equal(breakerFrom({ read: { status: at(36) }, now: NOW }).tripped, false, 'exactly 36 hours is still fresh');
  const cases = [
    [{ status: at(36.01) }, 'stale'],
    [{ status: greenStatus(NOW + 11 * 60_000) }, 'stale'],
    [{ status: { ...at(1), ok: false } }, 'red'],
    [{ status: { ...at(1), ok: false, result: 'main_moved' } }, 'red'], // a green for a commit main had moved past: not ok, so open
    [{ status: { ...at(1), selftest: 'fail' } }, 'red'],
    [{ status: { ...at(1), mutations: 'skipped' } }, 'red'],
    [{ status: { ...at(1), mutations: 'fail', ok: true } }, 'red'],
    [{ status: { ...at(1), format: 'other/1' } }, 'unreadable'],
    [{ status: { ...at(1), checked_at: 'yesterday' } }, 'unreadable'],
    [{ status: null }, 'unreadable'],
    [{ error: 'HTTP 404' }, 'unreadable'],
    [null, 'unreadable'],
  ];
  for (const [read, reason] of cases) {
    const b = breakerFrom({ read, now: NOW });
    assert.equal(b.tripped, true, JSON.stringify(read)?.slice(0, 80));
    assert.equal(b.reason, reason, JSON.stringify(read)?.slice(0, 80));
  }
  assert.equal(breakerFrom({ read: { status: greenStatus(NOW + 5 * 60_000) }, now: NOW }).tripped, false, 'a few minutes of clock skew is fine');
  // Nothing odd from the file reaches the summary or the link.
  const odd = breakerFrom({ read: { status: { ...at(1), runner_image: 'x | y\n', run_url: 'https://evil.example/x' } }, now: NOW });
  assert.match(odd.summary, /on unknown,/);
  assert.equal(odd.run_url, null);
});

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

test('R-WD-01: the status is fetched without a token, followed through redirects, capped in size, retried once', async () => {
  const body = JSON.stringify(greenStatus(NOW));
  let f = fakeFetch([new Response(body, { status: 200 })]);
  const ok = await readConformance({ fetch: f.fetch, sleep: async () => {} });
  assert.equal(ok.status.ok, true);
  assert.equal(f.calls[0].url, CONFORMANCE_URL);
  assert.equal(f.calls[0].init.redirect, 'follow');
  const headers = new Headers(f.calls[0].init.headers);
  assert.equal(headers.get('authorization'), null, 'no token');
  assert.equal(headers.get('cookie'), null);
  assert.equal(CONFORMANCE_URL, 'https://github.com/isokron-ai/mcp-surface-corpus/releases/download/conformance/conformance-status.json');

  // The publisher replaces the asset: a 404 once is retried.
  f = fakeFetch([new Response('no', { status: 404 }), new Response(body, { status: 200 })]);
  assert.equal((await readConformance({ fetch: f.fetch, sleep: async () => {} })).status.ok, true);
  f = fakeFetch([new Response('no', { status: 404 }), new Response('no', { status: 404 })]);
  assert.deepEqual(await readConformance({ fetch: f.fetch, sleep: async () => {} }), { error: 'HTTP 404' });
  f = fakeFetch([new Error('getaddrinfo ENOTFOUND'), new Error('getaddrinfo ENOTFOUND')]);
  assert.match((await readConformance({ fetch: f.fetch, sleep: async () => {} })).error, /ENOTFOUND/);

  // Too large, not JSON, not a status: unreadable, without a retry.
  f = fakeFetch([new Response('x'.repeat(BREAKER.maxBytes + 1), { status: 200 })]);
  assert.match((await readConformance({ fetch: f.fetch, sleep: async () => {} })).error, /larger than/);
  f = fakeFetch([new Response('<html>', { status: 200 })]);
  assert.deepEqual(await readConformance({ fetch: f.fetch, sleep: async () => {} }), { error: 'not JSON' });
  f = fakeFetch([new Response('{"ok":true}', { status: 200 })]);
  assert.match((await readConformance({ fetch: f.fetch, sleep: async () => {} })).error, /not a well-formed status/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(statusProblems(greenStatus(NOW)), []);
});

test('R-WD-02: one isEnabled everywhere: only enabled === true dispatches; loadConfig refuses anything but real booleans', async () => {
  const { isEnabled, workflowProblems, loadConfig, computeDue } = await import('../due.mjs');
  for (const v of [true]) assert.equal(isEnabled({ enabled: v }), true);
  for (const v of [undefined, 'true', 1, 'yes', null, false]) assert.equal(isEnabled({ enabled: v }), false, String(v));
  // The breaker and the due list agree: a lane with enabled missing is neither held nor dispatched.
  assert.deepEqual(untrustedWorkflows({ a: { runs_untrusted: true }, b: { enabled: 'true', runs_untrusted: true }, c: { enabled: true, runs_untrusted: true } }, { enabledOnly: true }), ['c']);
  const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
  const lane = Object.keys(tiers.tiers.T1)[0];
  const due = (wf) => computeDue({ now: NOW, subjects: [{ id: 'npm:x', tier: 1, sha: 'a'.repeat(40) }], workflows: { [lane]: wf }, tiers, lastResults: new Map(), resultKeys: new Set(), inFlight: new Set(), parked: new Set() }).length;
  const base = { repo: 'o/r', file: 'x.yml', ref: 'main', runs_untrusted: true, sandbox_sha: null };
  assert.ok(due({ ...base, enabled: true }) > 0, 'enabled: due');
  for (const v of [undefined, 'true', 1]) assert.equal(due({ ...base, enabled: v }), 0, `enabled ${JSON.stringify(v)} is not dispatched`);
  // The real file passes; anything but a boolean, or a malformed sandbox_sha, is refused at load.
  assert.deepEqual(workflowProblems(workflows), []);
  assert.ok(loadConfig().workflows['live-probe']);
  assert.deepEqual(workflowProblems({ a: { enabled: 'true', runs_untrusted: false } }), ['a: enabled must be true or false']);
  assert.deepEqual(workflowProblems({ a: { enabled: true, runs_untrusted: 1, sandbox_sha: null } }), ['a: runs_untrusted must be true or false']);
  assert.deepEqual(workflowProblems({ a: { enabled: true } }), ['a: runs_untrusted must be true or false', 'a: sandbox_sha must be a full commit SHA or null']);
  assert.deepEqual(workflowProblems({ a: { enabled: false, runs_untrusted: true, sandbox_sha: 'main' } }), ['a: sandbox_sha must be a full commit SHA or null']);
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'wf-')), 'workflows.json');
  writeFileSync(f, JSON.stringify({ workflows: { a: { enabled: 1, runs_untrusted: true, sandbox_sha: null } } }));
  assert.throws(() => loadConfig({ workflowsPath: f }), /pump\/workflows\.json: a: enabled must be true or false/);
});

test('R-WD-04: the trusted set is pinned: exactly scan-static, meta-github, meta-registry, release-diff, t0-defects and t0-self say runs_untrusted false', () => {
  const trusted = Object.entries(workflows).filter(([, wf]) => wf.runs_untrusted === false).map(([n]) => n).sort();
  // release-diff reads package archives and source archives as data with our own readers; nothing from them runs.
  // t0-defects (tiny-tracker defect matrix) and t0-self (selftest, dogfood-tiny-tracker) run only our own code, installed with --ignore-scripts, in jobs with no secrets, one item per dispatch. The six dogfood workers that install npm trees with scripts, start Strapi or build upstream servers are t0-dogfood, which is untrusted (sandbox breaker gated).
  assert.deepEqual(trusted, ['meta-github', 'meta-registry', 'release-diff', 'scan-static', 't0-defects', 't0-self'], 'changing a lane to trusted needs this test changed, and review');
  for (const n of untrustedWorkflows(workflows)) assert.ok('sandbox_sha' in workflows[n], `${n} names the sandbox commit it pins (null until it does)`);
});

test('R-WD-06: the status body is read with a cap: reading stops at 16 KiB, it is never read whole first', async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(new Uint8Array(4096));
    },
  });
  const f = fakeFetch([new Response(endless, { status: 200 })]);
  assert.match((await readConformance({ fetch: f.fetch, sleep: async () => {} })).error, /larger than 16384 bytes/);
  assert.ok(pulled <= 6, `stopped after ${pulled} chunks of 4 KiB`);
  const lying = fakeFetch([new Response('x', { status: 200, headers: { 'content-length': '999999' } })]);
  assert.match((await readConformance({ fetch: lying.fetch, sleep: async () => {} })).error, /larger than/);
  assert.equal((await readCapped(new Response('abc'))).toString(), 'abc');
});

test('R-WD-07: a status older than one already seen is a rollback: unreadable, whatever it says', async () => {
  const at = NOW - HOUR;
  const verify = backed;
  const s = (run_id, run_attempt) => ({ ...greenStatus(at), run_id, run_attempt });
  let j = await judgeConformance({ read: { status: s(200, 1) }, now: NOW, memory: null, verify });
  assert.equal(j.tripped, false);
  assert.deepEqual([j.memory.newest.run_id, j.memory.newest.run_attempt, j.memory.newest.checked_at], [200, 1, s(200, 1).checked_at]);
  assert.equal(j.changed, true);
  for (const [old, why] of [[s(100, 3), 'an older run'], [{ ...s(200, 1), run_attempt: 1, run_id: 199 }, 'an older run id']]) {
    const r = await judgeConformance({ read: { status: old }, now: NOW, memory: j.memory, verify });
    assert.equal(r.tripped, true, why);
    assert.equal(r.reason, 'unreadable');
    assert.match(r.summary, /went back to run \d+ attempt \d+, older than run 200 attempt 1 already seen/);
  }
  // A red older run is refused the same way; a later attempt or run moves on.
  assert.equal((await judgeConformance({ read: { status: { ...s(150, 1), ok: false, selftest: 'fail' } }, now: NOW, memory: j.memory, verify })).summary.includes('went back'), true);
  j = await judgeConformance({ read: { status: s(200, 2) }, now: NOW, memory: j.memory, verify });
  assert.equal(j.tripped, false);
  assert.equal(j.memory.newest.run_attempt, 2);
  assert.equal(compareRuns({ run_id: 2, run_attempt: 1 }, { run_id: 1, run_attempt: 9 }), 1);
});

test('R-WD-08: a green status counts only when the Actions API shows its run as a successful nightly on main of that commit; looked up once', async () => {
  const at = NOW - HOUR;
  const st = { ...greenStatus(at), run_id: 4242, run_attempt: 2 };
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const run = { id: 4242, run_attempt: 2, repository: { full_name: 'isokron-ai/mcp-surface-corpus' }, path: '.github/workflows/conformance-nightly.yml', head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', head_sha: st.sandbox_sha, run_started_at: iso(at - 20 * 60_000), updated_at: iso(at + 2 * 60_000) };
  assert.deepEqual(runProblems(run, st), []);
  assert.deepEqual(runProblems({ ...run, event: 'workflow_dispatch' }, st), []);
  for (const [over, want] of [
    [{ path: '.github/workflows/other.yml' }, /not \.github\/workflows\/conformance-nightly\.yml/],
    [{ head_branch: 'evil' }, /not on main/],
    [{ event: 'push' }, /started by push/],
    [{ conclusion: 'failure' }, /concluded failure/],
    [{ status: 'in_progress', conclusion: null }, /not finished yet/],
    [{ head_sha: 'b'.repeat(40) }, /another commit/],
    [{ repository: { full_name: 'someone/fork' } }, /another repository/],
    [{ run_attempt: 1 }, /another attempt/],
  ]) assert.match(runProblems({ ...run, ...over }, st).join(', '), want);
  // A red status needs the identity only.
  assert.deepEqual(runProblems({ ...run, conclusion: 'failure' }, st, { conclusion: false }), []);

  // verifyRun: the attempt, then the commit is on main.
  const f = fakeFetch([new Response(JSON.stringify(run), { status: 200 }), new Response(JSON.stringify({ status: 'behind' }), { status: 200 })]);
  const v = await verifyRun({ fetch: f.fetch, status: st });
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.run, { started_at: run.run_started_at, updated_at: run.updated_at });
  assert.deepEqual(f.calls.map((c) => c.url), [
    'https://api.github.com/repos/isokron-ai/mcp-surface-corpus/actions/runs/4242/attempts/2',
    `https://api.github.com/repos/isokron-ai/mcp-surface-corpus/compare/main...${st.sandbox_sha}`,
  ]);
  const nf = fakeFetch([new Response('{}', { status: 404 })]);
  assert.equal((await verifyRun({ fetch: nf.fetch, status: st })).ok, false);
  assert.equal((await verifyRun({ fetch: nf.fetch, status: { ...st, run_id: null } })).ok, false);

  // judgeConformance: unbacked green is unreadable; a verified run is remembered and not looked up again.
  let calls = 0;
  const bad = await judgeConformance({ read: { status: st }, now: NOW, memory: null, verify: async () => { calls += 1; return { ok: false, why: 'concluded failure' }; } });
  assert.equal(bad.tripped, true);
  assert.equal(bad.reason, 'unreadable');
  assert.match(bad.summary, /not backed by its run: concluded failure/);
  assert.equal(bad.memory.newest, null, 'nothing remembered from an unbacked status');
  const good = await judgeConformance({ read: { status: st }, now: NOW, memory: null, verify: async (x, o) => { calls += 1; assert.equal(o.conclusion, true); return { ok: true, why: 't', run: v.run }; } });
  assert.equal(good.tripped, false, good.summary);
  assert.deepEqual(good.memory.verified, { run_id: 4242, run_attempt: 2, checked_at: st.checked_at, started_at: run.run_started_at, updated_at: run.updated_at });
  const again = await judgeConformance({ read: { status: st }, now: NOW, memory: good.memory, verify: async () => { calls += 1; return { ok: false, why: 'x' }; } });
  assert.equal(again.tripped, false);
  assert.equal(calls, 2, 'the remembered run is not looked up again');
});

test('R-WD-09: a forged red status cannot poison the rollback memory: nothing is remembered before its run\'s identity is verified', async () => {
  const at = NOW - HOUR;
  const forged = { ...greenStatus(at), run_id: Number.MAX_SAFE_INTEGER, run_attempt: 1, ok: false, selftest: 'fail' };
  const r = await judgeConformance({ read: { status: forged }, now: NOW, memory: null, verify: async (x, o) => { assert.equal(o.conclusion, false, 'a red needs its identity only'); return { ok: false, why: 'the Actions API answered HTTP 404' }; } });
  assert.equal(r.tripped, true);
  assert.equal(r.memory.newest, null);
  assert.equal(r.changed, false);
  // The real nightly afterwards still closes the breaker.
  const real = { ...greenStatus(at), run_id: 500, run_attempt: 1 };
  const ok = await judgeConformance({ read: { status: real }, now: NOW, memory: r.memory, verify: backed });
  assert.equal(ok.tripped, false, ok.summary);
  // A real red (identity verified, conclusion failure) is remembered as the newest.
  const red = { ...greenStatus(at), run_id: 600, run_attempt: 1, ok: false, selftest: 'fail' };
  const rr = await judgeConformance({ read: { status: red }, now: NOW, memory: ok.memory, verify: backed });
  assert.equal(rr.reason, 'red');
  assert.equal(rr.memory.newest.run_id, 600);
});

test('R-WD-10: a green status is aged by its verified run, not its own checked_at: a replay with a fresh date is stale, and a date outside the run is refused', async () => {
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const oldStart = NOW - 40 * HOUR;
  const st = { ...greenStatus(oldStart + 10 * 60_000), run_id: 700, run_attempt: 1 };
  const runTimes = { started_at: iso(oldStart), updated_at: iso(oldStart + 30 * 60_000) };
  const first = await judgeConformance({ read: { status: st }, now: oldStart + HOUR, memory: null, verify: async () => ({ ok: true, why: 't', run: runTimes }) });
  assert.equal(first.tripped, false);
  // The same run replayed with checked_at = now: the remembered run's start decides.
  const replay = { ...st, checked_at: iso(NOW - 60_000) };
  const r = await judgeConformance({ read: { status: replay }, now: NOW, memory: first.memory, verify: async () => { throw new Error('not looked up again'); } });
  assert.equal(r.tripped, true);
  assert.equal(r.reason, 'stale');
  // Looked up fresh, a checked_at outside the run's own times is refused.
  const run = { id: 700, run_attempt: 1, repository: { full_name: 'isokron-ai/mcp-surface-corpus' }, path: '.github/workflows/conformance-nightly.yml', head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', head_sha: st.sandbox_sha, run_started_at: runTimes.started_at, updated_at: runTimes.updated_at };
  assert.match(runProblems(run, replay).join(), /checked_at .* is not within the run/);
  assert.deepEqual(runProblems(run, st), []);
});

test('R-WD-11: the run lookup sends the job token to api.github.com only; the status file is fetched with none', async () => {
  const at = NOW - HOUR;
  const st = { ...greenStatus(at), run_id: 1, run_attempt: 1 };
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const run = { id: 1, run_attempt: 1, repository: { full_name: 'isokron-ai/mcp-surface-corpus' }, path: '.github/workflows/conformance-nightly.yml', head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', head_sha: st.sandbox_sha, run_started_at: iso(at - 60_000), updated_at: iso(at + 60_000) };
  const f = fakeFetch([new Response(JSON.stringify(run)), new Response(JSON.stringify({ status: 'identical' }))]);
  await verifyRun({ fetch: f.fetch, status: st, token: 'ghs_job_token' });
  for (const c of f.calls) {
    assert.ok(c.url.startsWith('https://api.github.com/'));
    assert.equal(new Headers(c.init.headers).get('authorization'), 'Bearer ghs_job_token');
  }
  const g = fakeFetch([new Response(JSON.stringify(run)), new Response(JSON.stringify({ status: 'identical' }))]);
  await verifyRun({ fetch: g.fetch, status: st });
  assert.equal(new Headers(g.calls[0].init.headers).get('authorization'), null, 'no token given, none sent');
});

test('R-WD-12: a commit that is not on main (a tag named main, a branch) does not back a status', async () => {
  const at = NOW - HOUR;
  const st = { ...greenStatus(at), run_id: 1, run_attempt: 1 };
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const run = { id: 1, run_attempt: 1, repository: { full_name: 'isokron-ai/mcp-surface-corpus' }, path: '.github/workflows/conformance-nightly.yml', head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: st.sandbox_sha, run_started_at: iso(at - 60_000), updated_at: iso(at + 60_000) };
  for (const status of ['ahead', 'diverged']) {
    const f = fakeFetch([new Response(JSON.stringify(run)), new Response(JSON.stringify({ status }))]);
    const v = await verifyRun({ fetch: f.fetch, status: st });
    assert.equal(v.ok, false, status);
    assert.match(v.why, /is not on main/);
  }
  for (const status of ['identical', 'behind']) {
    const f = fakeFetch([new Response(JSON.stringify(run)), new Response(JSON.stringify({ status }))]);
    assert.equal((await verifyRun({ fetch: f.fetch, status: st })).ok, true, status);
  }
  const nf = fakeFetch([new Response(JSON.stringify(run)), new Response('{}', { status: 404 })]);
  assert.equal((await verifyRun({ fetch: nf.fetch, status: st })).ok, false, 'unknown commit');
});

test('R-WD-13: the committed workflows.json loads under the validation', async () => {
  const { loadConfig } = await import('../due.mjs');
  const cfg = loadConfig();
  assert.deepEqual(Object.keys(cfg.workflows).sort(), Object.keys(workflows).sort());
  for (const wf of Object.values(cfg.workflows)) {
    assert.equal(typeof wf.enabled, 'boolean');
    assert.equal(typeof wf.runs_untrusted, 'boolean');
  }
});

test('R-WD-03: lanes pinned at another sandbox commit than the one the nightly tested are named (amber), not held', () => {
  const wfs = {
    'live-probe': { enabled: true, runs_untrusted: true, sandbox_sha: 'a'.repeat(40) },
    writecheck: { enabled: true, runs_untrusted: true, sandbox_sha: null },
    'build-probe': { enabled: false, runs_untrusted: true, sandbox_sha: 'c'.repeat(40) },
    'scan-static': { enabled: true, runs_untrusted: false },
  };
  assert.deepEqual(pinMismatches(wfs, 'a'.repeat(40)), [{ lane: 'writecheck', pins: null, tested: 'a'.repeat(40) }]);
  assert.deepEqual(pinMismatches(wfs, 'b'.repeat(40)).map((m) => m.lane), ['live-probe', 'writecheck']);
  assert.deepEqual(allowedWorkflows(wfs, { tripped: false }), wfs, 'a mismatch alone holds nothing');
});
