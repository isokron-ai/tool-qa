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
//   amber   3 to 6 hours, no snapshot yet, or the manifest could not be read
//   red     more than 6 hours
//   off     the state-snapshot lane is switched off

import { MANIFEST, SNAPSHOT_TAG, newest, parseManifest } from './snapshot.mjs';

const HOUR = 3600 * 1000;
export const SNAPSHOT_THRESHOLDS = Object.freeze({ amberMs: 3 * HOUR, redMs: 6 * HOUR });

export function snapshotCheck({ now, manifest, error = null, laneOn = true }) {
  const id = 'state-snapshot';
  if (!laneOn) return { id, status: 'off', summary: 'the state-snapshot lane is switched off (LANE_STATE_SNAPSHOT_ENABLED)' };
  if (error) return { id, status: 'amber', summary: `could not read the snapshot manifest: ${String(error).slice(0, 200)}` };
  const top = manifest && newest(manifest.snapshots ?? []);
  if (!top) return { id, status: 'amber', summary: `no state snapshot yet (release "${SNAPSHOT_TAG}", ${MANIFEST})` };
  const at = Date.parse(manifest.current_at ?? top.created);
  const age = Number.isFinite(at) ? now - at : Infinity;
  const hours = Number.isFinite(age) ? `${(age / HOUR).toFixed(1)} hours ago` : 'at an unknown time';
  const status = age > SNAPSHOT_THRESHOLDS.redMs ? 'red' : age > SNAPSHOT_THRESHOLDS.amberMs ? 'amber' : 'green';
  return {
    id,
    status,
    summary: `newest snapshot ${top.name}; a snapshot run last confirmed it holds the live state ${hours}`,
  };
}

/**
 * Read the manifest from the public snapshot release. `gh` is
 * snapshot/github.mjs createReleaseClient(). Returns { manifest } or { error }.
 */
export async function readSnapshotManifest(gh) {
  try {
    const release = await gh.getRelease(SNAPSHOT_TAG);
    if (!release) return { manifest: null };
    const assets = await gh.listAssets(release);
    const a = assets.find((x) => x.name === MANIFEST);
    if (!a) return { manifest: null };
    const manifest = parseManifest((await gh.download(a)).toString('utf8'));
    return manifest ? { manifest } : { error: `${MANIFEST} is not a snapshot manifest` };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
