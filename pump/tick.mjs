// One pump tick.
//
//   1. Reap: close dispatches and slot rows whose lease expired.
//   2. If there are worker slots: compute the due list from state (plus, with
//      the backfill switch on, the frame's oldest results for slots it leaves
//      free: pump/backfill.mjs), cut it into
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
import { controlTarget } from './controls.mjs';
import { workerInputs } from './dispatch.mjs';
import { computeDue, loadDueInputs, NO_HOOKS } from './due.mjs';
import { backfillCandidates, backfillFor, reserveSlots } from './backfill.mjs';
import { pinCheckMode, selfPin } from './pins.mjs';
import { acquireDispatchSlot, leaseTtlMs, occupancy, reapExpired } from './slots.mjs';

/**
 * Cut the due list into shards. Within a workflow the due order is kept; across
 * workflows the shard with the higher top priority goes first. On a lane that
 * names a `recheck_runner`, lead re-checks (reason lead_reverify) go in shards
 * of their own that carry `runner` (leads/recheck.mjs); slots_max holds over
 * both kinds of shard.
 */
export function planShards(due, workflows, { openByWorkflow = new Map() } = {}) {
  const groups = new Map();
  for (const d of due) {
    const runner = workflows[d.workflow]?.recheck_runner && d.reasons?.includes('lead_reverify') ? workflows[d.workflow].recheck_runner : null;
    const key = runner ? `${d.workflow}\u0000${runner}` : d.workflow;
    if (!groups.has(key)) groups.set(key, { name: d.workflow, runner, items: [] });
    groups.get(key).items.push(d);
  }
  const shards = [];
  const used = new Map(); // workflow -> shards planned so far, against slots_max
  // Re-check groups first within a workflow, so a full lane still re-checks.
  for (const { name, runner, items } of [...groups.values()].sort((a, b) => (a.runner ? 0 : 1) - (b.runner ? 0 : 1))) {
    const wf = workflows[name];
    if (!wf) continue;
    const size = Math.max(1, Math.trunc(Number(wf.shard_size)) || 1);
    const max = Number.isFinite(Number(wf.slots_max)) ? Number(wf.slots_max) : Infinity;
    for (let i = 0; i < items.length; i += size) {
      const n = used.get(name) ?? 0;
      if (n >= Math.max(0, max - (openByWorkflow.get(name) ?? 0))) break;
      used.set(name, n + 1);
      const chunk = items.slice(i, i + size);
      shards.push({ workflow: name, items: chunk, priority: chunk[0].priority, order: n, ...(runner ? { runner } : {}) });
    }
  }
  shards.sort((a, b) => b.priority - a.priority || a.order - b.order || (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0));
  return shards;
}

const SENT_RE = /\/actions\/workflows\/[^/]+\/(dispatches|runs)$/;

/**
 * A dispatch that failed in a way that does not say whether GitHub acted on it:
 * a server error or a network failure on the dispatch POST itself, or on the
 * poll for its run that follows a POST GitHub accepted. Anything before the
 * POST (re-reading the ref, minting the token) sent nothing (R-CHAOS-08); nor
 * did a refusal (4xx), a rate limit or our own budget.
 */
