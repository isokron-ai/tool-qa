import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { derive, itemsFromEntries, main, outInside, outUnsafe, readArchive, readPlain } from '../derive.mjs';
import { ageEncrypt } from '../../ingest/age.mjs';
import { writeTar } from '../../worker-kit/tar.mjs';
import { parseRegistry } from '../../ingest/registry.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const REGISTRY = parseRegistry(readFileSync(new URL('../../meta/test/fixtures/registry-pinned.yaml', import.meta.url), 'utf8'));

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;

/** Tar entries for a fixture: accepted/<attempt>/<index>/{manifest.json, observations/<lane>.ndjson, results/<lane>.json}. */
function entriesOf(fx, attempt = 'att-fixture') {
  const entries = [];
  fx.items.forEach((it, i) => {
    const base = `accepted/${attempt}-${i}/0/`;
    const manifest = {
      schema_version: 1, attempt_id: `${attempt}-${i}`, fence: i + 1, run_key: it.run_key,
      subject: { id: fx.subject, repo: fx.subject, sha: it.subject_sha },
      workflow: { repo: 'isokron-ai/x', file: `.github/workflows/${it.lane}.yml`, sha: '1'.repeat(40), run_id: 1, run_attempt: 1 },
      tools: it.tools, oracles: [], settings_manifest_digest: '0'.repeat(64), started_at: it.observed_at, finished_at: it.observed_at,
      files: [], skips: [], controls: [],
    };
    entries.push({ path: `${base}manifest.json`, data: Buffer.from(JSON.stringify(manifest)) });
    entries.push({ path: `${base}ingest.json`, data: Buffer.from('{}') });
    if (it.observations.length) entries.push({ path: `${base}observations/${it.lane}.ndjson`, data: Buffer.from(it.observations.map((o) => JSON.stringify(o)).join('\n') + '\n') });
    if (it.result) entries.push({ path: `${base}results/${it.lane}.json`, data: Buffer.from(JSON.stringify(it.result)) });
  });
  return entries;
}

function writePlain(dir, entries) {
  for (const e of entries) {
    const p = join(dir, ...e.path.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, e.data);
  }
}

const deriveFixture = (name) => {
  const fx = fixture(name);
  const { subjects, summary } = derive(itemsFromEntries(entriesOf(fx)));
  const d = subjects.get(fx.subject);
  const by = Object.fromEntries(d.records.map((r) => [r.field, r.value]));
  return { fx, d, by, summary };
};

test('R-DRIFT-01: a version-like release tag force-pushed to another commit is a git_tag_moves event, ranked high', () => {
  const { fx, by } = deriveFixture('git-force-push.json');
  assert.equal(by.git_tag_moves.length, 1);
  const [e] = by.git_tag_moves;
  const [want] = fx.expect.git_tag_moves;
  assert.deepEqual([e.kind, e.tag, e.rank, e.from.commit, e.to.commit], ['git_tag_moved', want.tag, want.rank, want.from, want.to]);
  assert.equal(e.rank_reason, 'moved_after_release');
  assert.equal(e.last_seen_before, fx.items[0].observed_at);
  assert.equal(e.seen_at, fx.items[1].observed_at);
});

test('R-DRIFT-02: a version-like image tag that resolves to a new digest is an oci_tag_moves event, ranked medium; latest moving is not', () => {
  const { fx, by, d } = deriveFixture('oci-tag-moved.json');
  const [want] = fx.expect.oci_tag_moves;
  assert.deepEqual(by.oci_tag_moves.map((e) => [e.kind, e.reference, e.tag, e.rank, e.from_digest, e.to_digest]),
    [['oci_tag_moved', 'ghcr.io/acme/image-server', want.tag, want.rank, want.from, want.to]]);
  assert.equal(by.oci_tag_moves[0].rank_reason, 'moved_after_release');
  assert.equal(d.stats.floating_moved, fx.expect.floating_moved);
});

