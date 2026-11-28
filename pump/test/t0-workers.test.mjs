// R-CTL-17, R-CTL-18: the t0-dogfood lane lists only workers that build a result bundle, and they run the sandbox commit
// the lane names (pump/t0-workers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../due.mjs';
import { jobNames, t0WorkerProblems, workerFileUrl } from '../t0-workers.mjs';

const SHA = '78a7834cf028507b03e90e266b87bebeacfccd51';
const OTHER = '11974fbb75a8c276214c887a079d6ad6df374124';

/** A worker file in the shape of the sandboxed dogfood workers (isokron-ai/mcp-writecheck-action, wca#80). */
const worker = (sha = SHA) => `name: "dogfood: x"
on:
  workflow_dispatch:
    inputs: {}
env:
  SANDBOX_REF: '${sha}'
jobs:
  t0-start:
    runs-on: ubuntu-24.04
    steps:
      - run: echo go
  conformance:
    needs: t0-start
    uses: isokron-ai/mcp-surface-corpus/.github/workflows/sandbox-conformance.yml@${sha} # SANDBOX_REF
  own:
    needs: [t0-start, conformance]
    steps:
      - id: sandbox
        uses: isokron-ai/mcp-surface-corpus/sandbox-guard@${sha} # SANDBOX_REF
      - run: node dogfood/sbx.mjs up
  t0-manifest:
    needs: [t0-start, conformance, own]
    steps:
      - name: Build the result bundle
        run: |
          mkdir -p "$RUNNER_TEMP/out"
          node loop/t0-bundle.mjs --out "$RUNNER_TEMP/out"
      - uses: isokron-ai/tool-qa/worker-kit@${'b'.repeat(40)} # T0_WORKER_KIT_REF
        with:
          item-index: 0
`;

test('R-CTL-17: a worker that builds no result bundle, or pins another sandbox than the lane, is refused (mutations)', () => {
  assert.deepEqual(t0WorkerProblems(worker(), { sandboxSha: SHA }), []);
  assert.deepEqual(jobNames(worker()), ['t0-start', 'conformance', 'own', 't0-manifest']);
  const base = worker();
  const noManifest = base.slice(0, base.indexOf('  t0-manifest:\n'));
  const mutants = {
    'no t0-manifest job (dogfood-kubernetes since wca#80)': noManifest,
    'no worker-kit': base.replace(/      - uses: isokron-ai\/tool-qa\/worker-kit@[^\n]*\n/, ''),
    'worker-kit at a branch': base.replace(/worker-kit@b{40}/, 'worker-kit@main'),
    'no bundle builder': base.replace('node loop/t0-bundle.mjs', 'echo'),
    'SANDBOX_REF another commit': base.replace(`SANDBOX_REF: '${SHA}'`, `SANDBOX_REF: '${OTHER}'`),
    'no SANDBOX_REF': base.replace(`  SANDBOX_REF: '${SHA}'\n`, ''),
    'conformance at another commit': base.replace(`sandbox-conformance.yml@${SHA}`, `sandbox-conformance.yml@${OTHER}`),
    'guard at a branch': base.replace(`sandbox-guard@${SHA}`, 'sandbox-guard@main'),
    'no guard': base.replace(/      - id: sandbox\n        uses: [^\n]*\n/, ''),
    'no conformance': base.replace(/  conformance:\n(?: {4}[^\n]*\n)+/, ''),
  };
  for (const [what, text] of Object.entries(mutants)) {
    assert.notEqual(text, base, `${what}: the mutation applies`);
    assert.ok(t0WorkerProblems(text, { sandboxSha: SHA }).length > 0, `${what}: refused`);
  }
  assert.ok(t0WorkerProblems(base, { sandboxSha: OTHER }).length >= 3, "a lane pin that is not the workers' is refused");
  assert.deepEqual(t0WorkerProblems(base, { sandboxSha: null }), ['the lane names no sandbox_sha']);
});

test('R-CTL-18: the shipped t0-dogfood lane lists the five sandboxed workers, at the sandbox commit they pin; kubernetes is out', () => {
  const lane = loadConfig().workflows['t0-dogfood'];
  assert.equal(lane.runs_untrusted, true);
  assert.equal(lane.sandbox_sha, SHA, 'the commit the workers pin (mcp-writecheck-action SANDBOX_REF, wca#80)');
  assert.deepEqual(Object.keys(lane.control_subjects).map((x) => x.split('.').pop()).sort(), ['dogfood-grafana', 'dogfood-kronicle-lite', 'dogfood-payload', 'dogfood-sea-lite', 'dogfood-writesafe']);
  assert.equal(lane.control_subjects['isokron-ai/mcp-writecheck-action.dogfood-kubernetes'], undefined, 'kind keeps it outside the sandbox: it builds no bundle (wca R-DSB-03)');
  assert.equal(workerFileUrl(lane, 'isokron-ai/mcp-writecheck-action.dogfood-grafana'), 'https://raw.githubusercontent.com/isokron-ai/mcp-writecheck-action/main/.github/workflows/dogfood-grafana.yml');
});

// The worker files themselves, at the lane's ref. Required on GitHub Actions; on a machine with no network it is skipped.
const offline = process.env.GITHUB_ACTIONS !== 'true' && !(await fetch('https://raw.githubusercontent.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(() => true, () => false));
test('R-CTL-18: every t0-dogfood subject\'s worker file, at the lane\'s ref, has a t0-manifest job and pins the lane\'s sandbox_sha', { skip: offline && 'no network here (required on GitHub Actions)' }, async () => {
  const lane = loadConfig().workflows['t0-dogfood'];
  for (const subject of Object.keys(lane.control_subjects)) {
    const url = workerFileUrl(lane, subject);
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert.equal(r.status, 200, `${subject}: ${url}`);
    assert.deepEqual(t0WorkerProblems(await r.text(), { sandboxSha: lane.sandbox_sha }), [], subject);
  }
});
