// Drift at an unchanged release: three signals, found by comparing each
// observation of one subject with what was last seen before it (pure
// functions; longitudinal/derive.mjs feeds them from the archive).
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
// Tags are compared with their last-seen state across the subject's whole
// history, not only with the previous observation: a read that failed in
// between, or a git tag that left the 100-tag window and came back, does not
// hide a move (R-DRIFT-11).
//
// False-positive guards:
//   - Only version-like tags are events: a full MAJOR.MINOR.PATCH, optionally
//     v-prefixed or behind a package prefix (pkg@1.2.3, pkg-v1.2.3, sub/v1.2.3),
//     with an optional pre-release or build suffix, and no floating word
//     (snapshot, dev, nightly, edge, latest, main, master, canary) in the
//     pre-release or as a bare one-word prefix (a package prefix such as
//     mcp-main@ or edge-runtime- is not checked). latest, main, v1, 1.2, 1.0.0-SNAPSHOT and
//     other floating tags are expected to move; they are counted, never events.
//   - A move that looks like a fix-up re-tag is kept, ranked low. git: the old
//     and new targets were made within FIXUP_WINDOW_MS of each other (tagger
//     date, else committer date; both are set by whoever made them, so they
//     are not trusted alone) and we last saw the old target within the window
//     of when it was made. Images: we last saw the old digest within the
//     window after the registry release. A moved image tag otherwise ranks
//     medium (base-image rebuilds are routine), a moved git tag high.
//   - A tool list change is excluded (counted, not an event) when our own tools
//     changed: the manifest's tool versions differ, or the run_key differs while
//     the subject commit is the same (a tool, oracle, probe or settings change).
//   - An npm, PyPI or NuGet package at the same version is never an event: a
//     published version's content cannot change there.
//   - A tool list change behind a floating image tag is not an event.
//   - scan-static reads source, so "same commit, same run_key, different list"
//     is our reader's nondeterminism, not the subject's drift: it is reported
//     as tool-side (`tool_side`), never as a subject event.

import { ociTarget } from '../meta/lib/oci.mjs';

export const FIXUP_WINDOW_MS = 60 * 60 * 1000;

const SEMVER_CORE = String.raw`\d+\.\d+\.\d+(?:\.\d+)?`;
const VERSION_TAG_RE = new RegExp(`^((?:[A-Za-z0-9@._/-]{0,200}?[@/-])?)[vV]?${SEMVER_CORE}(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,63}))?(?:\\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$`);
/** Words that mark a moving tag even when it carries a version (R-DRIFT-18). */
export const FLOATING_WORDS = Object.freeze(['snapshot', 'dev', 'nightly', 'edge', 'latest', 'main', 'master', 'canary']);
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;

/** A tag with bidirectional control characters replaced, so it cannot reorder text where it is shown (R-DRIFT-23). */
export function cleanTag(tag) {
  return typeof tag === 'string' ? tag.replace(BIDI_RE, '?') : tag;
}

/**
 * A tag that names one release: semver (MAJOR.MINOR.PATCH), optionally
 * v-prefixed or package-prefixed, with no floating word in its prefix or
 * pre-release part.
 */
export function versionLikeTag(tag) {
  if (typeof tag !== 'string' || tag.length > 255) return false;
  const m = VERSION_TAG_RE.exec(tag);
  if (!m) return false;
  // The pre-release part is checked word by word. A prefix only when it is one bare word (nightly-1.0.0,
  // master/v1.0.0): a package prefix (ending in @) or one of several parts (edge-runtime-v2.0.0) names a
  // package, and a floating word inside a package name says nothing about the tag (R-DRIFT-25).
  if ((m[2] ?? '').toLowerCase().split(/[^a-z0-9]+/).some((w) => FLOATING_WORDS.includes(w))) return false;
  const prefix = m[1];
  if (prefix && !prefix.endsWith('@')) {
    const bare = prefix.slice(0, -1).toLowerCase();
    if (/^[a-z0-9]+$/.test(bare) && FLOATING_WORDS.includes(bare)) return false;
  }
  return true;
}

