// Oracle disagreement (loop upgrade #7): where our reader, the live tool list
// and the official SDK clients or conformance suite disagree, our tools are
// weakest, so those subjects are looked at sooner (pump/due.mjs) and their
// fingerprints rank higher in the check-in (longitudinal/checkin.mjs).
//
// Pure functions only. The state store (state/db.mjs noteOracle) keeps the
// facts per (subject, lane) and the derived per-subject disagreement; the
// check-in derives the same from the archive. Both go through this file, so
// the two can never read the oracles differently.
//
// Facts come from two lanes:
//   scan-static  results/scan-static.json: catalog_hash, tool_count (what our
//                reader says the server registers)
//   live-probe   observations: tool_count, tool_list_sha256 (what the server
//                listed to our probe), sdk_client_results (official SDK
//                clients), conformance_checks, oracle_disagreements (the
//                worker's own comparisons, each a lead, never a verdict)
//
// Hashes are not compared across lanes (R-ORD-11): scan-static and live-probe
// both use the checker engine's catalog hash, but the reader's tool list comes
// from source (derived, approximate, names only), so equal hashes are not
// expected even when nothing is wrong. Across lanes only the tool count is
// compared, and only when the reader's list is complete and from the same
// subject version (R-ORD-12). tool_set therefore comes from the worker's own
// comparisons, which are made within one lane, on the wire list.
//
// A disagreement has a kind: tool_set (same count, different tools), tool_count,
// schema (same tools, different definitions), protocol (an official client
// could not initialise or list where our probe did) or conformance (our lint
// against the conformance suite). It is evidence about OUR tool. It is never a
// subject-side finding by itself. Where an oracle shows the server itself is
// wrong (the worker's entry says attribution "server", or the conformance suite
// fails a check while every client and our reader agree), that is recorded as
// server_side evidence and opens no disagreement.

import { createHash } from 'node:crypto';

/** Re-checks with the same disagreement before the due boost stops (foldDisagreement). */
export const ORACLE_MAX_UNCHANGED = 5;
/**
 * At most this many re-check cycles with a disagreement present per subject in
 * ORACLE_BUDGET_DAYS, however often it clears and comes back: more than that
 * settles it (R-ORD-13). A server that flaps cannot hold the 1-day re-checks
 * and the weight for ever.
 */
export const ORACLE_BUDGET_MAX = 6;
export const ORACLE_BUDGET_DAYS = 30;
export const KINDS = Object.freeze(['tool_set', 'tool_count', 'schema', 'protocol', 'conformance']);
/** The design classes of the worker's oracle_disagreements (DESIGN-v3 D4, D6, D7, D12) and the kind each stands for. */
const CLASS_KIND = Object.freeze({
  D4: 'schema', schema_mismatch: 'schema', D6: 'tool_set', live_client: 'tool_set',
  D7: 'conformance', lint_vs_conformance: 'conformance', D12: 'protocol', crash: 'protocol', timeout: 'protocol',
});
/** SDK client outcomes where the client failed on a server our probe could list. */
const CLIENT_FAILED = new Set(['init_failed', 'list_failed']);
/** The lanes that carry oracle facts. */
export const ORACLE_LANES = Object.freeze(['scan-static', 'live-probe']);
const MAX_ITEMS = 16;
const MAX_TEXT = 64;

