// live/classes.mjs: every rejection reason the source can record has an
// explicit class; unknown codes are worker_output; quarantines are no class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CLASSES, classOf, DEFAULT_CLASS, isQuarantine, QUARANTINE_REASONS, REASON_CLASSES } from '../classes.mjs';
import { NOT_COUNTED_REASONS } from '../../state/db.mjs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** Every rejection reason code written in the source, by the patterns the source uses. */
export function sourceReasons() {
  const codes = new Set();
  const add = (re, text) => { for (const m of text.matchAll(re)) codes.add(m[1]); };
  const ingest = read('ingest/ingest.mjs');
  const analyze = read('ingest/analyze.mjs');
  const forgery = read('ingest/forgery.mjs');
  const registry = read('ingest/registry.mjs');
  const ledger = read('ingest/ledger.mjs');
  const db = read('state/db.mjs');
  for (const text of [ingest, analyze]) {
    add(/\breject\('([a-z_]+)'/g, text);
    add(/\bstop\('[a-z_]+', '([a-z_]+)'/g, text);
    add(/\bdone\('[a-z_]+', '([a-z_]+)'/g, text);
    add(/\bfinish\('[a-z_]+', '([a-z_]+)'/g, text);
    add(/\bfail\('([a-z_]+)'/g, text);
    add(/: '([a-z_]+)'(?=[;)\s])/g, text.split('\n').filter((l) => /finalReason|ledger_refused/.test(l)).join('\n'));
  }
  // analyze.mjs: the forgery ranking.
  const order = /const PROBLEM_ORDER = \[([^\]]+)\]/s.exec(analyze);
  assert.ok(order, 'PROBLEM_ORDER found in ingest/analyze.mjs');
  add(/'([a-z_]+)'/g, order[1]);
  for (const text of [forgery, registry, analyze, ingest]) add(/\breason: '([a-z_]+)'/g, text);
  add(/\bcmp\('([a-z_]+)'/g, forgery);
  add(/'([a-z_]+)'/g, (/reason = (!a \? [^;]+);/.exec(ledger) ?? [, ''])[1]);
  // state/db.mjs: checkFence and recordResult.
  add(/reason: '([a-z_]+)'/g, (/checkFence\(subject[\s\S]*?\n {2}\}/.exec(db) ?? [''])[0]);
  add(/\bwhy = '([a-z_]+)'/g, db);
  add(/'([a-z_]+)'/g, (/why = reason \? String\(reason\) : '([a-z_]+)'/.exec(db) ?? ['', ''])[0]);
  for (const r of NOT_COUNTED_REASONS) codes.add(r);
  return codes;
}

test('every rejection reason code in the source is mapped to a class explicitly', () => {
  const codes = sourceReasons();
  // The scan must find the vocabulary, not an empty set that passes trivially.
  for (const c of ['stale_fence', 'lease_expired', 'digest_mismatch', 'manifest_invalid', 'no_artifact', 'observation_format',
    'ingest_timeout', 'artifact_expired', 'run_not_found', 'retry_later', 'retry_throttled', 'run_sha_mismatch', 'ledger_refused',
    'rejected_by_ingest', 'unknown_attempt', 'duplicate_result', 'forgery_control_unverified', 'secret_scan']) {
    assert.ok(codes.has(c), `the source scan finds ${c}`);
  }
  assert.ok(codes.size >= 55, `found ${codes.size} codes`);
  const missing = [...codes].filter((c) => !QUARANTINE_REASONS.includes(c) && !Object.hasOwn(REASON_CLASSES, c));
  assert.deepEqual(missing, [], 'every code has an explicit class');
});

test('the plan\'s lease and infra codes are in those classes', () => {
  for (const c of ['stale_fence', 'lease_expired', 'no_lease', 'holder_mismatch', 'lease_released', 'unknown_fence', 'fence_mismatch']) assert.equal(classOf(c), 'lease', c);
  for (const c of ['ingest_timeout', 'ingest_error', 'artifact_expired', 'run_not_found', 'retry_later', 'retry_throttled']) assert.equal(classOf(c), 'infra', c);
  for (const c of ['digest_mismatch', 'forgery_control_injected', 'manifest_invalid', 'no_manifest', 'unlisted_file']) assert.equal(classOf(c), 'integrity', c);
  for (const c of ['bad_bundle', 'no_artifact', 'observation_format', 'undeclared_field']) assert.equal(classOf(c), 'worker_output', c);
});

test('unknown, empty and odd codes fall into worker_output; every class is one of four', () => {
  assert.equal(DEFAULT_CLASS, 'worker_output');
  for (const c of ['brand_new_reason', '', null, undefined, 42, '__proto__', 'constructor', 'toString']) assert.equal(classOf(c), 'worker_output', String(c));
  assert.deepEqual([...CLASSES], ['lease', 'integrity', 'worker_output', 'infra']);
  for (const [code, cls] of Object.entries(REASON_CLASSES)) assert.ok(CLASSES.includes(cls), `${code} -> ${cls}`);
  assert.ok(Object.isFrozen(REASON_CLASSES));
});

test('a quarantine is no class: secret_scan is not in the table, and isQuarantine sees it by reason or outcome', () => {
  for (const r of QUARANTINE_REASONS) assert.ok(!Object.hasOwn(REASON_CLASSES, r), `${r} has no class`);
  assert.equal(isQuarantine({ reason: 'secret_scan' }), true);
  assert.equal(isQuarantine({ reason: 'something_new', outcome: 'quarantined' }), true);
  assert.equal(isQuarantine({ reason: 'digest_mismatch', outcome: 'rejected' }), false);
  assert.equal(isQuarantine({}), false);
});
