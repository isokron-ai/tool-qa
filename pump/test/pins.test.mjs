// Version pins (R-PIN-01): the pump half (pump/pins.mjs, tick.mjs, dispatch.mjs)
// and the pure checks ingest uses. Ingest's decisions: ingest/test/pins.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LANES } from '../../meta/lanes.mjs';
import { openState } from '../../state/db.mjs';
import { createDispatcher, workerInputs } from '../dispatch.mjs';
import { checkPins, expectedPins, lanePinModes, PIN_CHECK_MODES, pinCheckMode, pinDecision, pinEvidence, selfPin } from '../pins.mjs';
import { runTick } from '../tick.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const shipped = JSON.parse(readFileSync(new URL('../workflows.json', import.meta.url), 'utf8')).workflows;

const FULL = '116b0ca'.padEnd(40, '7');
const HEAD = 'd4a373a'.padEnd(40, '0');

const lane = (over = {}) => ({
  enabled: true, runs_untrusted: false, repo: 'isokron-ai/mcp-check', file: 'live-probe.yml', ref: 'main',
  shard_size: 2, setup_minutes: 4, minutes_per_subject: 2, slots_max: 12,
  versions: { tool: { 'mcp-check': '116b0ca' }, oracle: {}, probe: { 'mcp-surface-corpus': '4c16b58' } },
  image_digest: null, settings_state: 'default', ...over,
});

function setup(workflows, subjects = 2) {
  const c = fakeClock();
  const db = openState(':memory:');
  for (let i = 0; i < subjects; i++) db.setSubjectVersion({ id: `npm:pkg-${i}`, kind: 'package', source: 'npm', tier: 1, sha: String(i).repeat(40), now: c.t });
  let n = 0;
  return { c, db, config: { tiers, workflows }, newId: () => `att-${++n}` };
}

function recorder({ head = HEAD, commits = { '116b0ca': FULL } } = {}) {
  const calls = [];
  const resolved = [];
  return {
    calls,
    resolved,
    async dispatch(req) {
      calls.push(req);
      return { runId: 1000 + calls.length, runUrl: null, correlatedBy: 'response' };
    },
    async resolveRef() {
      return head;
    },
    async resolveCommit({ repo, sha }) {
      resolved.push([repo, sha]);
      if (!commits[sha]) throw new Error(`${repo}: cannot resolve the pinned commit ${sha} (HTTP 404)`);
      return commits[sha];
    },
  };
}

// ---- the pure checks ----

test('R-PIN-01: a commit pin is proven only by the full commit it starts; a package version says nothing about it', () => {
  assert.equal(pinEvidence('116b0ca', FULL), 'proof');
  assert.equal(pinEvidence(FULL, FULL), 'proof');
  assert.equal(pinEvidence('116b0ca', HEAD), 'contradiction', 'another commit');
  assert.equal(pinEvidence('116b0ca', 'd4a373a'), 'contradiction', 'another short commit');
  assert.equal(pinEvidence('116b0ca', '116b0'), 'silent', 'shorter than the pin: could be either');
  assert.equal(pinEvidence('116b0ca', '116b0ca'), 'silent', 'the short form is no proof of the commit');
  assert.equal(pinEvidence('116b0ca', '1.3.1'), 'silent', 'a package version');
  assert.equal(pinEvidence('1.2.0', '1.2.0'), 'proof', 'any other pin: the same version string');
  assert.equal(pinEvidence('1.2.0', '1.3.0'), 'contradiction');
  assert.equal(pinEvidence('1.2.0', undefined), 'silent');
});

test('R-PIN-01: checkPins finds each pinned component by name, under a scope or owner, or as tool-qa-<lane>', () => {
  const expected = { tool: { 'mcp-check': '116b0ca', 'meta-github': '1.2.0' }, probe: { 'mcp-surface-corpus': '4c16b58', fuzz: '1' } };
  const r = checkPins(expected, [
    { name: '@isokron/mcp-check', version: FULL },
    { name: 'tool-qa-meta-github', version: '1.2.0' },
    { name: 'isokron-ai/mcp-surface-corpus', version: '4c16b58'.padEnd(40, '1') },
    { name: 'mcp-surface-corpus-sandbox', version: HEAD }, // another name: not this component
  ]);
  assert.deepEqual(r.verified.map((e) => e.name), ['mcp-check', 'meta-github', 'mcp-surface-corpus']);
  assert.deepEqual(r.unverified, [{ kind: 'probe', name: 'fuzz', pin: '1', got: null }]);
  assert.deepEqual(r.mismatched, []);
  // One contradicting report outweighs a proving one.
  const both = checkPins({ tool: { 'mcp-check': '116b0ca' }, probe: {} }, [{ name: 'mcp-check', version: FULL }, { name: '@isokron/mcp-check', version: HEAD }]);
  assert.deepEqual(both.mismatched, [{ kind: 'tool', name: 'mcp-check', pin: '116b0ca', got: HEAD }]);
});

