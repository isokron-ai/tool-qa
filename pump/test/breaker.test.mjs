import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BREAKER, CONFORMANCE_URL, allowedWorkflows, breakerFrom, readConformance, runsUntrusted, statusProblems, untrustedWorkflows } from '../breaker.mjs';
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
