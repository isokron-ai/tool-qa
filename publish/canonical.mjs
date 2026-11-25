// Canonical JSON and hashes for published records.
//
// A record's bytes must be the same on every run and on every machine, so the
// same record is never "new" twice (idempotent re-runs) and a consumer can
// recompute every digest. Keys are sorted at every level; arrays keep their
// order; numbers and strings are JSON.stringify's.

import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical: a number that is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Identity of one accepted result: the attempt and its run key (a run key is one item's). The
 * item's position in the attempt is not part of it and not published: a gap in positions would
 * show that a result was held.
 */
export const recordId = ({ attempt_id: a, run_key: k }) => sha256(`${a}\n${k}`);

/** sha256 of the canonical record without its own `content_sha256`. */
export function contentDigest(record) {
  const { content_sha256: _drop, ...rest } = record;
  return sha256(canonical(rest));
}
