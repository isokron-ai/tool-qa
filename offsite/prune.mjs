#!/usr/bin/env node
// Off-site prune: free room in the R2 bucket when it nears the cost cap.
// Off by default; see docs/OPERATIONS.md, "Off-site backup".
//
//   node offsite/prune.mjs --mode dry-run|apply
//
// While the bucket holds at most OFFSITE_PRUNE_AT_BYTES (default 85% of
// OFFSITE_MAX_BYTES) only the expiry below happens. Above it, objects are deleted until the
// bucket is down to OFFSITE_PRUNE_TO_BYTES (default 70% of the cap), in this
// order, oldest first within each group:
//   1. _state/cursor/        old cursors (the newest 10 are kept)
//   2. snapshot-manifests/   old copies of the snapshot manifest (the newest 10 are kept)
//   3. ingest/               full sealed bundles
//   4. snapshots/            state snapshots, never the newest OFFSITE_PRUNE_KEEP_SNAPSHOTS (default 48)
// The keep-forever set (keep/, history/) is never deleted, and neither is an
// artifact on the hold list (offsite/holds.mjs). Separately from the cap, a full
// bundle past 30 days that has its keep-forever copy is expired whatever the
// bucket's size (loop upgrade 20). A full bundle with no copy (from before that
// upgrade) is only taken with OFFSITE_PRUNE_LEGACY_INGEST=true.
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
import { artifactOfKey, isHeld, readHolds } from './holds.mjs';

const DAY = 24 * 3_600_000;
export const LOCK_DAYS = 30;
export const MARGIN_DAYS = 1;
export const KEEP_CURSORS = 10;
export const KEEP_SNAPSHOT_MANIFESTS = 10;
export const KEEP_SNAPSHOTS = 48;
// Never in this list: keep/ (the keep-forever part of the ingest outputs) and history/ (history artifacts),
// the keep-forever set; and manifest/, the record of what was copied when.
export const ORDER = Object.freeze([PREFIX.cursor, PREFIX.snapshotManifests, PREFIX.ingest, PREFIX.snapshots]);

/** The artifact name that pairs a full bundle with its keep-forever copy: ingest-<run>-<attempt> to ingest-keep-<run>-<attempt>. */
const pairedKeepName = (key) => {
  const m = /^ingest-(\d+-\d+)$/.exec(artifactOfKey(key) ?? '');
  return m ? `ingest-keep-${m[1]}` : null;
};

/** The prune thresholds from the environment (defaults from the cap). */
export function pruneLimits(env, maxBytes = DEFAULTS.maxBytes) {
  const num = (name, fallback) => {
    const raw = String(env[name] ?? '').trim();
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback;
  };
  const at = num('OFFSITE_PRUNE_AT_BYTES', Math.floor(maxBytes * 0.85));
  const to = Math.min(num('OFFSITE_PRUNE_TO_BYTES', Math.floor(maxBytes * 0.7)), at);
  return { at, to, keepSnapshots: num('OFFSITE_PRUNE_KEEP_SNAPSHOTS', KEEP_SNAPSHOTS), legacy: String(env.OFFSITE_PRUNE_LEGACY_INGEST ?? '') === 'true' };
}

/**
 * Which objects to delete. Pure: takes the bucket listing.
 *
 * Two passes, both only past the bucket's lock (30 days plus a day of margin):
 *   expiry   every full ingest bundle that has its keep-forever copy (ingest-keep-<run>-<attempt>)
 *            and no hold: full raw data lives 30 days, whatever the bucket's size;
 *   cap      only while the bucket is over `at`, down to `to`: the groups in ORDER, oldest first.
 * The keep-forever set (keep/, history/) is in neither, and a held artifact is never deleted. A full
 * bundle with no keep-forever copy (made before loop upgrade 20) is only deleted when `legacy` is set.
 * @returns {{ total: number, needed: boolean, delete: object[], freed: number, after: number, reachesTarget: boolean, kept: object }}
 */
