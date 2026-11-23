// Checks worker-kit/action.yml by running its shell steps locally with a tiny
// stand-in for the Actions runner. `uses:` steps are recorded, not run, and the
// age download step is replaced by a link to a local age binary when one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { readTar } from '../tar.mjs';

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const action = parseYaml(readFileSync(join(KIT, 'action.yml'), 'utf8'));

function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
// AGE_BIN / AGE_KEYGEN_BIN (as set in CI) win over PATH.
const AGE = process.env.AGE_BIN || which('age');
const AGE_KEYGEN = process.env.AGE_KEYGEN_BIN || which('age-keygen');

function readOutputs(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function resolveExpr(text, ctx) {
  return String(text).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    let m = /^inputs\.([\w-]+)$/.exec(expr);
    if (m) return ctx.inputs[m[1]] ?? '';
    m = /^steps\.(\w+)\.outputs\.(\w+)$/.exec(expr);
    if (m) return ctx.steps[m[1]]?.[m[2]] ?? '';
    throw new Error(`unsupported expression ${expr}`);
  });
}

function evalIf(cond, ctx) {
  if (cond === undefined) return true;
  const m = /^inputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'$/.exec(cond);
  if (!m) throw new Error(`unsupported if: ${cond}`);
  const v = ctx.inputs[m[1]] ?? '';
  return m[2] === '==' ? v === m[3] : v !== m[3];
}

/** Run the composite action. Returns { ran, skipped, uses, outputs, failed }. */
function runAction(inputs, { runnerTemp, env: extraEnv = {} }) {
  const defaults = Object.fromEntries(Object.entries(action.inputs).map(([k, v]) => [k, v.default ?? '']));
  const ctx = { inputs: { ...defaults, ...inputs }, steps: {} };
  const result = { ran: [], skipped: [], uses: [], failed: null };
  for (const step of action.runs.steps) {
    if (!evalIf(step.if, ctx)) { result.skipped.push(step.name); continue; }
    if (step.uses) { result.uses.push({ name: step.name, uses: step.uses, with: Object.fromEntries(Object.entries(step.with).map(([k, v]) => [k, resolveExpr(v, ctx)])) }); continue; }
    if (/install-age\.sh/.test(step.run)) {
      // Never download in tests: link the local binary where the step would install it.
      mkdirSync(join(runnerTemp, 'tool-qa-age'), { recursive: true });
      symlinkSync(AGE, join(runnerTemp, 'tool-qa-age', 'age'));
      result.ran.push(step.name);
      continue;
    }
    const outFile = join(runnerTemp, `out-${result.ran.length}`);
    writeFileSync(outFile, '');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, GITHUB_ACTION_PATH: KIT, GITHUB_OUTPUT: outFile, ...extraEnv };
    for (const [k, v] of Object.entries(step.env ?? {})) env[k] = resolveExpr(v, ctx);
    assert.doesNotMatch(step.run, /\$\{\{/, `${step.name}: no expressions inside run`);
    const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { env, encoding: 'utf8' });
    if (step.id) ctx.steps[step.id] = readOutputs(outFile);
    result.ran.push(step.name);
    if (r.status !== 0) { result.failed = { step: step.name, stdout: r.stdout, stderr: r.stderr }; break; }
  }
  result.outputs = Object.fromEntries(Object.entries(action.outputs).map(([k, v]) => [k, resolveExpr(v.value, ctx)]));
  return result;
}

const SHA40 = '2'.repeat(40);
function workerSetup() {
  const root = mkdtempSync(join(tmpdir(), 'wk-action-'));
  const bundle = join(root, 'bundle');
  mkdirSync(join(bundle, 'results'), { recursive: true });
  writeFileSync(join(bundle, 'results', 'report.json'), '{"ok":true}');
  const meta = join(root, 'meta.json');
  writeFileSync(meta, JSON.stringify({
    subject: { id: 'npm:x', repo: null, sha: null }, tools: [{ name: 'mcp-check', version: '1.0.0' }], oracles: [],
    settings_manifest_digest: '3'.repeat(64), started_at: '2026-11-21T10:00:00Z', skips: [], controls: [],
  }));
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  const env = {
    GITHUB_REPOSITORY: 'isokron-ai/mcp-check',
    GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-check/.github/workflows/live-probe.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: SHA40, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  };
  const inputs = { 'bundle-dir': bundle, 'meta-file': meta, 'attempt-id': 'att-77', fence: '5', 'run-key': '4'.repeat(64) };
  return { root, runnerTemp, env, inputs };
}

