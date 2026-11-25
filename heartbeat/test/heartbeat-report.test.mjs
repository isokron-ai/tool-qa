import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { tick, report, WATCH } from '../worker.mjs';
import { appendDecisions, mapComponents, allowlistHealth, RING } from '../report.mjs';
import { scanObject } from '../scan.mjs';

const NOW = Date.parse('2026-11-25T17:00:00Z');
const ISO = new Date(NOW).toISOString();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const vendor = ['cl', 'aude'].join(''); // split, as in the scanner, so this file does not match its own check

const CHECKS = [
  { id: 'pump', status: 'green', summary: 'a pump run is in progress (started 18 minutes ago) see https://github.com/isokron-ai/tool-qa/actions/runs/45710892172', link: 'https://github.com/isokron-ai/tool-qa/actions/runs/45710892172' },
  { id: 'history-registry-delta', status: 'green', summary: 'newest registry-delta artifact is from 8 minutes ago' },
  { id: 'slots', status: 'green', summary: '2 of 2 worker slots in use' },
  { id: 'dispatches', status: 'amber', summary: '2 dispatches waiting for results' },
  { id: 'pump-successor', status: 'green', summary: 'the pump dispatched its successor', at: '2026-11-25T22:20:49.107Z' },
  { id: 'state-size', status: 'green', summary: 'database 10.4 MB; attempts 4337', at: '2026-11-25T22:20:21.783Z' },
  { id: 'subjects', status: 'green', summary: 'seed-v1 already loaded (997 subjects)', at: '2026-11-25T22:20:52.735Z' },
  { id: 'run:pump', status: 'green', summary: 'latest pump.yml run succeeded', link: 'https://github.com/isokron-ai/tool-qa/actions/runs/45709323228' },
  { id: 'sandbox-breaker', status: 'green', summary: 'closed: sandbox conformance passed 9.0 hours ago, run https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/45624243240', link: 'https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/45624243240' },
  { id: 'archive', status: 'green', summary: 'last good archive pull 99 minutes ago (pulled 73)', at: '2026-11-25T20:49:34.170Z' },
];
const BODY = (checks = CHECKS) => `<!-- loop-health:v1 ${JSON.stringify({ overall: 'green', updated: '2026-11-25T22:28:27.862Z', checks, secret_extra: 'x' })} -->\n\n**Overall: green**\n\nUpdated by the loop watchdog.\n`;
const STATUS = { components: [{ name: 'Actions', status: 'degraded_performance' }, { name: 'API Requests', status: 'operational' }, { name: 'Git Operations', status: 'operational' }, { name: 'Webhooks', status: 'partial_outage' }, { name: 'Copilot', status: 'major_outage' }] };

function fakeR2(initial) {
  const store = new Map(initial === undefined ? [] : [['v1/heartbeat.json', initial]]);
  const r = { puts: [], store, get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null), put: async (k, v, o) => { r.puts.push({ k, v, o }); store.set(k, v); } };
  return r;
}
function fakeNet({ status = STATUS, issue = BODY(), statusHttp = 200, issueHttp = 200, noTokenOnly = false, throwStatus = false, throwIssue = false } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.authorization });
    if (url.includes('githubstatus.com')) { if (throwStatus) throw new TypeError('fetch failed'); return res(statusHttp, status); }
    if (url.endsWith('/issues/40')) {
      if (throwIssue) throw new TypeError('fetch failed');
      if (noTokenOnly && init.headers.authorization) return res(403, {});
      return res(issueHttp, { body: issue, title: 'x', user: { login: 'someone' } });
    }
    throw new Error('unexpected ' + url);
  };
  f.calls = calls; return f;
}
const written = (r2) => JSON.parse(r2.puts[0].v);

test('report: githubstatus components map to actions, api, git, webhooks; others and odd values are dropped', () => {
  assert.deepEqual(mapComponents(STATUS), { actions: 'degraded_performance', api: 'operational', git: 'operational', webhooks: 'partial_outage' });
  assert.deepEqual(mapComponents({ components: [{ name: 'Actions', status: 'weird' }] }), { actions: 'unknown', api: 'unknown', git: 'unknown', webhooks: 'unknown' });
  assert.equal(mapComponents({}), null);
});

