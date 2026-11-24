import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogDrift, cleanTag, FIXUP_WINDOW_MS, gitTagMoves, gitTagSeries, ociTagMoves, versionLikeTag } from '../drift.mjs';

test('R-DRIFT-04: version-like means a full MAJOR.MINOR.PATCH, optionally v- or package-prefixed; floating tags are not', () => {
  for (const t of ['1.2.3', 'v1.2.3', 'V0.0.1', '1.2.3-rc.1', 'v2.0.0+build.5', '1.2.3.4', '@scope/pkg@1.2.3', 'pkg@0.4.0', 'server-v1.0.0', 'sub/module/v1.2.3', 'release-2.1.0', '2024.11.01']) {
    assert.equal(versionLikeTag(t), true, t);
  }
  for (const t of ['latest', 'main', 'stable', 'nightly', 'edge', 'v1', 'v1.2', '1', '1.2', 'sha-abc1234', 'foo1.2.3', 'v1.2.x', '', null, 7, `v${'1.'.repeat(200)}1`]) {
    assert.equal(versionLikeTag(t), false, String(t));
  }
});

const tags = (list) => ({ tags: list.map(([tag, commit, at, obj = null]) => ({ tag, commit, tag_object: obj, commit_date: at, tagged_at: null })) });
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('gitTagMoves: a tag only one side has, or one whose commit could not be read, is never a move', () => {
  const r = gitTagMoves(tags([['v1.0.0', A, '2026-11-01T00:00:00Z'], ['v1.1.0', null, null]]), tags([['v1.1.0', B, '2026-11-20T00:00:00Z'], ['v1.2.0', B, '2026-11-20T00:00:00Z']]));
  assert.deepEqual(r, { events: [], compared: 0, floating_moved: 0, reannotated: 0 });
  assert.deepEqual(gitTagMoves(null, tags([])).events, []);
});

test('R-DRIFT-05: the fix-up window is an hour either way between the two targets; unknown times rank high', () => {
  const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
  const t0 = '2026-11-20T10:00:00.000Z';
  const edge = gitTagMoves(tags([['v1.0.0', A, t0]]), tags([['v1.0.0', B, at(t0, FIXUP_WINDOW_MS)]]));
  assert.equal(edge.events[0].rank, 'low');
  const past = gitTagMoves(tags([['v1.0.0', A, t0]]), tags([['v1.0.0', B, at(t0, FIXUP_WINDOW_MS + 1000)]]));
  assert.equal(past.events[0].rank, 'high');
  const unknown = gitTagMoves(tags([['v1.0.0', A, null]]), tags([['v1.0.0', B, t0]]));
  assert.deepEqual([unknown.events[0].rank, unknown.events[0].rank_reason], ['high', 'times_unknown']);
});

test('ociTagMoves: only answered reads compare; a failed read on either side is not a move', () => {
  const x = (digest, status = 'ok') => [{ reference: 'ghcr.io/a/b', tag: '1.0.0', digest, status }];
  assert.equal(ociTagMoves(x(`sha256:${'1'.repeat(64)}`), x(null, 'rate_limited')).compared, 0);
  assert.equal(ociTagMoves(x(null, 'not_found'), x(`sha256:${'1'.repeat(64)}`)).compared, 0);
  const moved = ociTagMoves(x(`sha256:${'1'.repeat(64)}`), x(`sha256:${'2'.repeat(64)}`));
  assert.deepEqual([moved.events.length, moved.events[0].rank, moved.events[0].rank_reason], [1, 'medium', 'release_time_unknown']);
});

test('catalogDrift: equal or missing hashes say nothing; a new package version is a release, not drift', () => {
  const base = { lane: 'live-probe', tools: [{ name: 'mcp-check', version: '1' }], run_key: 'r', subject_sha: null, commit: null, oci_digest: null };
  const p = (version, hash) => ({ ...base, tool_list_sha256: hash, package: { type: 'cargo', identifier: 'x', version } });
  assert.equal(catalogDrift(p('1.0.0', 'h1'), p('1.0.0', 'h1')), null);
  assert.equal(catalogDrift(p('1.0.0', null), p('1.0.0', 'h1')), null);
  assert.deepEqual(catalogDrift(p('1.0.0', 'h1'), p('1.1.0', 'h2')), { excluded: 'new_release' });
  assert.equal(catalogDrift(p('1.0.0', 'h1'), p('1.0.0', 'h2')).event.kind, 'catalog_changed_same_version');
  assert.deepEqual(catalogDrift({ ...base, tool_list_sha256: 'h1', package: null }, { ...base, tool_list_sha256: 'h2', package: null }), { excluded: 'no_anchor' });
});

