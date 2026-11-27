import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import worker, { tick, WATCH } from '../worker.mjs';
import { report, appendDecisions, mapComponents, allowlistHealth, RING } from '../report.mjs';
import { scanObject, scanBody, RULES } from '../scan.mjs';

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

function fakeR2(initial, { size } = {}) {
  let n = 0; const etags = new Map();
  const store = new Map();
  if (initial !== undefined) { store.set('v1/heartbeat.json', initial); etags.set('v1/heartbeat.json', 'e' + n++); }
  const r = {
    puts: [], gets: 0, store, raceOnce: false,
    get: async (k) => { r.gets++; return store.has(k) ? { etag: etags.get(k), size: size ?? store.get(k).length, text: async () => store.get(k) } : null; },
    put: async (k, v, o) => {
      if (r.raceOnce) { r.raceOnce = false; store.set(k, '{"decisions":[]}'); etags.set(k, 'e' + n++); }
      const have = etags.get(k);
      if (o && o.onlyIf) {
        if (o.onlyIf.etagMatches && o.onlyIf.etagMatches !== have) return null;
        if (o.onlyIf.etagDoesNotMatch === '*' && have) return null;
      }
      r.puts.push({ k, v, o }); store.set(k, v); etags.set(k, 'e' + n++); return {};
    },
  };
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
const j0 = written;

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
  const out = await report({ env: { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', LIVE: r2 }, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'restarted', http: 204 }], fetch: f, now: NOW });
  assert.deepEqual(out, { written: true });
  assert.equal(r2.puts.length, 1);
  assert.equal(r2.puts[0].k, 'v1/heartbeat.json');
  assert.deepEqual(r2.puts[0].o.httpMetadata, { contentType: 'application/json', cacheControl: 'public, max-age=30' });
  assert.deepEqual(r2.puts[0].o.onlyIf, { etagDoesNotMatch: '*' }, 'no existing object: only if absent');
  assert.equal(j0(r2).heartbeat, 'on');
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

test('report: everything but a restart is written when its state (action and http) changes; a restart is always written', () => {
  const d = (action, i = 0, http) => ({ at: ago(10 - i), workflow: 'pump.yml', action, ...(http ? { http } : {}) });
  let ring = appendDecisions([], [d('ok')]);
  ring = appendDecisions(ring, [d('ok', 1), d('ok', 2)]);
  assert.equal(ring.length, 1);
  ring = appendDecisions(ring, [d('restarted', 3), d('restarted', 4), d('ok', 5), d('skipped_switch', 6), d('skipped_switch', 7), d('failed', 8, 500), d('failed', 8, 500), d('failed', 9, 502), d('deferred', 9), d('deferred', 9)]);
  assert.deepEqual(ring.map((x) => `${x.action}${x.http ?? ''}`), ['ok', 'restarted', 'restarted', 'ok', 'skipped_switch', 'failed500', 'failed502', 'deferred']);
});

test('report: two hours of outage ticks do not push an earlier restart out of the ring', async () => {
  const r2 = fakeR2();
  const env = { GH_TOKEN: 't', HEARTBEAT_ENABLED: 'true', LIVE: r2 };
  await report({ env, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'restarted', http: 204 }], fetch: fakeNet(), now: NOW });
  const log = await tick({ token: 't', enabled: 'true', now: NOW, watch: PW, fetch: fakeGitHub({ vars502: true }) });
  assert.deepEqual(log.decisions.map((d) => [d.workflow, d.action, d.http]), [['*', 'check_failed', 502]]);
  for (let i = 1; i <= 24; i++) { // 24 ticks of 5 minutes
    const now = NOW + i * 300_000;
    const l = await tick({ token: 't', enabled: 'true', now, watch: PW, fetch: fakeGitHub({ vars502: true }) });
    await report({ env, decisions: l.decisions, fetch: fakeNet(), now });
  }
  const ring = JSON.parse(r2.store.get('v1/heartbeat.json')).decisions;
  assert.equal(ring.filter((d) => d.action === 'restarted').length, 1, 'the earlier restart survives');
  assert.equal(ring.filter((d) => d.action === 'check_failed').length, 1, 'one entry for the whole outage');
  assert.ok(!ring.some((d) => d.action === 'failed'), 'a failed read is not a failed dispatch');
});

test('report: heartbeat is "on", "off" or "no_token" at the top level, so a disabled heartbeat never reads as healthy', async () => {
  for (const [env, want] of [[{ HEARTBEAT_ENABLED: 'true', GH_TOKEN: 't' }, 'on'], [{ HEARTBEAT_ENABLED: 'false', GH_TOKEN: 't' }, 'off'], [{ GH_TOKEN: 't' }, 'off'], [{ HEARTBEAT_ENABLED: 'true' }, 'no_token']]) {
    const r2 = fakeR2();
    await report({ env: { ...env, LIVE: r2 }, fetch: fakeNet(), now: NOW });
    assert.equal(written(r2).heartbeat, want);
  }
});

test('report: the write is conditional on the etag read: a lost race skips this tick; a big or unparsable object is treated as empty', async () => {
  let r2 = fakeR2('{"decisions":[]}');
  await report({ env: { LIVE: r2 }, fetch: fakeNet(), now: NOW });
  assert.deepEqual(r2.puts[0].o.onlyIf, { etagMatches: 'e0' });
  r2 = fakeR2('{"decisions":[]}'); r2.raceOnce = true;
  const out = await report({ env: { LIVE: r2 }, decisions: [{ at: ISO, workflow: 'pump.yml', action: 'restarted' }], fetch: fakeNet(), now: NOW });
  assert.deepEqual(out, { written: false, skipped: 'conflict' });
  assert.equal(r2.puts.length, 0);
  const logged = []; const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
  try {
    const big = fakeR2(JSON.stringify({ decisions: Array.from({ length: 5 }, () => ({ at: ISO, workflow: 'x', action: 'restarted' })) }), { size: 70_000 });
    await report({ env: { LIVE: big }, decisions: [], fetch: fakeNet(), now: NOW });
    assert.equal(JSON.parse(big.puts[0].v).decisions.length, 0, 'over 64 KB: treated as empty');
    const bad = fakeR2('{oops');
    await report({ env: { LIVE: bad }, decisions: [], fetch: fakeNet(), now: NOW });
    assert.equal(bad.puts.length, 1);
  } finally { console.log = orig; }
  assert.ok(logged.some((l) => /over 65536/.test(l)) && logged.some((l) => /cannot be parsed/.test(l)));
});

test('report: the two fetches carry a 5 second timeout signal', async () => {
  const signals = []; const f = async (url, init) => { signals.push(init.signal); return fakeNet()(url, init); };
  await report({ env: { LIVE: fakeR2() }, fetch: f, now: NOW });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((x) => x && typeof x.aborted === 'boolean'));
});

test('report: a scan hit drops the summaries, rescans and writes the clean rest; the log names the rule, not the text', async () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const cases = [
    ['github-token', [{ id: 'pump', status: 'green', summary: 'leak ' + token }]],
    ['email', [{ id: 'slots', status: 'green', summary: 'mail someone@somewhere-real.org' }]],
    ['vendor-name', [{ id: 'dispatches', status: 'green', summary: 'worker by ' + vendor + ' ok' }]],
  ];
  for (const [rule, checks] of cases) {
    const r2 = fakeR2(); const logged = [];
    const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
    let out; try { out = await report({ env: { LIVE: r2 }, fetch: fakeNet({ issue: BODY([...checks, { id: 'subjects', status: 'green', at: ISO }]) }), now: NOW }); } finally { console.log = orig; }
    assert.deepEqual(out, { written: true, degraded: 'summaries' });
    assert.equal(r2.puts.length, 1);
    const j = written(r2);
    assert.ok(j.health.checks.length === 2 && j.health.checks.every((c) => !('summary' in c)), rule + ': summaries dropped, checks kept');
    const text = logged.join('\n');
    assert.ok(text.includes(rule));
    assert.ok(!text.includes(token) && !text.includes('somewhere-real') && !text.includes(vendor));
    assert.ok(!r2.puts[0].v.includes(token) && !r2.puts[0].v.includes(vendor));
  }
  assert.deepEqual(scanObject({ a: ['clean text', { b: 'fine' }] }), []);
});