test('report: the health block is parsed and allowlisted: only id, status, at, and summaries of allowlisted checks; no links, run URLs or extra fields', () => {
  const h = allowlistHealth(BODY());
  assert.deepEqual(Object.keys(h).sort(), ['checks', 'overall', 'updated']);
  const byId = Object.fromEntries(h.checks.map((c) => [c.id, c]));
  for (const c of h.checks) for (const k of Object.keys(c)) assert.ok(['id', 'status', 'at', 'summary'].includes(k), k);
  for (const id of ['pump', 'slots', 'dispatches', 'history-registry-delta', 'sandbox-breaker']) assert.ok(byId[id].summary, id);
  for (const id of ['pump-successor', 'state-size', 'subjects', 'run:pump', 'archive']) assert.ok(!('summary' in byId[id]), id + ' has no summary');
  assert.equal(byId['pump-successor'].at, '2026-11-25T22:20:49.107Z');
  assert.ok(!JSON.stringify(h).includes('http'), 'no URL survives');
  assert.ok(!JSON.stringify(h).includes('secret_extra'));
  assert.equal(allowlistHealth('no block here'), null);
  assert.equal(allowlistHealth('<!-- loop-health:v1 {not json} -->'), null);
});

test('report: the written file has the schema, checked_at, decisions, github and health, with the right headers', async () => {
  const r2 = fakeR2(); const f = fakeNet();
  const out = await report({ env: { GH_TOKEN: 't0ken', LIVE: r2 }, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'restarted', http: 204 }], fetch: f, now: NOW });
  assert.deepEqual(out, { written: true });
  assert.equal(r2.puts.length, 1);
  assert.equal(r2.puts[0].k, 'v1/heartbeat.json');
  assert.deepEqual(r2.puts[0].o, { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' } });
  const j = written(r2);
  assert.equal(j.schema, 'isokron-loop-heartbeat/1');
  assert.equal(j.checked_at, ISO);
  assert.deepEqual(j.decisions, [{ at: ISO, workflow: 'pump.yml', action: 'restarted', http: 204 }]);
  assert.equal(j.github.components.webhooks, 'partial_outage');
  assert.equal(j.health.overall, 'green');
  assert.equal(f.calls.find((c) => c.url.endsWith('/issues/40')).auth, 'Bearer t0ken');
});

test('report: an issue read refused with the token (401, 403, 404) is retried once without it', async () => {
  const f = fakeNet({ noTokenOnly: true });
  const r2 = fakeR2();
  await report({ env: { GH_TOKEN: 't0ken', LIVE: r2 }, fetch: f, now: NOW });
  const issueCalls = f.calls.filter((c) => c.url.endsWith('/issues/40'));
  assert.equal(issueCalls.length, 2);
  assert.ok(issueCalls[0].auth && !issueCalls[1].auth);
  assert.equal(written(r2).health.overall, 'green');
  const g = fakeNet({ issueHttp: 500 }); // a 500 is not retried
  await report({ env: { GH_TOKEN: 't0ken', LIVE: fakeR2() }, fetch: g, now: NOW });
  assert.equal(g.calls.filter((c) => c.url.endsWith('/issues/40')).length, 1);
});

test('report: the decisions ring keeps the newest 48, across runs', async () => {
  const mk = (i) => ({ at: new Date(NOW + i * 1000).toISOString(), workflow: 'pump.yml', action: 'restarted', http: 204 });
  const r2 = fakeR2();
  await report({ env: { LIVE: r2 }, decisions: Array.from({ length: 40 }, (_, i) => mk(i)), fetch: fakeNet(), now: NOW });
  await report({ env: { LIVE: r2 }, decisions: Array.from({ length: 30 }, (_, i) => mk(40 + i)), fetch: fakeNet(), now: NOW });
  const d = JSON.parse(r2.store.get('v1/heartbeat.json')).decisions;
  assert.equal(RING, 48);
  assert.equal(d.length, 48);
  assert.equal(d[0].at, mk(22).at);
  assert.equal(d[47].at, mk(69).at);
  assert.equal(appendDecisions(null, [{ bogus: true }, { at: 'x', workflow: 'w', action: 'ok' }]).length, 0);
});

test('report: ok and skipped_switch decisions are written when they change, restarts and failures always', () => {
  const d = (action, i = 0) => ({ at: ago(10 - i), workflow: 'pump.yml', action });
  let ring = appendDecisions([], [d('ok')]);
  ring = appendDecisions(ring, [d('ok', 1), d('ok', 2)]);
  assert.equal(ring.length, 1);
  ring = appendDecisions(ring, [d('restarted', 3), d('restarted', 4), d('ok', 5), d('skipped_switch', 6), d('skipped_switch', 7)]);
  assert.deepEqual(ring.map((x) => x.action), ['ok', 'restarted', 'restarted', 'ok', 'skipped_switch']);
});

