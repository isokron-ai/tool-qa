// One pump tick.
//
//   1. Reap: close dispatches and slot rows whose lease expired.
//   2. If there are worker slots: compute the due list from state, cut it into
//      shards per workflow (shard_size each, at most slots_max open per
//      workflow), highest priority first.
//   3. For each shard, while a slot is free: take the slot, take a lease per
//      run_key (held by the shard's attempt id), record the dispatch in state,
//      then send the workflow_dispatch and record the run it created. If the
//      send fails, the dispatch is marked failed and its leases and slot are
//      freed, so the work is due again on the next tick.
//
// The dispatch is written to state before it is sent. A pump that dies after
// sending leaves a pending dispatch whose lease simply expires.

import { randomUUID } from 'node:crypto';

import { BudgetExceededError } from './budgets.mjs';
import { workerInputs } from './dispatch.mjs';
import { dueFromState, NO_HOOKS } from './due.mjs';
import { acquireDispatchSlot, leaseTtlMs, occupancy, reapExpired } from './slots.mjs';

/**
 * Cut the due list into shards. Within a workflow the due order is kept; across
 * workflows the shard with the higher top priority goes first.
 */
export function planShards(due, workflows, { openByWorkflow = new Map() } = {}) {
  const groups = new Map();
  for (const d of due) {
    if (!groups.has(d.workflow)) groups.set(d.workflow, []);
    groups.get(d.workflow).push(d);
  }
  const shards = [];
  for (const [name, items] of groups) {
    const wf = workflows[name];
    if (!wf) continue;
    const size = Math.max(1, Math.trunc(Number(wf.shard_size)) || 1);
    const max = Number.isFinite(Number(wf.slots_max)) ? Number(wf.slots_max) : Infinity;
    const cap = Math.max(0, max - (openByWorkflow.get(name) ?? 0));
    for (let i = 0, n = 0; i < items.length && n < cap; i += size, n++) {
      const chunk = items.slice(i, i + size);
      shards.push({ workflow: name, items: chunk, priority: chunk[0].priority, order: n });
    }
  }
  shards.sort((a, b) => b.priority - a.priority || a.order - b.order || (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0));
  return shards;
}

function stopReason(err) {
  if (err instanceof BudgetExceededError || err?.name === 'BudgetExceededError') return 'budget';
  const status = Number(err?.status);
  if (status === 401) return 'unauthorized';
  if (status === 429 || (status === 403 && /rate limit/i.test(String(err?.message)))) return 'rate_limited';
  if (status >= 500) return 'api_error';
  if (err?.name === 'GitHubError' && status === 0) return 'network';
  return null;
}

/**
 * @param {{ db: import('../state/db.mjs').StateDb, now?: () => number,
 *   config: { tiers: object, workflows: Record<string, object> }, workerSlots: number,
 *   dispatcher: { dispatch: (req: object) => Promise<object> }, log?: (line: string) => void,
 *   newId?: () => string, hooks?: object, deadline?: number }} args
 *   deadline: no new shard is started at or after this time (ms).
 */
export async function runTick({ db, now = Date.now, config, workerSlots, dispatcher, log = () => {}, newId = randomUUID, hooks = NO_HOOKS, deadline }) {
  const t0 = now();
  const reaped = reapExpired(db, { now: t0 });
  const summary = {
    at: new Date(t0).toISOString(),
    workerSlots,
    reaped: reaped.dispatches.length,
    reapedSlots: reaped.slots,
    due: null,
    planned: 0,
    dispatched: 0,
    failed: 0,
    skippedWorkflows: [],
    stopped: null,
  };
  for (const d of reaped.dispatches) log(`lease expired: closed ${d.workflow} shard ${d.shard_id} (${d.attempt_id})`);
  if (!(workerSlots > 0)) return summary;

  const due = dueFromState(db, { now: t0, tiers: config.tiers, workflows: config.workflows, hooks });
  summary.due = due.length;
  if (due.length === 0) return summary;

  const openByWorkflow = new Map();
  for (const d of occupancy(db, { now: t0 }).dispatches) openByWorkflow.set(d.workflow, (openByWorkflow.get(d.workflow) ?? 0) + 1);
  const shards = planShards(due, config.workflows, { openByWorkflow });
  summary.planned = shards.length;

  const skip = new Set();
  for (const shard of shards) {
    if (skip.has(shard.workflow)) continue;
    const wf = config.workflows[shard.workflow];
    const t = now();
    if (deadline !== undefined && t >= deadline) {
      summary.stopped = 'deadline';
      break;
    }
    const attemptId = String(newId());
    const shardId = `${shard.workflow}-${attemptId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    const ttlMs = leaseTtlMs(wf, shard.items.length);
    if (acquireDispatchSlot(db, { attemptId, workerSlots, ttlMs, now: t }) === null) {
      summary.stopped = 'slots_full';
      break;
    }
    const leased = [];
    for (const it of shard.items) {
      db.recordRunKey(it.run_key, { subject: it.subject, workflow: shard.workflow, fields: it.fields, now: t });
      const l = db.acquireLease(it.run_key, attemptId, { ttlMs, now: t });
      if (l.acquired) leased.push({ run_key: it.run_key, subject: it.subject, fence: l.fence });
    }
    if (leased.length === 0) {
      db.releaseSlotForAttempt(attemptId, 'nothing_leased', { now: t });
      continue;
    }
    try {
      db.createDispatch({
        attemptId, shardId, workflow: shard.workflow, repo: wf.repo, workflowFile: wf.file, ref: wf.ref,
        expires: t + ttlMs, items: leased, now: t,
      });
    } catch (err) {
      for (const l of leased) db.releaseLease(l.run_key, attemptId, l.fence, { now: t });
      db.releaseSlotForAttempt(attemptId, 'failed', { now: t });
      throw err;
    }
    try {
      const inputs = workerInputs({ shardId, attemptId, items: leased });
      const out = await dispatcher.dispatch({ repo: wf.repo, workflowFile: wf.file, ref: wf.ref, inputs, shardId });
      db.markDispatched(attemptId, {
        runId: out?.runId ?? null, runUrl: out?.runUrl ?? null, workflowSha: out?.workflowSha ?? null, correlatedBy: out?.correlatedBy ?? null,
      });
      summary.dispatched += 1;
      log(`dispatched ${shardId}: ${leased.length} item(s) to ${wf.repo} ${wf.file}${out?.runId ? `, run ${out.runId}` : ', run not matched yet'}`);
    } catch (err) {
      const message = String(err?.message ?? err);
      db.failDispatch(attemptId, { error: message, now: now() });
      summary.failed += 1;
      log(`dispatch of ${shardId} failed: ${message}`);
      const stop = stopReason(err);
      if (stop) {
        summary.stopped = stop;
        break;
      }
      skip.add(shard.workflow);
      summary.skippedWorkflows.push(shard.workflow);
    }
  }
  return summary;
}
