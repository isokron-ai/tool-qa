// publishLive with the real builder (live/build.mjs). Skipped while that file
// is absent; runs once it is merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { openState } from '../../state/db.mjs';
import { publishLive } from '../publish.mjs';

const have = existsSync(new URL('../build.mjs', import.meta.url));
const ENV = { LANE_LIVE_SNAPSHOT_ENABLED: 'true', LIVE_R2_ACCESS_KEY_ID: 'AKIA_SYN', LIVE_R2_SECRET_ACCESS_KEY: 'syn-secret-xyz', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };
const workflows = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows ?? {};

test('integration: publishLive with the real builder uploads snapshot, hour file and pointer, and the scan passes', { skip: have ? false : 'live/build.mjs is not present yet' }, async () => {
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
    const keys = puts.map((p) => p.key);
    assert.match(keys[0], /^v1\/snap\/[0-9a-f]{16}\.json$/);
    assert.equal(keys.at(-1), 'v1/latest.json');
    assert.ok(keys.includes('v1/events/2026-11-25/14.ndjson'));
    const snap = JSON.parse(puts[0].body);
    assert.equal(snap.schema, 'isokron-loop-live/1');
    assert.ok(Buffer.byteLength(puts[0].body) < 20 * 1024);
    const ptr = JSON.parse(puts.at(-1).body);
    assert.equal(ptr.snap, keys[0]);
    assert.equal(ptr.seq, snap.seq);
    // inside the first 5 minutes of the hour the previous hour is written too, immutable
    const prev = puts.find((p) => p.key === 'v1/events/2026-11-25/13.ndjson');
    if (prev) assert.equal(prev.cc, 'public, max-age=31536000, immutable');
    assert.equal(db.getKv('live.last_upload').ok, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
