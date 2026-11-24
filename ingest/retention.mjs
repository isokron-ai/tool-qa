// What is kept forever and what is kept for a window (loop upgrade 20).
//
// Pure helpers, no I/O. The pump calls keepSet() on each item's outputs as it
// seals them: the keep-forever files go into their own small sealed file
// (`keep-<attempt>-<index>.tar.age`), the tool list into a content-addressed
// one (`catalog-<sha256>.tar.age`), so nothing downstream needs the age key to
// tell the two tiers apart. offsite/prune.mjs and offsite/holds.mjs read the
// windows. See docs/OPERATIONS.md, "Data retention".

import { createHash } from 'node:crypto';

/** Days a full raw bundle is kept (DESIGN-v3 section 9.6, owner decision of 24 Nov 2026). */
export const FULL_RAW_DAYS = 30;
/** Days a hold keeps full raw data, by what the hold is for (DESIGN-v3 section 9.6). */
export const HOLD_DAYS = Object.freeze({ dispute: 90, disclosure: 90, raw: 548 });

const ITEM_RE = /^(accepted|rejected|quarantine)\/([^/]+)\/(\d+)\/(.+)$/;
const ATTEMPT_RE = /^(accepted|rejected|quarantine)\/([^/]+)\/(ingest\.json)$/;
const KEEP_FILE_RE = /^(manifest\.json|ingest\.json|results\/[^/]+|observations\/[^/]+|raw\/subject\/repo\.json)$/;
const CONTROL_RE = /^(controls\/[^/]+|raw\/control-forgery\/[^/]+)$/;
export const CATALOG_PATH = 'raw/subject/tools.json';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** True when the manifest records a control whose observed result is not the expected one. */
export function controlFailed(manifestBytes) {
  try {
    const controls = JSON.parse(manifestBytes.toString('utf8'))?.controls;
    return Array.isArray(controls) && controls.some((c) => c?.observed !== c?.expected);
  } catch {
    return true; // a manifest that cannot be read is no proof the controls passed
  }
}

/**
 * The keep-forever part of one run of outputs (a Map of path to bytes).
 * @returns {{ keep: Map<string, Buffer>, catalogs: Map<string, Buffer>, dropped: string[] }}
 *   keep: the files for the keep-forever tar; catalogs: sha256 of tools.json bytes to those bytes;
 *   dropped: paths left out of the keep set (they stay in the full bundle for its window)
 */
export function keepSet(outputs) {
  const keep = new Map();
  const catalogs = new Map();
  const dropped = [];
  const failed = new Set();
  for (const [path, data] of outputs) {
    const m = ITEM_RE.exec(path);
    if (m && m[4] === 'manifest.json' && controlFailed(data)) failed.add(`${m[1]}/${m[2]}/${m[3]}`);
  }
  for (const [path, data] of outputs) {
    const m = ITEM_RE.exec(path);
    if (!m) {
      if (ATTEMPT_RE.test(path)) keep.set(path, data);
      else dropped.push(path);
      continue;
    }
    const [, outcome, attempt, index, rest] = m;
    if (KEEP_FILE_RE.test(rest)) keep.set(path, data);
    else if (rest === CATALOG_PATH) catalogs.set(sha256(data), data);
    else if (CONTROL_RE.test(rest) && failed.has(`${outcome}/${attempt}/${index}`)) keep.set(path, data);
    else dropped.push(path);
  }
  return { keep, catalogs, dropped };
}
