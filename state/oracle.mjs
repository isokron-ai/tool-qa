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
// scan-static also carries the ast-grep oracle (O3, mcp-check corpus/ast-grep/): results.oracle_ast_grep (what ast-grep read
// from the same commit's source: status, confidence, tool count) and the worker's own comparison of the reader's names with
// ast-grep's, in the oracle_disagreements field (class D1 static_missing, D2 static_phantom; counts and a fingerprint, no
// names, which stay in the worker). Where ast-grep could not read a registration it says `unreadable`, `none` or `error`:
// that is never a disagreement and never a fault of the subject. Across lanes the three-way rule of DESIGN-v3 section 7
// sets the confidence from counts only: live = ast-grep != reader is a high-confidence bug in our reader; ast-grep = reader
// != live is likely dynamic or gated registration; all three different goes to a human.
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
/**
 * Facts of a subject with no version (neither sha nor artifact digest) are
 * compared across lanes only when they were observed this close together
 * (R-ORD-16). Without a version, "the same version" cannot be told from the
 * facts, so time stands in for it: a months-old scan against a fresh live list
 * is two different servers, not a disagreement. 12 hours: a due re-check sends
 * both lanes of a subject in the same pump pass or two (minutes to a few hours
 * apart), while a server with no pinned version can change at any deploy, so a
 * longer window would compare lists that may belong to different releases. A
 * pair that falls outside the window is simply not compared (nothing opens);
 * it is compared again when the lanes next report close together.
 */
