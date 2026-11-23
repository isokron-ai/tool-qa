import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../build-bundle.mjs';
import { readTar } from '../tar.mjs';
import { validateManifest, sha256Hex } from '../contract.mjs';

const SHA40 = '1'.repeat(40);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wk-build-'));
  const dir = join(root, 'bundle');
  mkdirSync(join(dir, 'observations'), { recursive: true });
  mkdirSync(join(dir, 'controls'), { recursive: true });
  writeFileSync(join(dir, 'observations', 'p.ndjson'), '{"field":"protocol_negotiated","value":"2025-06-18"}\n');
  writeFileSync(join(dir, 'controls', 'forgery.json'), '{"outcome":"contained"}');
  const meta = join(root, 'meta.json');
  writeFileSync(meta, JSON.stringify({
    subject: { id: 'npm:example', repo: 'example/server', sha: SHA40 },
    tools: [{ name: 'mcp-check', version: '1.0.0' }],
    oracles: [],
    settings_manifest_digest: 'e'.repeat(64),
    started_at: '2026-11-21T10:00:00Z',
    skips: [{ stage: 'build-probe', reason: 'timeout_start' }],
    controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json' }],
  }));
  const outFile = join(root, 'gh-output');
  writeFileSync(outFile, '');
  const env = {
    GITHUB_REPOSITORY: 'isokron-ai/mcp-check',
    GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-check/.github/workflows/live-probe.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: SHA40,
    GITHUB_RUN_ID: '4242',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: outFile,
  };
  return { root, dir, meta, env, outFile, out: join(root, 'out') };
}

function outputs(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

test('builds a tar with a valid manifest and writes step outputs', () => {
  const s = setup();
  try {
    const code = main(['--dir', s.dir, '--meta', s.meta, '--attempt-id', 'att-9', '--fence', '12', '--run-key', 'f'.repeat(64), '--out', s.out], s.env, { write: () => {} });
    assert.equal(code, 0);
    const o = outputs(s.outFile);
    assert.equal(o.attempt_id, 'att-9');
    assert.equal(o.artifact_name, 'result-att-9.tar.age');
    assert.equal(o.bundle_path, join(s.out, 'result-att-9.tar'));
    assert.equal(o.encrypted_path, join(s.out, 'result-att-9.tar.age'));
    const entries = readTar(readFileSync(o.bundle_path));
    assert.equal(entries[0].path, 'manifest.json');
    const manifest = JSON.parse(entries[0].data.toString('utf8'));
    assert.equal(o.manifest_sha256, sha256Hex(entries[0].data));
    assert.equal(validateManifest(manifest).ok, true);
    assert.equal(manifest.fence, 12);
    assert.equal(manifest.workflow.run_id, 4242);
    assert.deepEqual(entries.slice(1).map((e) => e.path), ['controls/forgery.json', 'observations/p.ndjson']);
    assert.deepEqual(manifest.files.map((f) => f.path), ['controls/forgery.json', 'observations/p.ndjson']);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('bad identity inputs fail with a usage error and write nothing', () => {
  const s = setup();
  try {
    for (const args of [
      ['--fence', '0'], ['--fence', '1e3'], ['--fence', ' 5'], ['--run-key', 'xyz'], ['--attempt-id', '../evil'],
    ]) {
      const base = { '--attempt-id': 'att-9', '--fence': '12', '--run-key': 'f'.repeat(64) };
      base[args[0]] = args[1];
      const argv = ['--dir', s.dir, '--meta', s.meta, '--out', s.out, ...Object.entries(base).flat()];
      const errs = [];
      const code = main(argv, s.env, { write: () => {}, error: (m) => errs.push(m) });
      assert.equal(code, 2, args.join(' '));
      assert.equal(existsSync(join(s.out, 'result-att-9.tar')), false);
    }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('a meta file that is not JSON fails without echoing its content', () => {
  const s = setup();
  try {
    writeFileSync(s.meta, 'SECRET-LOOKING-TEXT {');
    const errs = [];
    const code = main(['--dir', s.dir, '--meta', s.meta, '--attempt-id', 'a1', '--fence', '1', '--run-key', 'f'.repeat(64), '--out', s.out], s.env, { write: () => {}, error: (m) => errs.push(m) });
    assert.equal(code, 1);
    assert.doesNotMatch(errs.join('\n'), /SECRET-LOOKING-TEXT/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('an invalid manifest (unknown skip reason) fails', () => {
  const s = setup();
  try {
    const meta = JSON.parse(readFileSync(s.meta, 'utf8'));
    meta.skips = [{ stage: 'x', reason: 'not_a_reason' }];
    writeFileSync(s.meta, JSON.stringify(meta));
    const errs = [];
    const code = main(['--dir', s.dir, '--meta', s.meta, '--attempt-id', 'a1', '--fence', '1', '--run-key', 'f'.repeat(64), '--out', s.out], s.env, { write: () => {}, error: (m) => errs.push(m) });
    assert.equal(code, 1);
    assert.match(errs.join('\n'), /reason/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
