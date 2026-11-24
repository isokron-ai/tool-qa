// The health item for the state snapshots, for the watchdog's "Loop health"
// issue. Pure: it takes the snapshot manifest (snapshot/snapshot.mjs) and the
// time, and returns one check item.
//
// The age is measured from the manifest's `current_at`: the last time a
// snapshot run saw that the newest snapshot holds the live state. Dedupe means
// an idle loop makes no new snapshot files, but each run still refreshes
// `current_at`, so an idle loop stays green while snapshot runs keep going.
//
//   green   current within 3 hours
//   amber   3 to 6 hours; no snapshot yet; the release or its manifest is
//           missing or unreadable; `current_at` more than 5 minutes in the
//           future (a clock or a manifest that cannot be trusted)
//   red     more than 6 hours
//   off     the state-snapshot lane is switched off
//
// It never throws: anything unexpected is an amber item, so a bad manifest
// cannot take the watchdog run down with it.

import { MANIFEST, SNAPSHOT_TAG, newest, parseManifest } from './snapshot.mjs';

const HOUR = 3600 * 1000;
export const SNAPSHOT_THRESHOLDS = Object.freeze({ amberMs: 3 * HOUR, redMs: 6 * HOUR, futureMs: 5 * 60 * 1000 });

export function snapshotCheck(input) {
  const id = 'state-snapshot';
  try {
    return judge(input);
  } catch (err) {
    return { id, status: 'amber', summary: `could not judge the snapshot manifest: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

function judge({ now, manifest, error = null, missing = null, laneOn = true }) {
  const id = 'state-snapshot';
  if (!laneOn) return { id, status: 'off', summary: 'the state-snapshot lane is switched off (LANE_STATE_SNAPSHOT_ENABLED)' };
  if (error) return { id, status: 'amber', summary: `could not read the snapshot manifest: ${String(error).slice(0, 200)}` };
  if (!manifest) {
    const what = missing === 'release'
      ? `no release "${SNAPSHOT_TAG}" yet: no snapshot has ever been taken`
      : `the release "${SNAPSHOT_TAG}" has no ${MANIFEST}: snapshots may exist, but none is recorded`;
    return { id, status: 'amber', summary: what };
  }
  const top = newest(manifest.snapshots ?? []);
  if (!top) return { id, status: 'amber', summary: `${MANIFEST} lists no snapshots yet` };
  const at = Date.parse(manifest.current_at ?? top.created);
  const age = Number.isFinite(at) ? now - at : Infinity;
  if (age < -SNAPSHOT_THRESHOLDS.futureMs) {
    return { id, status: 'amber', summary: `${MANIFEST} says the live state was last confirmed ${((-age) / HOUR).toFixed(1)} hours in the future; not trusting it (newest snapshot ${top.name})` };
  }
  const hours = Number.isFinite(age) ? `${(Math.max(0, age) / HOUR).toFixed(1)} hours ago` : 'at an unknown time';
  const status = age > SNAPSHOT_THRESHOLDS.redMs ? 'red' : age > SNAPSHOT_THRESHOLDS.amberMs ? 'amber' : 'green';
  return {
    id,
    status,
    summary: `newest snapshot ${top.name}; a snapshot run last confirmed it holds the live state ${hours}`,
  };
}

/**
 * Read the manifest from the public snapshot release. `gh` is
 * snapshot/github.mjs createReleaseClient(). Returns { manifest },
 * { manifest: null, missing: 'release' | 'manifest' } or { error }.
 */
export async function readSnapshotManifest(gh) {
  try {
    const release = await gh.getRelease(SNAPSHOT_TAG);
    if (!release) return { manifest: null, missing: 'release' };
    const assets = await gh.listAssets(release);
    const a = assets.find((x) => x.name === MANIFEST);
    if (!a) return { manifest: null, missing: 'manifest' };
    const manifest = parseManifest((await gh.download(a)).toString('utf8'));
    return manifest ? { manifest } : { error: `${MANIFEST} is not a snapshot manifest` };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
