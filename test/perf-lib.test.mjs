// The rules of the performance baselines (perf/lib.mjs, perf/compare.mjs): which
// release is "previous", what counts as amber and red, and that noise cannot
// turn a run red. See docs/PERFORMANCE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_THRESHOLDS, compareVersions, judgeProfile, judgeResult, median, parseVersion, previousVersion, summariseChurn, summariseRepeats, summariseSteps } from '../perf/lib.mjs';
import { baselineVersions, loadBaseline } from '../perf/compare.mjs';
import { buildScenario, fillArgs, loadServers, parseLoadOutput, FORBIDDEN_PORTS, freePort } from '../perf/run.mjs';

const summary = (o = {}) => ({ repeats: 3, requests: 1000, failed: 0, p50_ms: 2, p95_ms: 5, p99_ms: 8, error_rate: 0, ok_per_s: 1000, p95_spread: 1.05, ...o });
const result = (server, version, profiles, cal = 10) => ({ schema: 'tool-qa/perf/1', server, version, runner: { calibration_ms: cal }, inspector: { version: '2.16.0' }, profiles });

test('versions compare as semver, and a release is above its own pre-release', () => {
  assert.equal(compareVersions('0.12.1', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(parseVersion('1.2'), null);
  assert.throws(() => compareVersions('x', '1.0.0'));
});

test('previousVersion is the newest version strictly below the current one', () => {
  const have = ['0.9.0', '0.10.0', '0.12.0', '0.12.1', '0.13.0', 'junk'];
  assert.equal(previousVersion('0.12.1', have), '0.12.0');
  assert.equal(previousVersion('0.9.0', have), null);
  assert.equal(previousVersion('0.12.2', have), '0.12.1');
  assert.equal(previousVersion('0.12.1', []), null);
});

test('median ignores gaps and handles even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, undefined, 5]), 5);
  assert.equal(median([]), null);
});

test('summariseRepeats takes medians, keeps the worst error rate, and reports the spread', () => {
  const mk = (p95, err = 0) => ({ requests: 100, ok: 100 - err * 100, errorRate: err, okThroughput: 500, latencyMs: { p50: 1, p95, p99: p95 + 1 } });
  const s = summariseRepeats([mk(4), mk(5), mk(12, 0.05)]);
  assert.equal(s.p95_ms, 5);
  assert.equal(s.error_rate, 0.05);
  assert.equal(s.p95_spread, 3);
  assert.equal(s.failed, 5);
});

test('summariseSteps gives each scenario step its own median', () => {
  const rep = (a, b) => ({ steps: [{ name: 'a', requests: 10, errorRate: 0, latencyMs: { p50: a, p95: a * 2 } }, { name: 'b', requests: 5, errorRate: 0.2, latencyMs: { p50: b, p95: b * 2 } }] });
  const s = summariseSteps([rep(1, 10), rep(3, 20), rep(2, 30)]);
  assert.equal(s.a.p95_ms, 4);
  assert.equal(s.b.error_rate, 0.2);
  assert.equal(s.a.requests, 30);
});

test('R-PERF-03: session churn is read from the churn object the Inspector prints, not from connections', () => {
  // The shape the Inspector 2.16.0 prints for --load --load-churn.
  const run = (opened, p95) => ({ churn: { callsPerSession: 3, opened, failed: 0, closeFailed: 0, connectMs: { p50: 1.9, p95 } }, latencyMs: { p95: 3.4 }, elapsedMs: 4000 });
  const c = summariseChurn([run(4000, 4), run(5000, 6), { error: 'x' }, null]);
  assert.equal(c.sessions_opened, 9000);
  assert.equal(c.connect_p95_ms, 5);
  assert.equal(c.sessions_per_s, 1125);
  assert.equal(summariseChurn([{ error: 'x' }]), null);
});

test('a run close to the baseline is ok', () => {
  const j = judgeProfile(summary({ p95_ms: 5.8, p50_ms: 2.2 }), summary(), { cur: 10, base: 10 });
  assert.equal(j.status, 'ok');
});

test('p95 above 1.5x and 2 ms is amber; above 2.5x and 5 ms is red', () => {
  assert.equal(judgeProfile(summary({ p95_ms: 8 }), summary(), { cur: 10, base: 10 }).status, 'amber');
  assert.equal(judgeProfile(summary({ p95_ms: 14 }), summary(), { cur: 10, base: 10 }).status, 'red');
});

test('a big ratio on a tiny number is not a regression (the millisecond floors)', () => {
  const base = summary({ p50_ms: 0.05, p95_ms: 0.09, p99_ms: 0.16 });
  const cur = summary({ p50_ms: 0.12, p95_ms: 0.4, p99_ms: 0.5 });
  assert.equal(judgeProfile(cur, base, { cur: 10, base: 10 }).status, 'ok');
});

test('the baseline is scaled to the speed of the runner it runs on', () => {
  // The runner is twice as slow (calibration 20 vs 10): a p95 of 9 ms is what 5 ms was.
  const slow = judgeProfile(summary({ p95_ms: 9, p50_ms: 3.5, ok_per_s: 520 }), summary(), { cur: 20, base: 10 });
  assert.equal(slow.status, 'ok');
  assert.equal(slow.scale, 2);
  // Far outside the band the numbers are compared raw, with a note.
  const far = judgeProfile(summary({ p95_ms: 9 }), summary(), { cur: 100, base: 10 });
  assert.equal(far.scale, 1);
  assert.ok(far.notes.some((n) => n.startsWith('info:')));
});

test('errors: a small rise is amber, a big one red', () => {
  assert.equal(judgeProfile(summary({ error_rate: 0.005 }), summary(), { cur: 10, base: 10 }).status, 'amber');
  assert.equal(judgeProfile(summary({ error_rate: 0.05 }), summary(), { cur: 10, base: 10 }).status, 'red');
});

test('throughput falling under half is amber, under 30 percent red', () => {
  assert.equal(judgeProfile(summary({ ok_per_s: 450 }), summary(), { cur: 10, base: 10 }).status, 'amber');
  assert.equal(judgeProfile(summary({ ok_per_s: 200 }), summary(), { cur: 10, base: 10 }).status, 'red');
});

test('a noisy run (repeats disagree by more than 3x) can be amber but never red', () => {
  const j = judgeProfile(summary({ p95_ms: 30, p95_spread: 4 }), summary(), { cur: 10, base: 10 });
  assert.equal(j.noisy, true);
  assert.equal(j.status, 'amber');
});

test('R-PERF-01: a first baseline with failed calls, or a profile that failed, is red, not accepted', () => {
  const noisyFirst = judgeResult(result('s', '1.0.0', { stdio: { summary: summary({ error_rate: 0.1 }) } }), null);
  assert.equal(noisyFirst.status, 'red');
  assert.equal(judgeResult(result('s', '1.0.0', { stdio: { error: 'boom' } }), null).status, 'red');
  assert.equal(judgeResult(result('s', '1.0.0', { stdio: { summary: summary() } }), null).status, 'new');
});

test('R-PERF-02: a baseline whose profile did not complete is skipped, not a crash', () => {
  const base = result('s', '1.0.0', { stdio: { error: 'did not start' }, http: { summary: summary() } });
  const v = judgeResult(result('s', '1.1.0', { stdio: { summary: summary() }, http: { summary: summary() } }), base);
  assert.equal(v.status, 'ok');
  assert.ok(v.notes.some((n) => n.includes('stdio')));
});

test('a result that did not complete is red against a baseline too', () => {
  const v = judgeResult(result('s', '1.1.0', { stdio: { error: 'timeout' } }), result('s', '1.0.0', { stdio: { summary: summary() } }));
  assert.equal(v.status, 'red');
});

test('one server is never compared with another', () => {
  assert.throws(() => judgeResult(result('sea-lite', '1.0.0', { stdio: { summary: summary() } }), result('kronicle-lite', '0.9.0', { stdio: { summary: summary() } })), /different servers/);
});

test('the thresholds are the documented ones', () => {
  assert.deepEqual([DEFAULT_THRESHOLDS.p95_amber_factor, DEFAULT_THRESHOLDS.p95_red_factor, DEFAULT_THRESHOLDS.noisy_spread], [1.5, 2.5, 3]);
});

test('baselineVersions lists a server\'s own baselines only, and loadBaseline checks the schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-bl-'));
  try {
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a', '1.0.0.json'), JSON.stringify(result('a', '1.0.0', {})));
    writeFileSync(join(dir, 'a', 'notes.json'), '{}');
    writeFileSync(join(dir, 'b', '2.0.0.json'), JSON.stringify({ schema: 'other' }));
    assert.deepEqual(baselineVersions(dir, 'a'), ['1.0.0']);
    assert.deepEqual(baselineVersions(dir, 'none'), []);
    assert.equal(loadBaseline(dir, 'a', '1.0.0').server, 'a');
    assert.throws(() => loadBaseline(dir, 'b', '2.0.0'), /schema/);
    assert.throws(() => loadBaseline(dir, '../x', '1.0.0'));
    assert.throws(() => loadBaseline(dir, 'a', '1.0.0/../../x'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('servers.json lists our own servers only, with a scenario of read-only tools and fixtures that load', () => {
  const servers = loadServers();
  assert.deepEqual(Object.keys(servers).sort(), ['fixture', 'kronicle-lite', 'mcp-check', 'sea-lite', 'tiny-tracker']);
  for (const [id, s] of Object.entries(servers)) {
    assert.ok(s.repo === null || /^isokron-ai\//.test(s.repo), `${id} is not one of ours`);
    assert.ok(s.scenario.length >= 1);
    const sc = buildScenario(s);
    for (const step of sc.steps) assert.equal(step.method, 'tools/call');
    assert.ok(!JSON.stringify(sc).includes('@fixtures/'), `${id}: a fixture reference was not inlined`);
    for (const p of s.profiles) assert.ok(s[`${p}_args`] !== undefined, `${id} lists the ${p} profile but has no ${p}_args`);
  }
});

test('fillArgs fills the data directory and the port', () => {
  assert.deepEqual(fillArgs(['serve', '--port', '{port}', '--data-dir', '{data}'], { port: 5000, data: '/x' }), ['serve', '--port', '5000', '--data-dir', '/x']);
});

test('parseLoadOutput reads the first JSON line and refuses an error or an empty run', () => {
  assert.equal(parseLoadOutput('note\n{"result":{"latencyMs":{"p50":1},"requests":3}}\n').requests, 3);
  assert.throws(() => parseLoadOutput('{"error":{"message":"nope"}}'), /nope/);
  assert.throws(() => parseLoadOutput('{"result":{"latencyMs":null}}'), /no latency/);
  assert.throws(() => parseLoadOutput('no json'), /no JSON/);
});

test('free ports never include the four reserved ones', async () => {
  assert.deepEqual([...FORBIDDEN_PORTS].sort(), [4710, 4711, 47310, 47311]);
  for (let i = 0; i < 20; i++) assert.ok(!FORBIDDEN_PORTS.has(await freePort()));
});

import { plan } from '../perf/plan.mjs';

const SERVERS = {
  'sea-lite': { package: 'sea-lite', rebuild: ['better-sqlite3'] },
  'tiny-tracker': { package: '@mcp-write-safety/tiny-tracker', rebuild: [] },
  fixture: { local_script: 'fixture-server.mjs' },
};
const latestOf = async (pkg) => ({ 'sea-lite': '0.7.1', '@mcp-write-safety/tiny-tracker': '0.3.0' })[pkg];

test('plan: a scheduled run measures each server\'s latest release once, and never the fixture', async () => {
  const have = new Set(['sea-lite 0.7.1']);
  const { matrix, notes } = await plan({ servers: SERVERS, env: {}, hasBaseline: (s, v) => have.has(`${s} ${v}`), latest: latestOf });
  assert.deepEqual(matrix.include.map((m) => `${m.server} ${m.version}`), ['tiny-tracker 0.3.0']);
  assert.ok(notes[0].includes('sea-lite 0.7.1'));
  const forced = await plan({ servers: SERVERS, env: { PERF_FORCE: 'true' }, hasBaseline: () => true, latest: latestOf });
  assert.equal(forced.matrix.include.length, 2);
});

test('plan: one server at one exact version; anything else is refused whole', async () => {
  const ok = await plan({ servers: SERVERS, env: { PERF_SERVER: 'sea-lite', PERF_VERSION: '0.7.0' }, hasBaseline: () => false, latest: latestOf });
  assert.deepEqual(ok.matrix.include, [{ server: 'sea-lite', package: 'sea-lite', version: '0.7.0', rebuild: 'better-sqlite3' }]);
  const bad = (env) => plan({ servers: SERVERS, env, hasBaseline: () => false, latest: latestOf });
  await assert.rejects(bad({ PERF_SERVER: 'sea-lite\nfixture' }));
  await assert.rejects(bad({ PERF_SERVER: 'github-mcp-server' }));
  await assert.rejects(bad({ PERF_SERVER: 'fixture' }));
  await assert.rejects(bad({ PERF_VERSION: '0.7.0' }), /one server/);
  await assert.rejects(bad({ PERF_SERVER: 'sea-lite', PERF_VERSION: '0.7.0\n9.9.9' }));
  await assert.rejects(bad({ PERF_SERVER: 'sea-lite', PERF_VERSION: 'latest' }));
});

test('plan: a bad version from the registry stops the run', async () => {
  await assert.rejects(plan({ servers: SERVERS, env: {}, hasBaseline: () => false, latest: async () => '1.0.0 && curl x' }), /bad version/);
});

import { manifest } from '../perf/install-server.mjs';

test('R-PERF-04: a version with a trailing newline is not a version; install-server refuses it and any loose name or version', () => {
  assert.deepEqual(manifest('@mcp-write-safety/tiny-tracker', '0.3.0').dependencies, { '@mcp-write-safety/tiny-tracker': '0.3.0' });
  assert.throws(() => manifest('sea-lite', '^0.7.0'));
  assert.throws(() => manifest('sea-lite', 'latest'));
  assert.throws(() => manifest('sea-lite@0.7.1', '0.7.1'));
  assert.throws(() => manifest('github:evil/repo', '1.0.0'));
  assert.throws(() => manifest('sea-lite', '0.7.1\n'));
});
