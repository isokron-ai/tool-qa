// Chaos, end to end: subjects keyed by GitHub's numeric repository id (loop
// upgrade #15, state schema v8). A repository renamed or transferred between
// ticks (with a result in flight under its old name), one deleted, one turned
// private and back, an old name taken by a new repository, and an id that
// comes back naming another repository (which GitHub never does).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOUR, MIN, WORKFLOW } from './lib/sim.mjs';
import { assertRecovered, CHAOS, logLines, startPump, withSim } from './lib/harness.mjs';

// Look bound subjects up again every 20 minutes instead of daily, so the
// scenarios play out in a few simulated hours.
const IDENTITY = { retryMs: { none: 0, ok: 20 * MIN, error: 5 * MIN, not_found: 20 * MIN, conflict: 20 * MIN } };

const subjectOf = (s, id) => s.subjects.find((x) => x.id === id);
const eventsOf = (s, id) => s.subjectEvents.filter((e) => e.subject === id).map((e) => e.kind);
/** A new tool version: every subject is due again (reason tool_version). */
function bumpTool(sim, v) {
  sim.config.workflows[WORKFLOW].versions = { ...sim.config.workflows[WORKFLOW].versions, tool: { 'mcp-check': v } };
}
/** The owner/name each worker run was sent, per item. */
const sentNames = (sim, from = 0) => sim.workerRuns.slice(from).flatMap((r) => JSON.parse(r.inputs.items).map((i) => i.subject));

async function warmUp(sim) {
  startPump(sim);
  await sim.runFor(45 * MIN);
  assert.equal(sim.missing().length, 0, 'every subject has its first result');
  const s = sim.readLive();
  assert.equal(s.version, 8);
  for (const [i, x] of sim.subjects.entries()) {
    const row = subjectOf(s, x.id);
    assert.equal(row.repo_id, 9000 + i, `${x.id} is bound to its repository id`);
    assert.equal(row.name, x.id);
    assert.deepEqual(eventsOf(s, x.id), ['id_bound']);
  }
  return s;
}

test('R-SUBJ-04: a rename and a transfer between ticks, one with a result in flight under the old name: one subject each, no run_key moves, the result lands, later work goes out under the new name', CHAOS, async () => {
  // Every pump run looks every subject up again, and leases are long enough
  // for a 40-minute worker run, so the rename is seen before the result is judged.
  const identity = { retryMs: { ...IDENTITY.retryMs, ok: 0 } };
  await withSim({ identity, workflow: { setup_minutes: 60 } }, async (sim) => {
    await warmUp(sim);
    // New work for everyone; the workers take 40 minutes, so their results are
    // judged by a later pump run than the one that sent them.
    bumpTool(sim, 'chaos02');
    sim.worker = () => ({ durationMs: 40 * MIN });
    const before = sim.workerRuns.length;
    await sim.runFor(12 * MIN);
    const inFlight = sim.readLive().items.filter((i) => i.subject === 'chaos-org/server-1' && i.resolved === null);
    assert.equal(inFlight.length, 1, 'server-1 is in flight');
    assert.equal(inFlight[0].subject_name, 'chaos-org/server-1', 'sent under the name it had then');
    assert.ok(sentNames(sim, before).includes('chaos-org/server-1'));

    sim.gh.renamePublicRepo('chaos-org/server-1', 'chaos-org/server-1-renamed');
    sim.gh.renamePublicRepo('chaos-org/server-2', 'other-org/server-2');
    sim.worker = () => ({});
    await sim.runFor(2 * HOUR);

    let s = sim.readLive();
    assert.equal(s.subjects.length, 6, 'no second subject for a renamed or transferred repository');
    assert.equal(subjectOf(s, 'chaos-org/server-1').name, 'chaos-org/server-1-renamed');
    assert.equal(subjectOf(s, 'chaos-org/server-1').repo_id, 9001);
    assert.deepEqual(eventsOf(s, 'chaos-org/server-1'), ['id_bound', 'renamed']);
    assert.equal(subjectOf(s, 'chaos-org/server-2').name, 'other-org/server-2');
    assert.deepEqual(eventsOf(s, 'chaos-org/server-2'), ['id_bound', 'transferred']);
    // The in-flight result was recorded under the subject key, by run_key.
    const landed = s.results.find((r) => r.run_key === inFlight[0].run_key);
    assert.ok(landed, 'the result sent under the old name was accepted');
    assert.equal(landed.subject, 'chaos-org/server-1');
    const renamedAt = s.subjectEvents.find((e) => e.subject === 'chaos-org/server-1' && e.kind === 'renamed').at;
    assert.ok(renamedAt < landed.accepted_at, `the rename (${renamedAt}) was seen before the result was judged (${landed.accepted_at})`);
    assert.equal(sim.missing().length, 0, 'every subject has a result for its current run_key: none moved');
    assert.ok(logLines(sim, /pump: subject chaos-org\/server-1: renamed \(chaos-org\/server-1 -> chaos-org\/server-1-renamed\)/).length >= 1);

    // The next round of work goes out under the new names.
    const mark = sim.workerRuns.length;
    bumpTool(sim, 'chaos03');
    await sim.runFor(HOUR);
    const sent = sentNames(sim, mark);
    assert.ok(sent.includes('chaos-org/server-1-renamed') && sent.includes('other-org/server-2'), `sent: ${sent.join(', ')}`);
    assert.ok(!sent.includes('chaos-org/server-1') && !sent.includes('chaos-org/server-2'), 'never under the old names again');
    s = sim.readLive();
    assert.equal(s.subjects.length, 6);
    assertRecovered(sim);
  });
});

