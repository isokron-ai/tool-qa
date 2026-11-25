import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseRegistry } from '../../ingest/registry.mjs';
import { buildRecord } from '../record.mjs';
import { checkItem, itemsFromEntries } from '../read.mjs';
import { auditStore, filesToWrite, loadStore, merge, writeFiles } from '../store.mjs';
import { canonical, contentDigest } from '../canonical.mjs';
import { main as runMain, publishEntries } from '../run.mjs';
import { REGISTRY_TEXT, flat, item, registry, sha } from './fixtures.mjs';

// Fake credentials, assembled at run time so this file holds no token-shaped string.
const j = (...p) => p.join('');
const FAKE_TOKEN = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const FAKE_EMAIL = j('maintainer', '@', 'some-company.io');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-test-'));
  const results = join(dir, 'results');
  mkdirSync(join(results, 'fields'), { recursive: true });
  writeFileSync(join(results, 'fields/registry.yaml'), REGISTRY_TEXT);
  return { dir, results, out: join(dir, 'out'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Build records from entries against an empty store. */
function build(entries, reg = registry()) {
  const store = loadStore(join(tmpdir(), 'no-such-data-dir'));
  const { stats, merged } = publishEntries([entries], { registry: reg, store });
  return { stats, merged, store, records: merged.added };
}

const allBytes = (store) => [...store.files.values()].flat().map((r) => canonical(r)).join('\n');

test('R-PUB-01: a result that carries a security-class field is held whole; nothing says it existed', () => {
  const entries = flat(
    item({ attempt: 'att-1', n: 1, subject: 'demo' }),
    // planned S field and an active M field: both are security-class, whatever their status
    item({ attempt: 'att-2', n: 2, subject: 'other', observations: [{ field: 'tool_count', value: 5 }, { field: 'ci_exploitable_trigger', value: { file: 'SECRET-FINDING-DETAIL' } }] }),
    item({ attempt: 'att-3', n: 3, subject: 'third', observations: [{ field: 'tool_count', value: 6 }, { field: 'injection_like_text_confirmed', value: { x: 1 } }] }),
  );
  const { stats, records, store } = build(entries);
  assert.deepEqual(records.map((r) => r.subject.id), ['io.example/demo'], 'only the result with no security-class field is published');
  const text = JSON.stringify({ stats, bytes: allBytes(store) });
  assert.ok(!text.includes('SECRET-FINDING-DETAIL') && !text.includes('io.example/other') && !text.includes('io.example/third'), 'the held subjects are not named anywhere');
  assert.ok(!/security/i.test(JSON.stringify(stats)), 'the stats say nothing about a security hold');
  assert.deepEqual(stats.held_other, {}, 'and do not count it under another reason');
  // buildRecord itself
  const h = checkItem(itemsFromEntries(entries.filter((e) => e.path.includes('/att-2/')))[0]);
  assert.deepEqual(buildRecord(h.item, registry()), { held: true, reason: 'security_class' });
});

test('R-PUB-01: every S and M field of the pinned field registry holds a result, planned or not', () => {
  const pinned = parseRegistry(readFileSync(new URL('../../meta/test/fixtures/registry-pinned.yaml', import.meta.url), 'utf8'));
  const sensitive = [...pinned.fields.values()].filter((f) => f.class === 'S' || f.class === 'M');
  assert.ok(sensitive.length >= 8, 'the pinned registry has security-class fields');
  for (const f of sensitive) {
    const entries = item({ observations: [{ field: f.id, value: f.type === 'string' ? 'x' : f.type === 'integer' ? 1 : f.type === 'array' ? [] : {} }] });
    const checked = checkItem(itemsFromEntries(entries)[0]);
    assert.deepEqual(buildRecord(checked.item, pinned), { held: true, reason: 'security_class' }, f.id);
  }
});

test('R-PUB-02: fields that are not public are left out, and only observations are read from a result', () => {
  const entries = item({ observations: [
    { field: 'tool_count', value: 3 },
    { field: 'injection_like_text_patterns', value: ['a'] }, // P-h
    { field: 'tool_descriptions_text', value: ['AUTHOR-TEXT-LEFT-OUT'] }, // P-t
    { field: 'write_tool_confirmed', value: true }, // B
    { field: 'static_vs_live_agreement', value: { n: 1 } }, // PA
    { field: 'raw_transcript', value: 'PRIVATE-TRANSCRIPT' }, // X
    { field: 'not_yet_collected', value: 1 }, // planned
    { field: 'never_declared', value: 1 },
  ] });
  const { records, stats, store } = build(entries);
  assert.deepEqual(records[0].observations.map((o) => o.field), ['tool_count']);
  const text = allBytes(store);
  for (const marker of ['AUTHOR-TEXT-LEFT-OUT', 'PRIVATE-TRANSCRIPT', 'TEST-ONLY-FINDING-TEXT', 'TEST-ONLY-RAW-TEXT']) assert.ok(!text.includes(marker), marker);
  assert.deepEqual(stats.withheld_fields, { 'class_P-h': 1, 'class_P-t': 1, class_B: 1, class_PA: 1, class_X: 1, status_planned: 1, undeclared: 1 });
});

test('R-PUB-02: in text the server author wrote (R1) only the secret span is masked; anywhere else a secret holds the result', () => {
  const masked = build(item({ observations: [{ field: 'registry_name', value: `demo ${FAKE_TOKEN} server` }, { field: 'tool_count', value: 1 }] }));
  const rec = masked.records[0];
  assert.equal(rec.observations.find((o) => o.field === 'registry_name').value, 'demo [REDACTED:github-token] server');
  assert.equal(rec.observations.find((o) => o.field === 'registry_name').masked, true);
  assert.ok(!allBytes(masked.store).includes(FAKE_TOKEN));

  for (const [field, value] of [['stderr_counts', { sample: FAKE_TOKEN }], ['startup_ms', 5], ['tool_count', 2]]) {
    const obs = field === 'startup_ms' ? [{ field, value }, { field: 'stderr_counts', value: { note: `mail ${FAKE_EMAIL}` } }] : [{ field, value }];
    const held = build(item({ observations: obs }));
    if (field === 'stderr_counts' || field === 'startup_ms') {
      assert.equal(held.records.length, 0, `${field}: a secret or an email holds the result`);
      assert.deepEqual(held.stats.held_other, { redaction_hit: 1 });
    }
  }
  // a secret in `why` is caught too
  const why = build(item({ observations: [{ field: 'tool_count', value: null, why: `not read: ${FAKE_TOKEN}` }] }));
  assert.equal(why.records.length, 0);
});

test('R-PUB-02: a canary-looking value, an oversize value and a value nested too deep hold the result, they are not cut or passed', () => {
  assert.equal(build(item({ observations: [{ field: 'server_info', value: { name: 'ISOKRON_CANARY_a1b2c3d4e5' } }] })).records.length, 0);
  assert.deepEqual(build(item({ observations: [{ field: 'stderr_counts', value: { s: 'x'.repeat(5000) } }] })).stats.held_other, { oversize: 1 });
  let deep = 1;
  for (let i = 0; i < 80; i++) deep = { a: deep };
  assert.deepEqual(build(item({ observations: [{ field: 'stderr_counts', value: deep }] })).stats.held_other, { too_deep: 1 });
});

test('R-PUB-03: a skip that is our limit is published as our limit, never as a failed server; a skipped server is not a failed one', () => {
  const entries = flat(
    item({ attempt: 'a-tool', n: 1, subject: 'demo', lane: 'scan-static', observations: [], extraFiles: { 'logs/read.log': 'x' }, skips: [{ stage: 'read', reason: 'unsupported_language', fault: 'tool', evidence: 'logs/read.log' }] }),
    item({ attempt: 'a-subject', n: 2, subject: 'other', lane: 'live-probe', observations: [], skips: [{ stage: 'start', reason: 'start_requires_credentials', fault: 'subject' }] }),
    item({ attempt: 'a-mixed', n: 3, subject: 'third', lane: 'live-probe', observations: [], skips: [{ stage: 'start', reason: 'start_requires_credentials', fault: 'subject' }, { stage: 'trace', reason: 'trace_unavailable', fault: 'tool' }] }),
    item({ attempt: 'a-infra', n: 4, subject: 'demo', lane: 'meta-github', observations: [], skips: [{ stage: 'api', reason: 'rate_limited', fault: 'infra', retryable: true }] }),
    item({ attempt: 'a-ok', n: 5, subject: 'demo', lane: 'live-probe' }),
  );
  const { records, store } = build(entries);
  const by = Object.fromEntries(records.map((r) => [r.provenance.attempt_id, r]));
  assert.deepEqual(by['a-tool'].coverage, { state: 'unassessed_tool', fault_side: 'tool', attribution: 'our_limit', skips: [{ stage: 'read', reason: 'unsupported_language', fault: 'tool' }] });
  assert.equal(by['a-subject'].coverage.state, 'subject');
  assert.equal(by['a-subject'].coverage.attribution, 'server_condition');
  assert.equal(by['a-mixed'].coverage.state, 'unassessed_tool', 'our limit is never hidden behind a server-side skip');
  assert.equal(by['a-infra'].coverage.attribution, 'infrastructure');
  assert.equal(by['a-ok'].coverage.state, 'assessed');
  assert.equal(by['a-ok'].coverage.fault_side, null);
  // no verdict, no score, no evidence path anywhere
  const text = allBytes(store);
  assert.ok(!/"(pass|passed|fail|failed|score|grade|rating|rank|overall|verdict)"/i.test(text));
  assert.ok(!text.includes('logs/read.log'), 'evidence paths are not published');
});

test('R-PUB-04: running again on the same input adds nothing and changes no file', () => {
  const t = scratch();
  try {
    const entries = flat(item({ attempt: 'att-1', n: 1 }), item({ attempt: 'att-2', n: 2, subject: 'other', finishedAt: '2026-11-25T01:00:00Z' }));
    const args = ['--results', t.results, '--out', t.out, '--plain-dir', join(t.dir, 'plain')];
    for (const e of entries) { mkdirSync(join(t.dir, 'plain', e.path, '..'), { recursive: true }); writeFileSync(join(t.dir, 'plain', e.path), e.data); }
    return (async () => {
      assert.equal(await runMain(args, {}), 0);
      const first = JSON.parse(readFileSync(join(t.out, 'report.json'), 'utf8'));
      assert.equal(first.records_added, 2);
      assert.deepEqual(first.files_changed.sort(), ['manifest.json', 'results/live-probe/2026-11-24.jsonl', 'results/live-probe/2026-11-25.jsonl']);
      // "publish": copy the output into the results checkout, then run again
      writeFiles(join(t.results, 'data'), new Map(first.files_changed.map((p) => [p, readFileSync(join(t.out, 'data', p))])));
      assert.equal(await runMain(args, {}), 0);
      const second = JSON.parse(readFileSync(join(t.out, 'report.json'), 'utf8'));
      assert.equal(second.records_added, 0);
      assert.equal(second.records_unchanged, 2);
      assert.deepEqual(second.files_changed, []);
      assert.ok(!existsSync(join(t.out, 'data')), 'no file would be written');
    })().finally(t.done);
  } catch (e) { t.done(); throw e; }
});

test('R-PUB-04: the order of the inputs, and the same result sealed twice, change nothing', () => {
  const a = item({ attempt: 'att-1', n: 1 });
  const b = item({ attempt: 'att-2', n: 2, subject: 'other' });
  const one = build([...a, ...b]);
  const two = build([...b, ...a, ...a]);
  assert.equal(allBytes(one.store), allBytes(two.store));
  assert.equal(one.records.length, 2);
  const s1 = new Map(one.store.files);
  const m1 = filesToWrite(one.store, one.merged, { registry: registry(), dataDir: '/nonexistent' });
  const m2 = filesToWrite(two.store, two.merged, { registry: registry(), dataDir: '/nonexistent' });
  assert.deepEqual([...m1].map(([p, b]) => [p, sha(b)]), [...m2].map(([p, b]) => [p, sha(b)]));
  assert.ok(s1.size > 0);
});

test('R-PUB-05: only results ingest accepted are read, and every one must agree with ingest and with its own manifest', () => {
  const good = item({ attempt: 'att-1', n: 1 });
  const entries = flat(
    good,
    item({ attempt: 'att-r', n: 2, subject: 'other', dir: 'rejected' }),
    item({ attempt: 'att-q', n: 3, subject: 'third', dir: 'quarantine' }),
    item({ attempt: 'att-x', n: 4, mutateIngest: (i) => { i.outcome = 'rejected'; } }),
    item({ attempt: 'att-y', n: 5, mutateIngest: (i) => { i.ledger.run_key = 'f'.repeat(64); } }),
    item({ attempt: 'att-z', n: 6, mutateIngest: (i) => { i.item_index = 9; } }),
    item({ attempt: 'att-f', n: 7, mutateIngest: (i) => { i.ledger.fence = 99; } }),
    item({ attempt: 'att-m', n: 8, mutateManifest: (m) => { m.attempt_id = 'someone-else'; } }),
    item({ attempt: 'att-d', n: 9, mutateManifest: (m) => { m.files.find((f) => f.path === 'observations/main.ndjson').sha256 = '0'.repeat(64); } }),
  );
  const { records, stats } = build(entries);
  assert.deepEqual(records.map((r) => r.provenance.attempt_id), ['att-1']);
  assert.equal(stats.items_not_accepted, 6);
});

test('R-PUB-05: every record carries what traces it to a run key and an attempt, and its own digests recompute', () => {
  const { records } = build(item({ attempt: 'att-1', n: 1 }));
  const r = records[0];
  assert.match(r.provenance.run_key, /^[0-9a-f]{64}$/);
  assert.equal(r.provenance.attempt_id, 'att-1');
  assert.ok(!('item_index' in r.provenance), 'the position in the attempt is not published');
  assert.equal(r.provenance.workflow.repo, 'isokron-ai/mcp-check');
  assert.equal(r.content_sha256, contentDigest(r));
  assert.deepEqual(auditStore(loadStore('/nonexistent'), registry()), []);
});

test('R-PUB-06: a published record is never changed; a changed one stops the run, a retracted one is not brought back', () => {
  const { store, records } = build(item({ attempt: 'att-1', n: 1 }));
  const changed = structuredClone(records[0]);
  changed.observations[0].value = 99;
  changed.content_sha256 = contentDigest(changed);
  const m = merge(store, [changed]);
  assert.equal(m.added.length, 0);
  assert.equal(m.conflicts.length, 1);
  assert.equal(store.records.get(records[0].record_id).record.observations[0].value, records[0].observations[0].value);
  // retracted: not published again from an older sealed file
  const fresh = loadStore('/nonexistent');
  fresh.corrections = [{ kind: 'retract', target: records[0].record_id }];
  const again = merge(fresh, [records[0]]);
  assert.equal(again.added.length, 0);
  assert.equal(again.removed, 1);
});

test('R-PUB-06: what is already published must still be publishable under the registry as it is now', () => {
  const { store } = build(item({ attempt: 'att-1', n: 1 }));
  assert.deepEqual(auditStore(store, registry()), []);
  const tightened = parseRegistry(REGISTRY_TEXT.replace('{id: tool_count, layer: protocol, type: integer, unit: count, source: scan-live, class: P,', '{id: tool_count, layer: protocol, type: integer, unit: count, source: scan-live, class: S,'));
  const problems = auditStore(store, tightened);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /field tool_count is not publishable now/);
  assert.ok(!problems[0].includes('"value"'), 'a problem names the field, never a value');
  // and a record that was altered after publishing is caught
  const rec = [...store.records.values()][0].record;
  rec.coverage.state = 'assessed-ish';
  assert.match(auditStore(store, registry()).join('\n'), /content_sha256 does not match/);
});

test('R-PUB-07: end to end with real age: sealed results are read with the key, the output is plain, and nothing decrypted is left behind', { skip: spawnSync('age', ['--version']).status !== 0 }, async () => {
  const t = scratch();
  try {
    const kg = spawnSync('age-keygen', [], { encoding: 'utf8' });
    const identity = /AGE-SECRET-KEY-1[A-Z0-9]+/.exec(kg.stdout)[0];
    const pub = /age1[a-z0-9]+/.exec(kg.stdout)[0];
    const { writeTar } = await import('../../worker-kit/tar.mjs');
    const { packBundle } = await import('../../worker-kit/bundle.mjs');
    const sealedDir = join(t.dir, 'sealed/2026-11-24/ingest-keep-1-1');
    mkdirSync(sealedDir, { recursive: true });
    const tar = writeTar(flat(item({ attempt: 'att-1', n: 1 }), item({ attempt: 'att-2', n: 2, subject: 'other', observations: [{ field: 'ci_exploitable_trigger', value: {} }] })).map((e) => ({ path: e.path, data: e.data })));
    const enc = spawnSync('age', ['-r', pub], { input: packBundle(tar) });
    writeFileSync(join(sealedDir, 'keep-att-1.tar.age'), enc.stdout);
    writeFileSync(join(sealedDir, 'keep-broken.tar.age'), Buffer.from('not age'));
    const priv = join(t.dir, 'private');
    const seal = join(t.dir, 'recipients.pub');
    writeFileSync(seal, `${pub}\n`);
    const code = await runMain(['--results', t.results, '--out', t.out, '--private-out', priv, '--seal-to', seal, '--source-dir', join(t.dir, 'sealed')], { AGE_IDENTITY: identity });
    assert.equal(code, 4, 'an unreadable sealed file is not clean');
    const report = JSON.parse(readFileSync(join(t.out, 'report.json'), 'utf8'));
    assert.equal(report.records_added, 1, 'the output is still written');
    assert.ok(!('unreadable_sealed_files' in report), 'and the public report does not carry the count');
    assert.deepEqual(readdirSync(priv), ['report.json.age'], 'the private report is sealed, never plain');
    const dec = spawnSync('age', ['-d', '-i', '-'], { input: Buffer.concat([Buffer.from(`${identity}\n`)]) });
    assert.ok(dec.status !== 0);
    const idf = join(t.dir, 'id.txt');
    writeFileSync(idf, `${identity}\n`);
    const priv2 = JSON.parse(spawnSync('age', ['-d', '-i', idf, join(priv, 'report.json.age')], { encoding: 'utf8' }).stdout);
    assert.equal(priv2.unreadable_sealed_files, 1);
    assert.equal(priv2.clean, false);
    const written = readdirSync(t.out, { recursive: true });
    assert.ok(written.every((p) => !/\.age$/.test(p)));
    assert.ok(!JSON.stringify(report).includes(identity));
    // without the identity nothing is read
    assert.equal(await runMain(['--results', t.results, '--out', t.out, '--source-dir', join(t.dir, 'sealed')], {}), 1);
  } finally { t.done(); }
});

test('R-PUB-08: nothing in the publisher, its documents or its output names an AI model or vendor', () => {
  const words = [['cl', 'aude'], ['anthr', 'opic'], ['open', 'ai'], ['gp', 't-'], ['gem', 'ini'], ['op', 'us '], ['son', 'net'], ['ha', 'iku'], ['chat', 'gpt'], ['gr', 'ok']].map((p) => p.join(''));
  const re = new RegExp(words.join('|'), 'i');
  const root = new URL('../../', import.meta.url).pathname;
  const files = [...readdirSync(join(root, 'publish')).filter((f) => f.endsWith('.mjs')).map((f) => `publish/${f}`), '.github/workflows/publish-results.yml', 'docs/PUBLISHING.md'];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.ok(!re.test(text), `${f} names a model or vendor`);
  }
  const { store } = build(flat(item({ n: 1 })));
  assert.ok(!re.test(allBytes(store)));
});

