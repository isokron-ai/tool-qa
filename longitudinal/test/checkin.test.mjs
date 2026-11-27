import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyse, byTime, failuresOf, itemsFromEntries, loadSeed, main, nameTokens, readArchive, renderMarkdown, subjectWeight, DEFAULT_CONFIG } from '../checkin.mjs';
import { ageEncrypt } from '../../ingest/age.mjs';
import { packBundle } from '../../worker-kit/bundle.mjs';
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
      subject: { id: it.subject, repo: it.subject, sha: it.sha ?? null },
      workflow: { repo: 'isokron-ai/x', file: `.github/workflows/${it.lane}.yml`, sha: '1'.repeat(40), run_id: it.run_id, run_attempt: 1 },
      tools: it.tools, oracles: [], settings_manifest_digest: '0'.repeat(64), started_at: it.at, finished_at: it.at,
      files: [], skips: it.skips, controls: [],
    };
    entries.push({ path: `${base}manifest.json`, data: Buffer.from(JSON.stringify(manifest)) });
    entries.push({ path: `${base}ingest.json`, data: Buffer.from(JSON.stringify({ run: { id: it.run_id }, input: { run_id: it.run_id } })) });
    if (it.result) entries.push({ path: `${base}results/${it.lane}.json`, data: Buffer.from(JSON.stringify(it.result)) });
    if (it.observations) entries.push({ path: `${base}observations/${it.lane}.ndjson`, data: Buffer.from(it.observations.map((r) => JSON.stringify(r)).join('\n')) });
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