test('R-DRIFT-18: a version with a floating word in its prefix or pre-release (snapshot, dev, nightly, edge, latest, main, master, canary) is not version-like', () => {
  for (const t of ['1.0.0-SNAPSHOT', '0.0.0-dev', '1.0.0-dev.3', 'nightly-1.0.0', 'main-1.0.0', 'master/v1.0.0', '1.2.3-latest', 'edge-2.0.0', '3.0.0-canary.1', 'v2.0.0-nightly.20261124']) {
    assert.equal(versionLikeTag(t), false, t);
  }
  for (const t of ['devtools-v1.0.0', 'mainframe@1.0.0', '1.0.0-rc.1', '1.0.0-beta', 'latestvalue-1.0.0', '1.2.3+build.dev']) {
    assert.equal(versionLikeTag(t), true, t);
  }
});

test('R-DRIFT-19: a moved version image tag ranks medium (base images are rebuilt routinely), a moved git tag high', () => {
  const o = (d) => [{ reference: 'ghcr.io/a/b', tag: '1.0.0', digest: `sha256:${d.repeat(64)}`, status: 'ok' }];
  assert.equal(ociTagMoves(o('1'), o('2'), { prevAt: '2026-11-20T00:00:00Z', releasedAt: () => '2026-11-01T00:00:00Z' }).events[0].rank, 'medium');
  const g = (c) => ({ tags: [{ tag: 'v1.0.0', commit: c.repeat(40), tag_object: null, commit_date: '2026-11-01T00:00:00Z', tagged_at: null }] });
  assert.equal(gitTagMoves(g('a'), { tags: [{ ...g('b').tags[0], commit_date: '2026-11-20T00:00:00Z' }] }).events[0].rank, 'high');
});

test('R-DRIFT-05: dates within the window rank low only when our own last sight of the old target was within the window of when it was made', () => {
  const t0 = '2026-11-20T10:00:00.000Z';
  const prev = { tags: [{ tag: 'v1.0.0', commit: A, tag_object: null, commit_date: t0, tagged_at: null }] };
  const cur = { tags: [{ tag: 'v1.0.0', commit: B, tag_object: null, commit_date: '2026-11-20T10:30:00.000Z', tagged_at: null }] };
  assert.equal(gitTagMoves(prev, cur, { prevAt: '2026-11-20T10:20:00.000Z' }).events[0].rank, 'low');
  // We saw the old target three hours after it was made: the claimed dates do not make it a fix-up.
  assert.equal(gitTagMoves(prev, cur, { prevAt: '2026-11-20T13:00:00.000Z' }).events[0].rank, 'high');
});

test('R-DRIFT-06: a NuGet package at the same version is treated like npm and PyPI: never an event', () => {
  const base = { lane: 'live-probe', tools: [], run_key: 'r', subject_sha: null, commit: null, oci_digest: null };
  const p = (hash) => ({ ...base, tool_list_sha256: hash, package: { type: 'nuget', identifier: 'Acme.Server', version: '1.0.0' } });
  assert.deepEqual(catalogDrift(p('h1'), p('h2')), { excluded: 'immutable_registry_version' });
});

test('R-DRIFT-20: only scan-static reports a same-commit list change tool-side; another lane with only a commit has no anchor', () => {
  const o = (lane, hash) => ({ lane, tools: [], run_key: 'r', subject_sha: A, commit: A, package: null, oci_digest: null, tool_list_sha256: hash });
  assert.equal(catalogDrift(o('scan-static', 'h1'), o('scan-static', 'h2')).tool_side.kind, 'same_commit_list_changed');
  assert.deepEqual(catalogDrift(o('live-probe', 'h1'), o('live-probe', 'h2')), { excluded: 'no_anchor' });
});

test('R-DRIFT-23: bidirectional control characters in a tag name never reach an event', () => {
  assert.equal(cleanTag('v1.0.0\u202e'), 'v1.0.0?');
  // Such a name is never version-like, so it can only be counted as floating.
  const r = gitTagSeries([
    { at: '2026-11-20T00:00:00Z', value: { tags: [{ tag: 'v1.0.0-\u2066x', commit: A, commit_date: '2026-11-01T00:00:00Z' }] } },
    { at: '2026-11-22T00:00:00Z', value: { tags: [{ tag: 'v1.0.0-\u2066x', commit: B, commit_date: '2026-11-21T00:00:00Z' }] } },
  ]);
  assert.deepEqual([r.events.length, r.floating_moved], [0, 1]);
});
