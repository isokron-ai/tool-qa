// Health items for data retention (loop upgrade 20), for the watchdog's "Loop
// health" issue. Both are pure and never throw.
//
//   keep-forever   the second copy of the keep-forever set (keep/copy.mjs), from the
//                  newest status.r<N>.json on the `keep-forever` release.
//                  green  the last good run is at most 12 hours old and nothing waits more than
//                         30 days to be copied
//                  amber  12 to 24 hours without a good run; the last run failed; the oldest
//                         artifact still waiting is 30 to 60 days old; no run yet or the status
//                         cannot be read
//                  red    over 24 hours without a good run, or an artifact has waited more than
//                         60 days (GitHub deletes its copy at 90, so the keep-forever data is
//                         close to lost)
//                  off    LANE_KEEP_FOREVER_ENABLED is not "true"
//   retention-seal sealing the pump's outputs (ingest/collect.mjs, kv retention.seal): amber when
//                  the last seal could not compress or could not write the keep-forever file
//                  (the full bundle was still sealed, as a plain tar if need be); red after three
//                  in a row, because every such seal leaves a hole in the keep-forever set.

import { newestRevision } from './copy.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const KEEP_THRESHOLDS = Object.freeze({ greenMs: 12 * HOUR, redMs: 24 * HOUR, waitAmberMs: 30 * DAY, waitRedMs: 60 * DAY, futureMs: 10 * 60_000 });
export const SEAL_RED_STREAK = 3;

const ago = (ms) => (ms < 2 * HOUR ? `${Math.round(ms / 60_000)} minutes` : ms < 3 * DAY ? `${(ms / HOUR).toFixed(1)} hours` : `${Math.round(ms / DAY)} days`);

/** { status } | { missing: 'release' | 'status' } | { error } from the keep-forever release. `release` is snapshot/github.mjs createReleaseClient(). */
export async function readKeepStatus(release) {
  try {
    const rel = await release.getRelease('keep-forever');
    if (!rel) return { missing: 'release' };
    const best = newestRevision(await release.listAssets(rel), 'status');
    if (!best) return { missing: 'status' };
    return { status: JSON.parse((await release.download(best.asset)).toString('utf8')) };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 200) };
  }
}

export function keepCheck(input) {
  const id = 'keep-forever';
  try {
    return judgeKeep(input);
  } catch (err) {
    return { id, status: 'amber', summary: `could not judge the keep-forever copy: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

function judgeKeep({ now, status = null, error = null, missing = null, laneOn = true }) {
  const id = 'keep-forever';
  if (!laneOn) return { id, status: 'off', summary: 'the keep-forever copy is switched off (LANE_KEEP_FOREVER_ENABLED)' };
  if (error) return { id, status: 'amber', summary: `could not read the keep-forever status: ${String(error).slice(0, 200)}` };
  if (!status) return { id, status: 'amber', summary: missing === 'release' ? 'no release "keep-forever" yet: the copy has never run' : 'the release "keep-forever" has no status: the copy has not reported yet' };
  const notes = [];
  let level = 0; // 0 green, 1 amber, 2 red
  const raise = (to, why) => {
    level = Math.max(level, to);
    if (why) notes.push(why);
  };
  const okAt = Date.parse(status.last_ok_at ?? '');
  if (!Number.isFinite(okAt)) raise(1, `no good run yet${status.reason ? ` (${String(status.reason).slice(0, 120)})` : ''}`);
  else if (okAt - now > KEEP_THRESHOLDS.futureMs) raise(1, `the last good run is dated ${status.last_ok_at}, in the future`);
  else {
    const age = Math.max(0, now - okAt);
    if (age > KEEP_THRESHOLDS.redMs) raise(2, `no good run for ${ago(age)}`);
    else if (age > KEEP_THRESHOLDS.greenMs) raise(1, `no good run for ${ago(age)}`);
  }
  if (status.status !== 'ok') raise(1, `the last run failed: ${String(status.reason ?? 'unknown').slice(0, 160)}`);
  const oldest = Date.parse(status.pending?.oldest_at ?? '');
  if (Number.isFinite(oldest) && Number(status.pending?.count) > 0) {
    const wait = now - oldest;
    if (wait > KEEP_THRESHOLDS.waitRedMs) raise(2, `${status.pending.count} artifact(s) wait to be copied, the oldest for ${ago(wait)}: GitHub deletes them at 90 days`);
    else if (wait > KEEP_THRESHOLDS.waitAmberMs) raise(1, `${status.pending.count} artifact(s) wait to be copied, the oldest for ${ago(wait)}`);
  }
  const copied = status.copied ? `last run copied ${status.copied.artifacts} artifact(s), ${status.copied.bytes} bytes` : 'no run counts';
  return { id, status: ['green', 'amber', 'red'][level], summary: [copied, `${Number(status.pending?.count) || 0} waiting`, ...notes].join('; '), ...(status.at ? { at: status.at } : {}) };
}

/** The `retention-seal` item from kv `retention.seal`, or null when nothing has been sealed since the upgrade. */
export function sealCheck(seal) {
  const id = 'retention-seal';
  try {
    if (!seal || typeof seal !== 'object') return { id, status: 'green', summary: 'nothing sealed since compression and the keep-forever files began' };
    const streak = Number(seal.streak) || 0;
    const ratio = seal.bytes_out > 0 ? (seal.bytes_in / seal.bytes_out).toFixed(1) : '?';
    const base = `sealed ${seal.sealed} time(s), compressed ${ratio} to 1, ${seal.failures?.compress ?? 0} compression and ${seal.failures?.keep ?? 0} keep-forever failure(s) in all`;
    if (streak >= SEAL_RED_STREAK) return { id, status: 'red', summary: `the last ${streak} seals failed (${seal.last_failure?.kind}: ${String(seal.last_failure?.error ?? '').slice(0, 120)}); the keep-forever set has holes; ${base}`, at: seal.at };
    if (streak > 0) return { id, status: 'amber', summary: `the last seal failed (${seal.last_failure?.kind}: ${String(seal.last_failure?.error ?? '').slice(0, 120)}); ${base}`, at: seal.at };
    return { id, status: 'green', summary: base, at: seal.at };
  } catch (err) {
    return { id, status: 'amber', summary: `could not judge the seal record: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
