// Version pins (R-PIN-01), ingest's half: a result's recorded tool and probe
// versions must be what ran, or the result is refused. The pump's half and the
// pure checks: pump/test/pins.test.mjs. In the pump: ingest/test/collect.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openState, NOT_COUNTED_REASONS, PIN_PAUSE_MS } from '../../state/db.mjs';
import { ingestAttempt } from '../ingest.mjs';
import { normalizeAttempt } from '../ledger.mjs';
import { parseRegistry } from '../registry.mjs';
import {
  defaultFiles, expectedRow, fakeDecrypt, fakeEncrypt, fakeGithub, fakeLedger, makeBundle, REGISTRY_TEXT, RUN_ID, RUN_KEY, WORKER_REPO,
} from '../testkit.mjs';

const registry = { ...parseRegistry(REGISTRY_TEXT), source: 'test' };
const INPUT = { repo: WORKER_REPO, runId: RUN_ID, attemptId: 'att-1' };
const NOW = () => new Date('2026-01-01T01:00:00Z');

const PIN = '116b0ca';
const FULL = PIN.padEnd(40, '7');
const HEAD = 'd4a373a'.padEnd(40, '0');
const PINS = { tool: { 'mcp-check': PIN }, probe: { 'mcp-surface-corpus': '4c16b58' } };
const CORPUS = { name: 'isokron-ai/mcp-surface-corpus', version: '4c16b58'.padEnd(40, '1') };

/** One item of lane `live-probe` whose run_key is filed under PINS, judged with the given pin_check mode. */
async function judge({ tools, mode = 'enforce', pins = PINS, meta = {}, files, lane = 'live-probe', modes } = {}) {
  const bundle = makeBundle({ meta: { tools, ...meta }, ...(files ? { files } : {}) });
  const ledger = fakeLedger([expectedRow({ workflow: lane, pins })]);
  const r = await ingestAttempt(INPUT, {
    ledger, github: fakeGithub({ blob: fakeEncrypt(bundle.tar) }), decrypt: fakeDecrypt, registry, now: NOW,
    pinModes: modes ?? { [lane]: mode },
  });
  return { r, ledger, report: r.report };
}

test('R-PIN-01: pin match accepted: a bundle that reports the full pinned commit, and each other pin, is accepted', async () => {
  for (const mode of ['enforce', 'label']) {
    const { r, ledger, report } = await judge({ mode, tools: [{ name: '@isokron/mcp-check', version: FULL }, CORPUS] });
    assert.equal(r.outcome, 'accepted', mode);
    assert.equal(ledger.records[0].accepted, true);
    assert.deepEqual(report.pins.verified.map((e) => [e.kind, e.name, e.pin, e.got]), [['tool', 'mcp-check', PIN, FULL], ['probe', 'mcp-surface-corpus', '4c16b58', CORPUS.version]]);
    assert.deepEqual(report.pins.unverified, []);
    assert.equal(report.pins.mode, mode);
  }
});

test('R-PIN-01: mismatch refused with a reason and the tool fault side, on every lane: the worker ran another commit than the run_key is filed under', async () => {
  for (const mode of ['enforce']) { // on a label lane the worker repository's own pin is the R-PIN-02 exception
    const { r, ledger, report } = await judge({ mode, tools: [{ name: 'mcp-check', version: HEAD }, CORPUS] });
    assert.equal(r.outcome, 'rejected', mode);
    assert.equal(r.reason, 'pin_mismatch');
    assert.deepEqual(ledger.records.map((x) => [x.accepted, x.reason]), [[false, 'pin_mismatch']], 'recorded as refused');
    assert.equal(report.pins.fault, 'tool');
    assert.deepEqual(report.problems.map((p) => [p.reason, p.fault, p.kind, p.key, p.expected, p.got]), [['pin_mismatch', 'tool', 'tool', 'mcp-check', PIN, HEAD]]);
    assert.ok(r.outputs.has('rejected/att-1/0/ingest.json'));
    assert.equal([...r.outputs.keys()].some((k) => k.startsWith('accepted/')), false, 'nothing of it is kept as a result');
  }
  // A probe pinned at one commit and run at another is refused the same way.
  const probe = await judge({ mode: 'label', tools: [{ name: 'mcp-check', version: '1.3.1' }, { ...CORPUS, version: HEAD }] });
  assert.equal(probe.r.reason, 'pin_mismatch');
  assert.deepEqual(probe.report.problems.map((p) => [p.kind, p.key]), [['probe', 'mcp-surface-corpus']]);
  // A version pin (tool-qa's own lanes) is refused when another version ran.
  const meta = await judge({ lane: 'meta-github', pins: { tool: { 'meta-github': '1.2.0' }, probe: {} }, tools: [{ name: 'tool-qa-meta-github', version: '1.3.0' }] });
  assert.equal(meta.r.reason, 'pin_mismatch');
});