const text = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/.test(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const hash = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

/**
 * The oracle facts of one accepted bundle, or null when its lane carries none.
 * @param {string} lane  'scan-static' or 'live-probe'
 * @param {(field: string) => any} get  the value of an observed field (null when absent)
 * @param {object|null} result  the lane's results/<lane>.json
 */
export function oracleFacts(lane, get, result = null) {
  if (lane === 'scan-static') {
    if (!result || result.status !== 'graded') return null;
    const h = hash(result.catalog_hash);
    if (!h) return null;
    const l = result.list ?? {};
    // Complete: the reader saw every tool by name from a source it trusts.
    const complete = Boolean(result.list) && l.approximate !== true && l.fidelity !== 'names' && !(l.tools_left_out > 0) && !(l.unresolved_names > 0)
      && !(l.registration_not_seen > 0) && l.listing_truncated !== true && result.listing?.truncated !== true && result.listing?.budget_hit !== true;
    return { lane, tool_list_sha256: h, tool_count: int(result.tool_count), complete };
  }
  if (lane !== 'live-probe') return null;
  const h = hash(get('tool_list_sha256'));
  const sdk = (Array.isArray(get('sdk_client_results')) ? get('sdk_client_results') : []).slice(0, MAX_ITEMS).filter((e) => e && typeof e === 'object').map((e) => ({
    client: text(e.client) ?? '?', outcome: text(e.outcome), tool_count: int(e.tool_count), catalog_vs_reader: text(e.catalog_vs_reader),
  }));
  const checks = Array.isArray(get('conformance_checks')) ? get('conformance_checks') : [];
  const worker = (Array.isArray(get('oracle_disagreements')) ? get('oracle_disagreements') : []).slice(0, MAX_ITEMS).filter((e) => e && typeof e === 'object').map((e) => ({
    class: text(e.class), kind: text(e.kind), oracles: (Array.isArray(e.oracles) ? e.oracles : []).map(text).filter(Boolean).slice(0, 4), attribution: text(e.attribution),
  }));
  if (!h && sdk.length === 0 && checks.length === 0 && worker.length === 0) return null;
  return {
    lane, tool_list_sha256: h, tool_count: int(get('tool_count')), sdk,
    conformance_failed: checks.filter((c) => c && c.status === 'fail' && c.scored !== false).length, worker,
  };
}

/**
 * The disagreements of one subject from its latest facts per lane.
 * @param {{static?: object|null, live?: object|null, version?: string|null}} facts  version: the subject version of the newest result; lanes of another version are left out. Without it, the lanes are compared only when they share a version.
 * @returns {{kinds: {kind: string, oracles: string[]}[], server_side: string[], signature: string|null}}
 *   kinds: sorted, one entry per (kind, oracle pair); signature: sha256 of kinds, null when none
 */
export function deriveDisagreements({ static: st = null, live = null, version = undefined } = {}) {
  const found = new Map();
  const server = new Set();
  const add = (kind, oracles) => { const o = [...oracles].sort(); found.set(`${kind}\u0000${o.join(',')}`, { kind, oracles: o }); };

  // A lane whose facts are of another subject version than `version` (the newest result's) is stale: left out (R-ORD-12).
  if (version !== undefined) {
    if (st && st.version !== version) st = null;
    if (live && live.version !== version) live = null;
  } else if (st && live && st.version !== live.version) {
    st = null;
  }
  if (st?.complete === true && st.tool_count !== null && live?.tool_count !== null && live?.tool_count !== undefined && st.tool_count !== live.tool_count) {
    add('tool_count', ['reader', 'live']);
  }
  if (live) {
    for (const c of live.sdk ?? []) {
      if (c.outcome === 'listed') {
        if (c.tool_count !== null && live.tool_count !== null && c.tool_count !== live.tool_count) add('tool_count', [`sdk:${c.client}`, 'live']);
        else if (c.catalog_vs_reader === 'different') add('schema', [`sdk:${c.client}`, 'reader']);
      } else if (CLIENT_FAILED.has(c.outcome) && live.tool_count !== null) add('protocol', [`sdk:${c.client}`, 'live']);
    }
    for (const w of live.worker ?? []) {
      if (w.attribution === 'server') { server.add(w.kind ?? w.class ?? 'worker_entry'); continue; }
      const kind = KINDS.includes(w.kind) ? w.kind : CLASS_KIND[w.class] ?? null;
      if (kind) add(kind, w.oracles.length ? w.oracles : ['worker']);
    }
    // A failed scored conformance check while the clients and our reader agree is the server's own failure.
    if (live.conformance_failed > 0 && ![...found.values()].some((d) => d.kind === 'conformance')) server.add('conformance_fail');
  }
  const kinds = [...found.values()].sort((a, b) => (a.kind + a.oracles).localeCompare(b.kind + b.oracles));
  const signature = kinds.length ? createHash('sha256').update(JSON.stringify(kinds)).digest('hex') : null;
  return { kinds, server_side: [...server].sort().map((s) => s.slice(0, MAX_TEXT)), signature };
}

/**
 * Fold one subject's derived disagreement into its stored record.
 * @param {{status: string, signature: string, unchanged_rechecks: number}|null} prior  the stored row, or null
 * @param {{kinds: object[], signature: string|null}} now
 * @param {{maxUnchanged: number, cycle: boolean}} cfg  maxUnchanged: re-check cycles without a change before the boost stops;
 *   cycle: this result completes a check cycle (every lane with facts has reported), so it counts as one re-check (R-ORD-13)
 * @returns {{status: 'open'|'cleared'|'settled'|null, unchanged_rechecks: number, reason: string|null}}
 *   null status: nothing to store (no disagreement and none stored)
 */
export function foldDisagreement(prior, now, { maxUnchanged = ORACLE_MAX_UNCHANGED, cycle = true } = {}) {
  if (!now.signature) {
    if (!prior || prior.status === 'cleared') return { status: prior ? 'cleared' : null, unchanged_rechecks: 0, reason: prior ? prior.reason ?? null : null };
    return { status: 'cleared', unchanged_rechecks: 0, reason: 'oracles_agree' };
  }
  if (!prior || prior.status === 'cleared' || prior.signature !== now.signature) return { status: 'open', unchanged_rechecks: 0, reason: null };
  if (prior.status === 'settled') return { status: 'settled', unchanged_rechecks: prior.unchanged_rechecks, reason: 'unchanged_rechecks' };
  const n = prior.unchanged_rechecks + (cycle ? 1 : 0);
  return n >= maxUnchanged ? { status: 'settled', unchanged_rechecks: n, reason: 'unchanged_rechecks' } : { status: 'open', unchanged_rechecks: n, reason: null };
}

const parseJson = (buf) => { try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); } catch { return null; } };

/** The first non-null value of each field in a bundle's observations/*.ndjson. files: iterable of [path, data]. */
export function observedFields(files) {
  const fields = new Map();
  for (const [path, data] of files) {
    if (!/^observations\/[^/]+\.ndjson$/.test(path)) continue;
    for (const line of (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).split('\n')) {
      if (!line.trim()) continue;
      const r = parseJson(line);
      if (r && typeof r.field === 'string' && r.value !== null && r.value !== undefined && !fields.has(r.field)) fields.set(r.field, r.value);
    }
  }
  return fields;
}

/** oracleFacts() of an accepted bundle's files (a Map of path to bytes): null for a lane with none. Never throws. */
export function oracleFactsFromFiles(lane, files) {
  try {
    if (!ORACLE_LANES.includes(lane)) return null;
    const fields = observedFields(files);
    const raw = files.get(`results/${lane}.json`);
    return oracleFacts(lane, (k) => fields.get(k) ?? null, raw ? parseJson(raw) : null);
  } catch {
    return null;
  }
}
