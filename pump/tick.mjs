// One pump tick.
//
//   1. Reap: close dispatches and slot rows whose lease expired.
//   2. If there are worker slots: compute the due list from state, cut it into
//      shards per workflow (shard_size each, at most slots_max open per
//      workflow), highest priority first.
//   3. For each shard, while a slot is free: take the slot, take a lease per
//      run_key (held by the shard's attempt id) and record the dispatch in
//      state as pending.
//   4. beforeSend(): the pump saves the state, so every dispatch about to be
//      sent is already in the saved copy. If that fails, nothing is sent and
//      the pending dispatches are withdrawn (marked failed, leases and slots
//      freed).
//   5. Send each workflow_dispatch and record the run it created. If a send
//      fails, the dispatch is marked failed and its leases and slot are freed,
//      so the work is due again on the next tick.
//
// A pump that dies after sending therefore leaves, in the saved state, a
// pending dispatch that holds its slot and leases until its lease expires;
// ingest finds its run by name. It never leaves a worker run the state does
// not know about (R-ING-10).

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
 *   beforeSend: optional async () => boolean, called once after the tick's
 *   dispatches are recorded as pending and before any is sent; the pump saves
 *   the state there. false (or a throw) withdraws them all unsent.
 */
export async function runTick({
  db, now = Date.now, config, workerSlots, dispatcher, log = () => {}, newId = randomUUID, hooks = NO_HOOKS, deadline, beforeSend,
}) {
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
    withdrawn: 0,
    skippedWorkflows: [],
    paused: [],
    stopped: null,
  };
  for (const d of reaped.dispatches) log(`lease expired: closed ${d.workflow} shard ${d.shard_id} (${d.attempt_id})`);
  // A workflow paused by the run_sha_mismatch alarm (R-ING-22) gets nothing; said in every tick, housekeeping too.
  const paused = new Set((typeof db.pausedWorkflows === 'function' ? db.pausedWorkflows({ now: t0 }) : []).map((p) => p.workflow));
  summary.paused = [...paused];
  if (!(workerSlots > 0)) return summary;

  const due = dueFromState(db, { now: t0, tiers: config.tiers, workflows: config.workflows, hooks }).filter((d) => !paused.has(d.workflow));
  summary.due = due.length;
  if (due.length === 0) return summary;

  const openByWorkflow = new Map();
  for (const d of occupancy(db, { now: t0 }).dispatches) openByWorkflow.set(d.workflow, (openByWorkflow.get(d.workflow) ?? 0) + 1);
  const shards = planShards(due, config.workflows, { openByWorkflow });
  summary.planned = shards.length;

  // 1. Reserve: for each shard, while a slot is free, take the slot and the
  // leases and record the dispatch as pending. Nothing is sent yet.
  const reserved = [];
  const shaByRef = new Map(); // `${repo}@${ref}` -> commit SHA, once per tick
  const refSkip = new Set();
  for (const shard of shards) {
    const wf = config.workflows[shard.workflow];
    if (refSkip.has(shard.workflow)) continue;
    const t = now();
    if (deadline !== undefined && t >= deadline) {
      summary.stopped = 'deadline';
      break;
    }
    // The commit the run must be at, recorded with the dispatch (R-ING-12).
    let workflowSha = null;
    if (typeof dispatcher?.resolveRef === 'function') {
      const refKey = `${wf.repo}@${wf.ref}`;
      try {
        if (!shaByRef.has(refKey)) shaByRef.set(refKey, await dispatcher.resolveRef({ repo: wf.repo, ref: wf.ref }));
        workflowSha = shaByRef.get(refKey);
      } catch (err) {
        log(`cannot resolve ${wf.repo} ${wf.ref} for ${shard.workflow}; not dispatching it this tick: ${err?.message ?? err}`);
        const stop = stopReason(err);
        if (stop) {
          summary.stopped = stop;
          break;
        }
        refSkip.add(shard.workflow);
        summary.skippedWorkflows.push(shard.workflow);
        continue;
      }
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
        expires: t + ttlMs, items: leased, workflowSha, now: t,
      });
    } catch (err) {
      for (const l of leased) db.releaseLease(l.run_key, attemptId, l.fence, { now: t });
      db.releaseSlotForAttempt(attemptId, 'failed', { now: t });
      for (const r of reserved) db.failDispatch(r.attemptId, { error: 'not sent: the tick failed before sending', now: now() });
      throw err;
    }
    reserved.push({ shard, wf, attemptId, shardId, leased, workflowSha });
  }
  if (reserved.length === 0) return summary;

  // 2. Make the reservations durable before anything is sent (R-ING-10): a
  // worker run the saved state does not know about would run outside the slot
  // ledger, and its fences would be handed out again. If the save fails,
  // nothing is sent and the reservations are withdrawn.
  const withdraw = (list, why) => {
    for (const r of list) {
      db.failDispatch(r.attemptId, { error: `not sent: ${why}`, now: now() });
      summary.withdrawn += 1;
    }
  };
  if (beforeSend) {
    let saved = false;
    try {
      saved = (await beforeSend()) !== false;
    } catch (err) {
      log(`saving the state before sending failed: ${err?.message ?? err}`);
    }
    if (!saved) {
      withdraw(reserved, 'the state could not be saved first');
      summary.stopped = 'state_push_failed';
      log(`nothing dispatched: the state could not be saved before sending ${reserved.length} shard(s)`);
      return summary;
    }
  }

  // 3. Send, in order. A dispatch that fails is marked failed and its leases
  // and slot freed, so the work is due again on the next tick.
  const skip = new Set();
  for (let i = 0; i < reserved.length; i++) {
    const { shard, wf, attemptId, shardId, leased, workflowSha } = reserved[i];
    if (skip.has(shard.workflow)) {
      withdraw([reserved[i]], `an earlier ${shard.workflow} dispatch failed this tick`);
      continue;
    }
    if (deadline !== undefined && now() >= deadline) {
      summary.stopped = 'deadline';
      withdraw(reserved.slice(i), 'the run deadline passed');
      break;
    }
    try {
      // Read the ref again right before sending, so a merge since the tick
      // began does not make this run a run_sha_mismatch (R-ING-24).
      if (workflowSha && typeof dispatcher?.resolveRef === 'function') {
        const fresh = await dispatcher.resolveRef({ repo: wf.repo, ref: wf.ref });
        if (fresh !== workflowSha) {
          db.updateDispatchSha(attemptId, fresh);
          log(`${wf.repo} ${wf.ref} moved to ${fresh} since this tick began; ${shardId} expects that commit`);
        }
      }
      const inputs = workerInputs({ shardId, attemptId, items: leased });
      const out = await dispatcher.dispatch({ repo: wf.repo, workflowFile: wf.file, ref: wf.ref, inputs, shardId });
      // The expected commit was recorded at creation; markDispatched keeps it.
      db.markDispatched(attemptId, { runId: out?.runId ?? null, runUrl: out?.runUrl ?? null, correlatedBy: out?.correlatedBy ?? null });
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
        withdraw(reserved.slice(i + 1), `dispatching stopped (${stop})`);
        break;
      }
      skip.add(shard.workflow);
      summary.skippedWorkflows.push(shard.workflow);
    }
  }
  return summary;
}
