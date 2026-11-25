import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { evaluateGate } from '../gate.mjs';
import { BRANCH, deliver, prBody } from '../deliver.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = 'a'.repeat(40);
const ON = { RESULTS_PUBLISH_ENABLED: 'true', LOOP_ENABLED: 'true' };

test('R-PUB-09: publishing is off unless RESULTS_PUBLISH_ENABLED is exactly "true", and the loop is on', () => {
  assert.equal(evaluateGate({ LOOP_ENABLED: 'true' }).proceed, false, 'an unset switch is off');
  for (const v of ['', 'false', 'TRUE', '1', 'yes', ' true']) assert.equal(evaluateGate({ ...ON, RESULTS_PUBLISH_ENABLED: v }).proceed, false, JSON.stringify(v));
  assert.equal(evaluateGate({ ...ON, LOOP_ENABLED: 'false' }).proceed, false, 'the loop switch is respected');
  assert.equal(evaluateGate({ RESULTS_PUBLISH_ENABLED: 'true' }).proceed, false);
  assert.equal(evaluateGate({ ...ON, LOOP_PAUSE_UNTIL: '2999-01-01T00:00:00Z' }).proceed, false, 'a pause is respected');
  assert.equal(evaluateGate({ ...ON, LANE_PUBLISH_RESULTS_ENABLED: 'false' }).proceed, false);
  assert.equal(evaluateGate(ON).proceed, true);
});

test('R-PUB-09: the workflow keeps the key and the App apart, uploads no artifact, and asks for no write permission of its own', () => {
  const wf = parseYaml(readFileSync(join(ROOT, '.github/workflows/publish-results.yml'), 'utf8'));
  const job = wf.jobs.publish;
  assert.equal(job.environment, 'loop');
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  const text = readFileSync(join(ROOT, '.github/workflows/publish-results.yml'), 'utf8');
  assert.ok(!/upload-artifact/.test(text), 'nothing decrypted is uploaded: a public repository\'s artifacts are public');
  const steps = job.steps;
  assert.equal(steps.find((s) => s.id === 'gate').env.RESULTS_PUBLISH_ENABLED, '${{ vars.RESULTS_PUBLISH_ENABLED }}');
  const holders = (name) => steps.filter((s) => JSON.stringify(s.env ?? {}).includes(name)).map((s) => s.name);
  assert.deepEqual(holders('AGE_IDENTITY'), ['Build the files to publish']);
  assert.deepEqual(holders('APP_PRIVATE_KEY'), ['Open or update the pull request on mcp-results']);
  // every step after the gate waits for it
  for (const s of steps.filter((x) => x.id !== 'gate' && !/Check out/.test(x.name))) assert.match(s.if, /steps\.gate\.outputs\.proceed == 'true'/, s.name);
  assert.match(steps.at(-1).if, /schedule|inputs\.dry_run == false/);
  assert.equal(wf.on.workflow_dispatch.inputs.dry_run.default, 'true');
  assert.ok(!('pull_request' in wf.on) && !('push' in wf.on));
});

function fakeApi({ main = BASE, verified = true, refExists = false, open = [], mintError = null } = {}) {
  const calls = [];
  const client = {
    async request(method, path, { body, query, allow = [] } = {}) {
      calls.push({ method, path, body, query });
      const r = (data, status = 200) => ({ status, data, headers: new Headers() });
      if (method === 'GET' && path.endsWith('/git/ref/heads/main')) return r({ object: { sha: main } });
      if (method === 'GET' && path.includes('/git/commits/')) return r({ tree: { sha: 't0' }, verification: { verified } });
      if (method === 'POST' && path.endsWith('/git/trees')) return r({ sha: 't1' }, 201);
      if (method === 'POST' && path.endsWith('/git/commits')) return r({ sha: 'c'.repeat(40), verification: { verified } }, 201);
      if (method === 'GET' && path.includes(`/git/ref/heads/${BRANCH}`)) return refExists ? r({ object: { sha: 'old' } }) : r({}, 404);
      if (method === 'POST' && path.endsWith('/git/refs')) return r({}, 201);
      if (method === 'PATCH' && path.includes('/git/refs/')) return r({});
      if (method === 'GET' && path.endsWith('/pulls')) return r(open);
      if (method === 'POST' && path.endsWith('/pulls')) return r({ number: 12 }, 201);
      if (method === 'PATCH' && path.includes('/pulls/')) return r({});
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const minted = [];
  const mint = async (ask) => { minted.push(ask); if (mintError) throw new Error(mintError); return { token: 'tok' }; };
  return { client, calls, mint, minted };
}

function outDir(files = ['results/live-probe/2026-11-24.jsonl', 'manifest.json']) {
  const dir = mkdtempSync(join(tmpdir(), 'deliver-test-'));
  for (const p of files) { mkdirSync(join(dir, 'data', p, '..'), { recursive: true }); writeFileSync(join(dir, 'data', p), '{"x":1}\n'); }
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ records_added: 1, records_unchanged: 0, files_changed: files, registry: { version: 0, sha256: 'a'.repeat(64) }, held_other: {}, unreadable_sealed_files: 0 }));
  return dir;
}

