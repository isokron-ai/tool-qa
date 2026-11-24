// The control for the performance baselines: the real harness (perf/run.mjs and
// the pinned Inspector CLI) run against the dependency-free fixture server, once
// fast and once with a 20 ms delay. A harness that could not see that slowdown
// would make every green result worthless, so this must come out red.
//
// It needs the Inspector installed (`npm ci --prefix perf --ignore-scripts`).
// Without it the test skips, unless PERF_REQUIRE=1 (the performance workflow
// sets it), in which case a missing Inspector fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeResult } from '../perf/lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INSPECTOR = join(ROOT, 'perf/node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js');
const have = existsSync(INSPECTOR);
const skip = have ? false : process.env.PERF_REQUIRE === '1' ? false : 'the Inspector is not installed in perf/ (npm ci --prefix perf)';

function measure(dir, name, extra = []) {
  const out = join(dir, `${name}.json`);
  const r = spawnSync(process.execPath, [join(ROOT, 'perf/run.mjs'), '--server', 'fixture', '--out', out, '--duration', '2', '--warmup', '1', '--repeats', '2', ...extra], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `run.mjs failed: ${r.stderr}`);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  res.version = '1.0.0';
  return res;
}

test('the pinned Inspector is the one the lockfile says', { skip }, () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'perf/package-lock.json'), 'utf8'));
  const pinned = lock.packages['node_modules/@modelcontextprotocol/inspector'].version;
  const pkg = JSON.parse(readFileSync(join(ROOT, 'perf/package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@modelcontextprotocol/inspector'], pinned, 'package.json pins an exact version');
  assert.equal(JSON.parse(readFileSync(join(INSPECTOR, '../../../../package.json'), 'utf8')).version, pinned);
});

test('control: a 20 ms slowdown in the fixture server is red against the fast run, and an unchanged server is ok', { skip, timeout: 240000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-control-'));
  try {
    const fast = measure(dir, 'fast');
    const again = measure(dir, 'again');
    const slow = measure(dir, 'slow', ['--extra-arg=--delay-ms=20']);
    assert.equal(fast.profiles.stdio.error, undefined);
    assert.ok(fast.profiles.stdio.summary.requests > 100, 'the fast run made real calls');
    assert.equal(fast.profiles.stdio.summary.error_rate, 0);
    // A second run of the same server must not be flagged, however fast it is.
    assert.notEqual(judgeResult(again, fast).status, 'red');
    assert.notEqual(judgeResult(again, fast).status, 'amber', JSON.stringify(judgeResult(again, fast)));
    const verdict = judgeResult(slow, fast);
    assert.equal(verdict.status, 'red', JSON.stringify(verdict));
    assert.ok(slow.profiles.stdio.summary.p95_ms > fast.profiles.stdio.summary.p95_ms + 15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run.mjs refuses a server that is not one of ours, and a malformed number', { skip }, () => {
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, 'perf/run.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(run('--server', 'github-mcp-server', '--out', '/tmp/x.json').status, 2);
  assert.equal(run('--server', 'fixture', '--out', '/tmp/x.json', '--duration', '5\n6').status, 2);
  assert.equal(run('--server', '../etc', '--out', '/tmp/x.json').status, 2);
});
