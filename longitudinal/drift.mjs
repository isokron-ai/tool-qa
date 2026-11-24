// Drift at an unchanged release: three signals, each found by comparing two
// successive observations of one subject (pure functions; longitudinal/derive.mjs
// feeds them from the archive).
//
//   git_tag_moves    a version-like git tag whose target commit changed
//                    (a force-pushed tag), from meta-github's git_tag_targets;
//   oci_tag_moves    a version-like image tag that resolves to a new digest,
//                    from meta-registry's oci_tag_digests;
//   catalog_drift_same_version
//                    a tool list hash that changed while the package version,
//                    image digest and commit did not, from live-probe's
//                    tool_list_sha256 or scan-static's catalog hash.
//
// False-positive guards:
//   - Only version-like tags are events: a full MAJOR.MINOR.PATCH, optionally
//     v-prefixed or behind a package prefix (pkg@1.2.3, pkg-v1.2.3, sub/v1.2.3),
//     with an optional pre-release or build suffix. latest, main, v1, 1.2 and
//     other floating tags are expected to move; they are counted, never events.
//   - A tag moved within FIXUP_WINDOW_MS of its release is kept, ranked low: a
//     re-tag minutes after a release is a common fix-up.
//   - A tool list change is excluded (counted, not an event) when our own tools
//     changed: the manifest's tool versions differ, or the run_key differs while
//     the subject commit is the same (a tool, oracle, probe or settings change).
//   - An npm or PyPI package at the same version is never an event: a published
//     version's content cannot change there.
//   - scan-static reads source, so "same commit, same run_key, different list"
//     is our reader's nondeterminism, not the subject's drift: it is reported
//     as tool-side (`tool_side`), never as a subject event.

export const FIXUP_WINDOW_MS = 60 * 60 * 1000;

const SEMVER = String.raw`\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?`;
const VERSION_TAG_RE = new RegExp(`^(?:[A-Za-z0-9@._/-]{0,200}?[@/-])?[vV]?${SEMVER}$`);

/** A tag that names one release: semver (MAJOR.MINOR.PATCH), optionally v-prefixed or package-prefixed. */
export function versionLikeTag(tag) {
  return typeof tag === 'string' && tag.length <= 255 && VERSION_TAG_RE.test(tag);
}

const ms = (t) => (typeof t === 'string' ? Date.parse(t) : NaN);

/** When a tag target was made: the tagger date of an annotated tag, else the commit date. */
const madeAt = (x) => ms(x?.tagged_at ?? x?.commit_date ?? null);

/**
 * Compare two git_tag_targets values of one subject, `prev` observed at
 * `prevAt` and `cur` at `curAt`. Returns { events, compared, floating_moved,
 * reannotated }: an event for each version-like tag whose commit changed.
 */
export function gitTagMoves(prev, cur, { prevAt = null, curAt = null } = {}) {
  const out = { events: [], compared: 0, floating_moved: 0, reannotated: 0 };
  if (!prev || !cur || !Array.isArray(prev.tags) || !Array.isArray(cur.tags)) return out;
  const before = new Map(prev.tags.filter((t) => typeof t?.tag === 'string').map((t) => [t.tag, t]));
  for (const now of cur.tags) {
    const was = before.get(now?.tag);
    if (!was) continue;
    out.compared++;
    if (!was.commit || !now.commit) continue; // a tag of a tag, or a target we could not read
    if (was.commit === now.commit) {
      if (was.tag_object !== now.tag_object && versionLikeTag(now.tag)) out.reannotated++;
      continue;
    }
    if (!versionLikeTag(now.tag)) { out.floating_moved++; continue; }
    const a = madeAt(was);
    const b = madeAt(now);
    const quick = Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= FIXUP_WINDOW_MS;
    out.events.push({
      kind: 'git_tag_moved',
      tag: now.tag,
      from: { commit: was.commit, tag_object: was.tag_object ?? null, commit_date: was.commit_date ?? null, tagged_at: was.tagged_at ?? null },
      to: { commit: now.commit, tag_object: now.tag_object ?? null, commit_date: now.commit_date ?? null, tagged_at: now.tagged_at ?? null },
      last_seen_before: prevAt,
      seen_at: curAt,
      rank: quick ? 'low' : 'high',
      rank_reason: quick ? 'retag_within_an_hour' : Number.isFinite(a) && Number.isFinite(b) ? 'moved_after_release' : 'times_unknown',
    });
  }
  return out;
}

/**
 * Compare two oci_tag_digests values of one subject. `releasedAt(server_name,
 * registry_version)` gives the registry publish time of the version a tag was
 * declared for, or null. A move is ranked low when the old digest was last
 * seen within FIXUP_WINDOW_MS of that release: the change may be the fix-up
 * re-tag rather than a later replacement.
 */