test('R-PIN-01: pinDecision: a match is accepted; a contradiction is refused on every lane, tool side; an unproven pin only on an enforce lane', () => {
  const expected = { tool: { 'mcp-check': '116b0ca' }, probe: {} };
  for (const mode of PIN_CHECK_MODES) {
    const ok = pinDecision({ mode, expected, tools: [{ name: 'mcp-check', version: FULL }] });
    assert.equal(ok.reason, null, `${mode}: match`);
    assert.equal(ok.report.verified.length, 1);
    const bad = pinDecision({ mode, expected, tools: [{ name: 'mcp-check', version: HEAD }] });
    assert.equal(bad.reason, 'pin_mismatch', `${mode}: mismatch`);
    assert.equal(bad.report.fault, 'tool');
    assert.deepEqual(bad.problems.map((p) => [p.reason, p.fault, p.key, p.expected, p.got]), [['pin_mismatch', 'tool', 'mcp-check', '116b0ca', HEAD]]);
  }
  const semver = [{ name: 'mcp-check', version: '1.3.1' }];
  assert.equal(pinDecision({ mode: 'label', expected, tools: semver }).reason, null, 'label: accepted, with the pin listed as unverified');
  assert.equal(pinDecision({ mode: 'label', expected, tools: semver }).report.unverified.length, 1);
  const enforced = pinDecision({ mode: 'enforce', expected, tools: semver });
  assert.equal(enforced.reason, 'pin_unverified');
  assert.deepEqual(enforced.problems.map((p) => [p.fault, p.got]), [['tool', '1.3.1']]);
  assert.equal(pinDecision({ mode: 'enforce', expected, tools: [] }).problems[0].got, 'not reported');
  // No label recorded for the run_key, or a ledger that says nothing: nothing to make true.
  assert.deepEqual(pinDecision({ mode: 'enforce', expected: null, tools: [] }), { reason: null, problems: [], report: { mode: 'enforce', checked: false, why: 'no_label' } });
  assert.equal(pinDecision({ mode: 'enforce', expected: undefined, tools: [] }).report.why, 'not_in_ledger');
});

test('R-PIN-01: expectedPins reads a run_key\'s fields or getAttempt\'s pins; anything else is no label', () => {
  assert.deepEqual(expectedPins({ tool_versions: { a: '1' }, probe_versions: {} }), { tool: { a: '1' }, probe: {} });
  assert.deepEqual(expectedPins({ tool: { a: '1' } }), { tool: { a: '1' }, probe: {} });
  assert.equal(expectedPins(null), null);
  assert.equal(expectedPins({ tool: { a: 1 } }), null);
  assert.equal(expectedPins({ tool: ['x'] }), null);
});

// ---- the config ----

test('R-PIN-01: every lane in pump/workflows.json says its pin_check; a lane that does not is held to enforce', () => {
  for (const [name, wf] of Object.entries(shipped)) {
    assert.ok(PIN_CHECK_MODES.includes(wf.pin_check), `${name}: pin_check must be "label" or "enforce", got ${JSON.stringify(wf.pin_check)}`);
  }
  assert.equal(pinCheckMode({}), 'enforce');
  assert.equal(pinCheckMode({ pin_check: 'Label' }), 'enforce', 'only an exact "label" relaxes it');
  assert.equal(pinCheckMode(undefined), 'enforce');
  assert.deepEqual(lanePinModes({ a: { pin_check: 'label' }, b: {} }), { a: 'label', b: 'enforce' });
});

test('R-PIN-01: an enforce lane\'s own commit pin is the versions.tool entry named after its worker repository', () => {
  assert.deepEqual(selfPin(lane()), { name: 'mcp-check', pin: '116b0ca' });
  assert.equal(selfPin(lane({ versions: { tool: { 'mcp-check': '1.3.1' } } })), null, 'not a commit');
  assert.equal(selfPin(lane({ repo: 'isokron-ai/tool-qa', versions: { tool: { 'meta-github': '1.2.0' } } })), null, 'tool-qa\'s lanes pin their VERSION');
  assert.deepEqual(selfPin(shipped.writecheck), { name: 'mcp-writecheck-action', pin: shipped.writecheck.versions.tool['mcp-writecheck-action'] });
});

