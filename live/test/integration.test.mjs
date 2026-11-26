// publishLive with the real builder (live/build.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { publishLive } from '../publish.mjs';

const ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN', LIVE_R2_SECRET_ACCESS_KEY: 'syn-secret-xyz', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };
const workflows = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows ?? {};

test('integration: publishLive with the real builder uploads snapshot, hour files and pointer, and the scan passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-int-'));
  try {
    const db = openState(join(dir, 'state.sqlite'));
    const t = Date.parse('2026-11-25T14:02:00Z');
    const lane = Object.keys(workflows)[0] ?? 'live-probe';
    db.recordEvent({ type: 'dispatch_sent', occurredAt: t - 60_000, lane, n: 2, data: {} }, t - 60_000);
    db.recordEvent({ type: 'dispatch_sent', occurredAt: t - 3_700_000, lane, n: 1, data: {} }, t - 3_700_000);
    const puts = [];
    const lines = [];
    const put = async (key, body, o) => { puts.push({ key, body, cc: o.cacheControl }); return { status: 200 }; };
    const r = await publishLive({ db, put, env: ENV, now: () => t, config: { workflows, switches: {}, history: [], lane_notes: { 'live-probe': 're_sweep' } }, deadlineMs: 5000, log: (l) => lines.push(l) });
    assert.equal(r.ok, true, lines.join('\n'));
    // The snapshot's files end with the pointer; the daily history (first publish of the day) follows it.
    const allKeys = puts.map((p) => p.key);
    const keys = allKeys.slice(0, allKeys.indexOf('v1/latest.json') + 1);
    assert.match(keys[0], /^v1\/snap\/[0-9a-f]{16}\.json$/);
    assert.equal(keys.at(-1), 'v1/latest.json');
    assert.ok(allKeys.slice(keys.length).every((k) => k.startsWith('v1/history/')), allKeys.join(' '));
    assert.ok(keys.includes('v1/events/2026-11-25/14.ndjson'));
    const snap = JSON.parse(puts[0].body);
    assert.equal(snap.schema, 'isokron-loop-live/1');
    assert.ok(Buffer.byteLength(puts[0].body) < 20 * 1024);
    const ptr = JSON.parse(puts[keys.length - 1].body);
    assert.equal(ptr.snap, keys[0]);
    assert.equal(ptr.seq, snap.seq);
    // inside the first 5 minutes of the hour the previous hour is written too, immutable
    const prev = puts.find((p) => p.key === 'v1/events/2026-11-25/13.ndjson');
    assert.ok(prev, 'the previous hour is written 2 minutes into a new hour');
    assert.equal(prev.cc, 'public, max-age=31536000, immutable');
    assert.ok(keys.indexOf('v1/events/2026-11-25/13.ndjson') < keys.indexOf('v1/latest.json'), 'before the pointer');
    assert.equal(prev.body.trim().split('\n').filter(Boolean).length, 1, 'the one event of the previous hour');
    assert.equal(JSON.parse(prev.body.trim()).type, 'batch_sent');
    assert.ok(JSON.parse(puts.find((p) => p.key === 'v1/events/2026-11-25/14.ndjson').body.trim()).published_at);
    // twenty minutes into the hour there is no previous-hour file
    puts.length = 0;
    const later = Date.parse('2026-11-25T14:20:00Z');
    const r2 = await publishLive({ db, put, env: ENV, now: () => later, config: { workflows, switches: {}, history: [] }, deadlineMs: 5000, log: (l) => lines.push(l) });
    assert.equal(r2.ok, true, lines.join('\n'));
    assert.ok(!puts.some((p) => p.key === 'v1/events/2026-11-25/13.ndjson'));
    assert.equal(db.getKv('live.last_upload').ok, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
