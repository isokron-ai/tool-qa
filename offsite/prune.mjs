#!/usr/bin/env node
// Off-site prune: free room in the R2 bucket when it nears the cost cap.
// Off by default; see docs/OPERATIONS.md, "Off-site backup".
//
//   node offsite/prune.mjs --mode dry-run|apply
//
// Nothing happens while the bucket holds at most OFFSITE_PRUNE_AT_BYTES
// (default 85% of OFFSITE_MAX_BYTES). Above it, objects are deleted until the
// bucket is down to OFFSITE_PRUNE_TO_BYTES (default 70% of the cap), in this
// order, oldest first within each group:
//   1. history/              public registry and package data
//   2. _state/cursor/        old cursors (the newest 10 are kept)
//   3. snapshot-manifests/   old copies of the snapshot manifest (the newest 10 are kept)
//   4. ingest/               sealed loop results
//   5. snapshots/            state snapshots, never the newest OFFSITE_PRUNE_KEEP_SNAPSHOTS (default 48)
// Only objects last written more than 31 days ago are candidates: the
// bucket's lock rule (keep-30-days) refuses any delete before 30 days, and a
// day of margin covers clock skew. The run manifests under manifest/ are
// never deleted; they are the record of what was copied when.
//
// If deleting every candidate still leaves the bucket over the target, the
// run says so (the rest is still under the lock) and exits 1. Apply deletes
// nothing, and exits 1, when the listing looks cut short: a page marked
// truncated with no continuation token, or the newest cursor or run manifest
// (each listed on its own) missing from it.
//
// Environment: the same R2_* settings as offsite/backup.mjs, OFFSITE_MAX_BYTES,
// OFFSITE_PRUNE_AT_BYTES, OFFSITE_PRUNE_TO_BYTES, OFFSITE_PRUNE_KEEP_SNAPSHOTS,
// GITHUB_STEP_SUMMARY.

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scrub as scrubText } from '../pump/github.mjs';
import { DEFAULTS, PREFIX, inventory, meter, readConfig } from './backup.mjs';

const DAY = 24 * 3_600_000;
export const LOCK_DAYS = 30;
export const MARGIN_DAYS = 1;
export const KEEP_CURSORS = 10;
export const KEEP_SNAPSHOT_MANIFESTS = 10;
export const KEEP_SNAPSHOTS = 48;
export const ORDER = Object.freeze([PREFIX.history, PREFIX.cursor, PREFIX.snapshotManifests, PREFIX.ingest, PREFIX.snapshots]);

/** The prune thresholds from the environment (defaults from the cap). */
export function pruneLimits(env, maxBytes = DEFAULTS.maxBytes) {
  const num = (name, fallback) => {
    const raw = String(env[name] ?? '').trim();
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback;
  };
  const at = num('OFFSITE_PRUNE_AT_BYTES', Math.floor(maxBytes * 0.85));
  const to = Math.min(num('OFFSITE_PRUNE_TO_BYTES', Math.floor(maxBytes * 0.7)), at);
  return { at, to, keepSnapshots: num('OFFSITE_PRUNE_KEEP_SNAPSHOTS', KEEP_SNAPSHOTS) };
}

/**
 * Which objects to delete. Pure: takes the bucket listing.
 * @returns {{ total: number, needed: boolean, delete: object[], freed: number, after: number, reachesTarget: boolean, kept: object }}
 */
export function planPrune(objects, { now, at, to, keepSnapshots = KEEP_SNAPSHOTS, lockDays = LOCK_DAYS, marginDays = MARGIN_DAYS }) {
  const total = objects.reduce((s, o) => s + (Number(o.size) || 0), 0);
  const plan = { total, needed: total > at, delete: [], freed: 0, after: total, reachesTarget: total <= to, kept: { locked: 0, protected: 0 } };
  if (!plan.needed) return plan;
  const cutoff = now - (lockDays + marginDays) * DAY;
  const time = (o) => Date.parse(o.lastModified ?? '');
  const newestFirst = (list) => [...list].sort((a, b) => b.key.localeCompare(a.key));
  const protectedKeys = new Set();
  const under = (prefix) => objects.filter((o) => o.key.startsWith(prefix));
  for (const o of newestFirst(under(PREFIX.cursor)).slice(0, KEEP_CURSORS)) protectedKeys.add(o.key);
  for (const o of newestFirst(under(PREFIX.snapshotManifests)).slice(0, KEEP_SNAPSHOT_MANIFESTS)) protectedKeys.add(o.key);
  // Snapshot keys are snapshots/<day>/state-<time>-<sha8>.sqlite.age: by name is by time.
  const snaps = [...under(PREFIX.snapshots)].sort((a, b) => b.key.split('/').pop().localeCompare(a.key.split('/').pop()));
  for (const o of snaps.slice(0, keepSnapshots)) protectedKeys.add(o.key);
  for (const prefix of ORDER) {
    const group = under(prefix).sort((a, b) => (time(a) || 0) - (time(b) || 0) || a.key.localeCompare(b.key));
    for (const o of group) {
      if (plan.after <= to) break;
      if (protectedKeys.has(o.key)) {
        plan.kept.protected += 1;
        continue;
      }
      if (!Number.isFinite(time(o)) || time(o) > cutoff) {
        plan.kept.locked += 1;
        continue;
      }
      plan.delete.push(o);
      plan.freed += Number(o.size) || 0;
      plan.after -= Number(o.size) || 0;
    }
  }
  plan.reachesTarget = plan.after <= to;
  return plan;
}