test('R-PUB-11: no position in the attempt is published, so a held result leaves no gap; the id does not depend on it', () => {
  const entries = flat(
    item({ attempt: 'shard-1', index: 0, n: 1, subject: 'demo' }),
    item({ attempt: 'shard-1', index: 1, n: 2, subject: 'other', observations: [{ field: 'tool_count', value: 5 }, { field: 'ci_exploitable_trigger', value: {} }] }),
    item({ attempt: 'shard-1', index: 2, n: 3, subject: 'third' }),
  );
  const { records, store } = build(entries);
  assert.equal(records.length, 2);
  const text = allBytes(store);
  assert.ok(!/item_index/.test(text));
  assert.ok(records.every((r) => !('item_index' in r.provenance)));
  const again = build(item({ attempt: 'shard-1', index: 7, n: 1, subject: 'demo' }));
  assert.equal(again.records[0].record_id, records.find((r) => r.subject.id === 'io.example/demo').record_id, 'the same result is the same record wherever it sat in its shard');
});

test('R-PUB-12: nothing about what was held or left out is public: not in the report, the log, the step summary; the private report is sealed', async () => {
  const t = scratch();
  try {
    const entries = flat(
      item({ attempt: 'a-1', n: 1 }),
      item({ attempt: 'a-2', n: 2, subject: 'other', observations: [{ field: 'tool_count', value: 5 }, { field: 'ci_exploitable_trigger', value: {} }] }),
      item({ attempt: 'a-3', n: 3, subject: 'third', observations: [{ field: 'stderr_counts', value: { s: FAKE_TOKEN } }] }),
      item({ attempt: 'a-4', n: 4, subject: 'other', observations: [{ field: 'write_tool_confirmed', value: true }] }),
      item({ attempt: 'a-5', n: 5, dir: 'rejected' }),
    );
    const plain = join(t.dir, 'plain');
    for (const e of entries) { mkdirSync(join(plain, e.path, '..'), { recursive: true }); writeFileSync(join(plain, e.path), e.data); }
    const summary = join(t.dir, 'summary.md');
    writeFileSync(summary, '');
    const logs = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { logs.push(String(c)); return true; };
    let code;
    try { code = await runMain(['--results', t.results, '--out', t.out, '--private-out', join(t.dir, 'priv'), '--plain-dir', plain], { GITHUB_STEP_SUMMARY: summary }); } finally { process.stderr.write = orig; }
    assert.equal(code, 0);
    const pub = JSON.parse(readFileSync(join(t.out, 'report.json'), 'utf8'));
    assert.deepEqual(Object.keys(pub).sort(), ['files_changed', 'records_added', 'records_unchanged', 'registry', 'version']);
    const everything = [JSON.stringify(pub), logs.join(''), readFileSync(summary, 'utf8')].join('\n');
    for (const word of ['held', 'withheld', 'redaction', 'security', 'items_not_accepted', 'records_built', 'unreadable', 'oversize']) assert.ok(!everything.includes(word), word);
    // the private report has them, and only where asked for
    const priv = JSON.parse(readFileSync(join(t.dir, 'priv/report.json'), 'utf8'));
    assert.deepEqual(priv.held_other, { redaction_hit: 1, empty_assessed: 1 });
    assert.equal(priv.records_built, 1);
    assert.ok(!existsSync(join(t.out, 'private')) && !readdirSync(t.out, { recursive: true }).some((p) => /priv/.test(p)));
  } finally { t.done(); }
});