export function ociTagMoves(prev, cur, { prevAt = null, curAt = null, releasedAt = () => null } = {}) {
  const out = { events: [], compared: 0, floating_moved: 0 };
  if (!Array.isArray(prev) || !Array.isArray(cur)) return out;
  const key = (x) => `${x?.reference}\u0000${x?.tag}`;
  const before = new Map(prev.filter((x) => x?.status === 'ok' && typeof x.digest === 'string').map((x) => [key(x), x]));
  for (const now of cur) {
    if (now?.status !== 'ok' || typeof now.digest !== 'string') continue;
    const was = before.get(key(now));
    if (!was) continue;
    out.compared++;
    if (was.digest === now.digest) continue;
    if (!versionLikeTag(now.tag)) { out.floating_moved++; continue; }
    const rel = ms(releasedAt(now.server_name ?? was.server_name ?? null, now.registry_version ?? was.registry_version ?? null));
    const seen = ms(prevAt);
    const quick = Number.isFinite(rel) && Number.isFinite(seen) && seen - rel <= FIXUP_WINDOW_MS && seen >= rel;
    out.events.push({
      kind: 'oci_tag_moved',
      reference: now.reference,
      tag: now.tag,
      server_name: now.server_name ?? null,
      registry_version: now.registry_version ?? null,
      from_digest: was.digest,
      to_digest: now.digest,
      last_seen_before: prevAt,
      seen_at: curAt,
      rank: quick ? 'low' : 'high',
      rank_reason: quick ? 'old_digest_seen_within_an_hour_of_release' : Number.isFinite(rel) ? 'moved_after_release' : 'release_time_unknown',
    });
  }
  return out;
}

const IMMUTABLE = new Set(['npm', 'pypi']);
const sameTools = (a, b) => JSON.stringify(normTools(a)) === JSON.stringify(normTools(b));
const normTools = (t) => (Array.isArray(t) ? t.map((x) => `${x?.name}@${x?.version}`).sort() : []);

/**
 * Compare two catalog observations of one subject from the same lane:
 *   { lane, observed_at, run_key, tools: [{name, version}], subject_sha,
 *     tool_list_sha256, tool_count, commit,
 *     package: {type, identifier, version} | null, oci_digest }
 * Returns null (nothing to say: a hash missing, or equal), { excluded: reason },
 * { tool_side: {...} } or { event: {...} }.
 */
export function catalogDrift(a, b) {
  if (!a || !b || typeof a.tool_list_sha256 !== 'string' || typeof b.tool_list_sha256 !== 'string') return null;
  if (a.tool_list_sha256 === b.tool_list_sha256) return null;
  if (!sameTools(a.tools, b.tools)) return { excluded: 'tool_version_changed' };
  // The run_key moved while the subject did not: our tools, oracles, probes or settings changed.
  const runKeyExplains = a.run_key && b.run_key && a.run_key !== b.run_key && a.subject_sha === b.subject_sha;
  const side = (x) => ({ tool_list_sha256: x.tool_list_sha256, tool_count: x.tool_count ?? null, observed_at: x.observed_at ?? null });
  const event = (kind, rank, anchor) => ({ event: { kind, lane: b.lane, anchor, from: side(a), to: side(b), rank } });
  const pa = a.package;
  const pb = b.package;
  if (pa && pb && pa.type && pa.type === pb.type && pa.identifier === pb.identifier) {
    if (pa.version !== pb.version || !pa.version) return { excluded: 'new_release' };
    const anchor = { type: pb.type, identifier: pb.identifier, version: pb.version };
    if (pb.type === 'oci') {
      if (a.oci_digest && b.oci_digest && a.oci_digest !== b.oci_digest) {
        return event('catalog_changed_with_tag_move', 'high', { ...anchor, from_digest: a.oci_digest, to_digest: b.oci_digest });
      }
      if (!a.oci_digest || !b.oci_digest) return { excluded: 'no_anchor' };
      if (runKeyExplains) return { excluded: 'run_key_changed' };
      return event('catalog_changed_same_image', 'medium', { ...anchor, digest: b.oci_digest });
    }
    // A published npm or PyPI version cannot change: never an event.
    if (IMMUTABLE.has(pb.type)) return { excluded: 'immutable_registry_version' };
    if (runKeyExplains) return { excluded: 'run_key_changed' };
    return event('catalog_changed_same_version', 'medium', anchor);
  }
  if (pa || pb) return { excluded: 'package_changed' };
  if (a.commit && b.commit) {
    if (a.commit !== b.commit) return { excluded: 'new_commit' };
    if (runKeyExplains || (a.run_key && b.run_key && a.run_key !== b.run_key)) return { excluded: 'run_key_changed' };
    // Same source, same tools, same run_key, different list: our reader, not the subject.
    return { tool_side: { kind: 'same_commit_list_changed', lane: b.lane, commit: b.commit, from: side(a), to: side(b) } };
  }
  return { excluded: 'no_anchor' };
}
