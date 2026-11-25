// Example snapshots from realistic fake states, for the site (stream E copies
// them as fixtures). They must stay exactly what the builder makes: this test
// rebuilds each one and compares. To refresh them after a deliberate change:
//   LIVE_WRITE_FIXTURES=1 node --test live/test/fixtures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { buildLiveSnapshot } from '../build.mjs';
import { realisticState } from './seed.mjs';

const NOW = Date.parse('2026-11-25T21:40:00.000Z');

export const SCENARIOS = {
  // Scanning on three lanes at LOOP_SLOTS=2, two batches out.
  live: () => {
    const s = realisticState({ now: NOW });
    // The live-probe re-sweep note, as the config picks it while one runs.
    s.cfg.lane_notes = { 'live-probe': 're_sweep' };
    return { ...s, retry: null };
  },
  // LOOP_SLOTS=0 for the last six hours: the pump runs housekeeping ticks, nothing is out.
  idle: () => {
    const s = realisticState({ now: NOW, slots: '0', openBatches: false, batchesUntil: NOW - 6 * 3_600_000, tickAt: Date.parse('2026-11-25T21:31:41.000Z') });
    return { ...s, retry: null };
  },
  // GitHub answers 502 on the state push: attempt 3 of 6 is open.
  retrying: () => {
    const retries = [
      { at: NOW - 95_000, label: 'state_asset', status: 502, attempts: 1 },
      { at: NOW - 40_000, label: 'state_asset', status: 502, attempts: 2 },
    ];
    const s = realisticState({ now: NOW, retries });
    return { ...s, retry: { call: 'state_asset', status: 502, attempt: 3, of: 6, next_at: NOW + 7_400, since: NOW - 95_000 } };
  },
};

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`fixture snapshot-${name}.json is what the builder makes from its fake state`, () => {
    const { db, now, cfg, retry } = make();
    const { snapshot, problems } = buildLiveSnapshot(db, { now, config: cfg, retry, version: '0f1e2d3' });
    assert.deepEqual(problems, []);
    assert.equal(snapshot.mode, name);
    if (name === 'idle') assert.equal(snapshot.mode_reason, 'scanning paused by us');
    if (name === 'retrying') assert.equal(snapshot.retry.attempt, 3);
    const url = new URL(`fixtures/snapshot-${name}.json`, import.meta.url);
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (process.env.LIVE_WRITE_FIXTURES === '1') writeFileSync(url, text);
    assert.equal(readFileSync(url, 'utf8'), text);
  });
}
