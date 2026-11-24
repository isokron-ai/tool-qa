import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyse, failuresOf, itemsFromEntries, loadSeed, main, readArchive, subjectWeight, DEFAULT_CONFIG } from '../checkin.mjs';
import { ageEncrypt } from '../../ingest/age.mjs';
import { writeTar } from '../../worker-kit/tar.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const SEED_FILE = new URL('checkin-seed.json', FIX).pathname;
const fixture = JSON.parse(readFileSync(new URL('checkin-items.json', FIX), 'utf8'));
const tierWeights = JSON.parse(readFileSync(new URL('../../pump/tiers.json', import.meta.url), 'utf8')).weights;

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;

/** Tar entries for the fixture items: accepted/<attempt>/<index>/{manifest.json, ingest.json, results/scan-static.json, raw/subject/scan.json}. */
function entriesOf(items = fixture.items) {
  const entries = [];
  for (const it of items) {
    const base = `accepted/${it.attempt}/${it.index}/`;
    const manifest = {
      schema_version: 1, attempt_id: it.attempt, fence: 1, run_key: 'a'.repeat(64),
      subject: { id: it.subject, repo: it.subject, sha: null },
      workflow: { repo: 'isokron-ai/x', file: `.github/workflows/${it.lane}.yml`, sha: '1'.repeat(40), run_id: it.run_id, run_attempt: 1 },
      tools: it.tools, oracles: [], settings_manifest_digest: '0'.repeat(64), started_at: it.at, finished_at: it.at,
      files: [], skips: it.skips, controls: [],
    };
    entries.push({ path: `${base}manifest.json`, data: Buffer.from(JSON.stringify(manifest)) });
    entries.push({ path: `${base}ingest.json`, data: Buffer.from(JSON.stringify({ run: { id: it.run_id }, input: { run_id: it.run_id } })) });
    if (it.result) entries.push({ path: `${base}results/${it.lane}.json`, data: Buffer.from(JSON.stringify(it.result)) });
    entries.push({ path: `${base}raw/subject/scan.json`, data: Buffer.from(JSON.stringify({ hints: { serverJson: Array.from({ length: it.server_json }, () => ({})) } })) });
  }
  return entries;
}

function writePlain(dir, entries) {
  for (const e of entries) {
    const p = join(dir, ...e.path.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, e.data);
  }
}

const run = (items = fixture.items, config = {}) => analyse(itemsFromEntries(entriesOf(items)), { seed: loadSeed(SEED_FILE), tierWeights, config });
const find = (r, pred) => r.fingerprints.find(pred);

test('R-CHECKIN-01: a language with a symbol in its name (C#) is kept in the idiom, not collapsed to <other>', () => {
  const r = run();
  const f = find(r, (x) => x.class === 'unsupported_language');
  assert.equal(f.idiom, 'none/c#');
  assert.equal(f.unlocks, 1);
  assert.deepEqual(f.example, { subject: 'acme/dotnet-srv', tier: 'T2', stars: 9999 });
});

test('R-CHECKIN-02: no-tools skips are split by the repository language from the seed, and a partial reader limit says which limit', () => {
  const r = run();
  const py = find(r, (x) => x.class === 'no_tools_found');
  assert.equal(py.idiom, 'none/repo:python');
  assert.equal(py.layout, 'server_json:0;via:github');
  assert.equal(py.kind, 'no_tools_found');
  const kinds = r.fingerprints.filter((x) => x.partial).map((x) => `${x.kind}|${x.idiom}`).sort();
  assert.deepEqual(kinds, ['reader_limit:unreadable_descriptions|source/derived/go', 'reader_limit:unresolved_names|source/derived/go']);
});

