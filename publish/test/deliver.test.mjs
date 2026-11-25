import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../scripts/lib/yaml-lite.mjs';
import { evaluateGate } from '../gate.mjs';
import { BRANCH, TRAILER, deliver, prBody } from '../deliver.mjs';

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

test('R-PUB-09: the key, the checker and the App never share a step; only ciphertext is uploaded; every later step waits for the gate', () => {
  const file = readFileSync(join(ROOT, '.github/workflows/publish-results.yml'), 'utf8');
  const wf = parseYaml(file);
  assert.deepEqual(wf.permissions, {});
  assert.ok(!('pull_request' in wf.on) && !('push' in wf.on));
  const { build, deliver: del } = wf.jobs;
  assert.equal(del.environment, 'loop', 'the existing secrets, not moved');
  assert.deepEqual(build.permissions, { contents: 'read', actions: 'read' });
  assert.equal(build.environment, 'loop');
  const holders = (job, name) => job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes(name)).map((s) => s.name);
  assert.deepEqual(holders(build, 'AGE_IDENTITY'), ['Build the files to publish']);
  assert.deepEqual(holders(build, 'APP_PRIVATE_KEY'), [], 'the build job has no App secret');
  assert.deepEqual(holders(del, 'AGE_IDENTITY'), ['Open the reviewed output']);
  assert.deepEqual(holders(del, 'APP_PRIVATE_KEY'), ['Open or update the pull request on mcp-results']);
  // the third-party checker runs after the only step that holds the key, with nothing secret in or after it
  const names = build.steps.map((s) => s.name);
  const keyAt = names.indexOf('Build the files to publish');
  assert.ok(names.indexOf('The checker is the reviewed version') > keyAt && names.findIndex((n) => /Verify with/.test(n)) > names.indexOf('The checker is the reviewed version'));
  assert.ok(build.steps.slice(keyAt + 1).every((st) => !/secrets\./.test(JSON.stringify(st))), 'no secret after the build step');
  assert.match(build.steps.find((st) => /Verify with/.test(st.name)).run, /--base "\$BASE"/);
  for (const st of build.steps.filter((x) => x.id !== 'gate' && !/Check out/.test(x.name))) assert.match(st.if, /steps\.gate\.outputs\.proceed == 'true'/, st.name);
  // uploads: ciphertext only (a sealed output, a sealed padded report), nothing readable
  const ups = build.steps.filter((st) => /upload-artifact/.test(st.uses ?? ''));
  assert.deepEqual(ups.map((u) => u.with.name.split('-').slice(0, 2).join('-')), ['publish-out', 'publish-private']);
  assert.ok(!/upload-artifact/.test(JSON.stringify(del)));
  assert.match(build.steps.find((st) => st.id === 'build').run, /--seal-to worker-kit\/ingest\.pub/);
  assert.match(build.steps.find((st) => st.id === 'seal').run, /seal\.mjs seal .*--to worker-kit\/ingest\.pub/);
  assert.deepEqual(holders(build, 'APP_ID'), []);
  // an unclean build ends the run red
  assert.match(wf.jobs['not-clean'].if, /outputs\.clean == 'false'/);
  assert.equal(del.steps.find((st) => st.id === 'gate').env.RESULTS_PUBLISH_ENABLED, '${{ vars.RESULTS_PUBLISH_ENABLED }}', 'the deliver job checks the switch again');
});

