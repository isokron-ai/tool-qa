// Health item for the Mac archive pull (scripts/archive-pull.mjs).
//
// After each successful run the archive pull sets the repository variable
// ARCHIVE_LAST_OK to JSON: `at` (an ISO time) and the run's counts. The
// watchdog workflow passes it in as `${{ vars.ARCHIVE_LAST_OK }}` through env;
// the job's GITHUB_TOKEN cannot read repository variables through the REST API.
//
//   archive   green while the last good pull is at most 12 hours old; amber up
//             to 24 hours, or when `at` is more than 10 minutes in the future;
//             red after 24 hours, or when the variable is empty, not JSON, or
//             its `at` is not a date. `off` when the variable is exactly "off"
//             (an archive retired on purpose).
//
// archiveCheck never throws: a bad value is a red item, not a failed watchdog run.

const MIN = 60_000;
const HOUR = 60 * MIN;

export const ARCHIVE_THRESHOLDS = Object.freeze({ greenMs: 12 * HOUR, redMs: 24 * HOUR, futureSlackMs: 10 * MIN });
export const ARCHIVE_VARIABLE = 'ARCHIVE_LAST_OK';

const ago = (ms) => (ms < 2 * HOUR ? `${Math.round(ms / MIN)} minutes ago` : `${(ms / HOUR).toFixed(1)} hours ago`);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : '?');

/** @returns {{ id: 'archive', status: string, summary: string, at?: string }} */
export function archiveCheck({ now, raw }) {
  const id = 'archive';
  try {
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!text) return { id, status: 'red', summary: `${ARCHIVE_VARIABLE} is empty: no archive pull has reported a good run (is the Mac's archive agent running?)` };
    if (text === 'off') return { id, status: 'off', summary: `the archive heartbeat check is switched off (${ARCHIVE_VARIABLE}=off)` };
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      return { id, status: 'red', summary: `${ARCHIVE_VARIABLE} is not JSON: ${JSON.stringify(text.slice(0, 60))}` };
    }
    const at = typeof v?.at === 'string' ? Date.parse(v.at) : NaN;
    if (!Number.isFinite(at)) return { id, status: 'red', summary: `${ARCHIVE_VARIABLE} has no valid date in "at": ${JSON.stringify(text.slice(0, 80))}` };
    const iso = new Date(at).toISOString();
    const counts = `pulled ${count(v.pulled)}, quarantined ${count(v.quarantined)}, refused as not ours ${count(v.refused_foreign ?? 0)}`;
    const age = now - at;
    if (age < -ARCHIVE_THRESHOLDS.futureSlackMs) return { id, status: 'amber', summary: `the last good archive pull is dated ${iso}, in the future: check the Mac's clock`, at: iso };
    if (age <= ARCHIVE_THRESHOLDS.greenMs) return { id, status: 'green', summary: `last good archive pull ${ago(Math.max(0, age))} (${counts})`, at: iso };
    const status = age <= ARCHIVE_THRESHOLDS.redMs ? 'amber' : 'red';
    return { id, status, summary: `no good archive pull for ${ago(age).replace(' ago', '')} (last at ${iso}: ${counts}); check ~/Library/Logs/tool-qa-archive-pull.log on the Mac`, at: iso };
  } catch (err) {
    return { id, status: 'red', summary: `could not judge ${ARCHIVE_VARIABLE}: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