export const ORACLE_UNVERSIONED_WINDOW_MS = 12 * 3_600_000;
export const KINDS = Object.freeze(['tool_set', 'tool_count', 'schema', 'protocol', 'conformance']);
/** The design classes of the worker's oracle_disagreements (DESIGN-v3 D4, D6, D7, D12) and the kind each stands for. */
const CLASS_KIND = Object.freeze({
  D1: 'tool_set', static_missing: 'tool_set', D2: 'tool_set', static_phantom: 'tool_set',
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

/** The worker's own comparisons, as entries of class, kind, oracles and attribution (and, where it gives them, a fingerprint, direction, count and confidence). */
function workerEntries(v) {
  return (Array.isArray(v) ? v : []).slice(0, MAX_ITEMS).filter((e) => e && typeof e === 'object').map((e) => {
    const out = { class: text(e.class), kind: text(e.kind), oracles: (Array.isArray(e.oracles) ? e.oracles : []).map(text).filter(Boolean).slice(0, 4), attribution: text(e.attribution) };
    const fp = typeof e.fingerprint === 'string' && /^[0-9a-f]{12}$/.test(e.fingerprint) ? e.fingerprint : null;
    if (fp) out.fingerprint = fp;
    const direction = text(e.direction);
    if (direction) out.direction = direction;
    const confidence = e.confidence === 'high' || e.confidence === 'medium' ? e.confidence : null;
    if (confidence) out.oracle_confidence = confidence; // how sure the oracle was of its own reading
    const count = int(e.count);
    if (count !== null && fp) out.count = count;
    return out;
  });
}

/** What ast-grep said about a subject's source (results.oracle_ast_grep): status, confidence and tool count, or null. */
function astGrepFact(v) {
  if (!v || typeof v !== 'object' || v.oracle !== 'ast-grep') return null;
  const status = ['read', 'none', 'unreadable', 'error'].includes(v.status) ? v.status : null;
  if (!status) return null;
  return { status, confidence: ['high', 'medium', 'low'].includes(v.confidence) ? v.confidence : null, tool_count: int(v.tool_count), unreadable_count: int(v.unreadable_count), tool_set_sha256: hash(v.tool_set_sha256) };
}

/** The three-way rule for one subject's facts: ast-grep must have read the source (status read) and the reader's list must be complete. Medium confidence gives a candidate, not a high-confidence bug. */
function wayOf(st, live, sameTime) {
  const ag = st?.ast_grep;
  if (!sameTime || !st || st.complete !== true || st.tool_count == null || ag?.status !== 'read' || ag.tool_count == null || live?.tool_count == null) return null;
  const t = threeWay(st.tool_count, ag.tool_count, live.tool_count);
  if (t && t.confidence) {
    // Equal counts are not equal tools: high needs ast-grep's name-set hash to equal the live list's (names, not counts).
    const namesAgree = ag.tool_set_sha256 && live.tool_names_sha256 && ag.tool_set_sha256 === live.tool_names_sha256;
    if (ag.confidence !== 'high' || !namesAgree) {
      const { confidence, ...rest } = t;
      const differ = ag.tool_set_sha256 && live.tool_names_sha256 && !namesAgree;
      return { ...rest, explanation: differ ? 'counts_agree_names_differ' : 'reader_bug_candidate', basis: differ ? 'ast-grep=live (counts only)' : t.basis + (live.tool_names_sha256 ? '' : ' (counts; live names not given)') };
    }
  }
  return t;
}

/**
 * The three-way rule (DESIGN-v3 section 7) from three tool counts: the reader's (r), ast-grep's (a) and the live list's (l).
 * Counts only; each oracle's list is its own lane's. Returns the extra fields of a disagreement entry, or null.
 */
export function threeWay(r, a, l) {
  if (![r, a, l].every((n) => Number.isSafeInteger(n))) return null;
  if (a === l && r !== l) return { confidence: 'high', basis: 'ast-grep=live', explanation: 'reader_bug' };
  if (a === r && r !== l) return { explanation: 'dynamic_or_gated_registration', basis: 'ast-grep=reader' };
  if (r === l && a !== l) return { explanation: 'oracle_rule_gap', basis: 'live=reader' };
  if (r !== l && a !== r && a !== l) return { triage: 'human', basis: 'all_differ' };
  return null;
}

/**
 * The oracle facts of one accepted bundle, or null when its lane carries none.
 * @param {string} lane  'scan-static' or 'live-probe'
 * @param {(field: string) => any} get  the value of an observed field (null when absent)
 * @param {object|null} result  the lane's results/<lane>.json
 */
export function oracleFacts(lane, get, result = null) {
  if (lane === 'scan-static') {
    if (!result) return null;
    const ag = astGrepFact(result.oracle_ast_grep);
    const worker = workerEntries(get('oracle_disagreements'));
    const extra = { ...(ag ? { ast_grep: ag } : {}), ...(worker.length ? { worker } : {}) };
    const h = result.status === 'graded' ? hash(result.catalog_hash) : null;
    if (!h) return ag || worker.length ? { lane, tool_list_sha256: null, tool_count: null, complete: false, ...extra } : null;
    const l = result.list ?? {};
    // Complete: the reader saw every tool by name from a source it trusts.
    const complete = Boolean(result.list) && l.approximate !== true && l.fidelity !== 'names' && !(l.tools_left_out > 0) && !(l.unresolved_names > 0)
      && !(l.registration_not_seen > 0) && l.listing_truncated !== true && result.listing?.truncated !== true && result.listing?.budget_hit !== true;
    return { lane, tool_list_sha256: h, tool_count: int(result.tool_count), complete, ...extra };
  }
  if (lane !== 'live-probe') return null;
  const h = hash(get('tool_list_sha256'));
  const namesHash = hash(get('tool_names_sha256')); // sha256 of the JSON array of the live list's tool names, sorted: the same hash ast-grep's tool_set_sha256 is
  const sdk = (Array.isArray(get('sdk_client_results')) ? get('sdk_client_results') : []).slice(0, MAX_ITEMS).filter((e) => e && typeof e === 'object').map((e) => ({
    client: text(e.client) ?? '?', outcome: text(e.outcome), tool_count: int(e.tool_count), catalog_vs_reader: text(e.catalog_vs_reader),
  }));
  const checks = Array.isArray(get('conformance_checks')) ? get('conformance_checks') : [];
  const worker = workerEntries(get('oracle_disagreements'));
  if (!h && sdk.length === 0 && checks.length === 0 && worker.length === 0) return null;
  return {
    lane, tool_list_sha256: h, ...(namesHash ? { tool_names_sha256: namesHash } : {}), tool_count: int(get('tool_count')), sdk,
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
  const add = (kind, oracles, extra = {}) => {
    const o = [...oracles].sort();
    found.set(`${kind}\u0000${o.join(',')}\u0000${extra.class ?? ''}\u0000${extra.fingerprint ?? ''}`, { kind, oracles: o, ...extra });
  };

  // A lane whose facts are of another subject version than `version` (the newest result's) is stale: left out (R-ORD-12).
  if (version !== undefined) {
    if (st && st.version !== version) st = null;
    if (live && live.version !== version) live = null;
  } else if (st && live && st.version !== live.version) {
    st = null;
  }
  // No version on both sides: they count as one version only when observed within the window (R-ORD-16).
  // Facts without a time (`at`) cannot be shown to be close, so they are not compared across lanes.
  let sameTime = true;
  if (st && live && st.version == null && live.version == null) {
    sameTime = Number.isFinite(st.at) && Number.isFinite(live.at) && Math.abs(st.at - live.at) <= ORACLE_UNVERSIONED_WINDOW_MS;
  }
  // The three-way rule: counts of the reader, ast-grep and the live list (threeWay), when all three are there.
  const way = wayOf(st, live, sameTime);
  if (sameTime && st?.complete === true && st.tool_count !== null && live?.tool_count !== null && live?.tool_count !== undefined && st.tool_count !== live.tool_count) {
    add('tool_count', ['reader', 'live'], way ?? {});
  }
  if (live) {
    for (const c of live.sdk ?? []) {
      if (c.outcome === 'listed') {
        if (c.tool_count !== null && live.tool_count !== null && c.tool_count !== live.tool_count) add('tool_count', [`sdk:${c.client}`, 'live']);
        else if (c.catalog_vs_reader === 'different') add('schema', [`sdk:${c.client}`, 'reader']);
      } else if (CLIENT_FAILED.has(c.outcome) && live.tool_count !== null) add('protocol', [`sdk:${c.client}`, 'live']);
    }
  }
  // The worker's own comparisons, of either lane (live-probe: SDK clients and conformance; scan-static: the reader against ast-grep).
  for (const [lane, side] of [['scan-static', st], ['live-probe', live]]) {
    for (const w of side?.worker ?? []) {
      // an entry that compares our reader with ast-grep (D1/D2) is about our tool whatever its attribution says
      if (w.attribution === 'server' && !w.oracles.includes('ast-grep')) { server.add(w.kind ?? w.class ?? 'worker_entry'); continue; }
      const kind = KINDS.includes(w.kind) ? w.kind : CLASS_KIND[w.class] ?? null;
      if (!kind) continue;
      const extra = {};
      if (lane === 'scan-static') {
        for (const k of ['class', 'fingerprint', 'direction', 'oracle_confidence']) if (w[k] !== undefined) extra[k] = w[k];
        // Which side the live list backs, from counts: the reader's bug, ast-grep's gap, dynamic registration, or a human's call.
        Object.assign(extra, way ?? {});
      }
      add(kind, w.oracles.length ? w.oracles : ['worker'], extra);
    }
  }
  if (live) {
    // A failed scored conformance check while the clients and our reader agree is the server's own failure.
    if (live.conformance_failed > 0 && ![...found.values()].some((d) => d.kind === 'conformance')) server.add('conformance_fail');
  }
  const kinds = [...found.values()].sort((a, b) => (a.kind + a.oracles + (a.class ?? '') + (a.fingerprint ?? '')).localeCompare(b.kind + b.oracles + (b.class ?? '') + (b.fingerprint ?? '')));
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
  // A settled record keeps the reason it settled for (recheck_budget or unchanged_rechecks) (R-ORD-18).
  if (prior.status === 'settled') return { status: 'settled', unchanged_rechecks: prior.unchanged_rechecks, reason: prior.reason ?? 'unchanged_rechecks' };
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