test('report: a secret or a vendor name anywhere in the output blocks the write and the log names the rule, not the text', async () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const cases = [
    ['github-token', [{ id: 'pump', status: 'green', summary: 'leak ' + token }]],
    ['email', [{ id: 'slots', status: 'green', summary: 'mail someone@somewhere-real.org' }]],
    ['vendor-name', [{ id: 'dispatches', status: 'green', summary: 'worker by ' + vendor + ' ok' }]],
  ];
  for (const [rule, checks] of cases) {
    const r2 = fakeR2(); const logged = [];
    const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
    let out; try { out = await report({ env: { LIVE: r2 }, fetch: fakeNet({ issue: BODY(checks) }), now: NOW }); } finally { console.log = orig; }
    assert.deepEqual(out, { written: false, blocked: rule });
    assert.equal(r2.puts.length, 0, rule + ' wrote');
    const text = logged.join('\n');
    assert.ok(text.includes(rule));
    assert.ok(!text.includes(token) && !text.includes('somewhere-real') && !text.includes(vendor));
  }
  assert.deepEqual(scanObject({ a: ['clean text', { b: 'fine' }] }), []);
});

test('report: each external failure degrades its own section to {error: "unavailable", checked_at}; the write still happens', async () => {
  const cases = [
    { net: { throwStatus: true }, github: true }, { net: { statusHttp: 503 }, github: true }, { net: { status: { components: 'nope' } }, github: true },
    { net: { throwIssue: true }, health: true }, { net: { issueHttp: 502 }, health: true }, { net: { issue: 'no block' }, health: true },
  ];
  for (const c of cases) {
    const r2 = fakeR2();
    await report({ env: { GH_TOKEN: 't', LIVE: r2 }, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'ok' }], fetch: fakeNet(c.net), now: NOW });
    const j = written(r2);
    assert.deepEqual(c.github ? j.github : j.health, { error: 'unavailable', checked_at: ISO });
    assert.ok(!('error' in (c.github ? j.health : j.github)), 'the other section is intact');
    assert.equal(j.decisions.length, 1);
  }
});

test('report: a corrupt previous file starts a fresh ring instead of failing', async () => {
  const r2 = fakeR2('{not json');
  await report({ env: { LIVE: r2 }, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'failed', http: 500 }], fetch: fakeNet(), now: NOW });
  assert.equal(written(r2).decisions.length, 1);
});

// --- tick's structured decisions, and isolation of the report ---------------------------------------------------------
const PW = WATCH.slice(0, 2);
function fakeGitHub({ loop = 'true', vars = {}, runs = {}, dispatchStatus = 204, listFail = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(init.method + ' ' + u.pathname);
    if (u.pathname.endsWith('/actions/variables')) { const all = { LOOP_ENABLED: loop, ...vars }; return res(200, { total_count: Object.keys(all).length, variables: Object.entries(all).map(([name, value]) => ({ name, value })) }); }
    const m = /\/workflows\/([^/]+)\/(runs|dispatches)$/.exec(u.pathname);
    if (m[2] === 'runs') return listFail ? res(500, {}) : res(200, { workflow_runs: runs[m[1]] || [] });
    return res(dispatchStatus, null);
  };
  f.calls = calls; return f;
}
const stale = { 'pump.yml': [{ status: 'completed', created_at: ago(300) }], 'watchdog.yml': [{ status: 'completed', created_at: ago(5) }] };

test('tick: returns decisions {at, workflow, action, http?} beside its log: ok, restarted, failed, skipped_switch', async () => {
  const run = (o) => tick({ token: 't0ken', enabled: 'true', now: NOW, watch: PW, ...o });
  let log = await run({ fetch: fakeGitHub({ runs: stale }) });
  assert.ok(Array.isArray(log) && log.every((l) => typeof l === 'string'), 'the log is still a plain array of lines');
  assert.deepEqual(log.decisions, [{ at: ISO, workflow: 'pump.yml', action: 'restarted', http: 204 }, { at: ISO, workflow: 'watchdog.yml', action: 'ok' }]);
  log = await run({ fetch: fakeGitHub({ runs: stale, dispatchStatus: 500 }) });
  assert.deepEqual(log.decisions[0], { at: ISO, workflow: 'pump.yml', action: 'failed', http: 500 });
  log = await run({ fetch: fakeGitHub({ runs: stale, vars: { LANE_PUMP_ENABLED: 'false' } }) });
  assert.deepEqual(log.decisions.map((d) => d.action), ['skipped_switch', 'ok']);
  log = await run({ fetch: fakeGitHub({ loop: 'false' }) });
  assert.deepEqual(log.decisions.map((d) => d.action), ['skipped_switch', 'skipped_switch']);
  log = await run({ fetch: fakeGitHub({ listFail: true }) });
  assert.deepEqual(log.decisions[0], { at: ISO, workflow: 'pump.yml', action: 'failed', http: 500 });
});