export function planPrune(objects, { now, at, to, keepSnapshots = KEEP_SNAPSHOTS, lockDays = LOCK_DAYS, marginDays = MARGIN_DAYS, holds = [], legacy = false }) {
  const total = objects.reduce((s, o) => s + (Number(o.size) || 0), 0);
  const plan = { total, needed: false, delete: [], freed: 0, after: total, reachesTarget: true, kept: { locked: 0, protected: 0, held: 0, unpaired: 0 }, expired: 0 };
  const cutoff = now - (lockDays + marginDays) * DAY;
  const time = (o) => Date.parse(o.lastModified ?? '');
  const newestFirst = (list) => [...list].sort((a, b) => b.key.localeCompare(a.key));
  const gone = new Set();
  const under = (prefix) => objects.filter((o) => o.key.startsWith(prefix));
  const keepNames = new Set(under(PREFIX.keep).map((o) => artifactOfKey(o.key)));
  // ingest-keepgap-<run>-<attempt>: the pump could not write some item's keep-forever file in that run, so the
  // keep artifact does not cover every full bundle of it. Such a run's bundles are treated as having no copy.
  const gapNames = new Set(under(PREFIX.ingest).map((o) => /^ingest-keepgap-(\d+-\d+)$/.exec(artifactOfKey(o.key) ?? '')?.[1]).filter(Boolean).map((id) => `ingest-keep-${id}`));
  const protectedKeys = new Set();
  for (const o of newestFirst(under(PREFIX.cursor)).slice(0, KEEP_CURSORS)) protectedKeys.add(o.key);
  for (const o of newestFirst(under(PREFIX.snapshotManifests)).slice(0, KEEP_SNAPSHOT_MANIFESTS)) protectedKeys.add(o.key);
  // Snapshot keys are snapshots/<day>/state-<time>-<sha8>.sqlite.age: by name is by time.
  const snaps = [...under(PREFIX.snapshots)].sort((a, b) => b.key.split('/').pop().localeCompare(a.key.split('/').pop()));
  for (const o of snaps.slice(0, keepSnapshots)) protectedKeys.add(o.key);
  const take = (o) => {
    gone.add(o.key);
    plan.delete.push(o);
    plan.freed += Number(o.size) || 0;
    plan.after -= Number(o.size) || 0;
  };
  /** Why an object may not go now, or null. */
  const refusal = (o) => {
    if (protectedKeys.has(o.key)) return 'protected';
    if (/^ingest-keepgap-/.test(artifactOfKey(o.key) ?? '')) return 'protected'; // the marker outlives the bundles it guards
    if (isHeld(o.key, holds, now)) return 'held';
    if (!Number.isFinite(time(o)) || time(o) > cutoff) return 'locked';
    const pump = o.key.startsWith(PREFIX.ingest) && /^ingest-\d+-\d+$/.test(artifactOfKey(o.key) ?? '');
    if (pump && gapNames.has(pairedKeepName(o.key))) return 'unpaired'; // never taken, not even with `legacy`
    if (pump && !keepNames.has(pairedKeepName(o.key)) && !legacy) return 'unpaired';
    return null;
  };
  const count = (why) => { plan.kept[why] += 1; };

  // Expiry: pump bundles older than their window that have their keep-forever copy in the bucket
  // (state archives and manual re-ingests have no such copy and are left to the cap pass).
  for (const o of under(PREFIX.ingest).sort((a, b) => (time(a) || 0) - (time(b) || 0) || a.key.localeCompare(b.key))) {
    if (pairedKeepName(o.key) === null) continue;
    const why = refusal(o);
    if (why === 'held' || why === 'unpaired') count(why);
    else if (!why) {
      take(o);
      plan.expired += 1;
    }
  }
  const over = plan.after > at;
  plan.needed = plan.expired > 0 || over;

  // Cap: only while the bucket is still over the threshold.
  if (over) {
    for (const prefix of ORDER) {
      const group = under(prefix).filter((o) => !gone.has(o.key)).sort((a, b) => (time(a) || 0) - (time(b) || 0) || a.key.localeCompare(b.key));
      for (const o of group) {
        if (plan.after <= to) break;
        const why = refusal(o);
        if (why) count(why);
        else take(o);
      }
    }
  }
  plan.reachesTarget = !over || plan.after <= to;
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
export async function runPrune({ store, mode, limits, holds = [], now = Date.now, log = () => {} }) {
  const m = meter(store, { maxClassA: Infinity, maxClassB: Infinity });
  const inv = await inventory(m);
  const plan = planPrune(inv.objects, { now: now(), holds, ...limits });
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
    const held = readHolds(env.OFFSITE_HOLDS_FILE || fileURLToPath(new URL('./holds.json', import.meta.url)));
    if (held.problems.length) {
      say(`offsite-prune: REFUSED, the hold list cannot be read (${held.problems.join('; ')}); nothing is deleted until it can`);
      return 1;
    }
    const r = await runPrune({ store, mode: args.mode, limits, holds: held.holds, now: deps.now ?? Date.now, log: say });
    const gb = (b) => `${(b / 1e9).toFixed(3)} GB`;
    const verb = args.mode === 'apply' ? 'deleted' : 'would delete';
    const lines = [
      `**Off-site prune (${args.mode})**`,
      '',
      `- bucket: ${gb(r.plan.total)}; prune above ${gb(limits.at)}, down to ${gb(limits.to)}`,
      r.plan.needed ? `- ${verb} ${r.plan.delete.length} object(s), ${gb(r.plan.freed)} (${r.plan.expired} full bundle(s) past ${LOCK_DAYS} days); left: ${gb(r.plan.after)}` : '- nothing to do',
      ...(r.plan.kept.held || r.plan.kept.unpaired ? [`- kept: ${r.plan.kept.held} held, ${r.plan.kept.unpaired} full bundle(s) with no keep-forever copy (OFFSITE_PRUNE_LEGACY_INGEST=true lets the prune take those too)`] : []),
      ...(r.plan.needed && !r.plan.reachesTarget ? [`- the rest is still under the 30-day lock or protected (${r.plan.kept.locked} locked, ${r.plan.kept.protected} protected, ${r.plan.kept.held} held, ${r.plan.kept.unpaired} unpaired); the keep-forever set is never deleted`] : []),
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