test('R-PUB-13: one bad item is held, it does not stop the run: the whole record is scanned, not only the observations', () => {
  const entries = flat(
    item({ attempt: 'a-1', n: 1 }),
    item({ attempt: 'a-2', n: 2, subject: 'other', mutateManifest: (m) => { m.subject.id = `io.example/${FAKE_TOKEN}`; } }),
    item({ attempt: 'a-3', n: 3, subject: 'third', mutateManifest: (m) => { m.tools[0].name = 'mcp-check'; m.workflow.file = '.github/workflows/live-probe.yml'; } }),
  );
  const { records, stats } = build(entries);
  assert.deepEqual(records.map((r) => r.provenance.attempt_id).sort(), ['a-1', 'a-3']);
  assert.deepEqual(stats.held_other, { redaction_hit: 1 });
});

test('R-PUB-14: a result whose every field was left out is not published as a clean assessment; one with a skip of ours still is', () => {
  const { records, stats } = build(flat(
    item({ attempt: 'a-1', n: 1, observations: [{ field: 'write_tool_confirmed', value: true }] }),
    item({ attempt: 'a-2', n: 2, subject: 'other', observations: [], extraFiles: { 'logs/x.log': 'x' }, skips: [{ stage: 'read', reason: 'too_large', fault: 'tool', evidence: 'logs/x.log' }] }),
  ));
  assert.deepEqual(records.map((r) => r.provenance.attempt_id), ['a-2']);
  assert.deepEqual(stats.held_other, { empty_assessed: 1 });
});