test('R-DRIFT-03: a tool list that changes behind an unchanged image digest is a catalog_drift_same_version event; a new digest behind the same tag ranks high', () => {
  const { fx, by } = deriveFixture('catalog-same-image.json');
  assert.deepEqual(by.catalog_drift_same_version.events.map((e) => ({ kind: e.kind, rank: e.rank })), fx.expect.catalog_events);
  const [same, moved] = by.catalog_drift_same_version.events;
  assert.equal(same.anchor.digest, '8'.repeat(64));
  assert.deepEqual([moved.anchor.from_digest, moved.anchor.to_digest], ['8'.repeat(64), '9'.repeat(64)]);
  assert.deepEqual([same.from.tool_count, same.to.tool_count], [4, 5]);
  assert.equal(by.catalog_drift_same_version.pairs, 2);
});

test('R-DRIFT-04: floating tags (latest, v1, v1.4, nightly, main) moving are counted, never events; a re-annotated version tag on the same commit is not a move', () => {
  const { fx, by, d, summary } = deriveFixture('git-floating-tags.json');
  assert.deepEqual(by.git_tag_moves, []);
  assert.equal(d.stats.floating_moved, fx.expect.floating_moved);
  assert.equal(d.stats.reannotated, fx.expect.reannotated);
  assert.deepEqual(summary.events, {});
});

test('R-DRIFT-05: a tag moved within an hour of its release is kept but ranked low (a fix-up re-tag), for git and for images', () => {
  const git = deriveFixture('git-retag-fixup.json');
  assert.deepEqual(git.by.git_tag_moves.map((e) => [e.tag, e.rank, e.rank_reason, e.from.commit, e.to.commit]),
    [['2.0.0', 'low', 'retag_within_an_hour', git.fx.expect.git_tag_moves[0].from, git.fx.expect.git_tag_moves[0].to]]);
  const oci = deriveFixture('oci-retag-fixup.json');
  assert.deepEqual(oci.by.oci_tag_moves.map((e) => [e.tag, e.rank, e.rank_reason]), [['v0.3.1', 'low', 'old_digest_seen_within_an_hour_of_release']]);
});

test('R-DRIFT-06: an npm or PyPI package at the same version is never a drift event, whatever its tool list does', () => {
  const { fx, by, summary } = deriveFixture('catalog-npm-same-version.json');
  assert.deepEqual(by.catalog_drift_same_version.events, []);
  assert.deepEqual(by.catalog_drift_same_version.excluded, fx.expect.excluded);
  assert.deepEqual(summary.events, {});
});

test('R-DRIFT-07: a tool list change explained by our own tools (new version, new run_key) is excluded; same commit, tools and run_key is our reader, reported tool-side', () => {
  const { fx, by, d, summary } = deriveFixture('catalog-scan-static.json');
  assert.deepEqual(by.catalog_drift_same_version.events, []);
  assert.deepEqual(by.catalog_drift_same_version.excluded, fx.expect.excluded);
  assert.equal(d.tool_side.length, fx.expect.tool_side);
  assert.equal(d.tool_side[0].kind, 'same_commit_list_changed');
  assert.equal(summary.tool_side[0].subject, fx.subject);
});

test('derive: every derived record is a declared field of the pinned registry with its type', () => {
  for (const name of ['git-force-push.json', 'oci-tag-moved.json', 'catalog-same-image.json']) {
    const { d } = deriveFixture(name);
    for (const r of d.records) {
      const f = REGISTRY.fields.get(r.field);
      assert.ok(f, r.field);
      assert.equal(f.type, Array.isArray(r.value) ? 'array' : 'object', r.field);
    }
  }
});

test('derive: one observation is no comparison, and a result archived twice counts once', () => {
  const fx = fixture('git-force-push.json');
  const one = derive(itemsFromEntries(entriesOf({ ...fx, items: fx.items.slice(0, 1) })));
  assert.deepEqual(one.subjects.get(fx.subject).records, []);
  const twice = [...entriesOf(fx), ...entriesOf(fx)];
  const r = derive(itemsFromEntries(twice));
  assert.equal(r.summary.items, 2);
  assert.equal(r.subjects.get(fx.subject).records[0].value.length, 1);
});

