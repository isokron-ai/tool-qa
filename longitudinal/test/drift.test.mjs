import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogDrift, FIXUP_WINDOW_MS, gitTagMoves, ociTagMoves, versionLikeTag } from '../drift.mjs';

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
  assert.deepEqual(r, { events: [], compared: 1, floating_moved: 0, reannotated: 0 });
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
  assert.deepEqual([moved.events.length, moved.events[0].rank, moved.events[0].rank_reason], [1, 'high', 'release_time_unknown']);
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