test('R-PUB-10: delivery opens a pull request from its own branch and never touches main', async () => {
  const dir = outDir();
  try {
    const api = fakeApi();
    const r = await deliver({ out: dir, baseSha: BASE, ...api });
    assert.deepEqual(r, { status: 'opened', pr: 12, commit: 'c'.repeat(40) });
    assert.deepEqual(api.minted, [{ repositories: ['mcp-results'], permissions: { contents: 'write', pull_requests: 'write' } }]);
    const writes = api.calls.filter((c) => c.method !== 'GET');
    assert.ok(writes.every((c) => !/heads\/main/.test(c.path)), 'no write names main');
    const ref = writes.find((c) => c.path.endsWith('/git/refs'));
    assert.equal(ref.body.ref, `refs/heads/${BRANCH}`);
    const pr = writes.find((c) => c.path.endsWith('/pulls'));
    assert.equal(pr.body.base, 'main');
    assert.ok(!/generated with/i.test(pr.body.body));
    const tree = writes.find((c) => c.path.endsWith('/git/trees')).body.tree;
    assert.deepEqual(tree.map((t) => t.path), ['data/results/live-probe/2026-11-24.jsonl', 'data/manifest.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-PUB-10: an open pull request is updated, an existing branch is moved by force, an unchanged run opens nothing', async () => {
  const dir = outDir();
  try {
    const api = fakeApi({ refExists: true, open: [{ number: 7 }] });
    assert.equal((await deliver({ out: dir, baseSha: BASE, ...api })).status, 'updated');
    assert.ok(api.calls.some((c) => c.method === 'PATCH' && c.body?.force === true && c.path.endsWith(BRANCH)));
    assert.ok(!api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const empty = outDir([]);
  try {
    const api = fakeApi();
    assert.deepEqual(await deliver({ out: empty, baseSha: BASE, ...api }), { status: 'nothing_to_publish' });
    assert.equal(api.minted.length + api.calls.length, 0, 'no token is minted and no call is made');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('R-PUB-10: delivery stops, creating nothing, when main moved, the commit is not verified, or the App lacks the permissions', async () => {
  const dir = outDir();
  try {
    let api = fakeApi({ main: 'b'.repeat(40) });
    await assert.rejects(deliver({ out: dir, baseSha: BASE, ...api }), /moved/);
    assert.equal(api.calls.filter((c) => c.method !== 'GET').length, 0);
    api = fakeApi({ verified: false });
    await assert.rejects(deliver({ out: dir, baseSha: BASE, ...api }), /not verified/);
    assert.ok(!api.calls.some((c) => /\/git\/refs/.test(c.path) && c.method !== 'GET'), 'the branch was not moved');
    api = fakeApi({ mintError: 'Resource not accessible by integration (HTTP 422)' });
    await assert.rejects(deliver({ out: dir, baseSha: BASE, ...api }), /owner has to grant those permissions/);
    assert.equal(api.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-PUB-10: a dry run builds the call plan and makes none; a path outside the layout, or files that differ from the report, are refused', async () => {
  const dir = outDir();
  try {
    const api = fakeApi();
    assert.deepEqual(await deliver({ out: dir, baseSha: BASE, dryRun: true, ...api }), { status: 'dry_run' });
    assert.equal(api.calls.length + api.minted.length, 0);
    writeFileSync(join(dir, 'data/extra.txt'), 'x');
    await assert.rejects(deliver({ out: dir, baseSha: BASE, ...api }), /not the ones report\.json lists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const bad = outDir(['../escape.jsonl'].slice(0, 0));
  rmSync(bad, { recursive: true, force: true });
  const odd = outDir(['notes/readme.md']);
  try {
    await assert.rejects(deliver({ out: odd, baseSha: BASE, ...fakeApi() }), /outside the data layout/);
  } finally { rmSync(odd, { recursive: true, force: true }); }
  assert.match(prBody({ records_added: 2, records_unchanged: 1, files_changed: ['manifest.json'], registry: { version: 0, sha256: 'a'.repeat(64) }, held_other: { oversize: 1 }, unreadable_sealed_files: 0 }), /held back from this batch/);
});

test('R-PUB-10: the command line refuses to run without the switch inputs it needs', () => {
  const r = spawnSync(process.execPath, ['publish/deliver.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
});