export function ambiguous(err) {
  if (err instanceof BudgetExceededError || err?.name === 'BudgetExceededError') return false;
  if (err?.name !== 'GitHubError') return false;
  const status = Number(err?.status);
  if (!(status === 0 || status >= 500)) return false;
  const method = String(err.method ?? '').toUpperCase();
  const path = String(err.path ?? '');
  if (!SENT_RE.test(path)) return false;
  return path.endsWith('/dispatches') ? method === 'POST' : method === 'GET';
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
 *   holdRunKeys: optional Set of run_keys not to dispatch this tick (the pump
 *   holds work whose expired dispatch ingest has not looked at yet; R-CHAOS-02).
 *   backfill: true to give free slots the due list leaves to the frame's
 *   oldest results (pump/backfill.mjs; LANE_BACKFILL_ENABLED).
 *   beforeSend: optional async () => boolean, called once after the tick's
 *   dispatches are recorded as pending and before any is sent; the pump saves
 *   the state there. false (or a throw) withdraws them all unsent.
 */
export async function runTick({
  db, now = Date.now, config, workerSlots, dispatcher, log = () => {}, newId = randomUUID, hooks = NO_HOOKS, deadline, beforeSend,
  holdRunKeys = null, backfill = false,
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

  const inputs = loadDueInputs(db, { now: t0, tiers: config.tiers, workflows: config.workflows, hooks });
  const due = computeDue(inputs).filter((d) => !paused.has(d.workflow) && !holdRunKeys?.has(d.run_key));
  summary.due = due.length;

  const occ = occupancy(db, { now: t0 });
  const openByWorkflow = new Map();
  for (const d of occ.dispatches) openByWorkflow.set(d.workflow, (openByWorkflow.get(d.workflow) ?? 0) + 1);
  // The backfill filler (pump/backfill.mjs, A1): free slots the due list
  // leaves are given to the frame's oldest results, ranked below all due work.
  let fill = [];
  if (backfill) {
    const lanes = Object.fromEntries(Object.entries(config.workflows).filter(([name]) => !paused.has(name)));
    const since = typeof db.attemptsSinceResult === 'function' ? db.attemptsSinceResult() : new Map();
    const candidates = backfillCandidates({ ...inputs, workflows: lanes }, { exclude: new Set(due.map((d) => `${d.subject}\u0000${d.workflow}`)), holdRunKeys, since });
    fill = backfillFor({ candidates, due, workflows: lanes, freeSlots: workerSlots - occ.slots, openByWorkflow, reserve: reserveSlots(config.tiers) });
    summary.backfill = fill.length;
  }
  if (due.length === 0 && fill.length === 0) return summary;

  const shards = planShards([...due, ...fill], config.workflows, { openByWorkflow });
  summary.planned = shards.length;

  // 1. Reserve: for each shard, while a slot is free, take the slot and the
  // leases and record the dispatch as pending. Nothing is sent yet.
  const reserved = [];
  const shaByRef = new Map(); // `${repo}@${ref}` -> commit SHA, once per tick
  const toolShaByLane = new Map(); // lane -> the full commit of its own pin (R-PIN-01), once per tick
  const labelWarned = new Set();
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
    // R-PIN-01: the worker runs its branch head unless told otherwise. On a
    // pin_check "enforce" lane the pump sends the full commit of the lane's
    // own pin (tool_sha), which the worker checks out and runs; a pin that
    // cannot be resolved is not dispatched. On a "label" lane nothing is sent,
    // and a pin that is not the branch head is said once a tick: until the
    // worker runs the pin, ingest refuses only what contradicts it.
    let toolSha = null;
    const own = selfPin(wf);
    if (own && pinCheckMode(wf) === 'enforce') {
      try {
        if (!toolShaByLane.has(shard.workflow)) {
          if (typeof dispatcher?.resolveCommit !== 'function') throw new Error('the dispatcher cannot resolve a commit pin');
          toolShaByLane.set(shard.workflow, await dispatcher.resolveCommit({ repo: wf.repo, sha: own.pin }));
        }
        toolSha = toolShaByLane.get(shard.workflow);
      } catch (err) {
        log(`cannot resolve ${shard.workflow}'s pinned commit ${own.name} ${own.pin}; not dispatching it this tick: ${err?.message ?? err}`);
        const stop = stopReason(err);
        if (stop) {
          summary.stopped = stop;
          break;
        }
        refSkip.add(shard.workflow);
        summary.skippedWorkflows.push(shard.workflow);
        continue;
      }
    } else if (own && workflowSha && !workflowSha.startsWith(own.pin) && !labelWarned.has(shard.workflow)) {
      labelWarned.add(shard.workflow);
      log(`${shard.workflow}: pin_check is "label" and ${wf.repo} ${wf.ref} is at ${workflowSha.slice(0, 12)}, not the pinned ${own.name} ${own.pin}: its results are filed under the pin but run the branch head (R-PIN-01)`);
    }
    // A control lane's subject names its own worker file and fixed inputs (pump/controls.mjs).
    const control = controlTarget(wf, shard.items[0].subject);
    const workflowFile = control?.file ?? wf.file;
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
      // subject: the key the result is recorded under; subject_name: the
      // current owner/name, what the worker clones or reads (schema v8).
      if (l.acquired) leased.push({ run_key: it.run_key, subject: it.subject, subject_name: it.name ?? it.subject, fence: l.fence, sha: it.fields?.sha ?? null });
    }
    if (leased.length === 0) {
      db.releaseSlotForAttempt(attemptId, 'nothing_leased', { now: t });
      continue;
    }
    try {
      db.createDispatch({
        attemptId, shardId, workflow: shard.workflow, repo: wf.repo, workflowFile, ref: wf.ref,
        expires: t + ttlMs, items: leased, workflowSha, now: t,
      });
    } catch (err) {
      for (const l of leased) db.releaseLease(l.run_key, attemptId, l.fence, { now: t });
      db.releaseSlotForAttempt(attemptId, 'failed', { now: t });
      for (const r of reserved) db.failDispatch(r.attemptId, { error: 'not sent: the tick failed before sending', withdrawn: true, now: now() });
      throw err;
    }
    reserved.push({ shard, wf, attemptId, shardId, leased, workflowSha, toolSha, control, workflowFile, runner: shard.runner ?? null });
  }
  if (reserved.length === 0) return summary;

  // 2. Make the reservations durable before anything is sent (R-ING-10): a
  // worker run the saved state does not know about would run outside the slot
  // ledger, and its fences would be handed out again. If the save fails,
  // nothing is sent and the reservations are withdrawn.
  const withdraw = (list, why) => {
    for (const r of list) {
      db.failDispatch(r.attemptId, { error: `not sent: ${why}`, withdrawn: true, now: now() });
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
    const { shard, wf, attemptId, shardId, leased, workflowSha, toolSha, control, workflowFile, runner } = reserved[i];
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
      const inputs = workerInputs({ shardId, attemptId, items: leased, toolSha, sendSha: wf.send_sha === true, style: wf.dispatch_style ?? null, extra: control?.inputs ?? null, runner });
      const out = await dispatcher.dispatch({ repo: wf.repo, workflowFile, ref: wf.ref, inputs, shardId });
      // The expected commit was recorded at creation; markDispatched keeps it.
      db.markDispatched(attemptId, { runId: out?.runId ?? null, runUrl: out?.runUrl ?? null, correlatedBy: out?.correlatedBy ?? null, now: now() });
      summary.dispatched += 1;
      log(`dispatched ${shardId}: ${leased.length} item(s) to ${wf.repo} ${workflowFile}${out?.runId ? `, run ${out.runId}` : ', run not matched yet'}`);
    } catch (err) {
      const message = String(err?.message ?? err);
      summary.failed += 1;
      if (ambiguous(err)) {
        // A server error or a lost connection after the request went out: GitHub
        // may have started the run anyway (R-CHAOS-05). The dispatch stays
        // pending with its slot and leases, as if the pump had died after
        // sending (R-ING-10): ingest finds its run by name if there is one,
        // and otherwise its lease expires and the work is due again. Freeing
        // them now would let a run the slot ledger does not count go on, its
        // result never judged, while the same work is sent again.
        summary.unconfirmed = (summary.unconfirmed ?? 0) + 1;
        db.noteUnconfirmedDispatch(attemptId, { status: Number(err?.status) || null, now: now() });
        log(`dispatch of ${shardId} may or may not have started a run (${message}); it stays pending until ingest finds its run or its lease expires`);
      } else {
        db.failDispatch(attemptId, { error: message, status: Number(err?.status) || null, now: now() });
        log(`dispatch of ${shardId} failed: ${message}`);
      }
      const stop = stopReason(err);
      if (stop) {
        summary.stopped = stop;
        withdraw(reserved.slice(i + 1), `dispatching stopped (${stop})`);
        break;
      }
      // A lead re-check shard sent with its own runner input (leads/recheck.mjs) may fail for that input alone (a
      // worker that does not declare it): the lane's other shards still go. Its dispatch counts against the lead's
      // re-check attempts (recheckPairs), so it is not sent for ever.
      if (runner) continue;
      skip.add(shard.workflow);
      summary.skippedWorkflows.push(shard.workflow);
    }
  }
  return summary;
}