test('R-PUB-15: a re-read record that differs from its published one is skipped inside the re-read window and stops the run outside it', () => {
  const published = build(item({ attempt: 'a-1', n: 1, finishedAt: '2026-11-24T10:05:00Z' }));
  const store = published.store;
  const stricter = parseRegistry(REGISTRY_TEXT.replace('{id: tool_count, layer: protocol, type: integer, unit: count, source: scan-live, class: P,', '{id: tool_count, layer: protocol, type: integer, unit: count, source: scan-live, class: PA,'));
  const again = (windowStartMs) => publishEntries([item({ attempt: 'a-1', n: 1, finishedAt: '2026-11-24T10:05:00Z' })], { registry: stricter, store, windowStartMs });
  const inside = again(Date.parse('2026-11-20T00:00:00Z'));
  assert.equal(inside.merged.skipped_conflicts, 1);
  assert.equal(inside.merged.conflicts.length, 0);
  const outside = again(Date.parse('2026-11-26T00:00:00Z'));
  assert.equal(outside.merged.conflicts.length, 1);
  assert.equal(again(null).merged.conflicts.length, 1, 'with no window (a backfill) it is always a stop');
});

test('R-PUB-16: our own failures end the run not clean (exit 4) after the output is written: an unreadable sealed file, a coverage mismatch, a skipped conflict', async () => {
  const t = scratch();
  try {
    const plain = join(t.dir, 'plain');
    const entries = flat(item({ attempt: 'a-1', n: 1 }), item({ attempt: 'a-2', n: 2, subject: 'other', mutateIngest: (i) => { i.bundle = { coverage: 'unassessed_tool' }; } }));
    for (const e of entries) { mkdirSync(join(plain, e.path, '..'), { recursive: true }); writeFileSync(join(plain, e.path), e.data); }
    const priv = join(t.dir, 'priv');
    const code = await runMain(['--results', t.results, '--out', t.out, '--private-out', priv, '--plain-dir', plain], {});
    assert.equal(code, 4);
    assert.equal(JSON.parse(readFileSync(join(t.out, 'report.json'), 'utf8')).records_added, 1, 'the good result is still delivered');
    const p = JSON.parse(readFileSync(join(priv, 'report.json'), 'utf8'));
    assert.deepEqual(p.held_other, { coverage_mismatch: 1 });
    assert.equal(p.clean, false);
  } finally { t.done(); }
});

