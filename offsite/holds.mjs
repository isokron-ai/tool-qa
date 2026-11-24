// The hold list: full raw data kept longer than the usual 30 days (loop upgrade 20).
//
// DESIGN-v3 section 9.6 keeps full raw data 90 days while a dispute or a
// disclosure is open, and 18 months for items selected for raw keeping. The
// list lives in offsite/holds.json (reviewed like any other change), one entry
// per ingest artifact:
//
//   { "holds": [ { "artifact": "ingest-45312591667-1", "for": "dispute", "from": "2026-11-24", "note": "..." } ] }
//
// `for` is dispute, disclosure or raw; the hold ends `from` plus that many
// days (HOLD_DAYS in ingest/retention.mjs). A hold is by artifact, so it keeps
// the whole artifact, not one item. It only stops the prune: GitHub still
// expires its own copy after 90 days. A file the prune cannot read as a hold
// list stops the prune (it never guesses that nothing is held).

import { readFileSync } from 'node:fs';

import { HOLD_DAYS } from '../ingest/retention.mjs';

const DAY = 24 * 3_600_000;
const ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** { holds: [{artifact, for, from, until}], problems: string[] } from the file's text. */
export function parseHolds(text) {
  const out = { holds: [], problems: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    out.problems.push('the hold list is not JSON');
    return out;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.holds)) {
    out.problems.push('the hold list has no "holds" array');
    return out;
  }
  data.holds.forEach((h, i) => {
    const where = `hold ${i + 1}`;
    const from = Date.parse(`${h?.from}T00:00:00Z`);
    if (!h || typeof h !== 'object') out.problems.push(`${where} is not an object`);
    else if (!ARTIFACT_RE.test(String(h.artifact ?? ''))) out.problems.push(`${where}: "artifact" is not an artifact name`);
    else if (!Object.hasOwn(HOLD_DAYS, h.for)) out.problems.push(`${where}: "for" must be one of ${Object.keys(HOLD_DAYS).join(', ')}`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(h.from)) || !Number.isFinite(from)) out.problems.push(`${where}: "from" must be a date like 2026-11-24`);
    else out.holds.push({ artifact: h.artifact, for: h.for, from: h.from, until: from + HOLD_DAYS[h.for] * DAY });
  });
  return out;
}

export function readHolds(file) {
  try {
    return parseHolds(readFileSync(file, 'utf8'));
  } catch (err) {
    return { holds: [], problems: [`cannot read ${file} (${err?.code ?? 'error'})`] };
  }
}

/** The artifact folder of an object key (`<prefix>/<day>/<artifact>/...`), or null. */
export const artifactOfKey = (key) => String(key).split('/')[2] ?? null;

/** True while a hold on the key's artifact has not ended. */
export function isHeld(key, holds, now) {
  const a = artifactOfKey(key);
  return a !== null && holds.some((h) => h.artifact === a && now < h.until);
}