test('R-CHECKIN-03: only the latest result of a subject and lane is affected; one fixed by a later run drops out and counts as healed', () => {
  const r = run();
  const py = find(r, (x) => x.class === 'no_tools_found');
  assert.deepEqual(py.evidence.map((e) => e.subject), ['acme/py-two', 'globex/py-three']);
  assert.equal(py.unlocks, 2);
  assert.equal(py.healed_since, 1);
  assert.equal(py.first_seen, '2026-11-20T10:00:00Z');
  assert.equal(py.last_seen, '2026-11-20T10:02:00Z');
  assert.deepEqual(py.unlocks_by_tier, { T2: 1, T3: 1 });
});

test('R-CHECKIN-04: impact is severity x the sum of tier weights boosted by popularity, and the formula is configurable', () => {
  const r = run();
  const py = find(r, (x) => x.class === 'no_tools_found');
  const w2 = subjectWeight({ tier: 'T2', stars: 500 }, tierWeights, DEFAULT_CONFIG);
  const w3 = subjectWeight({ tier: 'T3', stars: 0 }, tierWeights, DEFAULT_CONFIG);
  assert.equal(w3, tierWeights.T3);
  assert.ok(w2 > tierWeights.T2 && w2 < 2 * tierWeights.T2);
  assert.equal(py.impact, Math.round(DEFAULT_CONFIG.severity.no_tools_found * (w2 + w3) * 100) / 100);
  const flat = run(fixture.items, { popularity_boost: 0, severity: { no_tools_found: 1 } });
  const py2 = find(flat, (x) => x.class === 'no_tools_found');
  assert.equal(py2.impact, tierWeights.T2 + tierWeights.T3);
  // a partial reader limit counts at partial_multiplier of its class
  const part = find(r, (x) => x.kind === 'reader_limit:unresolved_names');
  assert.equal(part.severity, DEFAULT_CONFIG.severity.reader_limit * DEFAULT_CONFIG.partial_multiplier);
  // ranked: impact descending, ranks 1..n
  assert.deepEqual(r.fingerprints.map((f) => f.rank), r.fingerprints.map((_, i) => i + 1));
  for (let i = 1; i < r.fingerprints.length; i++) assert.ok(r.fingerprints[i - 1].impact >= r.fingerprints[i].impact);
});

test('R-CHECKIN-05: skips that are the subject\'s, a passing condition or our policy are not tool-side; an ambiguous reason is read from the result detail', () => {
  const r = run();
  const subjects = new Set(r.fingerprints.flatMap((f) => f.evidence.map((e) => e.subject)));
  for (const s of ['acme/needs-creds', 'acme/rate', 'acme/policy', 'acme/clean']) assert.ok(!subjects.has(s), `${s} is not a tool-side failure`);
  const mono = find(r, (x) => x.class === 'unsupported_layout');
  assert.equal(mono.layout, 'server_json:1;multi_server;via:github');
  assert.deepEqual(mono.unlocks_by_tier, { T1: 1 });
  // asking for infra too brings the rate limit in
  const withInfra = run(fixture.items, { faults: ['tool', 'unknown', 'infra'] });
  assert.ok(find(withInfra, (x) => x.class === 'rate_limited'));
});

test('R-CHECKIN-06: a signature holds only our own codes: a repository name in an error or detail never reaches it', () => {
  const r = run();
  const f = find(r, (x) => x.class === 'tool_error');
  assert.equal(f.signature, 'class=tool_error;detail=<other>;error=<other>;list_error=<other>;http=-;fault=tool;retryable=false');
  for (const fp of r.fingerprints) for (const bad of ['initech', 'secret-name', 'acme', 'globex']) assert.ok(!JSON.stringify({ ...fp, evidence: undefined, example: undefined }).toLowerCase().includes(bad), `${bad} in ${fp.fingerprint}`);
});