function fakeCtx() { const p = []; return { p, waitUntil: (x) => p.push(x) }; }
function stubGlobals(gh, extra) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.github.com') && !String(url).endsWith('/issues/40') ? gh(url, init) : extra(url, init));
  return () => { globalThis.fetch = orig; };
}

test('scheduled: the report runs in its own waitUntil and a throwing report changes nothing tick does', async () => {
  const gh = fakeGitHub({ runs: stale });
  const restore = stubGlobals(gh, async () => { throw new Error('boom'); });
  const orig = console.log; const logged = []; console.log = (...a) => logged.push(a.join(' '));
  try {
    const boom = { get: async () => { throw new Error('r2 down'); }, put: async () => { throw new Error('r2 down'); } };
    const ctx = fakeCtx();
    await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', REPORT_ENABLED: 'true', LIVE: boom }, ctx);
    assert.equal(ctx.p.length, 2, 'tick and report each have their own waitUntil');
    const settled = await Promise.allSettled(ctx.p);
    assert.equal(settled[0].status, 'fulfilled', 'the tick promise is untouched by the report');
    assert.equal(settled[1].status, 'fulfilled', 'the report failure is caught and logged');
    assert.ok(gh.calls.includes('POST /repos/isokron-ai/tool-qa/actions/workflows/pump.yml/dispatches'), 'the dispatch still happened');
    assert.ok(logged.some((l) => /heartbeat report: failed/.test(l)));
    // the same tick without a report does exactly the same calls
    const gh2 = fakeGitHub({ runs: stale }); restore(); const r2 = stubGlobals(gh2, async () => { throw new Error('x'); });
    try { await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true' }, fakeCtx()); await new Promise((r) => setTimeout(r, 20)); } finally { r2(); }
    assert.deepEqual(gh.calls, gh2.calls);
  } finally { console.log = orig; restore(); }
});

test('scheduled: no report unless REPORT_ENABLED is exactly "true" and LIVE is bound', async () => {
  for (const env of [{ REPORT_ENABLED: 'false', LIVE: fakeR2() }, { REPORT_ENABLED: 'TRUE', LIVE: fakeR2() }, { REPORT_ENABLED: 'true' }, { LIVE: fakeR2() }]) {
    const restore = stubGlobals(fakeGitHub({ runs: stale }), async () => { throw new Error('no network for the report'); });
    try {
      const ctx = fakeCtx();
      await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', ...env }, ctx);
      assert.equal(ctx.p.length, 1);
      await Promise.all(ctx.p);
      if (env.LIVE) assert.equal(env.LIVE.puts.length, 0);
    } finally { restore(); }
  }
});

test('scheduled: with the report on, a healthy end-to-end run writes heartbeat.json with the tick decisions', async () => {
  const r2 = fakeR2();
  const restore = stubGlobals(fakeGitHub({ runs: stale }), fakeNet());
  try {
    const ctx = fakeCtx();
    await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', REPORT_ENABLED: 'true', LIVE: r2 }, ctx);
    await Promise.all(ctx.p);
  } finally { restore(); }
  const j = written(r2);
  assert.ok(j.decisions.some((d) => d.workflow === 'pump.yml' && d.action === 'restarted'));
  assert.equal(j.health.overall, 'green');
});

test('wrangler.toml: the LIVE bucket binding is declared and the report is off by default', () => {
  const t = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(t, /\[\[r2_buckets\]\]\s+binding = "LIVE"\s+bucket_name = "isokron-loop-live"/);
  assert.match(t, /^REPORT_ENABLED = "false"$/m);
});

test('report: no AI vendor or model name in the heartbeat folder (R-PUB-08 word list)', () => {
  const words = [['cl', 'aude'], ['anthr', 'opic'], ['open', 'ai'], ['gp', 't-'], ['gem', 'ini'], ['op', 'us '], ['son', 'net'], ['ha', 'iku'], ['chat', 'gpt'], ['gr', 'ok']].map((p) => p.join(''));
  const re = new RegExp(words.join('|'), 'i');
  for (const f of ['worker.mjs', 'report.mjs', 'scan.mjs', 'wrangler.toml', 'README.md', 'test/heartbeat-report.test.mjs']) {
    assert.ok(!re.test(readFileSync(new URL('../' + f, import.meta.url), 'utf8')), f);
  }
});
