// The last check before anything public leaves the pump.
//
// scanPublic(value) runs ingest/redact.mjs scanValue (secrets, emails,
// canaries) and the vendor-name scanner (live/vendor-names.mjs) over every
// string and every object key of a JSON value. Hits are {rule, path} only:
// never the text, never offsets into it. The path names an object key only
// when the key is a plain short identifier that itself passes both scans
// (every key the snapshot builder writes is); any other key shows as `[?]`,
// so a log line about a blocked upload (the pump's log is public) cannot
// carry what was found. Any hit means nothing is uploaded.

import { scanValue } from '../ingest/redact.mjs';
import { scanVendorNames } from './vendor-names.mjs';

/** Most hits kept; a value with more is blocked all the same. */
export const MAX_HITS = 50;
/** Deeper than this is a hit in itself (the snapshot nests four levels). */
export const MAX_DEPTH = 16;

function stringHits(text, opts) {
  const rules = scanValue(text, opts).map((h) => h.rule);
  if (scanVendorNames(text).length > 0) rules.push('vendor-name');
  return rules;
}

const SAFE_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * @param {unknown} value  a JSON value (the snapshot, an event list)
 * @param {{canaries?: string[]}} [opts]  extra literal canaries (redact.mjs R4)
 * @returns {{ok: boolean, hits: {rule: string, path: string}[]}}
 */
export function scanPublic(value, opts = {}) {
  const hits = [];
  const seen = new Set();
  const add = (rule, path) => {
    const key = `${rule}\u0000${path}`;
    if (seen.has(key) || hits.length >= MAX_HITS) return;
    seen.add(key);
    hits.push({ rule, path });
  };
  // Explicit stack, document order.
  const stack = [{ v: value, path: '$', depth: 0 }];
  while (stack.length > 0) {
    const { v, path, depth } = stack.pop();
    if (typeof v === 'string') {
      for (const rule of stringHits(v, opts)) add(rule, path);
      continue;
    }
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) add('not-finite', path);
      continue;
    }
    if (depth >= MAX_DEPTH) { add('too-deep', path); continue; }
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: `${path}[${i}]`, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(v);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, x] = entries[i];
      const keyRules = stringHits(k, opts);
      const shown = SAFE_KEY.test(k) && keyRules.length === 0 ? `.${k}` : '[?]';
      for (const rule of keyRules) add(rule, `${path}${shown}`);
      stack.push({ v: x, path: `${path}${shown}`, depth: depth + 1 });
    }
  }
  return { ok: hits.length === 0, hits };
}