test('R-CHECKIN-06: probes: reasons, stages and languages outside the known lists, name fragments, short names, non-ASCII names and other items\' names', () => {
  const mk = (subject, i, extra) => ({
    subject, lane: 'scan-static', at: '2026-11-22T00:00:0' + i + 'Z', attempt: `att-p${i}`, index: 0, run_id: 2000 + i, tools: [{ name: 'mcp-check', version: '1.3.1' }],
    skips: [], result: { status: 'skipped', detail: 'no_tools', listing: { via: 'github' } }, server_json: 0, ...extra,
  });
  const probes = [
    // a reason, a stage and a class that are a name
    mk('acme/acme-widget-mcp', 1, { skips: [{ stage: 'acme-widget-private', reason: 'acme-widget-private', fault: 'tool' }] }),
    // a fragment of the name inside an error name, and a list error
    mk('acme/acme-widget-mcp-b', 2, { result: { status: 'error', detail: 'no_tools', error_name: 'AcmeWidgetFault', list_error: 'widgetmcpBroke' } }),
    // a short name is not enough to redact a word like ValidationError
    mk('ab/va', 3, { result: { status: 'error', error_name: 'ValidationError' } }),
    // non-ASCII: the folded name Uni-tool is in UniTool
    mk('Ünï-owner/Ünï-tool', 4, { result: { status: 'error', error_name: 'UniTool' } }),
    // another item's name in this item's error
    mk('plain/other-xyzw', 5, { result: { status: 'error', error_name: 'ZetaQuuxCrash', language_hint: 'Zeta-Quux-Lang', list: { from: 'zeta-quux', fidelity: 'zeta-fid' } } }),
    mk('zeta/zeta-quux', 6, { result: { status: 'skipped', detail: 'no_tools' } }),
  ];
  const r = analyse(itemsFromEntries(entriesOf(probes)), { seed: new Map(), tierWeights });
  const sigs = Object.fromEntries(r.fingerprints.flatMap((f) => f.evidence.map((e) => [e.subject + '#' + e.run_id, f])));
  assert.match(sigs['acme/acme-widget-mcp#2001'].signature, /^class=<other>;/);
  assert.equal(sigs['acme/acme-widget-mcp#2001'].component, '<other>');
  assert.equal(sigs['acme/acme-widget-mcp#2001'].class, '<other>');
  assert.match(sigs['acme/acme-widget-mcp-b#2002'].signature, /error=<other>;list_error=<other>/);
  assert.match(sigs['ab/va#2003'].signature, /error=validationerror/);
  assert.match(sigs['Ünï-owner/Ünï-tool#2004'].signature, /error=<other>/);
  assert.match(sigs['plain/other-xyzw#2005'].signature, /error=<other>/);
  assert.match(sigs['plain/other-xyzw#2005'].idiom, /^<other>\/<other>\/<other>$/);
  const all = JSON.stringify(r.fingerprints.map((f) => ({ ...f, evidence: undefined, example: undefined }))).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  for (const bad of ['widget', 'acme', 'uni-tool', 'unitool', 'zeta', 'quux']) assert.ok(!all.includes(bad), `${bad} reached a fingerprint`);
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
    // an output file that is itself a link into the input, or a second name for a file in it, is refused and the target is untouched
    const target = join(input, 'accepted', 'att-a', '0', 'manifest.json');
    const keep = readFileSync(target);
    symlinkSync(target, join(out, 'sym.md'));
    assert.equal(await main(['--plain', input, '--out-md', join(out, 'sym.md'), '--out-json', join(out, 'c4.json'), '--seed', SEED_FILE], { write: () => {} }), 2);
    linkSync(target, join(out, 'hard.json'));
    assert.equal(await main(['--plain', input, '--out-md', join(out, 'c5.md'), '--out-json', join(out, 'hard.json'), '--seed', SEED_FILE], { write: () => {} }), 2);
    assert.deepEqual(readFileSync(target), keep);
    // a link to somewhere else is refused too (a link is how an output gets pointed at a file)
    writeFileSync(join(dir, 'elsewhere'), 'x');
    symlinkSync(join(dir, 'elsewhere'), join(out, 'else.md'));
    assert.equal(await main(['--plain', input, '--out-md', join(out, 'else.md'), '--out-json', join(out, 'c6.json'), '--seed', SEED_FILE], { write: () => {} }), 2);
    assert.equal(readFileSync(join(dir, 'elsewhere'), 'utf8'), 'x');
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

test('R-RET-20: the archive reads sealed files made before and after zstd, and an item that is in a full bundle and in its keep-forever file counts once', { skip: !haveAge && 'age is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-zstd-'));
  try {
    const key = spawnSync(KEYGEN, [], { encoding: 'utf8' });
    const identity = /AGE-SECRET-KEY-1[0-9A-Z]+/.exec(key.stdout + key.stderr)[0];
    const recipient = /(age1[0-9a-z]+)/.exec(key.stderr + key.stdout)[1];
    const seal = (name, tar) => {
      const d = join(dir, 'ingest', '2026-11-24', name.split('/')[0]);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, name.split('/')[1]), ageEncrypt({ plaintext: tar, recipients: [recipient], ageBin: AGE }));
    };
    const all = entriesOf().map((e) => ({ path: e.path, data: e.data }));
    const tar = writeTar(all);
    seal('ingest-1-1/ingest-x-0.tar.age', tar); // sealed before the upgrade: a plain tar
    seal('ingest-2-1/ingest-y-0.tar.age', packBundle(tar)); // the same bundle, zstd
    seal('ingest-keep-2-1/keep-y-0.tar.age', packBundle(tar)); // and its keep-forever file
    const { items, stats } = readArchive(dir, { identity });
    assert.equal(stats.sealed, 3);
    assert.equal(stats.failed, 0);
    assert.equal(items.length, fixture.items.length, 'each item once, not once per file');
    const only = mkdtempSync(join(tmpdir(), 'checkin-zstd-only-'));
    try {
      const d = join(only, 'ingest', '2026-11-24', 'ingest-keep-3-1');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'keep-z-0.tar.age'), ageEncrypt({ plaintext: packBundle(tar), recipients: [recipient], ageBin: AGE }));
      assert.equal(readArchive(only, { identity }).items.length, fixture.items.length, 'after the full bundle has expired, the keep-forever file alone is enough');
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failuresOf: a graded result with nothing missing has none; a result with no list and no skips has none', () => {
  const items = itemsFromEntries(entriesOf());
  const clean = items.find((i) => i.subject === 'acme/clean');
  assert.deepEqual(failuresOf(clean), []);
});