test('R-PIN-01: missing SHA during rollout handled per the switch: a label lane accepts it with the pin listed unverified, an enforce lane refuses it (tool side)', async () => {
  // What scan-static and live-probe report today: the package version, not the commit.
  const today = [{ name: '@isokron/mcp-check', version: '1.3.1' }, CORPUS];
  const label = await judge({ mode: 'label', tools: today });
  assert.equal(label.r.outcome, 'accepted');
  assert.deepEqual(label.report.pins.unverified, [{ kind: 'tool', name: 'mcp-check', pin: PIN, got: '1.3.1' }]);
  assert.equal(label.report.pins.verified.length, 1, 'the corpus commit is still proven');
  const enforce = await judge({ mode: 'enforce', tools: today });
  assert.equal(enforce.r.outcome, 'rejected');
  assert.equal(enforce.r.reason, 'pin_unverified');
  assert.deepEqual(enforce.report.problems.map((p) => [p.reason, p.fault, p.key, p.got]), [['pin_unverified', 'tool', 'mcp-check', '1.3.1']]);
  // Not reported at all.
  const none = await judge({ mode: 'enforce', tools: [CORPUS] });
  assert.equal(none.r.reason, 'pin_unverified');
  assert.equal(none.report.problems[0].got, 'not reported');
  assert.equal((await judge({ mode: 'label', tools: [CORPUS] })).r.outcome, 'accepted');
});

test('R-PIN-01: a lane the config does not name is held to enforce; a run_key with no recorded label is not checked', async () => {
  const unknown = await judge({ lane: 'gone-lane', modes: {}, tools: [{ name: 'mcp-check', version: '1.3.1' }, CORPUS] });
  assert.equal(unknown.r.reason, 'pin_unverified');
  const noLabel = await judge({ pins: null, tools: [{ name: 'mcp-check', version: HEAD }] });
  assert.equal(noLabel.r.outcome, 'accepted');
  assert.deepEqual(noLabel.report.pins, { mode: 'enforce', checked: false, why: 'no_label' });
});

test('R-PIN-01: the pin check never overrides ingest\'s other judgments: a forgery, a quarantine and a retry still decide first', async () => {
  const wrong = [{ name: 'mcp-check', version: HEAD }];
  // Forgery: the wrong fence wins.
  const bundle = makeBundle({ identity: { fence: 6 }, meta: { tools: wrong } });
  const forged = await ingestAttempt(INPUT, {
    ledger: fakeLedger([expectedRow({ workflow: 'live-probe', pins: PINS })]), github: fakeGithub({ blob: fakeEncrypt(bundle.tar) }), decrypt: fakeDecrypt, registry, now: NOW, pinModes: { 'live-probe': 'enforce' },
  });
  assert.equal(forged.reason, 'fence_mismatch');
  // Quarantine: a secret in a result file.
  const files = { ...defaultFiles(), 'results/report.json': JSON.stringify({ token: `ghp_${'A'.repeat(36)}` }) };
  const q = await judge({ tools: wrong, files });
  assert.equal(q.r.outcome, 'quarantined');
  // A bundle of retryable skips from another commit is refused for its pins, not sent back to retry.
  const skips = [{ stage: 'start', reason: 'rate_limited', retryable: true }];
  const retry = await judge({ tools: wrong, meta: { skips } });
  assert.equal(retry.r.reason, 'pin_mismatch');
  const retryOk = await judge({ tools: [{ name: 'mcp-check', version: FULL }, CORPUS], meta: { skips } });
  assert.equal(retryOk.r.reason, 'retry_later', 'a proven bundle goes on to the retry rules unchanged');
});