/**
 * Why the full listing cannot be trusted to delete from, or null: the newest
 * cursor and the newest run manifest, each listed on its own, must both be in
 * it (a listing cut short loses its tail, and `manifest/` sorts late).
 */
export async function listingProblem(m, inv) {
  for (const prefix of [PREFIX.cursor, PREFIX.manifest]) {
    const own = await inventory(m, prefix);
    if (!own.objects.length) return `no ${prefix} object in the bucket: the backup has not run yet, nothing to protect against`;
    const newest = own.objects.map((o) => o.key).sort().at(-1);
    if (!inv.byKey.has(newest)) return `the full listing lacks the newest ${prefix} key ${newest}: it looks cut short`;
  }
  return null;
}

/** List, plan, and (in apply mode) delete. Apply refuses a listing that looks cut short. */
export async function runPrune({ store, mode, limits, now = Date.now, log = () => {} }) {
  const m = meter(store, { maxClassA: Infinity, maxClassB: Infinity });
  const inv = await inventory(m);
  const plan = planPrune(inv.objects, { now: now(), ...limits });
  if (mode === 'apply' && plan.delete.length) {
    const problem = await listingProblem(m, inv);
    if (problem) return { mode, plan, deleted: [], failed: [], refused: problem, ops: m.counts() };
  }
  const deleted = [];
  const failed = [];
  if (mode === 'apply') {
    for (const o of plan.delete) {
      try {
        await m.delete(o.key);
        deleted.push(o.key);
      } catch (err) {
        failed.push({ key: o.key, error: String(err?.message ?? err).slice(0, 200) });
        log(`offsite-prune: could not delete ${o.key}: ${err?.message ?? err}`);
      }
    }
  }
  return { mode, plan, deleted, failed, ops: m.counts() };
}

function parseArgs(argv) {
  let mode = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && i + 1 < argv.length) mode = argv[++i];
    else return { error: `unknown argument ${JSON.stringify(argv[i])}` };
  }
  if (mode !== 'dry-run' && mode !== 'apply') return { error: '--mode must be dry-run or apply' };
  return { mode };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`offsite-prune: ${args.error}\n`);
    return 2;
  }
  const cfg = readConfig(env);
  const secrets = [cfg.accessKeyId, cfg.secretAccessKey, cfg.accountId];
  const say = (line) => process.stderr.write(`${scrubText(line, secrets)}\n`);
  if (env.GITHUB_ACTIONS === 'true' && cfg.accountId) process.stdout.write(`::add-mask::${cfg.accountId}\n`);
  if (!cfg.configured) {
    say(`offsite-prune: not configured yet (${cfg.missing.join(', ')} not set); nothing to prune`);
    return 0;
  }
  if (cfg.problems.length) {
    say(`offsite-prune: ${cfg.problems.join('; ')}`);
    return 1;
  }
  let store;
  try {
    store = deps.store ?? (await (await import('./store-r2.mjs')).createR2Store(cfg));
    const limits = pruneLimits(env, cfg.limits.maxBytes);
    const r = await runPrune({ store, mode: args.mode, limits, now: deps.now ?? Date.now, log: say });
    const gb = (b) => `${(b / 1e9).toFixed(3)} GB`;
    const verb = args.mode === 'apply' ? 'deleted' : 'would delete';
    const lines = [
      `**Off-site prune (${args.mode})**`,
      '',
      `- bucket: ${gb(r.plan.total)}; prune above ${gb(limits.at)}, down to ${gb(limits.to)}`,
      r.plan.needed ? `- ${verb} ${r.plan.delete.length} object(s), ${gb(r.plan.freed)}; left: ${gb(r.plan.after)}` : '- nothing to do',
      ...(r.plan.needed && !r.plan.reachesTarget ? [`- the rest is still under the 30-day lock or protected (${r.plan.kept.locked} locked, ${r.plan.kept.protected} protected)`] : []),
      ...r.failed.map((f) => `- FAILED ${f.key}: ${f.error}`),
      ...(r.refused ? [`- REFUSED to delete: ${r.refused}`] : []),
    ].map((l) => scrubText(l, secrets));
    for (const o of r.plan.delete) say(`offsite-prune: ${verb} ${o.key} (${o.size} bytes, written ${o.lastModified})`);
    say(lines.slice(2).join('\n'));
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    return r.refused || r.failed.length || (r.plan.needed && !r.plan.reachesTarget) ? 1 : 0;
  } catch (err) {
    say(`offsite-prune: ${err?.message ?? err}`);
    return 1;
  } finally {
    store?.destroy?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