test('every uses: in the action is pinned to a full commit SHA, and upload keeps 3 days without re-zipping', () => {
  const uses = action.runs.steps.filter((s) => s.uses);
  assert.equal(uses.length, 1);
  assert.match(uses[0].uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(uses[0].with['retention-days'], '3');
  assert.equal(uses[0].with.archive, 'false');
  assert.equal(uses[0].if, "inputs.dry-run != 'true'");
});

test('install-age.sh pins an exact version and sha256 per architecture and checks it', () => {
  const sh = readFileSync(join(KIT, 'install-age.sh'), 'utf8');
  assert.match(sh, /^AGE_VERSION="v\d+\.\d+\.\d+"$/m);
  assert.match(sh, /^AGE_SHA256_LINUX_AMD64="[0-9a-f]{64}"$/m);
  assert.match(sh, /^AGE_SHA256_LINUX_ARM64="[0-9a-f]{64}"$/m);
  assert.match(sh, /sha256sum --check --strict/);
});

test('ingest.pub is a placeholder or holds exactly one recipient', () => {
  const lines = readFileSync(join(KIT, 'ingest.pub'), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(lines.length <= 1);
  for (const l of lines) assert.match(l.trim(), /^age1[02-9ac-hj-np-z]{58}$/);
  assert.doesNotMatch(readFileSync(join(KIT, 'ingest.pub'), 'utf8'), /AGE-SECRET-KEY/);
});

test('dry run builds the bundle and skips the age download, encryption and upload', () => {
  const s = workerSetup();
  try {
    const r = runAction({ ...s.inputs, 'dry-run': 'true' }, { runnerTemp: s.runnerTemp, env: s.env });
    assert.equal(r.failed, null, JSON.stringify(r.failed));
    assert.deepEqual(r.uses, []);
    assert.ok(r.skipped.includes('Install age (pinned version, sha256 checked)'));
    assert.ok(r.skipped.includes('Encrypt bundle'));
    assert.ok(r.skipped.includes('Upload encrypted bundle (3 days)'));
    assert.equal(existsSync(join(s.runnerTemp, 'tool-qa-age')), false);
    const entries = readTar(readFileSync(r.outputs['bundle-path']));
    assert.deepEqual(entries.map((e) => e.path), ['manifest.json', 'results/report.json']);
    assert.equal(r.outputs['artifact-name'], 'result-att-77.tar.age');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('a bad dry-run value stops the action before anything is built', () => {
  const s = workerSetup();
  try {
    const r = runAction({ ...s.inputs, 'dry-run': 'yes' }, { runnerTemp: s.runnerTemp, env: s.env });
    assert.equal(r.failed?.step, 'Check inputs');
    assert.equal(readdirSync(s.runnerTemp).some((n) => n === 'tool-qa-result'), false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('encrypts to the given recipient, removes the plain tar and hands only the .age file to upload', (t) => {
  if (!AGE || !AGE_KEYGEN) { t.skip('age and age-keygen are not installed; the encryption path is not exercised'); return; }
  const s = workerSetup();
  try {
    const keyFile = join(s.root, 'key.txt');
    execFileSync(AGE_KEYGEN, ['-o', keyFile], { stdio: 'ignore' });
    const recipient = execFileSync(AGE_KEYGEN, ['-y', keyFile], { encoding: 'utf8' }).trim();
    const r = runAction({ ...s.inputs, recipient }, { runnerTemp: s.runnerTemp, env: s.env });
    assert.equal(r.failed, null, JSON.stringify(r.failed));
    assert.equal(r.uses.length, 1);
    const up = r.uses[0].with;
    assert.equal(up.name, 'result-att-77.tar.age');
    assert.ok(up.path.endsWith('result-att-77.tar.age'));
    assert.equal(existsSync(up.path.replace(/\.age$/, '')), false, 'plain tar removed');
    const ct = readFileSync(up.path);
    assert.ok(ct.subarray(0, 21).toString() === 'age-encryption.org/v1');
    const plain = execFileSync(AGE, ['-d', '-i', keyFile, up.path]);
    assert.equal(readTar(plain)[0].path, 'manifest.json');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('refuses to upload when no recipient is given and ingest.pub is still a placeholder, or the recipient is malformed', (t) => {
  if (!AGE) { t.skip('age is not installed'); return; }
  const placeholder = !readFileSync(join(KIT, 'ingest.pub'), 'utf8').split('\n').some((l) => l.trim() && !l.trim().startsWith('#'));
  for (const recipient of [...(placeholder ? [''] : []), 'age1notakey', `age1${'q'.repeat(58)}\nage1${'q'.repeat(58)}`]) {
    const s = workerSetup();
    try {
      const r = runAction({ ...s.inputs, recipient }, { runnerTemp: s.runnerTemp, env: s.env });
      assert.equal(r.failed?.step, 'Encrypt bundle', JSON.stringify(recipient));
      assert.deepEqual(r.uses, []);
      assert.equal(existsSync(join(s.runnerTemp, 'tool-qa-result', 'result-att-77.tar')), false, 'plain tar removed');
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  }
});
