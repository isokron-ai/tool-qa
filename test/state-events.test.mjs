// The events table (schema v10): append-only, one row per fact, written in the
// fact's own transaction. See state/schema-v10.sql and docs/INTERFACES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openState } from '../state/db.mjs';

const T0 = Date.parse('2026-11-25T12:00:00Z');

test('recordEvent appends rows with growing ids; listEvents reads after an id', () => {
  const db = openState(':memory:');
  const a = db.recordEvent({ type: 'pump_run_started', data: { ticks: 0 } }, T0);
  const b = db.recordEvent({ type: 'dispatch_sent', occurredAt: T0 - 5000, lane: 'live-probe', n: 3, subject: null, data: { run_id: '1' } }, T0 + 1000);
  assert.ok(b > a);
  const all = db.listEvents();
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { id: a, type: 'pump_run_started', occurred_at: new Date(T0).toISOString(), recorded_at: new Date(T0).toISOString(), lane: null, n: 1, subject: null, data: { ticks: 0 } });
  assert.equal(all[1].occurred_at, new Date(T0 - 5000).toISOString());
  assert.equal(all[1].recorded_at, new Date(T0 + 1000).toISOString());
  assert.deepEqual(db.listEvents({ sinceId: a }).map((e) => e.id), [b]);
  assert.deepEqual(db.listEvents({ limit: 1 }).map((e) => e.id), [a]);
  assert.throws(() => db.recordEvent({ type: '' }, T0), TypeError);
  assert.throws(() => db.recordEvent({ type: 'x', n: -1 }, T0), TypeError);
});

test('an event id is never reused after the newest row is deleted', () => {
  const db = openState(':memory:');
  const a = db.recordEvent({ type: 'x' }, T0);
  db.raw.exec('DELETE FROM events');
  assert.ok(db.recordEvent({ type: 'x' }, T0) > a);
});
