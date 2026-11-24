import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeAttempt, openLedger, LedgerError } from '../ledger.mjs';

const ROW = {
  attempt_id: 'att-1', run_key: 'a'.repeat(64), fence: 7, repo: 'isokron-ai/mcp-check',
  run_id: 4242, workflow_file: '.github/workflows/qa-worker.yml', workflow_sha: '1'.repeat(40),
};

const SHARED = {
  attempt_id: 'att-1', repo: 'isokron-ai/mcp-check', run_id: 4242,
  workflow_file: '.github/workflows/qa-worker.yml', workflow_sha: '1'.repeat(40),
};

test('normalizeAttempt accepts the documented names and common aliases', () => {
  assert.deepEqual(normalizeAttempt(ROW), {
    ...SHARED, canaries: [], items: [{ index: 0, run_key: 'a'.repeat(64), fence: 7, current_fence: null, outcome: null, retries: 0, throttled: 0, throttled_since: null }],
  });
  const aliased = normalizeAttempt({
    attempt_id: 'att-1', run_key: 'a'.repeat(64), fencing_no: '7', worker_repo: 'isokron-ai/mcp-check',
    workflow_run_id: '4242', workflow: '.github/workflows/qa-worker.yml', current_fence: 9, canaries: '["ISOKRON_CANARY_abcdefgh"]',
  });
  assert.equal(aliased.items[0].fence, 7);
  assert.equal(aliased.run_id, 4242);
  assert.equal(aliased.repo, 'isokron-ai/mcp-check');
  assert.equal(aliased.workflow_file, '.github/workflows/qa-worker.yml');
  assert.equal(aliased.workflow_sha, null);
  assert.equal(aliased.items[0].current_fence, 9);
  assert.deepEqual(aliased.canaries, ['ISOKRON_CANARY_abcdefgh']);
  assert.equal(normalizeAttempt(null), null);
});

test('normalizeAttempt reads a multi-item row: items in dispatch order, each with its index', () => {
  const k = (c) => c.repeat(64);
  const n = normalizeAttempt({
    ...SHARED,
    items: [
      { item_index: 2, run_key: k('c'), fence: 12, current_fence: 12 },
      { index: 0, run_key: k('a'), fencing_no: '10', outcome: 'accepted' },
      { item_index: '1', run_key: k('b'), fence: 11, current_fence: 13 },
    ],
  });
  assert.deepEqual(n.items, [
    { index: 0, run_key: k('a'), fence: 10, current_fence: null, outcome: 'accepted', retries: 0, throttled: 0, throttled_since: null },
    { index: 1, run_key: k('b'), fence: 11, current_fence: 13, outcome: null, retries: 0, throttled: 0, throttled_since: null },
    { index: 2, run_key: k('c'), fence: 12, current_fence: 12, outcome: null, retries: 0, throttled: 0, throttled_since: null },
  ]);
  // Without an index, the position in the list is the index.
  const plainList = normalizeAttempt({ ...SHARED, items: [{ run_key: k('b'), fence: 3 }, { run_key: k('a'), fence: 4 }] });
  assert.deepEqual(plainList.items.map((i) => [i.index, i.run_key]), [[0, k('b')], [1, k('a')]]);
});

test('normalizeAttempt names the bad field, not its value', () => {
  for (const [k, v] of [['run_key', 'zz'], ['fence', 0], ['repo', 'nope'], ['workflow_file', 'x.yml'], ['attempt_id', '../x']]) {
    assert.throws(() => normalizeAttempt({ ...ROW, [k]: v }), (e) => e instanceof LedgerError && e.message.includes(k));
  }
  const it = (index, c, fence = 5) => ({ index, run_key: c.repeat(64), fence });
  for (const [items, field] of [
    [[], 'items'],
    ['x', 'items'],
    [[it(0, 'a'), it(2, 'b')], 'index'],
    [[it(0, 'a'), it(0, 'b')], 'index'],
    [[it(-1, 'a')], 'index'],
    [[it(0, 'a'), it(1, 'a')], 'run_key'],
    [[it(0, 'z')], 'run_key'],
    [[it(0, 'a', 0)], 'fence'],
  ]) {
    assert.throws(() => normalizeAttempt({ ...SHARED, items }), (e) => e instanceof LedgerError && e.message.includes(field), JSON.stringify(items));
  }
});

