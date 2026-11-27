#!/usr/bin/env node
// The chaos soak: many seeded random fault schedules against the whole loop
// (chaos/lib/sim.mjs), each followed by a quiet spell in which the loop must
// recover on its own. Runs weekly and on demand in .github/workflows/chaos-soak.yml.
//
//   node chaos/soak.mjs [--seeds 40] [--from 1] [--faults 14] [--hours 5] [--recover-hours 4] [--verbose]
//   node chaos/soak.mjs --seed 17 --verbose      reproduce one schedule, with its log
//
// For every seed: a fresh simulated GitHub and state, the pump started, a
// fault schedule drawn from the seed (chaos/lib/faults.mjs) played over
// --hours, then every fault cleared and the switches put back, and
// --recover-hours more. It then checks what chaos/lib/sim.mjs problems()
// checks: no invariant broken on the way (the state never went backwards
// except through an operator restore, no duplicate or stale-fence result
// accepted, every accepted result really uploaded), and at the end every
// subject has its result (or is parked by the rejection limit), the health
// issue is green, no worker run is unknown to the state and no lease is
// stuck. Exit 1 if any seed failed; the failing seeds and their schedules
// are printed so each can be rerun with --seed.
//
// No network: everything runs against the in-memory GitHub.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applySchedule, drawSchedule } from './lib/faults.mjs';
import { HOUR, rng, Sim, TOOLQA } from './lib/sim.mjs';

// Nothing here may reach a network, imported or run: any stray real call
// fails loudly (the same tripwire as chaos/lib/harness.mjs).
globalThis.fetch = async (url) => {
  throw new Error(`chaos soak: no network (${url})`);
};

export async function soakOne(seed, { faults = 14, hours = 5, recoverHours = 4, verbose = false, kinds } = {}) {
  const sim = new Sim({ seed, subjects: 8, verbose });
  const r = rng(seed * 7919 + 13);
  const schedule = drawSchedule(r, { faults, spanMs: hours * HOUR, kinds });
  const lines = applySchedule(sim, schedule);
  try {
    sim.queuePump(sim.gh.createRun(TOOLQA, 'pump.yml', { event: 'workflow_dispatch' }));
    await sim.runFor(hours * HOUR);
    // Quiet: every fault gone, the switches as they were.
    sim.gh.clearFaults();
    sim.killRules = [];
    sim.worker = () => ({});
    for (const run of sim.workerRuns.filter((x) => x.plan?.hold && x.status !== 'completed')) sim.releaseWorker(run);
    // The switches as they were, unless a person is mid-restore (they switch it back).
    if (!sim.operatorBusy) sim.setVar('LOOP_ENABLED', 'true');
    sim.setVar('LOOP_PAUSE_UNTIL', undefined);
    await sim.runFor(recoverHours * HOUR);
    const dup = schedule.filter((f) => f.kind === 'duplicate').length;
    const slow = schedule.filter((f) => f.kind === 'workerSlow' || f.kind === 'workerHold').length;
    const problems = sim.problems({
      allowOrphans: (sim.restoresApplied ?? 0) > 0,
      // A run past its lease keeps its runner while its slot is free again.
      extraRuns: dup + slow + (sim.restoresApplied ?? 0) * 3,
      allowParked: true,
      // The simulated subjects never age during the quiet spell, so a lane's newest result is old by design (R-WD-23).
      ignoreChecks: ['lane-fresh:'],
    });
    return { seed, ok: problems.length === 0, problems, schedule: lines, tail: problems.length ? sim.tail(150) : '' };
  } finally {
    await sim.close();
  }
}

function parseArgs(argv) {
  const o = { seeds: 40, from: 1, faults: 14, hours: 5, recoverHours: 4, verbose: false, seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${a} needs a number`);
      return v;
    };
    if (a === '--seeds') o.seeds = num();
    else if (a === '--from') o.from = num();
    else if (a === '--faults') o.faults = num();
    else if (a === '--hours') o.hours = num();
    else if (a === '--recover-hours') o.recoverHours = num();
    else if (a === '--seed') o.seed = num();
    else if (a === '--verbose') o.verbose = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`soak: ${err.message}\n`);
    return 2;
  }
  const seeds = o.seed !== null ? [o.seed] : Array.from({ length: o.seeds }, (_, i) => o.from + i);
  const started = Date.now();
  const failed = [];
  for (const seed of seeds) {
    const t = Date.now();
    const out = await soakOne(seed, { faults: o.faults, hours: o.hours, recoverHours: o.recoverHours, verbose: o.verbose });
    process.stdout.write(`seed ${seed}: ${out.ok ? 'ok' : 'FAILED'} (${((Date.now() - t) / 1000).toFixed(1)} s)\n`);
    if (!out.ok || o.seed !== null) {
      process.stdout.write(`  schedule:\n${out.schedule.map((l) => `    ${l}`).join('\n')}\n`);
    }
    if (!out.ok) {
      process.stdout.write(`  problems:\n${out.problems.map((p) => `    ${p}`).join('\n')}\n`);
      if (o.seed !== null) process.stdout.write(`  log tail:\n${out.tail}\n`);
      failed.push(seed);
    }
  }
  process.stdout.write(`${seeds.length - failed.length} of ${seeds.length} seeds ok in ${((Date.now() - started) / 1000).toFixed(0)} s${failed.length ? `; failed: ${failed.join(' ')} (rerun one with --seed <n> --verbose)` : ''}\n`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