test('R-PUB-19: the output leaves the build job sealed, and opens only with the reviewed digest, the loop key and untampered files', { skip: spawnSync('age', ['--version']).status !== 0 }, async () => {
  const { seal, open } = await import('../seal.mjs');
  const kg = spawnSync('age-keygen', [], { encoding: 'utf8' });
  const identity = /AGE-SECRET-KEY-1[A-Z0-9]+/.exec(kg.stdout)[0];
  const pub = /age1[a-z0-9]+/.exec(kg.stdout)[0];
  const other = /AGE-SECRET-KEY-1[A-Z0-9]+/.exec(spawnSync('age-keygen', [], { encoding: 'utf8' }).stdout)[0];
  const dir = mkdtempSync(join(tmpdir(), 'seal-'));
  try {
    mkdirSync(join(dir, 'in/data/results/live-probe'), { recursive: true });
    writeFileSync(join(dir, 'in/data/results/live-probe/2026-11-24.jsonl'), '{"x":"READABLE-MARKER"}\n');
    writeFileSync(join(dir, 'in/report.json'), '{}');
    const base = 'a'.repeat(40);
    const { sealed, sums } = seal({ dir: join(dir, 'in'), base, recipients: [pub], ageBin: 'age' });
    assert.ok(!sealed.includes('READABLE-MARKER'), 'ciphertext holds nothing readable');
    const outA = join(dir, 'out-a');
    const r = open({ sealed, identity, expect: sums, dir: outA, ageBin: 'age' });
    assert.deepEqual(r, { sums, base });
    assert.equal(readFileSync(join(outA, 'data/results/live-probe/2026-11-24.jsonl'), 'utf8'), '{"x":"READABLE-MARKER"}\n');
    // not the reviewed digest: nothing is written
    const outB = join(dir, 'out-b');
    assert.throws(() => open({ sealed, identity, expect: 'b'.repeat(64), dir: outB, ageBin: 'age' }), /not the reviewed/);
    assert.ok(!existsSync(outB));
    // not the loop's key
    assert.throws(() => open({ sealed, identity: other, expect: sums, dir: join(dir, 'out-c'), ageBin: 'age' }));
    // a different sealed output has a different digest, so an approval does not carry over
    writeFileSync(join(dir, 'in/report.json'), '{"records_added":1}');
    assert.notEqual(seal({ dir: join(dir, 'in'), base, recipients: [pub], ageBin: 'age' }).sums, sums);
    assert.throws(() => seal({ dir: join(dir, 'in'), base: 'short', recipients: [pub], ageBin: 'age' }), /full commit id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-PUB-20: the private report is padded to a fixed size, so its length shows nothing about its keys', async () => {
  const { pad } = await import('../seal.mjs');
  const small = pad(JSON.stringify({ a: 1 }));
  const big = pad(JSON.stringify({ a: 1, held_other: { redaction_hit: 4, oversize: 2, empty_assessed: 9 }, conflicts_skipped: 3, files_changed: Array.from({ length: 20 }, (_, i) => `f${i}`) }, null, 2));
  assert.equal(Buffer.byteLength(small), 16384);
  assert.equal(Buffer.byteLength(big), 16384);
  assert.deepEqual(JSON.parse(small), { a: 1 }, 'it is still JSON');
  assert.equal(Buffer.byteLength(pad('x'.repeat(20000))) % 16384, 0, 'a larger report is padded to a whole block');
});

test('R-PUB-21: the fence is not published: a global counter whose gaps could show where a result was held', () => {
  const { records, store } = build(item({ attempt: 'att-1', n: 1 }));
  assert.ok(!('fence' in records[0].provenance));
  assert.ok(!/"fence"/.test(allBytes(store)));
});