test('R-PIN-01: tool-qa\'s own lanes are enforced, and what their bundles report proves their pins', () => {
  assert.deepEqual(Object.keys(LANES).sort(), ['meta-backend', 'meta-github', 'meta-registry', 'release-diff']);
  for (const [name, lane] of Object.entries(LANES)) {
    assert.equal(shipped[name].pin_check, 'enforce', `${name} reports its version, so it is enforced`);
    // meta/run.mjs reports the lane as tool-qa-<lane.name> at lane.version, or what the lane lists in `tools` (meta-backend: the lane and its maps).
    const d = pinDecision({ mode: 'enforce', expected: expectedPins(shipped[name].versions), tools: lane.tools ?? [{ name: `tool-qa-${lane.name}`, version: lane.version }] });
    assert.equal(d.reason, null, `${name}: ${JSON.stringify(d.problems)}`);
    assert.equal(d.report.verified.length, Object.keys(shipped[name].versions.tool).length + Object.keys(shipped[name].versions.probe).length);
  }
  const meta = readFileSync(new URL('../../meta/run.mjs', import.meta.url), 'utf8');
  assert.match(meta, /tools: lane\.tools \? lane\.tools\.map\(\(t\) => \(\{ \.\.\.t \}\)\) : \[\{ name: `tool-qa-\$\{lane\.name\}`, version: lane\.version \}\]/, 'meta/run.mjs still reports tool-qa-<lane> at its version, or the lane\'s own list');
});

test('R-PIN-03: live-probe\'s pins are ones its worker can prove: the fuzz stage at the mcp-check pin, the sandbox at sandbox_sha', () => {
  // mcp-check corpus/live-probe.mjs toolsRan(): the bundle reports @isokron/mcp-check at the commit that ran (tool_sha,
  // the lane's own pin), the fuzz stage at that same commit, and isokron-ai/mcp-surface-corpus at the sandbox commit.
  // A fuzz pin left behind when the mcp-check pin moved made every result pin_mismatch (28 Nov, live-probe-842475c16925).
  const lp = shipped['live-probe'];
  const own = selfPin(lp);
  assert.ok(own, 'live-probe pins a commit of mcp-check');
  const ran = own.pin.padEnd(40, '0');
  const tools = [
    { name: '@isokron/mcp-check', version: ran },
    { name: 'isokron-ai/mcp-surface-corpus', version: lp.sandbox_sha },
    { name: 'fuzz', version: ran },
  ];
  const d = pinDecision({ mode: pinCheckMode(lp), expected: expectedPins(lp.versions), tools });
  assert.equal(d.reason, null, `live-probe: ${JSON.stringify(d.problems)}`);
  assert.equal(lp.versions.probe.fuzz, own.pin, 'the fuzz pin moves with the mcp-check pin');
  // The same commit is named twice on every lane that runs third-party code: the probe pin the worker reports and
  // the sandbox_sha the breaker compares with the nightly. They move together.
  for (const [name, wf] of Object.entries(shipped)) {
    const probe = wf.versions?.probe?.['mcp-surface-corpus'];
    if (probe === undefined) continue;
    assert.match(String(wf.sandbox_sha), /^[0-9a-f]{40}$/, `${name}: a probe mcp-surface-corpus pin needs a sandbox_sha`);
    assert.ok(wf.sandbox_sha.startsWith(probe), `${name}: probe mcp-surface-corpus ${probe} is not sandbox_sha ${wf.sandbox_sha}`);
  }
  // Fails closed: a fuzz pin the worker does not run is refused as the tool side's fault, never the subject's.
  const stale = pinDecision({ mode: 'enforce', expected: { tool: lp.versions.tool, probe: { ...lp.versions.probe, fuzz: 'bece344' } }, tools });
  assert.equal(stale.reason, 'pin_mismatch');
  assert.deepEqual(stale.problems.map((p) => [p.fault, p.kind, p.key, p.expected, p.got]), [['tool', 'probe', 'fuzz', 'bece344', ran]]);
});

// ---- the pump ----

test('R-PIN-01: workerInputs sends tool_sha only when given, and only a full commit', () => {
  const items = [{ subject: 's', run_key: 'k', fence: 1 }];
  assert.equal('tool_sha' in workerInputs({ shardId: 's', attemptId: 'a', items }), false, 'a worker without the input would refuse it');
  assert.equal(workerInputs({ shardId: 's', attemptId: 'a', items, toolSha: FULL }).tool_sha, FULL);
  assert.throws(() => workerInputs({ shardId: 's', attemptId: 'a', items, toolSha: '116b0ca' }), /full commit SHA/);
});