test('R-SUBJ-05: a deleted repository and one turned private are subject-fault skips: not dispatched while gone; the private one is back once public', CHAOS, async () => {
  await withSim({ identity: IDENTITY }, async (sim) => {
    await warmUp(sim);
    sim.gh.publicRepos = sim.gh.publicRepos.filter((r) => r.name !== 'chaos-org/server-3'); // deleted
    sim.gh.publicRepo('chaos-org/server-4').visible = false; // turned private
    await sim.runFor(40 * MIN);
    let s = sim.readLive();
    for (const id of ['chaos-org/server-3', 'chaos-org/server-4']) {
      const row = subjectOf(s, id);
      assert.equal(row.id_status, 'not_found', id);
      assert.ok(row.gone_at, `${id} is marked gone`);
      assert.equal(row.repo_id, 9000 + Number(id.at(-1)), 'it keeps its id');
      const ev = s.subjectEvents.find((e) => e.subject === id && e.kind === 'not_found');
      assert.deepEqual(JSON.parse(ev.detail).skip, { reason: 'repo_not_visible', fault: 'subject' });
    }
    // New work: the gone subjects are left out.
    const mark = sim.workerRuns.length;
    bumpTool(sim, 'chaos02');
    await sim.runFor(HOUR);
    let sent = sentNames(sim, mark);
    assert.ok(!sent.includes('chaos-org/server-3') && !sent.includes('chaos-org/server-4'), `sent: ${sent.join(', ')}`);
    assert.ok(sent.includes('chaos-org/server-0'));

    // Public again: found again and due again; the deleted one stays out.
    sim.gh.publicRepo('chaos-org/server-4').visible = true;
    const mark2 = sim.workerRuns.length;
    await sim.runFor(90 * MIN);
    s = sim.readLive();
    assert.equal(subjectOf(s, 'chaos-org/server-4').gone_at, null);
    assert.deepEqual(eventsOf(s, 'chaos-org/server-4'), ['id_bound', 'not_found', 'found_again']);
    sent = sentNames(sim, mark2);
    assert.ok(sent.includes('chaos-org/server-4'), 'the subject that came back is dispatched');
    assert.ok(!sentNames(sim, mark).includes('chaos-org/server-3'), 'the deleted one never is');
    assert.deepEqual(eventsOf(s, 'chaos-org/server-3'), ['id_bound', 'not_found'], 'not_found is recorded once');
    // Only the deleted subject lacks a result for the new tool version.
    assert.deepEqual(sim.problems(), ['no accepted result at the end for chaos-org/server-3']);
  });
});

test('R-SUBJ-06: an old name taken by a new repository, and an id that comes back naming another repository: nothing is rebound, renamed or split', CHAOS, async () => {
  await withSim({ identity: IDENTITY }, async (sim) => {
    await warmUp(sim);
    // server-5 moves away and a new repository takes its old name.
    sim.gh.renamePublicRepo('chaos-org/server-5', 'chaos-org/server-5-moved');
    sim.gh.addPublicRepo('chaos-org/server-5', { databaseId: 9100, createdAt: '2026-11-23T13:00:00Z' });
    // server-4's id now answers with another creation time and name: an id
    // reused, which GitHub never does.
    const r4 = sim.gh.publicRepo('chaos-org/server-4');
    r4.createdAt = '2026-11-23T13:30:00Z';
    r4.name = 'someone-else/other-thing';
    await sim.runFor(40 * MIN);
    let s = sim.readLive();
    const s5 = subjectOf(s, 'chaos-org/server-5');
    assert.equal(s5.repo_id, 9005, 'followed by its id, not by its old name');
    assert.equal(s5.name, 'chaos-org/server-5-moved');
    assert.ok(!s.subjects.some((x) => x.repo_id === 9100), 'the newcomer at the old name is not taken for it');
    const s4 = subjectOf(s, 'chaos-org/server-4');
    assert.equal(s4.id_status, 'conflict');
    assert.equal(s4.repo_id, 9004);
    assert.equal(s4.name, 'chaos-org/server-4', 'not renamed on a conflicting answer');
    assert.deepEqual(eventsOf(s, 'chaos-org/server-4'), ['id_bound', 'id_conflict']);

    // Work still goes out: server-4 under its last good name, server-5 under its new one.
    const mark = sim.workerRuns.length;
    bumpTool(sim, 'chaos02');
    await sim.runFor(HOUR);
    const sent = sentNames(sim, mark);
    assert.ok(sent.includes('chaos-org/server-4') && sent.includes('chaos-org/server-5-moved'), `sent: ${sent.join(', ')}`);
    assert.ok(!sent.includes('chaos-org/server-5') && !sent.includes('someone-else/other-thing'));
    s = sim.readLive();
    assert.deepEqual(eventsOf(s, 'chaos-org/server-4'), ['id_bound', 'id_conflict'], 'the conflict is recorded once');
    assert.equal(s.subjects.length, 6);
    assertRecovered(sim);
  });
});
