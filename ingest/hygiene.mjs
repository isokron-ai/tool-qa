// Report hygiene: what an ingest report may say about untrusted input.
//
// Reports carry reason codes, paths, lines, digests and counts, never file
// contents or secret values. Every string taken from the input goes through a
// labeler first: printable ASCII only, secret and canary spans masked, length
// capped.

import { maskText, scanText } from './redact.mjs';

/** How many problems or hits a report lists (the total is always given). */
export const MAX_LISTED = 50;
export const PROBLEM_KEYS = ['reason', 'field', 'path', 'line', 'json_path', 'key', 'index', 'kind', 'how', 'expected', 'got', 'detail', 'fault'];

/** Printable ASCII only, secret and canary spans masked, length capped. */
export function makeLabeler(canaries) {
  return (value, max = 200) => {
    let s = String(value).replace(/[^\x20-\x7e]/g, '?');
    const hits = scanText(s, { canaries });
    if (hits.length > 0) s = maskText(s, hits);
    return s.length > max ? `${s.slice(0, max)}...` : s;
  };
}

export function textOrNull(v, label) {
  return typeof v === 'string' ? label(v) : null;
}

export function cleanProblem(p, label) {
  const out = {};
  for (const k of PROBLEM_KEYS) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = label(v);
  }
  return out;
}

export function cleanHit(h, label) {
  const out = { path: label(h.path), rule: h.rule, class: h.class };
  if (Number.isInteger(h.line)) out.line = h.line;
  if (typeof h.json_path === 'string') out.json_path = label(h.json_path);
  if (h.in_key) out.in_key = true;
  out.start = h.start;
  out.length = h.length;
  return out;
}