test('R-PIN-01: an enforce lane is dispatched with its pinned commit, resolved in full, as tool_sha', async () => {
  const { c, db, config, newId } = setup({ 'live-probe': lane({ pin_check: 'enforce' }) });
  const d = recorder();
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(s.dispatched, 1);
  assert.equal(d.calls[0].inputs.tool_sha, FULL);
  assert.equal(d.calls[0].ref, 'main', 'still dispatched on its branch: GitHub takes no commit there');
  assert.deepEqual(d.resolved, [['isokron-ai/mcp-check', '116b0ca']]);
  db.close();
});

test('R-PIN-01: an enforce lane whose pinned commit cannot be resolved is not dispatched (fails closed)', async () => {
  const { c, db, config, newId } = setup({ 'live-probe': lane({ pin_check: 'enforce' }) });
  const d = recorder({ commits: {} });
  const lines = [];
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId, log: (l) => lines.push(l) });
  assert.equal(d.calls.length, 0);
  assert.deepEqual(s.skippedWorkflows, ['live-probe']);
  assert.deepEqual(db.openSlots(), [], 'no slot is held');
  assert.ok(lines.some((l) => /cannot resolve live-probe's pinned commit mcp-check 116b0ca; not dispatching it this tick/.test(l)));
  // A dispatcher that cannot resolve commits at all fails closed too.
  const { resolveCommit: _r, ...old } = recorder();
  const s2 = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: old, newId });
  assert.equal(s2.dispatched, 0);
  db.close();
});

test('R-PIN-01: a label lane sends no tool_sha, and says when its branch head is not the pin', async () => {
  const { c, db, config, newId } = setup({ 'live-probe': lane({ pin_check: 'label' }) }, 4);
  const d = recorder();
  const lines = [];
  const s = await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId, log: (l) => lines.push(l) });
  assert.equal(s.dispatched, 2);
  assert.ok(d.calls.every((x) => !('tool_sha' in x.inputs)));
  assert.deepEqual(d.resolved, [], 'nothing resolved');
  assert.equal(lines.filter((l) => /pin_check is "label" and isokron-ai\/mcp-check main is at d4a373a00000, not the pinned mcp-check 116b0ca/.test(l)).length, 1, 'once a tick');
  db.close();
});

test('R-PIN-01: an enforce lane with no commit pin of its own sends no tool_sha', async () => {
  const meta = lane({ repo: 'isokron-ai/tool-qa', file: 'meta-github.yml', pin_check: 'enforce', versions: { tool: { 'meta-github': '1.2.0' }, oracle: {}, probe: {} } });
  const { c, db, config, newId } = setup({ 'meta-github': meta });
  const d = recorder();
  await runTick({ db, now: c.now, config, workerSlots: 2, dispatcher: d, newId });
  assert.equal(d.calls.length, 1);
  assert.equal('tool_sha' in d.calls[0].inputs, false);
  db.close();
});

test('R-PIN-01: the dispatcher resolves an abbreviated pin once with the dispatch token; one GitHub cannot find fails with what to do', async () => {
  const c = fakeClock();
  const api = fakeApi([
    ['GET', '/repos/isokron-ai/mcp-check/commits/116b0ca', () => ({ body: { sha: FULL } })],
    ['GET', '/repos/isokron-ai/mcp-check/commits/0000000', () => ({ status: 422, body: { message: 'No commit found for SHA: 0000000' } })],
    ['GET', '/repos/isokron-ai/mcp-check/commits/1111111', () => ({ body: { sha: HEAD } })],
  ]);
  const mints = [];
  const d = createDispatcher({
    mintToken: async (args) => {
      mints.push(args);
      return { token: 'ghs_synthetic', expiresAt: c.t + 3_600_000 };
    },
    fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep,
  });
  assert.equal(await d.resolveCommit({ repo: 'isokron-ai/mcp-check', sha: '116b0ca' }), FULL);
  assert.equal(await d.resolveCommit({ repo: 'isokron-ai/mcp-check', sha: '116b0ca' }), FULL);
  assert.equal(api.calls.filter((x) => x.path.endsWith('/commits/116b0ca')).length, 1, 'a commit never moves: looked up once');
  assert.deepEqual(mints[0].permissions, { actions: 'write' });
  assert.equal(await d.resolveCommit({ repo: 'isokron-ai/mcp-check', sha: FULL }), FULL, 'a full SHA is taken as it is');
  await assert.rejects(d.resolveCommit({ repo: 'isokron-ai/mcp-check', sha: '0000000' }), /cannot resolve the pinned commit 0000000 \(HTTP 422\).*pin the full commit SHA/);
  await assert.rejects(d.resolveCommit({ repo: 'isokron-ai/mcp-check', sha: '1111111' }), /does not match it/);
});