test('R-PIN-01: the ledger hands ingest the run_key\'s pins; a hand-made ledger without them is not checked', () => {
  const row = normalizeAttempt(expectedRow({ pins: { tool_versions: { a: '1' }, probe_versions: { b: '2' } } }));
  assert.deepEqual(row.items[0].pins, { tool: { a: '1' }, probe: { b: '2' } });
  assert.equal(normalizeAttempt(expectedRow({ pins: null })).items[0].pins, null);
  assert.equal('pins' in normalizeAttempt(expectedRow()).items[0], false);
});

// ---- the state store ----

function dispatchOne(db, { now = Date.parse('2026-11-25T10:00:00Z'), attemptId = 'att-1', fields } = {}) {
  db.acquireSlot(attemptId, { budget: 5, ttlMs: 30 * 60_000, now });
  if (fields) db.recordRunKey(RUN_KEY, { subject: 'repo:1', workflow: 'live-probe', fields, now });
  const l = db.acquireLease(RUN_KEY, attemptId, { ttlMs: 30 * 60_000, now });
  db.createDispatch({
    attemptId, shardId: `s-${attemptId}`, workflow: 'live-probe', repo: WORKER_REPO, workflowFile: 'live-probe.yml', ref: 'main',
    expires: now + 30 * 60_000, items: [{ run_key: RUN_KEY, subject: 'repo:1', fence: l.fence }], now,
  });
  return l.fence;
}

test('R-PIN-01: getAttempt carries each item\'s pins from the fields its run_key was computed from', () => {
  const db = openState(':memory:');
  dispatchOne(db, { fields: { subject_id: 'repo:1', workflow: 'live-probe', tool_versions: { 'mcp-check': PIN }, oracle_versions: { x: '1' }, probe_versions: { 'mcp-surface-corpus': '4c16b58' } } });
  assert.deepEqual(db.getAttempt('att-1').items[0].pins, PINS, 'tool and probe versions; oracle versions are not checked');
  db.close();
});

test('R-PIN-01: pin refusals are not counted towards parking a run_key: the subject did nothing wrong', () => {
  assert.ok(NOT_COUNTED_REASONS.includes('pin_mismatch'));
  assert.ok(NOT_COUNTED_REASONS.includes('pin_unverified'));
  const db = openState(':memory:');
  const t = Date.parse('2026-11-25T10:00:00Z');
  for (let i = 0; i < 4; i++) {
    const now = t + i * 60 * 60_000;
    const fence = dispatchOne(db, { now, attemptId: `att-${i}` });
    db.recordResult({ run_key: RUN_KEY, attempt_id: `att-${i}`, fence, verdict: 'rejected', reason: i % 2 ? 'pin_unverified' : 'pin_mismatch', outcome: 'rejected', now: now + 60_000 });
  }
  assert.equal(db.rejectedCount(RUN_KEY), 0);
  assert.deepEqual(db.rejectedRunKeys(1), []);
  db.close();
});

test('R-PIN-01: pausePinRefused pauses the lane for an hour, says why, records the event, and never shortens a longer pause', () => {
  const db = openState(':memory:');
  const t = Date.parse('2026-11-25T10:00:00Z');
  const p = db.pausePinRefused('live-probe', { reason: 'pin_mismatch', now: t });
  assert.equal(p.until, new Date(t + PIN_PAUSE_MS).toISOString());
  assert.equal(PIN_PAUSE_MS, 3_600_000);
  const [paused] = db.pausedWorkflows({ now: t + 1 });
  assert.deepEqual({ ...paused }, { workflow: 'live-probe', reason: 'pin_mismatch', count: 1, since: new Date(t).toISOString(), until: p.until });
  db.pausePinRefused('live-probe', { reason: 'pin_mismatch', now: t + 10 * 60_000 });
  assert.equal(db.getKv('pump.paused:live-probe').count, 2, 'a second refusal while paused extends it');
  assert.equal(db.getKv('pump.paused:live-probe').since, new Date(t).toISOString());
  assert.equal(db.pausedWorkflows({ now: t + PIN_PAUSE_MS + 10 * 60_000 + 1 }).length, 0, 'the pause ends on its own');
  // A longer pause (the run_sha_mismatch alarm's six hours) is kept as it is.
  const long = { reason: 'run_sha_mismatch', count: 3, since: new Date(t).toISOString(), until: new Date(t + 6 * 3_600_000).toISOString() };
  db.setKv('pump.paused:writecheck', long, { now: t });
  db.pausePinRefused('writecheck', { reason: 'pin_unverified', now: t + 60_000 });
  assert.deepEqual(db.getKv('pump.paused:writecheck'), long);
  const events = db.raw.prepare("SELECT type, lane FROM events WHERE type = 'workflow_paused' ORDER BY id").all().map((e) => [e.type, e.lane]);
  assert.deepEqual(events, [['workflow_paused', 'live-probe'], ['workflow_paused', 'live-probe']]);
  db.close();
});