test('R-CHECKIN-10: every result in a bundle is read, not only the first one with a status', () => {
  const entries = entriesOf([fixture.items.find((i) => i.subject === 'acme/clean')]);
  const base = entries.find((e) => e.path.endsWith('results/scan-static.json'));
  // a second result (another lane's file) with a reader limit, sorted after the clean one
  const second = { status: 'graded', list: { from: 'source', fidelity: 'derived', language: 'go', unresolved_names: 3, unreadable: {} }, listing: { via: 'github' } };
  entries.push({ path: base.path.replace('scan-static.json', 'zz-extra.json'), data: Buffer.from(JSON.stringify(second)) });
  const r = analyse(itemsFromEntries(entries), { seed: new Map(), tierWeights });
  assert.deepEqual(r.fingerprints.map((f) => f.kind), ['reader_limit:unresolved_names']);
});

test('R-CHECKIN-11: a finished_at that does not parse sorts last, never NaN', () => {
  assert.deepEqual(['x', '2026-11-22T00:00:00Z', '2026-11-21T00:00:00Z'].sort(byTime), ['2026-11-21T00:00:00Z', '2026-11-22T00:00:00Z', 'x']);
  assert.equal(byTime('x', 'y'), 0);
  const items = fixture.items.filter((i) => i.subject === 'acme/py-two').map((i) => ({ ...i, at: 'not a time' }));
  const good = fixture.items.filter((i) => i.subject === 'globex/py-three');
  const r = run([...items, ...good]);
  const py = find(r, (x) => x.class === 'no_tools_found');
  assert.equal(py.first_seen, '2026-11-20T10:02:00Z');
  assert.equal(py.last_seen, 'not a time');
  for (const f of r.fingerprints) assert.ok(Number.isFinite(f.impact));
});

test('R-CHECKIN-12: the Markdown says how many evidence refs are left to the JSON, and shows all when asked', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...fixture.items[0], subject: `acme/many-${i}`, attempt: `att-m${i}`, index: 0, run_id: 3000 + i }));
  const r = run(many);
  assert.equal(r.fingerprints[0].evidence.length, 12);
  assert.match(renderMarkdown(r, { generatedAt: 'now' }), /Evidence \(12, first 10 here, 2 more in the JSON\)/);
  const all = renderMarkdown(r, { generatedAt: 'now', md_evidence: 12 });
  assert.doesNotMatch(all, /more in the JSON/);
  assert.equal([...all.matchAll(/run 30\d\d, attempt/g)].length, 12);
});

const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
/** Oracle facts for acme/py-two: a graded scan-static result, and a live-probe result an hour later that lists other tools. */
const oracleItems = (liveCount, { staticSha = null, liveSha = null } = {}) => [
  { subject: 'acme/py-two', lane: 'scan-static', at: '2026-11-19T10:00:00Z', attempt: 'att-o1', index: 0, run_id: 2001, tools: [{ name: 'mcp-check', version: '1.3.1' }], skips: [], server_json: 0,
    sha: staticSha, result: { status: 'graded', detail: null, catalog_hash: HA, tool_count: 3, list: { fidelity: 'exact', approximate: false, tools_left_out: 0, unresolved_names: 0, registration_not_seen: 0 } } },
  { subject: 'acme/py-two', lane: 'live-probe', at: '2026-11-19T11:00:00Z', attempt: 'att-o2', index: 0, run_id: 2002, tools: [{ name: 'mcp-check', version: '1.3.1' }], skips: [], server_json: 0, sha: liveSha,
    observations: [{ field: 'tool_count', value: liveCount }, { field: 'tool_list_sha256', value: HB }] },
];