test('report: a hit that survives dropping the summaries drops the health section; one that survives that writes nothing', async () => {
  const dirty = (pred) => (body, doc) => (pred(doc) ? [{ rule: 'forced', path: '$' }] : []);
  const hasSummary = (d) => d.health.checks && d.health.checks.some((c) => c.summary);
  const hasHealth = (d) => d.health.checks;
  let r2 = fakeR2();
  let out = await report({ env: { LIVE: r2 }, fetch: fakeNet(), now: NOW, scan: dirty(hasHealth) });
  assert.deepEqual(out, { written: true, degraded: 'health' });
  assert.deepEqual(written(r2).health, { error: 'unavailable', checked_at: ISO });
  r2 = fakeR2();
  out = await report({ env: { LIVE: r2 }, fetch: fakeNet(), now: NOW, scan: () => [{ rule: 'forced', path: '$' }] });
  assert.deepEqual(out, { written: false, blocked: 'forced' });
  assert.equal(r2.puts.length, 0);
  r2 = fakeR2();
  out = await report({ env: { LIVE: r2 }, fetch: fakeNet(), now: NOW, scan: dirty(hasSummary) });
  assert.equal(out.degraded, 'summaries');
});

test('report: what is scanned is exactly what is put (serialized once)', async () => {
  const r2 = fakeR2(); const seen = [];
  await report({ env: { LIVE: r2 }, fetch: fakeNet(), now: NOW, scan: (body, doc) => { seen.push(body); return scanBody(body, doc); } });
  assert.equal(seen.length, 1);
  assert.equal(r2.puts[0].v, seen[0]);
});

