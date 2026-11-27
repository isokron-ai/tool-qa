// The watchdog's `subject-heads` item (design audit A3): what the pump's head
// poll (pump/heads.mjs) left in kv pump.heads.
//
//   red    no head poll has been written for HEADS_RED_HOURS (24): subjects
//          only come due on their tier's age again, as before A3
//   amber  none written for HEADS_AMBER_HOURS (6; T1 is polled hourly), or
//          the last pass stopped on an error of ours or the API budget
//   green  otherwise, with how many active subjects have a sha
//   off    the poll is switched off (LANE_HEADS_ENABLED is not "true")
// Not shown before the first pass.

export const HEADS_AMBER_HOURS = 6;
export const HEADS_RED_HOURS = 24;
const HOUR = 3_600_000;

export function headsCheck({ now, heads }) {
  if (!heads || typeof heads !== 'object') return null;
  const base = { id: 'subject-heads', at: heads.at };
  const counts = `${Number(heads.with_sha ?? 0)} of ${Number(heads.active ?? 0)} active subjects have a sha`;
  if (heads.off === true) return { ...base, status: 'off', summary: `the head poll is switched off (LANE_HEADS_ENABLED); subjects come due on their tier's age only (${counts})` };
  const last = Date.parse(heads.last_write_at ?? '');
  const age = Number.isFinite(last) ? now - last : Infinity;
  const since = Number.isFinite(age) ? `${(age / HOUR).toFixed(1)} hours` : 'ever';
  const why = heads.stopped && heads.stopped !== 'points_reserve' ? `; the last pass stopped (${heads.stopped}${heads.error ? `: ${String(heads.error).slice(0, 80)}` : ''})` : '';
  if (age > HEADS_RED_HOURS * HOUR) return { ...base, status: 'red', summary: `no head poll written for ${since}: releases and new commits are not seen${why} (${counts})` };
  if (age > HEADS_AMBER_HOURS * HOUR) return { ...base, status: 'amber', summary: `no head poll written for ${since}${why} (${counts})` };
  if (why) return { ...base, status: 'amber', summary: `head poll last written ${since} ago${why} (${counts})` };
  return { ...base, status: 'green', summary: `head poll last written ${since} ago; ${counts}` };
}
