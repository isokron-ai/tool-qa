// A scanner for AI vendor, model, client and SDK names.
//
// Nothing public names one: the live snapshot is scanned with this before it
// is uploaded (live/scan.mjs), and the builder leaves out a server name that
// matches (live/build.mjs). The words are kept split in this file, as
// publish/test/publish.test.mjs R-PUB-08 does, so the source itself never
// names one and a search of the repository for them stays clean. The list
// covers at least R-PUB-08's words.
//
// Matching is case-insensitive. Most words match anywhere (a repository named
// x-<word>-server is caught); the few that are ordinary English words match
// only as whole words. A false hit only leaves a name out, or blocks one
// upload, so the list errs wide.

const SPLIT = [
  // R-PUB-08's list
  [['cl', 'aude']], [['anthr', 'opic']], [['open', 'ai']], [['gp', 't']], [['gem', 'ini']], [['op', 'us']],
  [['son', 'net']], [['ha', 'iku']], [['cha', 'tg', 'pt']], [['gr', 'ok']],
  // more vendors, models and clients
  [['mis', 'tral']], [['lla', 'ma']], [['deep', 'seek']], [['qw', 'en']], [['co', 'pilot']],
  [['co', 'here'], true], [['perplex', 'ity'], true], [['bar', 'd'], true], [['co', 'dex'], true],
];

/** The words, joined (lower case). Exported for reuse by other scanners and tests. */
export const VENDOR_WORDS = Object.freeze(SPLIT.map(([p]) => p.join('')));
const WHOLE = new Set(SPLIT.filter(([, w]) => w === true).map(([p]) => p.join('')));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A fresh global, case-insensitive regex for the words. */
export function vendorNameRe() {
  const alts = VENDOR_WORDS.map((w) => (WHOLE.has(w) ? `\\b${escape(w)}\\b` : escape(w)));
  return new RegExp(alts.join('|'), 'gi');
}

/**
 * Vendor-name hits in a string: [{rule: 'vendor-name', start, end, length}].
 * A hit never carries the matched text.
 */
export function scanVendorNames(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const m of text.matchAll(vendorNameRe())) {
    hits.push({ rule: 'vendor-name', start: m.index, end: m.index + m[0].length, length: m[0].length });
  }
  return hits;
}

/** Whether a string names an AI vendor, model or client. */
export function hasVendorName(text) {
  return typeof text === 'string' && vendorNameRe().test(text);
}
