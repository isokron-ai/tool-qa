// Chaos, end to end: the lead pipeline (state/leads.mjs) in the pump. A lead's
// sightings are folded in the same transaction as the result they come from,
// so a pump killed mid-ingest or after a push neither loses nor double-counts
// one, and a re-run on another worker run reproduces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CALLS } from './lib/faults.mjs';
import { HOUR, WORKFLOW } from './lib/sim.mjs';
import { assertRecovered, CHAOS, startPump, withSim } from './lib/harness.mjs';

const call = (name) => (c) => CALLS[name]({ method: c.method, path: c.path, host: c.url.origin, query: c.url.searchParams });
const SKIPS = [{ stage: 'static', reason: 'no_tools_found', fault: 'tool' }];
const version = (run) => run.ran?.find((t) => t.name === 'mcp-check')?.version ?? null;
/** server-0 always carries the failure; server-1 only until the tool's second version (a fix). */
const carries = (subject, v) => subject.endsWith('-0') || (subject.endsWith('-1') && v === 'chaos01');

test('R-LEAD-12: chaos: with leads on, a pump killed mid-ingest and after a push neither loses nor double-counts a lead; a re-run reproduces it and a fix re-checks clean', CHAOS, async () => {
  await withSim({ vars: { LANE_LEADS_ENABLED: 'dry-run' } }, async (sim) => {
    sim.worker = () => ({ item: (it, i, run) => (carries(it.subject, version(run)) ? { meta: { skips: SKIPS } } : {}) });
    sim.killWhen({ name: 'mid-ingest, on an artifact download', when: call('artifactZip') });
    sim.killWhen({ name: 'right after a state push', when: call('stateRename') });
    startPump(sim);
    await sim.runFor(2 * HOUR);
    // A new tool version: every subject is due again, in new worker runs.
    sim.config.workflows[WORKFLOW].versions.tool['mcp-check'] = 'chaos02';
    await sim.runFor(3 * HOUR);

    const s = sim.readLive();
    assert.ok(sim.killRules.every((r) => r.hits >= 1), `both kills happened: ${JSON.stringify(sim.killRules.map((r) => [r.name, r.hits]))}`);
    // What was accepted, from the workers' side: run_key -> {subject, version} of the run that carried it.
    const sent = new Map();
    for (const run of sim.workerRuns) for (const it of JSON.parse(run.inputs.items)) sent.set(`${run.inputs.attempt_id}\u0000${it.run_key}`, { subject: it.subject, v: version(run) });
    const accepted = s.attempts.filter((a) => a.accepted === 1).map((a) => sent.get(`${a.attempt_id}\u0000${a.run_key}`)).filter(Boolean);
    const want = accepted.filter((x) => carries(x.subject, x.v));
    assert.ok(want.length >= 3, `enough sightings to test: ${want.length}`);

    assert.equal(s.leads.length, 1, JSON.stringify(s.leads));
    const [lead] = s.leads;
    assert.equal(lead.sightings, want.length, 'every accepted result that carried it counted exactly once');
    assert.equal(lead.class, 'no_tools_found');
    assert.deepEqual(JSON.parse(lead.versions), ['mcp-check@chaos01', 'mcp-check@chaos02'], 'one lead across both versions');
    assert.ok(lead.reproduced_at, 'server-0 showed it again in another worker run');
    assert.equal(lead.status, 'open', 'dry-run files nothing');
    assert.equal(lead.issue_number, null);
    const pair = (subject) => s.lead_subjects.find((p) => p.subject === subject);
    assert.equal(pair('chaos-org/server-0').current, 1);
    assert.equal(pair('chaos-org/server-0').seen, want.filter((x) => x.subject.endsWith('-0')).length);
    assert.equal(pair('chaos-org/server-1').current, 0, 'the fixed subject re-checked clean');
    assert.ok(pair('chaos-org/server-1').clean >= 1);
    assertRecovered(sim);
  });
});

test('R-LEAD-12: chaos: with the switch unset the same run keeps no lead at all', CHAOS, async () => {
  await withSim({}, async (sim) => {
    sim.worker = () => ({ item: () => ({ meta: { skips: SKIPS } }) });
    startPump(sim);
    await sim.runFor(HOUR);
    const s = sim.readLive();
    assert.ok(s.attempts.some((a) => a.accepted === 1));
    assert.deepEqual([s.leads.length, s.lead_subjects.length], [0, 0]);
    assertRecovered(sim);
  });
});