test('R-PUB-22: nothing is delivered unreviewed: the schedule only builds; delivery needs a dispatch with the reviewed digest and the approve job, which holds no secret, so no approval means the open step never runs', () => {
  const wf = parseYaml(readFileSync(join(ROOT, '.github/workflows/publish-results.yml'), 'utf8'));
  const { build, approve, deliver: del } = wf.jobs;
  assert.ok(wf.on.schedule && wf.on.workflow_dispatch);
  assert.equal(wf.on.workflow_dispatch.inputs.deliver_run_id.default, '');
  assert.equal(wf.on.workflow_dispatch.inputs.reviewed_sums.default, '');
  assert.match(build.if, /schedule/);
  assert.match(build.if, /inputs\.deliver_run_id == ''/);
  // approve: a dispatch, a run id and a digest (the schedule has none), in the environment that has the reviewer
  assert.match(approve.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(approve.if, /inputs\.deliver_run_id != ''/);
  assert.match(approve.if, /inputs\.reviewed_sums != ''/);
  assert.equal(approve.environment, 'publish');
  assert.ok(!/secrets\./.test(JSON.stringify(approve)), 'the approval job holds no secret');
  assert.ok(!/AGE_IDENTITY|APP_PRIVATE_KEY/.test(JSON.stringify(approve)));
  // deliver: only after approve, in the loop's environment (the existing secrets, none moved)
  assert.equal(del.needs, 'approve');
  assert.equal(del.environment, 'loop');
  assert.equal(del.if, undefined, 'it has no condition of its own that could let it run without approve');
  assert.notEqual(approve.environment, del.environment);
  // so the open step, and every step with a secret, is behind approve
  const open = del.steps.find((st) => st.id === 'open');
  assert.match(open.run, /seal\.mjs open .*--expect "\$SUMS"/);
  assert.equal(open.env.SUMS, '${{ inputs.reviewed_sums }}');
  // approve checks the environment through the API, with the job's own token, and fails closed
  const check = approve.steps.find((st) => /required reviewers/.test(st.name));
  assert.match(check.run, /environments\/publish" \| node publish\/env-check\.mjs/);
  assert.equal(check.env.GH_TOKEN, '${{ github.token }}');
  assert.deepEqual(approve.permissions, { contents: 'read' });
  // no variable stands in for the check
  assert.ok(!/PUBLISH_REVIEW_GATE/.test(readFileSync(join(ROOT, '.github/workflows/publish-results.yml'), 'utf8').replace(/#.*$/gm, '')));
});

test('R-PUB-22: a missing, unprotected or reviewer-less publish environment fails closed', async () => {
  const { checkEnvironment } = await import('../env-check.mjs');
  assert.deepEqual(checkEnvironment({ name: 'publish', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] }), []);
  assert.deepEqual(checkEnvironment({ name: 'publish', protection_rules: [{ type: 'wait_timer' }, { type: 'required_reviewers' }] }), [], 'a rule that does not list its reviewers to this reader still counts');
  // made on the fly by a workflow that named it: no rules
  assert.match(checkEnvironment({ name: 'publish', protection_rules: [] })[0], /no required-reviewers rule/);
  assert.match(checkEnvironment({ name: 'publish' })[0], /no required-reviewers rule/);
  assert.match(checkEnvironment({ name: 'publish', protection_rules: [{ type: 'wait_timer', wait_timer: 5 }] })[0], /no required-reviewers rule/);
  assert.match(checkEnvironment({ name: 'publish', protection_rules: [{ type: 'required_reviewers', reviewers: [] }] })[0], /no reviewer/);
  for (const bad of [null, undefined, [], 'x', 404]) assert.equal(checkEnvironment(bad).length, 1);
  // the command line: a 404 body or no input is a failure, the protected answer a pass
  const run = (input) => spawnSync(process.execPath, ['publish/env-check.mjs'], { cwd: ROOT, input, encoding: 'utf8' }).status;
  assert.equal(run('{"message":"Not Found","status":"404"}'), 1);
  assert.equal(run(''), 1);
  assert.equal(run('not json'), 1);
  assert.equal(run(JSON.stringify({ name: 'publish', protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] })), 0);
});

test('R-PUB-17: the checker from mcp-results runs only if its files are the reviewed ones', async () => {
  const { checkPin } = await import('../pin-check.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/verify.mjs'), 'ok');
    const pin = { files: { 'scripts/verify.mjs': (await import('node:crypto')).createHash('sha256').update('ok').digest('hex') } };
    assert.deepEqual(checkPin(dir, pin), []);
    writeFileSync(join(dir, 'scripts/verify.mjs'), 'changed');
    assert.match(checkPin(dir, pin).join('\n'), /not the reviewed version/);
    assert.match(checkPin(dir, { files: { 'scripts/gone.mjs': 'a'.repeat(64) } }).join('\n'), /missing/);
    assert.deepEqual(checkPin(dir, { files: {} }), ['the pin lists no files']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-PUB-18: delivery leaves a branch alone that holds a commit this publisher did not make', async () => {
  const dir = outDir();
  try {
    const api = fakeApi({ refExists: true, refMessage: 'a manual fix' });
    await assert.rejects(deliver({ out: dir, baseSha: BASE, ...api }), /did not make/);
    assert.ok(!api.calls.some((c) => c.method !== 'GET'), 'nothing was written');
    const own = fakeApi({ refExists: true });
    assert.equal((await deliver({ out: dir, baseSha: BASE, ...own })).status, 'opened');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeApi({ main = BASE, verified = true, refExists = false, open = [], mintError = null, refMessage = `Results: 1 new record(s)\n\n${TRAILER}` } = {}) {
  const calls = [];
  const client = {
    async request(method, path, { body, query, allow = [] } = {}) {
      calls.push({ method, path, body, query });
      const r = (data, status = 200) => ({ status, data, headers: new Headers() });
      if (method === 'GET' && path.endsWith('/git/ref/heads/main')) return r({ object: { sha: main } });
      if (method === 'GET' && path.includes('/git/commits/')) return r({ tree: { sha: 't0' }, message: refMessage, verification: { verified } });
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
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ records_added: 1, records_unchanged: 0, files_changed: files, registry: { version: 0, sha256: 'a'.repeat(64) } }));
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
  assert.doesNotMatch(prBody({ records_added: 2, records_unchanged: 1, files_changed: ['manifest.json'], registry: { version: 0, sha256: 'a'.repeat(64) }, held_other: { oversize: 1 }, unreadable_sealed_files: 3 }), /held|oversize|unreadable|sealed/i, 'the pull request says nothing about what was held');
});

test('R-PUB-10: the command line refuses to run without the switch inputs it needs', () => {
  const r = spawnSync(process.execPath, ['publish/deliver.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
});