const ms = (t) => (typeof t === 'string' ? Date.parse(t) : NaN);

/** When a tag target was made: the tagger date of an annotated tag, else the commit date. */
const madeAt = (x) => ms(x?.tagged_at ?? x?.commit_date ?? null);

/**
 * Git tag moves over a subject's observations, oldest first:
 * [{ at, value: git_tag_targets }]. Each tag is compared with its last-seen
 * target, whenever that was. Returns { events, compared, floating_moved,
 * reannotated }.
 */
export function gitTagSeries(observations) {
  const out = { events: [], compared: 0, floating_moved: 0, reannotated: 0 };
  const last = new Map(); // tag -> { target, at }
  for (const o of observations) {
    if (!o?.value || !Array.isArray(o.value.tags)) continue;
    for (const now of o.value.tags) {
      if (typeof now?.tag !== 'string') continue;
      const seen = last.get(now.tag);
      if (!now.commit) continue; // a tag of a tag, or a target we could not read: keeps the last-seen one
      last.set(now.tag, { target: now, at: o.at ?? null });
      if (!seen) continue;
      out.compared++;
      const was = seen.target;
      if (was.commit === now.commit) {
        if (was.tag_object !== now.tag_object && versionLikeTag(now.tag)) out.reannotated++;
        continue;
      }
      if (!versionLikeTag(now.tag)) { out.floating_moved++; continue; }
      const a = madeAt(was);
      const b = madeAt(now);
      const seenAt = ms(seen.at);
      // Committer and tagger dates are whatever the tagger set: a quick re-tag counts only if our
      // own last sight of the old target was also within the window of when it was made (R-DRIFT-05).
      const quick = Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= FIXUP_WINDOW_MS
        && (!Number.isFinite(seenAt) || seenAt - a <= FIXUP_WINDOW_MS);
      out.events.push({
        kind: 'git_tag_moved',
        tag: cleanTag(now.tag),
        from: { commit: was.commit, tag_object: was.tag_object ?? null, commit_date: was.commit_date ?? null, tagged_at: was.tagged_at ?? null },
        to: { commit: now.commit, tag_object: now.tag_object ?? null, commit_date: now.commit_date ?? null, tagged_at: now.tagged_at ?? null },
        last_seen_before: seen.at,
        seen_at: o.at ?? null,
        rank: quick ? 'low' : 'high',
        rank_reason: quick ? 'retag_within_an_hour' : Number.isFinite(a) && Number.isFinite(b) ? 'moved_after_release' : 'times_unknown',
      });
    }
  }
  return out;
}

/** Two observations: gitTagSeries of [prev, cur]. */
export function gitTagMoves(prev, cur, { prevAt = null, curAt = null } = {}) {
  return gitTagSeries([{ at: prevAt, value: prev }, { at: curAt, value: cur }]);
}

/**
 * Image tag moves over a subject's observations, oldest first:
 * [{ at, value: oci_tag_digests }]. Only answered reads (`status: ok`) count
 * and update the last-seen digest of a (reference, tag); a failed read in
 * between hides nothing (R-DRIFT-11). `releasedAt(server_name,
 * registry_version)` gives the registry publish time of the version a tag was
 * declared for, or null.
 */
