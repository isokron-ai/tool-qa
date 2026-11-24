// Shared pieces of the two metadata lanes (meta-github and meta-registry):
// input checks, subject ids, sanitising what we keep, small helpers.
//
// Both lanes read public metadata only. Nothing from a subject is installed,
// built or run. What comes back from an API is still untrusted data, so:
//
//   - every value we keep sits under a key we chose; upstream object keys are
//     never copied (a key such as "attempt_id" could pose as a result
//     identity, ingest/forgery.mjs);
//   - every string we keep is scanned with ingest's own redaction rules and
//     the identity-claim pattern; a string with a hit is replaced by a
//     placeholder that names the rule, never by the text;
//   - free text written by upstream authors (descriptions, licence texts,
//     deprecation messages) is kept only as a sha256 and a length.

import { createHash } from 'node:crypto';

import { scanText } from '../../ingest/redact.mjs';
import { TEXT_CLAIM_RE } from '../../ingest/forgery.mjs';

export const LANES = Object.freeze(['meta-github', 'meta-registry', 'release-diff']);
export const MAX_ITEMS = 100;
export const MAX_ITEMS_CHARS = 60_000;

/** A GitHub repository: owner (letters, digits, hyphens) and name (letters, digits, . _ -). */
export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_KEY_RE = /^[0-9a-f]{64}$/;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Check the dispatch inputs as a whole (docs/INTERFACES.md, "Worker dispatch").
 * A subject that is not a GitHub owner/name is kept (it reports a
 * policy_excluded skip); a subject the manifest cannot hold (whitespace,
 * control characters, over 512 characters) refuses the whole run, since the
 * pump never sends one.
 * @returns {{shardId: string, attemptId: string, items: {index: number, subject: string, run_key: string, fence: number, repo: string|null}[]}}
 */
export function parseInputs({ shardId, attemptId, items }, { maxItems = MAX_ITEMS } = {}) {
  if (typeof shardId !== 'string' || !ID_RE.test(shardId)) throw new InputError('shard_id is malformed');
  if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) throw new InputError('attempt_id is malformed');
  if (typeof items !== 'string' || items.length > MAX_ITEMS_CHARS) throw new InputError(`items must be at most ${MAX_ITEMS_CHARS} characters`);
  let list;
  try {
    list = JSON.parse(items);
  } catch {
    throw new InputError('items is not JSON');
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > maxItems) throw new InputError(`items must be a list of 1 to ${maxItems} entries`);
  const keys = new Set();
  const out = list.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new InputError(`items[${i}] is not an object`);
    const extra = Object.keys(x).filter((k) => !['subject', 'run_key', 'fence'].includes(k));
    if (extra.length > 0) throw new InputError(`items[${i}] has keys other than subject, run_key and fence`);
    if (typeof x.subject !== 'string' || x.subject.length < 1 || x.subject.length > 512 || /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(x.subject)) {
      throw new InputError(`items[${i}].subject must be 1 to 512 characters with no space or control character`);
    }
    if (typeof x.run_key !== 'string' || !RUN_KEY_RE.test(x.run_key)) throw new InputError(`items[${i}].run_key must be 64 lower-case hex characters`);
    if (!Number.isSafeInteger(x.fence) || x.fence < 1) throw new InputError(`items[${i}].fence must be a positive whole number`);
    if (keys.has(x.run_key)) throw new InputError(`items[${i}].run_key repeats an earlier item`);
    keys.add(x.run_key);
    return { index: i, subject: x.subject, run_key: x.run_key, fence: x.fence, repo: SUBJECT_RE.test(x.subject) ? x.subject : null };
  });
  return { shardId, attemptId, items: out };
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted object keys, for digests that must not depend on key order. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Free text by an upstream author: kept as a digest and a length only. */
export function textDigest(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return { sha256: sha256Hex(text), length: text.length };
}

const IDENTITY_KEY_RE = /^(?:attempt[_-\s]?id|run[_-\s]?key|fence|fencing[_-\s]?(?:no|number)|fence[_-\s]?token)$/i;

/** Placeholder for a string we may not keep. */
export function removed(rule) {
  return `[removed: ${rule}]`;
}

/**
 * Make a value safe to keep: every string with a secret, email or canary hit
 * (ingest/redact.mjs) or an identity claim (ingest/forgery.mjs TEXT_CLAIM_RE)
 * is replaced by a placeholder. Throws if an object key looks like a result
 * identity: keys are always ours, so that is a bug, not data.
 */
export function sanitize(value, path = '$') {
  if (typeof value === 'string') {
    const hits = scanText(value);
    if (hits.length > 0) return removed(hits[0].rule);
    TEXT_CLAIM_RE.lastIndex = 0;
    if (TEXT_CLAIM_RE.test(value)) {
      TEXT_CLAIM_RE.lastIndex = 0;
      return removed('identity-like text');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => sanitize(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (IDENTITY_KEY_RE.test(k) || k === 'schema_version') throw new Error(`sanitize: key ${path}.${k} looks like a result identity`);
      out[k] = sanitize(v, `${path}.${k}`);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/** A short string, or null: for upstream values we keep verbatim (tags, versions, topics). */
export function str(v, max = 200) {
  if (typeof v !== 'string' || v.length === 0) return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return s.length > max ? s.slice(0, max) : s;
}

/** A whole number >= 0, or null. */
export function int(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** An RFC 3339 time, or null. */
export function time(v) {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : null;
}

export const bool = (v) => (typeof v === 'boolean' ? v : null);

/** Median of numbers, or null. */
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Days between two times, one decimal. */
export function daysBetween(a, b) {
  const d = (Date.parse(b) - Date.parse(a)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

/** github.com/<owner>/<repo> from a repository URL in any of the usual forms, lower case, or null. */
export function githubRepoOf(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** An observation record (worker-kit README): a value, or null with why. */
export function record(field, value, why) {
  if (value === null || value === undefined) return { field, value: null, why: why ?? 'not available' };
  return { field, value };
}

/**
 * The skip for a stage that did not run: an answer over the size cap is not
 * retried (policy_excluded); a rate limit or an outage is (R-META-01).
 */
export function skipFor(stage, code) {
  if (code === 'too_large') return { stage, reason: 'policy_excluded' };
  return { stage, reason: code === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable', retryable: true };
}
