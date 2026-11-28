// meta-backend's two data maps (meta/data/stand-ins.json, meta/data/spec-urls.json): read, checked, merged and
// indexed. Shared by the lane (meta/backend.mjs) and its scan worker (meta/lib/backend-scan-worker.mjs).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { buildIndex, mapProblems, mergeMaps } from './backend-scan.mjs';

const DATA = new URL('../data/', import.meta.url);

/** The two data maps, checked, merged and indexed. Throws on a bad map: a broken map is our bug and stops the lane. */
export function loadMaps({ standIns, specUrls } = {}) {
  const sText = standIns ?? readFileSync(new URL('stand-ins.json', DATA), 'utf8');
  const uText = specUrls ?? readFileSync(new URL('spec-urls.json', DATA), 'utf8');
  const s = typeof sText === 'string' ? JSON.parse(sText) : sText;
  const u = typeof uText === 'string' ? JSON.parse(uText) : uText;
  const problems = mapProblems(s, u);
  if (problems.length) throw new Error(`meta-backend: the data maps are not valid: ${problems.slice(0, 5).join('; ')}`);
  const table = mergeMaps(s, u);
  const sha = (t) => createHash('sha256').update(typeof t === 'string' ? t : JSON.stringify(t)).digest('hex');
  return {
    table,
    index: buildIndex(table),
    versions: { stand_ins: s.version, spec_urls: u.version, stand_ins_sha256: sha(sText), spec_urls_sha256: sha(uText) },
  };
}

let shipped = null;
/** The shipped maps (read once), or the maps a test hands over ({ standIns, specUrls }). */
export function loadMapsFrom(source) {
  if (source) return loadMaps(source);
  shipped ??= loadMaps();
  return shipped;
}