test('R-ORD-05: a subject whose oracles disagree weighs 1.5 times in every fingerprint it is affected by, and the weight is the config value', () => {
  const base = run();
  const agree = run([...fixture.items, ...oracleItems(3)]);
  const dis = run([...fixture.items, ...oracleItems(5)]);
  assert.deepEqual(agree.summary.oracle_disagreements, { subjects: 0, by_kind: {} });
  assert.deepEqual(dis.summary.oracle_disagreements, { subjects: 1, by_kind: { tool_count: 1 } });
  const key = (r) => r.fingerprints.map((f) => [f.fingerprint, f.impact, f.weighted_subjects, f.oracle_subjects]);
  assert.deepEqual(key(agree).map((x) => x.slice(0, 3)), key(base).map((x) => x.slice(0, 3)), 'facts that agree change nothing');
  const touched = dis.fingerprints.filter((f) => f.oracle_subjects > 0);
  assert.equal(touched.length, 1, 'py-two is affected by exactly one fingerprint');
  const was = base.fingerprints.find((f) => f.fingerprint === touched[0].fingerprint);
  const info = loadSeed(SEED_FILE).get('acme/py-two');
  const w = subjectWeight(info, tierWeights, DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.oracle_multiplier, 1.5);
  assert.ok(w > 0);
  assert.ok(Math.abs((touched[0].weighted_subjects - was.weighted_subjects) - 0.5 * w) < 0.02, `${touched[0].weighted_subjects} - ${was.weighted_subjects} vs ${0.5 * w}`);
  // Every other fingerprint keeps its numbers.
  for (const f of dis.fingerprints.filter((x) => x !== touched[0])) assert.deepEqual([f.impact, f.weighted_subjects, f.oracle_subjects], [base.fingerprints.find((b) => b.fingerprint === f.fingerprint).impact, base.fingerprints.find((b) => b.fingerprint === f.fingerprint).weighted_subjects, 0]);
  // The multiplier is configurable, and 1 turns the weight off.
  const off = run([...fixture.items, ...oracleItems(5)], { oracle_multiplier: 1 });
  assert.deepEqual(key(off).map((x) => x.slice(0, 3)), key(base).map((x) => x.slice(0, 3)));
  assert.equal(subjectWeight({ tier: 'T2', stars: 0, oracle: true }, tierWeights, DEFAULT_CONFIG), 1.5 * subjectWeight({ tier: 'T2', stars: 0 }, tierWeights, DEFAULT_CONFIG));
  // The ranking order follows the weighted impact; the report says so.
  assert.match(renderMarkdown(dis, { generatedAt: 'now' }), /1 subjects have an open oracle disagreement \(tool_count: 1\); their fingerprints weigh x1\.5\./);
  assert.match(renderMarkdown(dis, { generatedAt: 'now' }), /also has an open oracle disagreement/);
});

test('R-ORD-04: the check-in makes no fingerprint out of a disagreement, and a subject-side skip stays out', () => {
  const dis = run([...fixture.items, ...oracleItems(5)]);
  const base = run();
  assert.equal(dis.fingerprints.length, base.fingerprints.length, 'a disagreement is not a failure fingerprint of its own');
  // A subject with a disagreement and no failure at all appears in no fingerprint.
  const only = analyse(itemsFromEntries(entriesOf(oracleItems(5))), { seed: loadSeed(SEED_FILE), tierWeights });
  assert.deepEqual(only.fingerprints, []);
  assert.equal(only.summary.oracle_disagreements.subjects, 1);
  // A subject-fault skip (the repository is gone) is still not counted, disagreement or not.
  const gone = oracleItems(5).concat([{ subject: 'acme/py-two', lane: 'scan-static', at: '2026-11-23T10:00:00Z', attempt: 'att-o3', index: 0, run_id: 2003, tools: [], server_json: 0,
    skips: [{ stage: 'static', reason: 'repo_not_visible', fault: 'subject', evidence: 'results/scan-static.json', retryable: false }] }]);
  assert.deepEqual(analyse(itemsFromEntries(entriesOf(gone)), { seed: loadSeed(SEED_FILE), tierWeights }).fingerprints, []);
});