test('state ledger: uses getAttempt/recordResult on the db, or module functions', async () => {
  const recorded = [];
  const asMethods = {
    openState: () => ({
      getAttempt: (id) => (id === 'att-1' ? { ...ROW } : undefined),
      recordResult: (r) => { recorded.push(r); return { accepted: r.accepted, reason: r.reason }; },
      close: () => recorded.push('closed'),
    }),
  };
  const l = await openLedger({ statePath: 'x.sqlite', importState: async () => asMethods });
  assert.equal(l.kind, 'state');
  assert.equal(l.getAttempt('att-1').items[0].fence, 7);
  assert.equal(l.getAttempt('att-2'), null);
  const args = { run_key: ROW.run_key, attempt_id: 'att-1', fence: 7, outcome: 'accepted', accepted: true, reason: null };
  assert.deepEqual(l.recordResult(args), { accepted: true, reason: null });
  assert.deepEqual(recorded[0], args);
  l.close();
  assert.equal(recorded[1], 'closed');

  const asFunctions = {
    openState: () => ({ close() {} }),
    getAttempt: (db, id) => ({ ...ROW, attempt_id: id }),
    recordResult: () => ({ accepted: false, reason: 'stale_fence' }),
  };
  const f = await openLedger({ statePath: 'x.sqlite', importState: async () => asFunctions });
  assert.equal(f.getAttempt('att-1').attempt_id, 'att-1');
  assert.deepEqual(f.recordResult(args), { accepted: false, reason: 'stale_fence' });
});

test('state ledger without the attempts interface is a clear error', async () => {
  await assert.rejects(
    openLedger({ statePath: 'x.sqlite', importState: async () => ({ openState: () => ({ close() {} }) }) }),
    /state\/db\.mjs has no getAttempt/,
  );
  await assert.rejects(
    openLedger({ statePath: 'x.sqlite', importState: async () => ({ openState: () => ({ getAttempt() {}, close() {} }) }) }),
    /no recordResult/,
  );
  await assert.rejects(openLedger({}), /--state or --ledger-json/);
});

test('JSON ledger reads attempts and appends results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    const p = join(dir, 'ledger.json');
    writeFileSync(p, JSON.stringify({ attempts: [{ ...ROW, current_fence: 8 }, { ...ROW, attempt_id: 'att-2' }] }));
    const l = await openLedger({ ledgerJson: p, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(l.kind, 'json');
    assert.equal(l.getAttempt('att-1').items[0].current_fence, 8);
    // The newer lease wins: the JSON ledger mimics the state store's fence check.
    assert.deepEqual(
      l.recordResult({ run_key: ROW.run_key, attempt_id: 'att-1', fence: 7, outcome: 'accepted', accepted: true, reason: null }),
      { accepted: false, reason: 'stale_fence' },
    );
    assert.deepEqual(
      l.recordResult({ run_key: ROW.run_key, attempt_id: 'att-2', fence: 7, outcome: 'accepted', accepted: true, reason: null }),
      { accepted: true, reason: null },
    );
    // Once a result is recorded, the item carries its outcome (so a second ingest is a no-op).
    assert.equal(l.getAttempt('att-1').items[0].outcome, 'rejected');
    assert.equal(l.getAttempt('att-2').items[0].outcome, 'accepted');
    l.close();
    const saved = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(saved.results.length, 2);
    assert.deepEqual(saved.results[0], {
      run_key: ROW.run_key, attempt_id: 'att-1', fence: 7, outcome: 'rejected',
      accepted: false, reason: 'stale_fence', recorded_at: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON ledger: each item of a multi-item attempt has its own fence check and outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    const p = join(dir, 'ledger.json');
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    writeFileSync(p, JSON.stringify({ attempts: [{ ...SHARED, items: [{ run_key: a, fence: 7 }, { run_key: b, fence: 8, current_fence: 9 }] }] }));
    const l = await openLedger({ ledgerJson: p, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.deepEqual(l.recordResult({ run_key: a, attempt_id: 'att-1', fence: 7, outcome: 'accepted', accepted: true }), { accepted: true, reason: null });
    assert.deepEqual(l.getAttempt('att-1').items.map((i) => i.outcome), ['accepted', null], 'only the recorded item is decided');
    assert.deepEqual(l.recordResult({ run_key: b, attempt_id: 'att-1', fence: 8, outcome: 'accepted', accepted: true }), { accepted: false, reason: 'stale_fence' });
    assert.deepEqual(
      l.recordResult({ run_key: 'c'.repeat(64), attempt_id: 'att-1', fence: 8, outcome: 'accepted', accepted: true }),
      { accepted: false, reason: 'unknown_run_key' },
    );
    assert.deepEqual(l.getAttempt('att-1').items.map((i) => i.outcome), ['accepted', 'rejected']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
