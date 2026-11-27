// The sampling hook for tier cells in `mode: sample` (pump/tiers.json).
//
// A sample cell is due only when this hook picks the pair. The pick is
// deterministic: a stable hash of (subject id, workflow, ISO week) gives each
// pair a score in [0, 1) for the week; the pair is picked when its score is
// below the rate of its tier. The same inputs always give the same pick, so
// every pump run in a week agrees, nothing is re-rolled after a restart, and
// the sample changes only when the week turns.
//
// Rate and cap per tier come from repository variables passed to the pump as
// SAMPLE_RATE_T<n> (0 to 1) and SAMPLE_CAP_T<n> (most pairs per workflow per
// week). An unset, empty, negative or unreadable rate is 0: nothing is picked.
// An unset or unreadable cap is DEFAULT_CAP. With the rate at 0 (the shipped
// state) the hook picks nothing and the due list is as it was.
//
// The cap keeps the lowest scores: of the pairs under the rate in a tier and
// workflow, only the `cap` with the lowest scores (ties by subject id) are
// picked, so the cap never reshuffles the sample inside a week.
//
// A picked pair is due once per week: when its last accepted result is from
// this week the hook says no.

import { createHash } from 'node:crypto';

export const DEFAULT_CAP = 25;
export const SAMPLE_TIERS = Object.freeze([1, 2, 3, 4]);
const WEEK_MS = 7 * 86_400_000;

/** The ISO week of a time as 'YYYY-Www' (UTC, Monday first). */
export function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Midnight UTC on the Monday of the ISO week that contains ms. */
export function weekStartMs(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** The pair's score for the week, in [0, 1). */
export function sampleScore(subject, workflow, week) {
  const h = createHash('sha256').update(`${subject}\u0000${workflow}\u0000${week}`).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}

/** A rate from a variable: a number in [0, 1], else 0. */
export function parseRate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

/** A cap from a variable: a whole number >= 0, else DEFAULT_CAP. */
export function parseCap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_CAP;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return DEFAULT_CAP;
  return Number(s);
}

/** {rates: {1: r, ...}, caps: {1: c, ...}} from SAMPLE_RATE_T<n> and SAMPLE_CAP_T<n>. */
export function samplingFromEnv(env = process.env) {
  const rates = {};
  const caps = {};
  for (const t of SAMPLE_TIERS) {
    rates[t] = parseRate(env[`SAMPLE_RATE_T${t}`]);
    caps[t] = parseCap(env[`SAMPLE_CAP_T${t}`]);
  }
  return { rates, caps };
}

/**
 * The pairs picked for a tier and workflow in a week: score under the rate,
 * lowest `cap` scores kept.
 * @param {string[]} ids  active subject ids of the tier
 * @param {Function} [score]  the scoring function; only the mutation check replaces it
 * @returns {Set<string>}
 */
export function pickedSet({ ids, workflow, week, rate, cap, score = sampleScore }) {
  if (!(rate > 0) || !(cap > 0)) return new Set();
  const under = [];
  for (const id of ids) {
    const sc = score(id, workflow, week);
    if (sc < rate) under.push({ id, score: sc });
  }
  under.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(under.slice(0, cap).map((x) => x.id));
}

/**
 * The hook. `population()` returns the active subjects ({id, tier}); it is read
 * once per tier, workflow and week.
 * @returns {(subject: object, workflow: string, ctx: object) => boolean}
 */
export function createCellSampler({ rates = {}, caps = {}, population }) {
  const cache = new Map();
  return (subject, workflow, ctx) => {
    if (ctx?.cell?.mode !== 'sample') return false;
    const tier = subject.tier;
    const rate = Number(rates[tier] ?? 0);
    if (!(rate > 0)) return false;
    const week = isoWeek(ctx.now);
    const key = `${tier}\u0000${workflow}\u0000${week}`;
    let picked = cache.get(key);
    if (!picked) {
      for (const k of cache.keys()) if (!k.endsWith(`\u0000${week}`)) cache.delete(k);
      const ids = population().filter((s) => s.tier === tier).map((s) => s.id);
      picked = pickedSet({ ids, workflow, week, rate, cap: Number(caps[tier] ?? DEFAULT_CAP) });
      cache.set(key, picked);
    }
    if (!picked.has(subject.id)) return false;
    // Once per week: a result accepted this week is the week's sample.
    const last = ctx.last?.accepted_at ? Date.parse(ctx.last.accepted_at) : null;
    if (last !== null && last >= weekStartMs(ctx.now)) return false;
    return true;
  };
}

/** The hooks object for the pump: the defaults plus the cell sampler. */
export function samplingHooks({ env = process.env, population }) {
  const { rates, caps } = samplingFromEnv(env);
  return { cellSample: createCellSampler({ rates, caps, population }) };
}

/** Active subjects ({id, tier}) of a state store: not retired, gone or merged into another. */
export function activeSubjects(db) {
  return db.listSubjects().filter((s) => s.retired_at == null && s.gone_at == null && s.alias_of == null).map((s) => ({ id: s.id, tier: s.tier }));
}