test('derive CLI: --plain reads an accepted/ folder and writes one line per derived field; bad usage is exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-plain-'));
  try {
    const all = [];
    for (const name of ['git-force-push.json', 'oci-tag-moved.json', 'catalog-scan-static.json']) all.push(...entriesOf(fixture(name), name.replace('.json', '')));
    writePlain(join(dir, 'in'), all);
    const out = join(dir, 'derived.ndjson');
    let text = '';
    const code = await main(['--plain', join(dir, 'in'), '--out', out], { write: (s) => { text += s; }, now: () => new Date('2026-11-30T00:00:00Z') });
    assert.equal(code, 0);
    const summary = JSON.parse(text);
    assert.deepEqual(summary.events, { 'git_tag_moved:high': 1, 'oci_tag_moved:medium': 1 });
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.subject, l.field]).sort(), [
      ['acme/image-server', 'oci_tag_moves'], ['acme/source-server', 'catalog_drift_same_version'], ['acme/tagged-server', 'git_tag_moves']]);
    assert.ok(lines.every((l) => l.derived_at === '2026-11-30T00:00:00.000Z' && /derive\.mjs$/.test(l.source)));
    assert.equal(readPlain(join(dir, 'in')).items.length, 9);
    assert.equal(await main(['--plain'], { write: () => {} }), 2);
    assert.equal(await main(['--plain', dir, '--archive', dir], { write: () => {} }), 2);
    assert.equal(await main(['--plain', join(dir, 'nope')], { write: () => {} }), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derive: --archive decrypts sealed ingest files in memory, reads accepted items only, and counts a file it cannot read', { skip: !haveAge && 'age is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-archive-'));
  try {
    const k = spawnSync(KEYGEN, [], { encoding: 'utf8' });
    const identity = k.stdout.split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'));
    const pub = /public key: (age1[0-9a-z]+)/.exec(k.stdout + k.stderr)[1];
    const day = join(dir, 'ingest', '2026-11-24', 'ingest-1-1');
    mkdirSync(day, { recursive: true });
    const fx = fixture('git-force-push.json');
    const entries = entriesOf(fx);
    // A rejected item next to the accepted ones is never read.
    entries.push({ path: 'rejected/att-x/0/manifest.json', data: Buffer.from(JSON.stringify({ subject: { id: 'acme/rejected' }, finished_at: '2026-11-30T00:00:00Z' })) });
    writeFileSync(join(day, 'ingest-a-0.tar.age'), ageEncrypt({ plaintext: writeTar(entries), recipients: [pub], ageBin: AGE }));
    writeFileSync(join(day, 'ingest-b-0.tar.age'), Buffer.from('age-encryption.org/v1\nnot really\n'));
    const { items, stats } = readArchive(dir, { identity, ageBin: AGE });
    assert.deepEqual(stats, { sealed: 2, failed: 1, unreadable: 0 });
    assert.deepEqual(items.map((x) => x.subject), [fx.subject, fx.subject]);
    assert.equal(derive(items).summary.events['git_tag_moved:high'], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-DRIFT-11: a failed read in between (ok, rate_limited, ok with a new digest) or a git tag that leaves the window and comes back moved does not hide the move', () => {
  const oci = deriveFixture('oci-move-after-failed-read.json');
  const [want] = oci.fx.expect.oci_tag_moves;
  assert.deepEqual(oci.by.oci_tag_moves.map((e) => [e.tag, e.rank, e.from_digest, e.to_digest, e.last_seen_before]),
    [[want.tag, want.rank, want.from, want.to, want.last_seen_before]]);
  const git = deriveFixture('git-tag-returns.json');
  const [g] = git.fx.expect.git_tag_moves;
  assert.deepEqual(git.by.git_tag_moves.map((e) => [e.tag, e.rank, e.from.commit, e.to.commit, e.last_seen_before]),
    [[g.tag, g.rank, g.from, g.to, g.last_seen_before]]);
});

test('R-DRIFT-12: a tool list change behind a floating image tag is not an event: the probed tag counts, not the registry version', () => {
  const { fx, by } = deriveFixture('catalog-floating-image.json');
  assert.deepEqual(by.catalog_drift_same_version.events, fx.expect.catalog_events);
  assert.deepEqual(by.catalog_drift_same_version.excluded, fx.expect.excluded);
});

test('R-DRIFT-22: --since reports only events seen at or after it, with everything before it as the baseline; times are compared as times', async () => {
  const fx = fixture('git-tag-returns.json');
  const items = itemsFromEntries(entriesOf(fx));
  const at = (iso) => Date.parse(iso);
  // The move is seen in the third observation; its baseline (the first) is before --since.
  const mid = derive(items, { since: at('2026-11-23T00:00:00Z') }).subjects.get(fx.subject).records;
  assert.equal(mid.find((r) => r.field === 'git_tag_moves').value.length, 1);
  assert.deepEqual(derive(items, { since: at('2026-11-25T00:00:00Z') }).subjects.get(fx.subject).records, []);
  // An offset time is a time, not a string: 2026-11-24T01:00:00+02:00 is before the third observation.
  const dir = mkdtempSync(join(tmpdir(), 'drift-since-'));
  try {
    writePlain(join(dir, 'in'), entriesOf(fx));
    let text = '';
    assert.equal(await main(['--plain', join(dir, 'in'), '--since', '2026-11-24T01:00:00+02:00'], { write: (x) => { text += x; } }), 0);
    assert.deepEqual(JSON.parse(text).events, { 'git_tag_moved:high': 1 });
    text = '';
    assert.equal(await main(['--plain', join(dir, 'in'), '--since', '2026-11-24T00:00:01Z'], { write: (x) => { text += x; } }), 0);
    assert.deepEqual(JSON.parse(text).events, {});
    assert.equal(await main(['--plain', join(dir, 'in'), '--since', 'yesterday'], { write: () => {} }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-DRIFT-24: --out is written 0600, and never inside the folder being read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-out-'));
  try {
    writePlain(join(dir, 'in'), entriesOf(fixture('git-force-push.json')));
    const out = join(dir, 'derived.ndjson');
    writeFileSync(out, 'old', { mode: 0o644 });
    assert.equal(await main(['--plain', join(dir, 'in'), '--out', out], { write: () => {} }), 0);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    let text = '';
    assert.equal(await main(['--plain', join(dir, 'in'), '--out', join(dir, 'in', 'x.ndjson')], { write: (x) => { text += x; } }), 2);
    assert.match(text, /must not be inside/);
    assert.equal(await main(['--archive', join(dir, 'in'), '--out', join(dir, 'in', 'accepted', 'y.ndjson')], { write: () => {} }), 2);
    assert.equal(outInside(join(dir, 'in'), join(dir, 'in')), true);
    assert.equal(outInside(join(dir, 'in-sibling.ndjson'), join(dir, 'in')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-DRIFT-26: an --out that is a link, or a second name, for a file in the folder being read is refused and the file is untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'derive-link-'));
  try {
    const input = join(dir, 'in');
    mkdirSync(join(input, 'accepted', 'a', '0'), { recursive: true });
    const victim = join(input, 'accepted', 'a', '0', 'manifest.json');
    writeFileSync(victim, 'keep');
    mkdirSync(join(dir, 'out'));
    symlinkSync(victim, join(dir, 'out', 'sym.ndjson'));
    linkSync(victim, join(dir, 'out', 'hard.ndjson'));
    for (const f of ['sym.ndjson', 'hard.ndjson']) {
      assert.equal(outUnsafe(join(dir, 'out', f), input), true);
      assert.equal(await main(['--plain', input, '--out', join(dir, 'out', f)], { write: () => {} }), 2);
    }
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    assert.equal(outUnsafe(join(dir, 'out', 'new.ndjson'), input), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