// ---- R-PIN-02: the review's should-fix and nit ----

test('R-PIN-02: label lane, its own worker-repository pin moved: accepted, listed unverified with a self_pin_moved note, no refusal', async () => {
  // The default ledger row's worker repository is isokron-ai/mcp-check: "mcp-check" is the lane's own pin.
  const { r, ledger, report } = await judge({ mode: 'label', tools: [{ name: '@isokron/mcp-check', version: HEAD }, CORPUS] });
  assert.equal(r.outcome, 'accepted');
  assert.equal(ledger.records[0].accepted, true);
  assert.deepEqual(report.pins.mismatched, []);
  assert.deepEqual(report.pins.unverified, [{ kind: 'tool', name: 'mcp-check', pin: PIN, got: HEAD, note: `self_pin_moved: reported ${HEAD}, pinned ${PIN}` }]);
  assert.equal(report.pins.fault, undefined);
});

test('R-PIN-02: label lane, a pin that is not its own moved: still refused as pin_mismatch', async () => {
  const probe = await judge({ mode: 'label', tools: [{ name: 'mcp-check', version: HEAD }, { ...CORPUS, version: HEAD }] });
  assert.equal(probe.r.reason, 'pin_mismatch', 'the probe is not the worker repository');
  assert.deepEqual(probe.report.problems.map((p) => p.key), ['mcp-surface-corpus']);
  assert.equal(probe.report.pins.unverified[0].note, `self_pin_moved: reported ${HEAD}, pinned ${PIN}`, 'its own pin is still only a note');
  // Another tool of the same lane (writecheck's mcp-writecheck CLI next to mcp-writecheck-action).
  const other = await judge({ mode: 'label', pins: { tool: { 'mcp-check': PIN, 'mcp-writecheck': '3af41c6' }, probe: {} }, tools: [{ name: 'mcp-check', version: FULL }, { name: 'mcp-writecheck', version: HEAD }] });
  assert.equal(other.r.reason, 'pin_mismatch');
  assert.deepEqual(other.report.problems.map((p) => p.key), ['mcp-writecheck']);
});

test('R-PIN-02: enforce lane, its own worker-repository pin moved: still refused as pin_mismatch', async () => {
  const { r, report } = await judge({ mode: 'enforce', tools: [{ name: 'mcp-check', version: HEAD }, CORPUS] });
  assert.equal(r.reason, 'pin_mismatch');
  assert.deepEqual(report.problems.map((p) => [p.fault, p.key]), [['tool', 'mcp-check']]);
});

test('R-PIN-02: pins recorded but unreadable are refused (pin_unverified) on an enforce lane, never taken as no label', async () => {
  const enforce = await judge({ mode: 'enforce', pins: 'malformed', tools: [{ name: 'mcp-check', version: FULL }, CORPUS] });
  assert.equal(enforce.r.reason, 'pin_unverified');
  assert.deepEqual(enforce.report.pins, { mode: 'enforce', checked: false, why: 'malformed_label', fault: 'tool' });
  assert.equal(enforce.report.problems[0].fault, 'tool');
  const label = await judge({ mode: 'label', pins: { tool: ['x'] }, tools: [CORPUS] });
  assert.equal(label.r.outcome, 'accepted');
  assert.equal(label.report.pins.why, 'malformed_label');
  assert.equal(normalizeAttempt(expectedRow({ pins: 'malformed' })).items[0].pins, false);
  // In the store: fields that are not JSON, or not an object.
  const db = openState(':memory:');
  dispatchOne(db, { fields: '{not json' });
  assert.equal(db.getAttempt('att-1').items[0].pins, 'malformed');
  assert.equal(normalizeAttempt(db.getAttempt('att-1')).items[0].pins, false);
  db.close();
});