test('R-CHECKIN-07: every claim carries run id, attempt id and item index; the same bundle twice counts once', () => {
  const items = [...itemsFromEntries(entriesOf()), ...itemsFromEntries(entriesOf())];
  const r = analyse(items, { seed: loadSeed(SEED_FILE), tierWeights });
  assert.equal(r.summary.duplicates, fixture.items.length);
  const py = find(r, (x) => x.class === 'no_tools_found');
  assert.deepEqual(py.evidence.map((e) => [e.run_id, e.attempt_id, e.item_index]), [[1001, 'att-a', 1], [1001, 'att-a', 2]]);
  assert.match(py.fingerprint, /^[0-9a-f]{12}$/);
  // the same failure on another tool version is another fingerprint (a release that fixes it empties the old one)
  const bumped = fixture.items.map((i) => i.subject === 'acme/py-two' ? { ...i, tools: [{ name: 'mcp-check', version: '1.4.0' }] } : i);
  const r2 = run(bumped);
  assert.equal(r2.fingerprints.filter((f) => f.class === 'no_tools_found' && f.idiom === 'none/repo:python').length, 2);
});

test('R-CHECKIN-08: the reports are written 0600 outside the input, an output inside it is refused, and the reader writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-'));
  try {
    const input = join(dir, 'in');
    writePlain(input, entriesOf());
    const before = readdirSync(input, { recursive: true }).sort().join('\n');
    const out = join(dir, 'out');
    mkdirSync(out);
    const code = await main(['--plain', input, '--out-md', join(out, 'c.md'), '--out-json', join(out, 'c.json'), '--seed', SEED_FILE, '--top', '3'], { write: () => {} });
    assert.equal(code, 0);
    for (const f of ['c.md', 'c.json']) assert.equal(statSync(join(out, f)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(out, 'c.json'), 'utf8')).fingerprints[0].rank, 1);
    assert.match(readFileSync(join(out, 'c.md'), 'utf8'), /This fix unlocks 2 subjects/);
    assert.equal(readdirSync(input, { recursive: true }).sort().join('\n'), before);
    const bad = [];
    assert.equal(await main(['--plain', input, '--out-md', join(input, 'c.md'), '--out-json', join(out, 'c2.json'), '--seed', SEED_FILE], { write: (s) => bad.push(s) }), 2);
    assert.match(bad.join(''), /must not be inside/);
    symlinkSync(input, join(out, 'link')); // a link into the input does not get round the check
    assert.equal(await main(['--plain', input, '--out-md', join(out, 'link', 'c3.md'), '--out-json', join(out, 'c3.json'), '--seed', SEED_FILE], { write: () => {} }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-CHECKIN-09: the archive is read sealed, in memory, and nothing decrypted is left on disk', { skip: !haveAge && 'age is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-age-'));
  try {
    const key = spawnSync(KEYGEN, [], { encoding: 'utf8' });
    const identity = /AGE-SECRET-KEY-1[0-9A-Z]+/.exec(key.stdout + key.stderr)[0];
    const recipient = /(age1[0-9a-z]+)/.exec(key.stderr + key.stdout)[1];
    const sealedDir = join(dir, 'ingest', '2026-11-24', 'ingest-1-1');
    mkdirSync(sealedDir, { recursive: true });
    writeFileSync(join(sealedDir, 'ingest-x-0.tar.age'), ageEncrypt({ plaintext: writeTar(entriesOf().map((e) => ({ path: e.path, data: e.data }))), recipients: [recipient], ageBin: AGE }));
    writeFileSync(join(sealedDir, 'broken.tar.age'), Buffer.from('not age'));
    const snapshot = () => readdirSync(dir, { recursive: true }).sort().join('\n');
    const before = snapshot();
    const { items, stats } = readArchive(dir, { identity });
    assert.equal(snapshot(), before);
    assert.equal(stats.sealed, 2);
    assert.equal(stats.failed, 1);
    assert.equal(items.length, fixture.items.length);
    const r = analyse(items, { seed: loadSeed(SEED_FILE), tierWeights });
    assert.equal(find(r, (x) => x.class === 'no_tools_found').unlocks, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failuresOf: a graded result with nothing missing has none; a result with no list and no skips has none', () => {
  const items = itemsFromEntries(entriesOf());
  const clean = items.find((i) => i.subject === 'acme/clean');
  assert.deepEqual(failuresOf(clean), []);
});