// The same synthetic samples as ingest/test/redact.test.mjs, for the rules copied into scan.mjs.
const j = (...p) => p.join('');
const FAKE = {
  'github-token': j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  'github-fine-grained-pat': j('github', '_pat_', '1'.repeat(22), '_', 'a'.repeat(59)),
  'aws-access-key-id': j('AK', 'IA', 'Z7X6C5V4B3N2M1L0'),
  'private-key-block': j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'),
  'age-secret-key': j('AGE-SECRET', '-KEY-1', 'Q'.repeat(58)),
  'slack-token': j('xo', 'xb-', '1234567890-abcdefghij'),
  'stripe-secret-key': j('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0k1L2'),
  'google-api-key': j('AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  'npm-token': j('np', 'm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  'gitlab-pat': j('gl', 'pat-', 'a1B2c3D4e5F6g7H8i9J0'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  'generic-sk-key': j('sk', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  'url-credentials': j('https://deploy', ':', 'hunter2hunter2', '@', 'example.org/x'),
  'generic-secret-assignment': j('api_key', '="', 'Zx9Qw8Er7Ty6Ui5Op4As3', '"'),
  email: j('maintainer', '@', 'some-company.io'),
  canary: j('ISOKRON', '_CANARY_', 'a1b2c3d4e5'),
};

test('scan: every rule has a sample, and each sample is found inside text and inside a serialized body', () => {
  for (const r of RULES) assert.ok(FAKE[r.id], `no synthetic sample for ${r.id}`);
  for (const [rule, sample] of Object.entries(FAKE)) {
    assert.ok(scanObject({ v: `before ${sample} after` }).some((h) => h.rule === rule), rule);
    const doc = { v: `before ${sample} after` };
    assert.ok(scanBody(JSON.stringify(doc), doc).some((h) => h.rule === rule), rule + ' serialized');
    assert.equal(JSON.stringify(scanObject(doc)).includes(sample), false, 'a hit never carries the matched text');
  }
  assert.ok(scanObject({ [FAKE.email]: 1 }).some((h) => h.rule === 'email' && h.path === '$.<key>'));
});

test('scan: ordinary text has no hits', () => {
  const benign = [
    'Lists the files in a directory. Returns JSON.', 'Set GITHUB_TOKEN in the environment before you start the server.',
    'token: string (required) - the API token to use', '"password": "The password for the database user"',
    'git clone git@github.com:example/server.git', 'Contact: someone@example.com for help', 'https://user:${TOKEN}@host.example/repo',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'ULID 01JD0000000000000000000000 and uuid 123e4567-e89b-12d3-a456-426614174000', 'api_key="YOUR_API_KEY_HERE"',
    'a pump run is in progress (started 18 minutes ago)', '2 of 2 worker slots in use',
  ];
  for (const t of benign) assert.deepEqual(scanObject({ t }), [], t);
});

test('scan: every rule runs in linear time on crafted input (R-ING-01 inputs, 256 KiB)', () => {
  const PATHOLOGICAL = ['a.', 'a-', 'a@', 'a@b.', '.@a.', 'eyJ-', 'eyJa.', 'sk-', 'glpat-', 'x://u:', '-----BEGIN A ', 'token="', 'token= ', 'a1'];
  for (const unit of PATHOLOGICAL) {
    const text = unit.repeat(Math.ceil(262144 / unit.length));
    const t0 = Date.now(); scanObject({ text }); const ms = Date.now() - t0;
    assert.ok(ms < 2000, `${JSON.stringify(unit)} took ${ms} ms`);
  }
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
function fakeGitHub({ loop = 'true', vars = {}, runs = {}, dispatchStatus = 204, listFail = false, vars502 = false, many = 0, pages = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(init.method + ' ' + u.pathname);
    if (u.pathname.endsWith('/actions/variables')) { if (vars502) return res(502, {}); const all = { LOOP_ENABLED: loop, ...vars }; for (let i = 0; i < many; i++) all['FILLER_' + i] = 'x'; const ent = Object.entries(all); const page = Number(u.searchParams.get('page') || 1); return res(200, { total_count: ent.length, variables: ent.slice((page - 1) * 30, page * 30).map(([name, value]) => ({ name, value })) }); }
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
  assert.deepEqual(log.decisions[0], { at: ISO, workflow: 'pump.yml', action: 'check_failed', http: 500 });
});

test('tick: log.decisions is not enumerable, and the log is exactly the plain array of lines it was', async () => {
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, watch: PW, fetch: fakeGitHub({ runs: stale }) });
  assert.ok(!Object.keys(log).includes('decisions'));
  assert.equal(Object.getOwnPropertyDescriptor(log, 'decisions').enumerable, false);
  assert.deepEqual(log, [...log]);
  assert.equal(JSON.stringify(log), JSON.stringify([...log]));
});

test('tick: a dispatch held back by the per-tick cap is "deferred", not failed', async () => {
  const log = await tick({ token: 't0ken', enabled: 'true', now: NOW, fetch: fakeGitHub({ runs: {} }) }); // every workflow has no runs
  const acts = log.decisions.map((d) => d.action);
  assert.equal(acts.filter((a) => a === 'restarted').length, 4);
  assert.equal(acts.filter((a) => a === 'deferred').length, WATCH.length - 4);
  assert.ok(!acts.includes('failed'));
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
    try { const ctx2 = fakeCtx(); await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true' }, ctx2); await Promise.all(ctx2.p); } finally { r2(); }
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

test('scheduled: a report module that cannot load cannot stop the tick (it is imported inside the report branch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  try {
    copyFileSync(new URL('../worker.mjs', import.meta.url), join(dir, 'worker.mjs')); // no report.mjs next to it
    const w = (await import(pathToFileURL(join(dir, 'worker.mjs')).href)).default;
    const gh = fakeGitHub({ runs: stale });
    const restore = stubGlobals(gh, async () => { throw new Error('x'); });
    const orig = console.log; const logged = []; console.log = (...a) => logged.push(a.join(' '));
    try {
      const ctx = fakeCtx();
      await w.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', REPORT_ENABLED: 'true', LIVE: fakeR2() }, ctx);
      const settled = await Promise.allSettled(ctx.p);
      assert.deepEqual(settled.map((x) => x.status), ['fulfilled', 'fulfilled']);
      assert.ok(gh.calls.some((c) => c.includes('pump.yml/dispatches')));
      assert.ok(logged.some((l) => /heartbeat report: failed/.test(l)));
    } finally { console.log = orig; restore(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scheduled: tick plus report stay within the 50-subrequest limit in the worst case (counting R2 calls too)', async () => {
  const r2 = fakeR2('{"decisions":[]}'); let fetches = 0;
  const gh = fakeGitHub({ runs: {}, many: 290 }); // 10 variable pages, every workflow with no runs: 4 dispatches, the rest deferred
  const restore = stubGlobals(gh, async (url, init) => { fetches++; return fakeNet({ noTokenOnly: true })(url, init); }); // report: status + refused issue read + unauthenticated retry
  const orig = console.log; console.log = () => {};
  try {
    const ctx = fakeCtx();
    await worker.scheduled({}, { GH_TOKEN: 't0ken', HEARTBEAT_ENABLED: 'true', REPORT_ENABLED: 'true', LIVE: r2 }, ctx);
    await Promise.all(ctx.p);
  } finally { console.log = orig; restore(); }
  const tickCalls = gh.calls.length;
  assert.ok(tickCalls <= 40, `tick used ${tickCalls}`);
  assert.equal(fetches, 3);
  const total = tickCalls + fetches + r2.gets + r2.puts.length;
  assert.ok(total <= 50, `total subrequests ${total}`);
});

test('R-LIVE-60: a check the watchdog reports as off stays off (switched off on purpose is never turned into unknown)', async () => {
  const body = '<!-- loop-health:v1 {"overall":"green","updated":"2026-11-26T00:20:45.168Z","checks":[{"id":"pump","status":"off","summary":"LOOP_SLOTS is 0: the pump only does housekeeping on its schedule"},{"id":"slots","status":"green"}]} -->';
  const h = allowlistHealth(body);
  assert.equal(h.checks.find((c) => c.id === 'pump').status, 'off');
  assert.equal(h.checks.find((c) => c.id === 'slots').status, 'green');
});

test('R-WD-30: with more checks than fit, red and amber then the core liveness and backup items are kept, and the rest is counted in a "more-checks" entry', () => {
  const mk = (id, status = 'green') => ({ id, status, summary: 'x' });
  const lanes = Array.from({ length: 50 }, (_, i) => mk(`lane-fresh:l${i}`));
  const core = ['pump', 'slots', 'dispatches', 'state-snapshot', 'archive', 'offsite-backup', 'keep-forever'].map((id) => mk(id));
  const junk = Array.from({ length: 40 }, (_, i) => mk(`zz-extra-${i}`));
  // 98 checks in all: the red item comes last in the issue
  const checks = [...lanes, ...junk, ...core, mk('pump-dispatch', 'red')];
  const body = `<!-- loop-health:v1 ${JSON.stringify({ overall: 'red', updated: '2026-11-27T00:00:00.000Z', checks })} -->`;
  const h = allowlistHealth(body);
  const ids = h.checks.map((c) => c.id);
  assert.equal(h.checks.length, 81, '80 kept plus the count');
  assert.equal(ids[0], 'pump-dispatch', 'red first');
  for (const id of ['state-snapshot', 'archive', 'offsite-backup', 'keep-forever']) assert.ok(ids.includes(id), id);
  const more = h.checks.at(-1);
  assert.equal(more.id, 'more-checks');
  assert.match(more.summary, /^18 more checks not shown$/);
  // nothing is dropped, and no entry is added, when everything fits
  const small = allowlistHealth(`<!-- loop-health:v1 ${JSON.stringify({ overall: 'green', checks: [...core, ...lanes.slice(0, 20)] })} -->`);
  assert.equal(small.checks.length, 27);
  assert.ok(!small.checks.some((c) => c.id === 'more-checks'));
});