export function ociTagSeries(observations, { releasedAt = () => null } = {}) {
  const out = { events: [], compared: 0, floating_moved: 0 };
  const last = new Map(); // reference + tag -> { entry, at }
  for (const o of observations) {
    if (!Array.isArray(o?.value)) continue;
    for (const now of o.value) {
      if (now?.status !== 'ok' || typeof now.digest !== 'string') continue;
      const key = `${now.reference}\u0000${now.tag}`;
      const seen = last.get(key);
      last.set(key, { entry: now, at: o.at ?? null });
      if (!seen) continue;
      out.compared++;
      const was = seen.entry;
      if (was.digest === now.digest) continue;
      if (!versionLikeTag(now.tag)) { out.floating_moved++; continue; }
      const rel = ms(releasedAt(now.server_name ?? was.server_name ?? null, now.registry_version ?? was.registry_version ?? null));
      const seenAt = ms(seen.at);
      const quick = Number.isFinite(rel) && Number.isFinite(seenAt) && seenAt >= rel && seenAt - rel <= FIXUP_WINDOW_MS;
      out.events.push({
        kind: 'oci_tag_moved',
        reference: now.reference,
        tag: cleanTag(now.tag),
        server_name: now.server_name ?? null,
        registry_version: now.registry_version ?? null,
        from_digest: was.digest,
        to_digest: now.digest,
        last_seen_before: seen.at,
        seen_at: o.at ?? null,
        // Base images are rebuilt routinely and results are public by name: medium, not high (R-DRIFT-19).
        rank: quick ? 'low' : 'medium',
        rank_reason: quick ? 'old_digest_seen_within_an_hour_of_release' : Number.isFinite(rel) ? 'moved_after_release' : 'release_time_unknown',
      });
    }
  }
  return out;
}

/** Two observations: ociTagSeries of [prev, cur]. */
export function ociTagMoves(prev, cur, { prevAt = null, curAt = null, releasedAt = () => null } = {}) {
  return ociTagSeries([{ at: prevAt, value: prev }, { at: curAt, value: cur }], { releasedAt });
}

/** Registries where a published version's content cannot change (R-DRIFT-06). */
export const IMMUTABLE_REGISTRIES = Object.freeze(['npm', 'pypi', 'nuget']);
const sameTools = (a, b) => JSON.stringify(normTools(a)) === JSON.stringify(normTools(b));
const normTools = (t) => (Array.isArray(t) ? t.map((x) => `${x?.name}@${x?.version}`).sort() : []);

/** The version a package observation stands for: for an image, the tag that was probed. */
function versionOf(p) {
  if (p.type !== 'oci') return p.version ?? null;
  return ociTarget(p.identifier, p.version)?.tag ?? null;
}

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
    const va = versionOf(pa);
    const vb = versionOf(pb);
    if (va !== vb || !vb) return { excluded: 'new_release' };
    const anchor = { type: pb.type, identifier: pb.identifier, version: vb };
    if (pb.type === 'oci') {
      if (!a.oci_digest || !b.oci_digest) return { excluded: 'no_anchor' };
      if (a.oci_digest !== b.oci_digest) {
        // A floating tag is meant to move: its new image is a new release, not drift (R-DRIFT-12).
        if (!versionLikeTag(vb)) return { excluded: 'floating_tag' };
        return event('catalog_changed_with_tag_move', 'high', { ...anchor, from_digest: a.oci_digest, to_digest: b.oci_digest });
      }
      if (runKeyExplains) return { excluded: 'run_key_changed' };
      return event('catalog_changed_same_image', 'medium', { ...anchor, digest: b.oci_digest });
    }
    // A published npm, PyPI or NuGet version cannot change: never an event.
    if (IMMUTABLE_REGISTRIES.includes(pb.type)) return { excluded: 'immutable_registry_version' };
    if (runKeyExplains) return { excluded: 'run_key_changed' };
    return event('catalog_changed_same_version', 'medium', anchor);
  }
  if (pa || pb) return { excluded: 'package_changed' };
  if (a.commit && b.commit) {
    if (a.commit !== b.commit) return { excluded: 'new_commit' };
    if (a.run_key && b.run_key && a.run_key !== b.run_key) return { excluded: 'run_key_changed' };
    // Same source, same tools, same run_key, different list: scan-static's reader, not the subject (R-DRIFT-20).
    if (b.lane === 'scan-static' && a.lane === 'scan-static') {
      return { tool_side: { kind: 'same_commit_list_changed', lane: b.lane, commit: b.commit, from: side(a), to: side(b) } };
    }
    return { excluded: 'no_anchor' };
  }
  return { excluded: 'no_anchor' };
}
