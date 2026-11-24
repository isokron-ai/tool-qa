// Worker slots: how many worker runs the loop may have going at once.
//
// The account runs at most 20 jobs at a time. The loop leaves 2 spare and makes
// room for whatever else is running, and never uses more than 15:
//
//   loopBudget  = max(1, min(15, 20 - nonLoopRunning - 2))
//   workerSlots = min(LOOP_SLOTS, loopBudget - 1)
//
// LOOP_SLOTS counts worker slots. The pump's own job is the one extra place in
// loopBudget, so LOOP_SLOTS=15 means 14 workers plus the pump. LOOP_SLOTS=0 means
// no workers at all: the pump only does housekeeping.
//
// Each dispatch holds one slot row in the state store until its results are in,
// the run is closed, or its lease expires (1.5 times the expected shard time plus
// 10 minutes). Expired rows are reaped on every tick, so a crashed worker or a
// crashed pump never holds a slot for long.

export const RUNNER_CAP = 20;
export const HEADROOM = 2;
export const MAX_LOOP = 15;

function wholeNumber(v) {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/**
 * @param {{ loopSlots: number|string, nonLoopRunning?: number }} args
 * @returns {{ requested: number, loopBudget: number, workerSlots: number }}
 */
export function computeBudget({ loopSlots, nonLoopRunning = 0 }) {
  const requested = Math.max(0, Math.min(MAX_LOOP, wholeNumber(loopSlots)));
  if (requested === 0) return { requested: 0, loopBudget: 0, workerSlots: 0 };
  const others = Math.max(0, wholeNumber(nonLoopRunning));
  const loopBudget = Math.max(1, Math.min(MAX_LOOP, RUNNER_CAP - others - HEADROOM));
  const workerSlots = Math.max(0, Math.min(requested, loopBudget - 1));
  return { requested, loopBudget, workerSlots };
}

/** Lease (and slot) lifetime for a shard of `items` subjects on workflow `wf`. */
export function leaseTtlMs(wf, items = wf.shard_size) {
  const minutes = 1.5 * (Number(wf.setup_minutes) + Number(items) * Number(wf.minutes_per_subject)) + 10;
  return Math.round(minutes * 60_000);
}

/** Take a slot for a dispatch. Returns the slot number, or null when all are busy. */
export function acquireDispatchSlot(db, { attemptId, workerSlots, ttlMs, now }) {
  if (!(workerSlots > 0)) return null;
  return db.acquireSlot(attemptId, { budget: workerSlots, ttlMs, now });
}

/**
 * The run behind a dispatch is over (ingest saw it finish without every result):
 * close the dispatch and free its slot and remaining leases. recordResult()
 * already frees the slot when the last result of a dispatch comes in.
 */
export function releaseOnResult(db, attemptId, { reason = 'result', now } = {}) {
  return db.closeDispatch(attemptId, { reason, now });
}

/** Close expired dispatches and slot rows. Returns what was closed. */
export function reapExpired(db, { now }) {
  const before = db.openSlots().length;
  const dispatches = db.reapExpiredDispatches({ now });
  const after = db.openSlots().length;
  return { dispatches, slots: before - after };
}

/** Live (open, unexpired) slot rows and dispatches right now. Read-only. */
export function occupancy(db, { now }) {
  const t = new Date(now).toISOString();
  return { slots: db.openSlots().filter((s) => s.expires > t).length, dispatches: db.openDispatches({ now }) };
}
