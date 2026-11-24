import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BREAKER, CONFORMANCE_URL, allowedWorkflows, breakerFrom, compareRuns, judgeConformance, pinMismatches, readCapped, readConformance, runProblems, runsUntrusted, statusProblems, untrustedWorkflows, verifyRun } from '../breaker.mjs';
import { greenStatus } from '../../test/lib/conformance.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const workflows = JSON.parse(readFileSync(new URL('../workflows.json', import.meta.url), 'utf8')).workflows;

test('R-WD-01: workflows.json marks every lane: live-probe, writecheck, build-probe and scan-deep run third-party code; scan-static and meta-* do not', () => {
  for (const [name, wf] of Object.entries(workflows)) assert.equal(typeof wf.runs_untrusted, 'boolean', `${name} says runs_untrusted`);
  assert.deepEqual(untrustedWorkflows(workflows), ['build-probe', 'live-probe', 'scan-deep', 'writecheck']);
  assert.deepEqual(Object.keys(allowedWorkflows(workflows, { tripped: true })).sort(), ['meta-github', 'meta-registry', 'scan-static']);
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

test('R-WD-04: the trusted set is pinned: exactly scan-static, meta-github and meta-registry say runs_untrusted false', () => {
  const trusted = Object.entries(workflows).filter(([, wf]) => wf.runs_untrusted === false).map(([n]) => n).sort();
  assert.deepEqual(trusted, ['meta-github', 'meta-registry', 'scan-static'], 'changing a lane to trusted needs this test changed, and review');
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
  const verify = async () => ({ ok: true, why: 't' });
  const s = (run_id, run_attempt) => ({ ...greenStatus(at), run_id, run_attempt });
  let j = await judgeConformance({ read: { status: s(200, 1) }, now: NOW, memory: null, verify });
  assert.equal(j.tripped, false);
  assert.deepEqual(j.memory.newest, { run_id: 200, run_attempt: 1, checked_at: s(200, 1).checked_at });
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

test('R-WD-08: a green status counts only when the public Actions API shows its run as a successful nightly on main of that commit; looked up once, with no token', async () => {
  const at = NOW - HOUR;
  const st = { ...greenStatus(at), run_id: 4242, run_attempt: 2 };
  const run = { id: 4242, run_attempt: 2, repository: { full_name: 'isokron-ai/mcp-surface-corpus' }, path: '.github/workflows/conformance-nightly.yml', head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', head_sha: st.sandbox_sha };
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

  // verifyRun: the attempts endpoint, no token, no cookie.
  const f = fakeFetch([new Response(JSON.stringify(run), { status: 200 })]);
  assert.deepEqual(await verifyRun({ fetch: f.fetch, status: st }), { ok: true, why: 'a successful nightly run on main of that commit' });
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/isokron-ai/mcp-surface-corpus/actions/runs/4242/attempts/2');
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), null);
  const nf = fakeFetch([new Response('{}', { status: 404 })]);
  assert.equal((await verifyRun({ fetch: nf.fetch, status: st })).ok, false);
  assert.equal((await verifyRun({ fetch: nf.fetch, status: { ...st, run_id: null } })).ok, false);

  // judgeConformance: unbacked green is unreadable; a verified run is remembered and not looked up again.
  let calls = 0;
  const bad = await judgeConformance({ read: { status: st }, now: NOW, memory: null, verify: async () => { calls += 1; return { ok: false, why: 'concluded failure' }; } });
  assert.equal(bad.tripped, true);
  assert.equal(bad.reason, 'unreadable');
  assert.match(bad.summary, /not backed by its run: concluded failure/);
  const good = await judgeConformance({ read: { status: st }, now: NOW, memory: null, verify: async () => { calls += 1; return { ok: true, why: 't' }; } });
  assert.equal(good.tripped, false);
  assert.deepEqual(good.memory.verified, { run_id: 4242, run_attempt: 2, checked_at: st.checked_at });
  const again = await judgeConformance({ read: { status: st }, now: NOW, memory: good.memory, verify: async () => { calls += 1; return { ok: false, why: 'x' }; } });
  assert.equal(again.tripped, false);
  assert.equal(calls, 2, 'the remembered run is not looked up again');
  // A red status needs no lookup: it trips anyway.
  const red = await judgeConformance({ read: { status: { ...st, run_id: 5000, ok: false, selftest: 'fail' } }, now: NOW, memory: null, verify: async () => { throw new Error('must not be called'); } });
  assert.equal(red.reason, 'red');
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
