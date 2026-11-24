// Shared bits of the chaos test files (chaos/*.test.mjs).
//
// The chaos suite runs in its own CI job (.github/workflows/test.yml, job
// `chaos`) and locally with `npm run test:chaos`; a plain `npm test` lists its
// tests as skipped. Every test there runs the shipped pump, ingest, successor,
// watchdog, snapshot and restore code end to end against the in-memory GitHub
// of chaos/lib/fake-github.mjs. No network: any real fetch fails the test.

import assert from 'node:assert/strict';

import { Sim, TOOLQA } from './sim.mjs';

export const ON = process.env.TOOL_QA_CHAOS === '1';

/** test() options for a chaos test. */
export const CHAOS = Object.freeze({ skip: ON ? false : 'the chaos suite runs in its own job (npm run test:chaos)', timeout: 180_000 });

globalThis.fetch = async (url) => {
  throw new Error(`chaos suite: no network (${url})`);
};

/** A fresh sim; on failure the log tail is added to the error. */
export async function withSim(opts, fn) {
  const sim = new Sim(opts);
  try {
    await fn(sim);
  } catch (err) {
    err.message = `${err.message}\n--- simulated loop log (last lines) ---\n${sim.tail(150)}`;
    throw err;
  } finally {
    await sim.close();
  }
}

/** Dispatch the pump by hand, the way the loop is started. */
export function startPump(sim) {
  const run = sim.gh.createRun(TOOLQA, 'pump.yml', { event: 'workflow_dispatch' });
  sim.queuePump(run);
  return run;
}

/** Every invariant holds and the loop is where it should be (Sim.problems). */
export function assertRecovered(sim, opts = {}) {
  assert.deepEqual(sim.problems(opts), [], 'the loop did not end clean');
}

/** The health issue's overall status and one item's status. */
export function healthOf(sim, id) {
  const h = sim.health();
  return id ? h.checks[id]?.status ?? null : h.overall;
}

/** Pump runs, as `<conclusion>` strings, created at or after `fromMs`. */
export function pumpOutcomes(sim, fromMs = 0) {
  return sim.pumpRuns.filter((r) => Date.parse(r.created_at) >= fromMs).map((r) => r.conclusion ?? r.status);
}

/** Lines of the sim log matching `re`. */
export function logLines(sim, re) {
  return sim.logs.filter((l) => re.test(l));
}

/** Accepted attempts per run_key in the live state. */
export function acceptedPerKey(sim) {
  const s = sim.readLive();
  const m = new Map();
  for (const a of s.attempts.filter((x) => x.accepted === 1)) m.set(a.run_key, (m.get(a.run_key) ?? 0) + 1);
  return m;
}
