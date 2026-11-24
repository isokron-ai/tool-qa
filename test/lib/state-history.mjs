// A seeded generator of loop state with weeks of history, for the prune tests
// (test/state-prune.test.mjs). It drives the real state store the way the
// pump and ingest do: leases, slots, dispatches (sent, failed, expired,
// closed with items unreported), results of every kind (accepted, skips_only,
// counted rejections, retry_later, retry_throttled, identity rejections, late
// results inside and outside the lease), new tool versions and new commits
// (new run_key generations), forged results for unknown attempts, and ingest
// failure counters.

import { openState } from '../../state/db.mjs';
import { dueFromState, loadConfig } from '../../pump/due.mjs';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const T0 = Date.parse('2026-10-01T00:00:00Z');
export const WORKFLOW = 'scan-static';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { tiers: TIERS } = loadConfig();

/** The workflow config at tool version v. */
export function workflowsAt(v) {
  return { [WORKFLOW]: { enabled: true, runs_untrusted: false, versions: { tool: { 'mcp-check': `1.${v}.0` }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default' } };
}

export const tiers = TIERS;

/**
 * Build a state with `days` of history. Returns { db, now, config } where
 * `now` is the end time and `config` the workflow config then.
 */
export function buildHistory({ seed = 1, days = 21, subjects = 10, file = ':memory:', ttlMs = 45 * MIN, lateMs = 6 * HOUR } = {}) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const db = openState(file);
  let v = 1;
  const shas = [];
  for (let i = 0; i < subjects; i++) {
    shas.push(0);
    db.setSubjectVersion({ id: `org/server-${i}`, kind: 'github', source: 'seed:test', tier: i % 4, sha: `sha-${i}-0`, now: T0 });
  }
  let t = T0;
  let n = 0;
  const end = T0 + days * DAY;
  while (t < end) {
    t += Math.floor(10 * MIN + rand() * 40 * MIN);
    if (rand() < 0.03) v += 1; // a new tool version: every run_key moves
    if (rand() < 0.08) {
      const i = Math.floor(rand() * subjects);
      shas[i] += 1;
      db.setSubjectVersion({ id: `org/server-${i}`, kind: 'github', source: 'seed:test', tier: i % 4, sha: `sha-${i}-${shas[i]}`, now: t });
    }
    if (rand() < 0.02) db.noteChange(`org/server-${Math.floor(rand() * subjects)}`, { reason: 'advisory', now: t });
    const workflows = workflowsAt(v);
    db.reapExpiredDispatches({ now: t });

    // Results for live dispatches.
    for (const d of db.openDispatches({ now: t })) {
      if (rand() < 0.25) continue; // still running
      const a = db.getAttempt(d.attempt_id);
      if (rand() < 0.15) {
        db.closeDispatch(d.attempt_id, { reason: 'run_failed', now: t });
        continue;
      }
      for (const it of a.items) {
        if (it.outcome !== null) continue;
        if (rand() < 0.1) continue; // never reported: the run closes the rest
        const r = rand();
        const base = { run_key: it.run_key, attempt_id: d.attempt_id, fence: it.fence, now: t, digest: `sha256:${n++}` };
        if (r < 0.55) db.recordResult({ ...base, verdict: 'accepted', outcome: 'accepted', coverage: pick(['assessed', 'assessed', 'unassessed_tool', 'unassessed_infra', 'subject']), fault: pick([null, null, 'tool', 'infra', 'subject']) });
        else if (r < 0.65) db.recordResult({ ...base, verdict: 'accepted', outcome: 'accepted', resultOutcome: 'skips_only', coverage: 'unassessed_infra', fault: 'infra' });
        else if (r < 0.75) db.recordResult({ ...base, verdict: 'rejected', outcome: 'rejected', reason: pick(['forgery_suspected', 'bad_bundle', 'control_failed']) });
        else if (r < 0.87) db.recordResult({ ...base, verdict: 'rejected', outcome: 'retry_later', reason: 'retry_later' });
        else if (r < 0.95) db.recordResult({ ...base, verdict: 'rejected', outcome: 'retry_throttled', reason: 'retry_throttled' });
        else db.recordResult({ ...base, verdict: 'rejected', outcome: 'rejected', reason: 'run_sha_mismatch' });
        if (rand() < 0.05) db.recordResult({ ...base, verdict: 'accepted', outcome: 'accepted' }); // a repeat: duplicate
      }
      if (rand() < 0.5) db.closeDispatch(d.attempt_id, { reason: 'run_completed', now: t });
      if (rand() < 0.05) db.noteIngestFailure(d.attempt_id, 0, { error: 'boom', now: t });
    }

    // Late results for dispatches that expired within the late window: some
    // finished on time (completedAt before the lease ended), some did not.
    for (const d of db.dispatchesAwaitingResults({ now: t, lateMs })) {
      if (d.status !== 'expired' || rand() < 0.5) continue;
      for (const it of db.getAttempt(d.attempt_id).items) {
        if (it.outcome !== null) continue;
        const onTime = rand() < 0.5;
        db.recordResult({
          run_key: it.run_key, attempt_id: d.attempt_id, fence: it.fence, verdict: 'accepted', outcome: 'accepted', now: t,
          completedAt: Date.parse(d.expires) + (onTime ? -5 * MIN : 5 * MIN), coverage: 'assessed',
        });
      }
    }

    // A forged result for an attempt that does not exist.
    if (rand() < 0.05) db.recordResult({ run_key: 'f'.repeat(64), attempt_id: `forged-${n++}`, fence: 1, verdict: 'accepted', outcome: 'accepted', now: t });

    // New dispatches for due work, one shard of up to three pairs.
    const due = dueFromState(db, { now: t, tiers: TIERS, workflows }).slice(0, 3);
    if (due.length) {
      const attemptId = `att-${String(n++).padStart(6, '0')}`;
      const slot = db.acquireSlot(attemptId, { budget: 15, ttlMs, now: t });
      if (slot !== null) {
        const items = [];
        for (const d of due) {
          const l = db.acquireLease(d.run_key, attemptId, { ttlMs, now: t });
          if (!l.acquired) continue;
          db.recordRunKey(d.run_key, { subject: d.subject, workflow: d.workflow, fields: d.fields, now: t });
          items.push({ run_key: d.run_key, subject: d.subject, fence: l.fence });
        }
        if (items.length) {
          db.createDispatch({
            attemptId, shardId: `s-${attemptId}`, workflow: WORKFLOW, repo: 'isokron-ai/mcp-check', workflowFile: 'scan-static.yml', ref: 'main',
            expires: new Date(t + ttlMs).toISOString(), items, now: t,
          });
          if (rand() < 0.08) db.failDispatch(attemptId, { error: 'HTTP 500', now: t });
          else db.markDispatched(attemptId, { runId: String(9_000_000 + n), correlatedBy: 'response' });
        } else {
          db.releaseSlotForAttempt(attemptId, 'failed', { now: t });
        }
      }
    }
  }
  return { db, now: t, config: { tiers: TIERS, workflows: workflowsAt(v) } };
}
