// End to end through the command line: real age keys, a fake GitHub API
// (run, artifact list, redirect to blob storage) and a JSON ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { main } from '../ingest.mjs';
import { ageDecrypt, ageEncrypt } from '../age.mjs';
import { readTar } from '../../worker-kit/tar.mjs';
import {
  makeBundle, defaultRun, artifactEntry, expectedRow, REGISTRY_TEXT, WORKER_REPO, RUN_ID,
} from '../testkit.mjs';

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;
const skip = haveAge ? false : 'age and age-keygen are not on PATH (set AGE_BIN / AGE_KEYGEN_BIN to run this test)';

// Built at run time so the file holds no token-shaped literal.
const TOKEN = ['gh', 's_', 'T0k3nT0k3nT0k3nT0k3nT0k3nT0k3nT0k3nT0'].join('');
const API = `https://api.github.com/repos/${WORKER_REPO}`;
const BLOB = 'https://blob.example.net/artifact/901?sig=abc';

function keypair() {
  const identity = spawnSync(KEYGEN, [], { encoding: 'utf8' }).stdout;
  const recipient = spawnSync(KEYGEN, ['-y'], { input: identity, encoding: 'utf8' }).stdout.trim();
  return { identity, recipient };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeApi({ ciphertext, run = defaultRun(), artifacts = [artifactEntry()] }) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, auth: init.headers?.Authorization ?? null, redirect: init.redirect });
    if (u === `${API}/actions/runs/${RUN_ID}`) return jsonResponse(run);
    if (u === `${API}/actions/runs/${RUN_ID}/artifacts?per_page=100&page=1`) return jsonResponse({ total_count: artifacts.length, artifacts });
    if (u === `${API}/actions/artifacts/901/zip`) return new Response(null, { status: 302, headers: { location: BLOB } });
    if (u === BLOB) return new Response(ciphertext, { status: 200 });
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  return { fetch, requests };
}

function setup({ bundle = makeBundle(), rows = [expectedRow()] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-cli-'));
  const keys = keypair();
  const pub = join(dir, 'ingest.pub');
  writeFileSync(pub, `# test key\n${keys.recipient}\n`);
  const ledger = join(dir, 'ledger.json');
  writeFileSync(ledger, JSON.stringify({ attempts: rows }));
  const registry = join(dir, 'registry.yaml');
  writeFileSync(registry, REGISTRY_TEXT);
  const ciphertext = ageEncrypt({ plaintext: bundle.tar, recipients: [keys.recipient], ageBin: AGE });
  const out = join(dir, 'github_output');
  writeFileSync(out, '');
  const env = {
    GITHUB_TOKEN: TOKEN, AGE_IDENTITY: keys.identity, AGE_BIN: AGE, AGE_KEYGEN_BIN: KEYGEN, GITHUB_OUTPUT: out, RUNNER_TEMP: dir,
  };
  const args = [
    '--repo', WORKER_REPO, '--run-id', String(RUN_ID), '--attempt-id', 'att-1',
    '--ledger-json', ledger, '--registry', registry, '--seal-to', pub,
  ];
  return { dir, keys, pub, ledger, ciphertext, out, env, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(argv, env, fetch) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, env, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    fetch,
  });
  return { code, stdout, stderr };
}

const readOutputs = (file) => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));

test('accepts a real age bundle, seals the outputs to the ingest key and records once', { skip }, async () => {
  const s = setup();
  try {
    const api = fakeApi({ ciphertext: s.ciphertext });
    const sealed = join(s.dir, 'sealed', 'ingest.tar.age');
    const r = await cli([...s.args, '--sealed', sealed], s.env, api.fetch);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '::notice title=ingest::attempt att-1: accepted, recorded\n');
    assert.deepEqual(readOutputs(s.out), { outcome: 'accepted', reason: '', accepted: 'true', recorded: 'true', sealed });

    // The token goes to the API host only, never to blob storage.
    assert.deepEqual(api.requests.map((q) => [q.url, q.auth]), [
      [`${API}/actions/runs/${RUN_ID}`, `Bearer ${TOKEN}`],
      [`${API}/actions/runs/${RUN_ID}/artifacts?per_page=100&page=1`, `Bearer ${TOKEN}`],
      [`${API}/actions/artifacts/901/zip`, `Bearer ${TOKEN}`],
      [BLOB, null],
    ]);

    assert.equal(statSync(sealed).mode & 0o777, 0o600);
    const box = readFileSync(sealed);
    assert.ok(box.subarray(0, 22).toString() === 'age-encryption.org/v1\n', 'the sealed file is age ciphertext');
    const tar = ageDecrypt({ ciphertext: box, identity: s.keys.identity, ageBin: AGE, tmpDir: s.dir });
    const paths = readTar(tar).map((e) => e.path).sort();
    assert.ok(paths.includes('accepted/att-1/manifest.json') && paths.includes('accepted/att-1/ingest.json'), paths.join(','));
    assert.equal(paths.length, 7);

    const ledger = JSON.parse(readFileSync(s.ledger, 'utf8'));
    assert.deepEqual(ledger.results.map((x) => [x.attempt_id, x.outcome, x.accepted]), [['att-1', 'accepted', true]]);

    for (const text of [r.stdout, r.stderr, readFileSync(s.out, 'utf8')]) {
      assert.ok(!text.includes(TOKEN) && !text.includes('AGE-SECRET-KEY-'), 'no token or identity in any output');
    }

    // Dispatched again (for example by the watchdog): nothing to do, nothing fetched.
    writeFileSync(s.out, '');
    const again = await cli([...s.args, '--sealed', sealed], s.env, api.fetch);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /attempt att-1: already_recorded/);
    assert.equal(readOutputs(s.out).sealed, '');
    assert.equal(api.requests.length, 4);
    assert.equal(JSON.parse(readFileSync(s.ledger, 'utf8')).results.length, 1);
  } finally {
    s.cleanup();
  }
});