test('R-ORD-12: the check-in compares the lanes only on one subject version', () => {
  const same = run([...fixture.items, ...oracleItems(5, { staticSha: 'a'.repeat(40), liveSha: 'a'.repeat(40) })]);
  const moved = run([...fixture.items, ...oracleItems(5, { staticSha: 'a'.repeat(40), liveSha: 'b'.repeat(40) })]);
  assert.equal(same.summary.oracle_disagreements.subjects, 1);
  assert.equal(moved.summary.oracle_disagreements.subjects, 0, 'a new release seen by live-probe against the reader\'s old result is no disagreement');
});

test('R-ORD-16: the check-in compares unversioned lanes only when observed within the window: an old scan against a fresh live list is no disagreement', () => {
  assert.equal(run([...fixture.items, ...oracleItems(5)]).summary.oracle_disagreements.subjects, 1, 'an hour apart is compared');
  const far = oracleItems(5);
  far[1] = { ...far[1], at: '2026-11-22T10:00:00Z' };
  assert.equal(run([...fixture.items, ...far]).summary.oracle_disagreements.subjects, 0, 'three days apart, no version: not compared');
  const pinned = oracleItems(5, { staticSha: 'a'.repeat(40), liveSha: 'a'.repeat(40) });
  pinned[1] = { ...pinned[1], at: '2026-11-22T10:00:00Z' };
  assert.equal(run([...fixture.items, ...pinned]).summary.oracle_disagreements.subjects, 1, 'a pinned version is compared however far apart');
});


test('R-CHECKIN-13: the archive keeps one sealed file per item; the items of every file are read, not only those of the first file', { skip: !haveAge && 'age is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-perfile-'));
  try {
    const key = spawnSync(KEYGEN, [], { encoding: 'utf8' });
    const identity = /AGE-SECRET-KEY-1[0-9A-Z]+/.exec(key.stdout + key.stderr)[0];
    const recipient = /(age1[0-9a-z]+)/.exec(key.stderr + key.stdout)[1];
    const all = entriesOf().map((e) => ({ path: e.path, data: e.data }));
    // Split into one sealed file per item, as the pump writes them (ingest-<attempt>-<index>.tar.age).
    const byItem = new Map();
    for (const e of all) {
      const m = /^accepted\/([^/]+)\/(\d+)\//.exec(e.path);
      const k = `${m[1]}-${m[2]}`;
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k).push(e);
    }
    assert.ok(byItem.size >= 2, 'the fixture has several items');
    const d = join(dir, 'ingest', '2026-11-27', 'ingest-9-1');
    mkdirSync(d, { recursive: true });
    for (const [k, entries] of byItem) writeFileSync(join(d, `ingest-${k}.tar.age`), ageEncrypt({ plaintext: packBundle(writeTar(entries)), recipients: [recipient], ageBin: AGE }));
    const { items, stats } = readArchive(dir, { identity });
    assert.equal(stats.sealed, byItem.size);
    assert.equal(stats.failed, 0);
    assert.equal(items.length, fixture.items.length, 'one item per sealed file, all of them read');
    assert.equal(new Set(items.map((x) => x.key)).size, items.length, 'every item carries its own dedupe key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-CHECKIN-14: the lane is our own workflow name and is shown even when a subject name shares a word with it', () => {
  const item = itemsFromEntries(entriesOf()).find((it) => failuresOf(it).length > 0);
  assert.ok(item, 'the fixture has an item with a tool-side failure');
  const names = nameTokens(['acme/live-tools', 'x/probe-mcp', 'y/static-scan']);
  for (const lane of ['live-probe', 'scan-static']) {
    const fl = failuresOf({ ...item, lane }, DEFAULT_CONFIG, { names });
    assert.ok(fl.length > 0);
    assert.ok(fl.every((f) => f.lane === lane), `${lane} is not redacted`);
  }
  assert.ok(failuresOf({ ...item, lane: 'bad lane;' }, DEFAULT_CONFIG, { names }).every((f) => f.lane === '<other>'), 'a malformed lane is still refused');
});