test('a rejected bundle is kept as ciphertext only; --work-dir writes the outputs', { skip }, async () => {
  const s = setup({ bundle: makeBundle({ identity: { fence: 6 } }) });
  try {
    const api = fakeApi({ ciphertext: s.ciphertext });
    const work = join(s.dir, 'work');
    const r = await cli([...s.args, '--work-dir', work], s.env, api.fetch);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '::warning title=ingest::attempt att-1: rejected (fence_mismatch), recorded\n');
    assert.deepEqual(readOutputs(s.out), { outcome: 'rejected', reason: 'fence_mismatch', accepted: 'false', recorded: 'true', sealed: '' });
    assert.deepEqual(readFileSync(join(work, 'rejected/att-1/result.tar.age')), s.ciphertext);
    const report = JSON.parse(readFileSync(join(work, 'rejected/att-1/ingest.json'), 'utf8'));
    assert.equal(report.problems[0].reason, 'fence_mismatch');
    assert.ok(!existsSync(join(work, 'accepted')));
  } finally {
    s.cleanup();
  }
});

test('a failure after recording says so (in CI the state is then not pushed)', { skip }, async () => {
  const s = setup({ bundle: makeBundle({ identity: { fence: 6 } }) });
  try {
    const api = fakeApi({ ciphertext: s.ciphertext });
    const r = await cli([...s.args, '--sealed', join(s.ledger, 'cannot', 'be', 'here')], s.env, api.fetch);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^::error title=ingest::.*\(after rejected was recorded in the local ledger\)\n$/);
    assert.equal(readFileSync(s.out, 'utf8'), '', 'no step outputs, so the workflow does not push state');
  } finally {
    s.cleanup();
  }
});

test('refuses to judge anything while ingest.pub has no key or the identity is not its key', { skip }, async () => {
  const s = setup();
  try {
    const api = fakeApi({ ciphertext: s.ciphertext });
    const sealed = join(s.dir, 'sealed.tar.age');
    // No --seal-to: the committed worker-kit/ingest.pub, still a placeholder.
    const noSealTo = s.args.slice(0, s.args.indexOf('--seal-to'));
    const placeholder = await cli([...noSealTo, '--sealed', sealed], s.env, api.fetch);
    assert.equal(placeholder.code, 1);
    assert.match(placeholder.stdout, /^::error title=ingest::.*ingest\.pub has no age public key yet.*nothing was judged\n$/);

    const other = keypair();
    const wrong = await cli([...s.args, '--sealed', sealed], { ...s.env, AGE_IDENTITY: other.identity }, api.fetch);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stdout, /AGE_IDENTITY does not belong to any key/);
    assert.ok(!wrong.stdout.includes('AGE-SECRET-KEY-'));

    const junk = `AGE-SECRET-KEY-1${'Q'.repeat(10)}`;
    const bad = await cli([...s.args, '--sealed', sealed], { ...s.env, AGE_IDENTITY: junk }, api.fetch);
    assert.equal(bad.code, 1);
    assert.ok(!bad.stdout.includes(junk));

    const missing = await cli([...s.args, '--sealed', sealed], { ...s.env, AGE_IDENTITY: '' }, api.fetch);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /AGE_IDENTITY is not set/);

    assert.equal(api.requests.length, 0, 'nothing was fetched');
    assert.deepEqual(JSON.parse(readFileSync(s.ledger, 'utf8')).results ?? [], []);
    assert.ok(!existsSync(sealed));
    assert.equal(readFileSync(s.out, 'utf8'), '');
  } finally {
    s.cleanup();
  }
});

test('an API error stops the run with exit 1 and records nothing', { skip }, async () => {
  const s = setup();
  try {
    const fetch = async () => jsonResponse({ message: 'Bad credentials' }, 401);
    const r = await cli([...s.args, '--sealed', join(s.dir, 'x.tar.age')], s.env, fetch);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^::error title=ingest::GET \/repos\/isokron-ai\/mcp-check\/actions\/runs\/4242: HTTP 401\n$/);
    assert.deepEqual(JSON.parse(readFileSync(s.ledger, 'utf8')).results ?? [], []);
  } finally {
    s.cleanup();
  }
});

test('usage errors exit 2 before anything else', async () => {
  const base = ['--repo', WORKER_REPO, '--run-id', '1', '--attempt-id', 'att-1', '--ledger-json', 'l.json', '--sealed', 's'];
  const cases = [
    base.filter((a, i) => i < 4),
    [...base, '--state', 'x.sqlite'],
    base.slice(0, 8),
    base.map((a) => (a === 'att-1' ? '../x' : a)),
    base.map((a) => (a === '1' ? 'one' : a)),
    [...base, '--frobnicate'],
    [...base, '--registry'],
  ];
  for (const argv of cases) {
    let fetched = false;
    const r = await cli(argv, { GITHUB_TOKEN: TOKEN, AGE_IDENTITY: 'x' }, async () => { fetched = true; });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /usage: node ingest\/ingest\.mjs/);
    assert.equal(r.stdout, '');
    assert.equal(fetched, false);
  }
});
