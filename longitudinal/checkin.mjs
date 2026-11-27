#!/usr/bin/env node
// Rank the loop's tool-side failures by impact, for a check-in (loop upgrade 11).
//
//   node longitudinal/checkin.mjs --archive <dir> [--identity <file>] --out-md <file> --out-json <file>
//   node longitudinal/checkin.mjs --plain <dir>   --out-md <file> --out-json <file>
//
// Groups every tool-side skip, error and reader limit in the loop's accepted
// results into fingerprints (DESIGN-v3 section 7: tool, component, oracle,
// class, SDK idiom, layout, normalised signature; the tool version is part of
// the key too, so a fix shows as the old fingerprint emptying out) and ranks
// them by what fixing each would unlock: the subjects whose latest result of
// that lane still carries it, weighted by subject tier and popularity, times
// the class's severity. Every number comes with evidence refs: run id,
// attempt id and item index of the bundle it was read from.
//
// Reading follows longitudinal/derive.mjs: the archive's sealed bundles are
// decrypted in memory with the ingest identity (default
// ~/.isokron/loop-age-identity.key, never printed), only accepted items are
// read, and nothing decrypted is written to disk. The two outputs are the only
// files written: 0600, and never inside the folder being read. Free and local:
// no network, no model.
//
// Scoring (all numbers are the defaults of DEFAULT_CONFIG; --config <json>
// overrides any of them, deep-merged):
//
//   subject_weight(s) = tier_weight[tier(s)] * (1 + popularity_boost * min(1, log10(1 + stars(s)) / log10(1 + stars_cap)))
//   impact(fp)        = severity[class(fp)] * (partial_multiplier if fp is a partial reader limit) * sum over affected s of subject_weight(s)
//
// Oracle disagreement (loop upgrade #7, state/oracle.mjs): a subject whose
// latest scan-static, live-probe, SDK-client and conformance results disagree
// is where our tools are weakest, so its weight is multiplied by
// (1 + oracle_boost), default 1.5 times, in every fingerprint it is still
// affected by. The disagreement itself is evidence about our tool: it makes no
// fingerprint of its own and a server-side skip stays out as before.
//
//   subject_weight(s) = ... * (config.oracle_multiplier if s has an open disagreement else 1)
//
// tier_weight is `weights` in pump/tiers.json (T0 100 .. T4 10), the weights
// the pump's own priority uses; tier and stars come from the seed (the same
// tierFor as the pump). A subject not in the seed gets `unseeded_tier`.
//
// Exit codes: 0 done; 2 usage (or an output inside the input); 3 the input
// could not be read.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ageDecrypt } from '../ingest/age.mjs';
import { SKIP_REASONS, skipFault } from '../worker-kit/contract.mjs';
import { unpackBundle } from '../worker-kit/bundle.mjs';
import { readTar } from '../worker-kit/tar.mjs';
import { tierFor } from '../pump/subjects.mjs';
import { deriveDisagreements, oracleFacts, observedFields, ORACLE_LANES } from '../state/oracle.mjs';
import { DEFAULT_IDENTITY, outUnsafe, sealedFiles, subjectKeyOf, writeOut } from './derive.mjs';

const ROOT = new URL('../', import.meta.url);
export const SOURCE = 'tool-qa longitudinal/checkin.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  // Severity of a failure class: how much of a subject's picture is lost.
  severity: {
    tool_error: 5, no_tools_found: 4, unsupported_transport: 4, bridge_required: 3, no_runnable_artifact: 3,
    unsupported_language: 3, unsupported_layout: 3, reader_limit: 3, too_large: 2, trace_unavailable: 2,
    install_failed_registry: 2, timeout_start: 2, build_failed_upstream: 2, no_local_backend: 2, default: 2,
  },
  // A graded result that is incomplete (names without schemas, files over the limit) counts less than no result.
  partial_multiplier: 0.5,
  popularity_boost: 1,
  // A subject with an open oracle disagreement counts this many times as much (R-ORD-05).
  oracle_multiplier: 1.5,
  stars_cap: 10000,
  unseeded_tier: 'T4',
  // Which fault sides count as tool-side. "unknown" is a skip that did not say (bundles from before the fault field).
  faults: ['tool', 'unknown'],
  // Markdown shows this many evidence refs per fingerprint; the JSON has all of them.
  md_evidence: 10,
});

/** result.detail words (scan-static) -> the contract skip reason they stand for, and the fault they have. */
const DETAIL_CLASS = Object.freeze({
  no_tools: 'no_tools_found', multiple_servers: 'unsupported_layout', unsupported_language: 'unsupported_language',
  names_only: 'reader_limit', too_large: 'too_large', tool_error: 'tool_error',
});
/** Reasons the manifest may give for what the result detail says more exactly. */
const AMBIGUOUS = new Set(['no_runnable_artifact', 'install_failed_registry', 'timeout_start']);

const ITEM_RE = /^accepted\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(\d{1,6})\/(.+)$/;
const WANT_RE = /^(manifest\.json|ingest\.json|results\/[A-Za-z0-9._-]+\.json|raw\/subject\/scan\.json|observations\/[A-Za-z0-9._-]+\.ndjson)$/;

const parseJson = (buf) => { try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); } catch { return null; } };

/** Items from tar entries (or files) laid out as accepted/<attempt>/<index>/<path>. Unreadable manifests are counted. */
export function itemsFromEntries(entries, stats = { unreadable: 0 }) {
  const groups = new Map();
  for (const e of entries) {
    const m = ITEM_RE.exec(e.path);
    if (!m || !WANT_RE.test(m[3])) continue;
    const k = `${m[1]}/${m[2]}`;
    if (!groups.has(k)) groups.set(k, { attempt: m[1], index: Number(m[2]), files: new Map() });
    groups.get(k).files.set(m[3], e.data);
  }
  const out = [];
  for (const g of groups.values()) {
    const man = parseJson(g.files.get('manifest.json'));
    if (!man || typeof man.subject?.id !== 'string' || typeof man.finished_at !== 'string') { stats.unreadable++; continue; }
    const ing = parseJson(g.files.get('ingest.json'));
    const results = new Map();
    for (const [p, d] of g.files) {
      const m = /^results\/([A-Za-z0-9._-]+)\.json$/.exec(p);
      if (m) { const r = parseJson(d); if (r && typeof r === 'object') results.set(m[1], r); }
    }
    const lane = String(man.workflow?.file ?? '').split('/').pop().replace(/\.ya?ml$/, '') || 'unknown';
    out.push({
      // The subject key ingest recorded it under, which a rename does not
      // move (derive.mjs subjectKeyOf); the name the worker was sent is kept.
      subject: subjectKeyOf(g.files.get('ingest.json'), man),
      // The subject version the lane read (state oracle facts are compared on one version only, R-ORD-12).
      version: man.subject.sha ?? man.subject.artifact_digest ?? null,
      sent_as: man.subject.id,
      lane,
      observed_at: man.finished_at,
      attempt_id: String(man.attempt_id ?? g.attempt),
      item_index: g.index,
      // Dedupe key (R-CHECKIN-13): an item is in its full bundle and in its keep-forever
      // file; without a key every item after the first was dropped as already seen.
      key: `${man.attempt_id ?? g.attempt}/${g.index}/${man.run_key ?? ''}`,
      run_id: Number.isSafeInteger(ing?.run?.id) ? ing.run.id : Number.isSafeInteger(ing?.input?.run_id) ? ing.input.run_id : man.workflow?.run_id ?? null,
      tools: Array.isArray(man.tools) ? man.tools.map((t) => `${t?.name ?? '?'}@${t?.version ?? '?'}`) : [],
      skips: Array.isArray(man.skips) ? man.skips : [],
      results,
      scan: parseJson(g.files.get('raw/subject/scan.json')),
      fields: observedFields(g.files),
    });
  }
  return out;
}

/** Items from the archive, one sealed file at a time (decrypted in memory only). */
export function readArchive(archiveDir, { identity, ageBin = process.env.AGE_BIN || 'age', log = () => {} } = {}) {
  const stats = { sealed: 0, failed: 0, unreadable: 0 };
  const items = [];
  const seen = new Set();
  for (const file of sealedFiles(archiveDir)) {
    stats.sealed++;
    let entries;
    try {
      entries = readTar(unpackBundle(ageDecrypt({ ciphertext: readFileSync(file), identity, ageBin })));
    } catch (err) {
      stats.failed++;
      log(`could not read ${file.slice(archiveDir.length + 1)} (${err?.code ?? err?.name ?? 'error'})`);
      continue;
    }
    // An item is in its full bundle and in its keep-forever file (loop upgrade 20) until the full one expires.
    const fresh = itemsFromEntries(entries, stats).filter((item) => !seen.has(item.key));
    for (const item of fresh) seen.add(item.key);
    items.push(...fresh);
  }
  return { items, stats };
}

/** Items from a plain folder laid out as accepted/<attempt>/<index>/... */
export function readPlain(dir) {
  const entries = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) entries.push({ path: p.slice(dir.length + 1).split('\\').join('/'), data: readFileSync(p) });
    }
  };
  walk(dir);
  const stats = { unreadable: 0 };
  return { items: itemsFromEntries(entries, stats), stats };
}

// ---------------------------------------------------------------- fingerprints

const fold = (v) => String(v).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const flatten = (v) => fold(v).replace(/[^a-z0-9]/g, '');

/**
 * The name matcher for a set of subject ids: every case-folded NFKD token of at
 * least 3 characters of each owner and repo (acme-widget-mcp: acme, widget, mcp),
 * and each whole name with separators removed. Used on every free word.
 */
export function nameTokens(subjects) {
  const out = new Set();
  for (const subject of subjects) {
    for (const part of String(subject).split('/')) {
      const f = fold(part);
      for (const t of f.split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
      const whole = f.replace(/[^a-z0-9]/g, '');
      if (whole.length >= 3) out.add(whole);
    }
  }
  return out;
}
const hitsName = (value, names) => { const flat = flatten(value); for (const n of names) if (flat.includes(n)) return true; return false; };

/** A closed list: the value if it is on it, else <other> (null stays null). */
const oneOf = (v, list) => (v === null || v === undefined ? null : list.includes(v) ? v : '<other>');

const ENUMS = Object.freeze({
  stage: ['static', 'live', 'scan', 'build', 'install', 'start', 'probe', 'meta', 'registry', 'differential', 'conformance', 'bridge', 'trace'],
  from: ['catalog', 'source', 'committed', 'snapshots', 'live', 'registry'],
  fidelity: ['exact', 'derived', 'literal', 'names'],
  via: ['github', 'git', 'api', 'archive', 'tarball', 'zip', 'local'],
  language: ['python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin', 'c#', 'c++', 'c', 'swift', 'php', 'ruby', 'scala', 'dart', 'elixir', 'shell', 'ts/js', 'java/kotlin', 'other'],
  detail: ['no_tools', 'multiple_servers', 'unsupported_language', 'names_only', 'too_large', 'tool_error', 'rate_limited', 'needs_credentials', 'quarantined'],
});
const CLASSES = [...SKIP_REASONS];

/** A free word (error name, detail, list error): only our own short codes, never a name of anything in the run. */
function word(v, names) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(s)) return '<other>';
  return hitsName(s, names) ? '<other>' : s.toLowerCase();
}
/** A code from a closed list; anything else is <other>. */
const code = (v, list) => (v === null || v === undefined ? null : list.includes(v) ? v : '<other>');

const bucketHttp = (n) => (Number.isInteger(n) && n >= 100 && n < 600 ? `${Math.floor(n / 100)}xx` : null);

function layoutOf(item, result) {
  const sj = item.scan?.hints?.serverJson;
  const n = Array.isArray(sj) ? sj.length : null;
  const parts = [];
  if (n !== null) parts.push(`server_json:${n === 0 ? '0' : n === 1 ? '1' : 'many'}`);
  if (result?.detail === 'multiple_servers') parts.push('multi_server');
  if (result?.listing?.via) parts.push(`via:${oneOf(result.listing.via, ENUMS.via) ?? 'none'}`);
  return parts.join(';') || 'unknown';
}

/** A language name as the reader or the seed spells it (c#, c++, go): lower-case, a short fixed alphabet. */
const langWord = (v) => (typeof v === 'string' ? (ENUMS.language.includes(v.toLowerCase()) ? v.toLowerCase() : '<other>') : null);

function idiomOf(result, seedLanguage) {
  const l = result?.list;
  const lang = langWord(l?.language ?? result?.language_hint) ?? (langWord(seedLanguage) ? `repo:${langWord(seedLanguage)}` : 'unknown');
  return `${l ? `${oneOf(l.from, ENUMS.from) ?? 'none'}/${oneOf(l.fidelity, ENUMS.fidelity) ?? 'none'}` : 'none'}/${lang}`;
}

/**
 * The tool-side failures of one item, each {cls, partial, stage, signature, ...}.
 * A skip with a declared (or defaulted) fault outside config.faults is not ours.
 * The result's own detail word says more than an ambiguous manifest reason.
 */
export function failuresOf(item, config = DEFAULT_CONFIG, { langOf = () => null, names = nameTokens([item.subject]) } = {}) {
  const want = new Set(config.faults);
  // Every result in the bundle is read, not only the first.
  const results = [...item.results.values()].filter((r) => r && typeof r.status === 'string');
  const out = [];
  const detailOf = (r) => (r.status === 'skipped' ? DETAIL_CLASS[r.detail] ?? null : null);
  const primary = results.find((r) => detailOf(r)) ?? results.find((r) => r.status === 'error') ?? results[0] ?? null;
  const baseFor = (r) => ({ idiom: idiomOf(r, langOf(item.subject)), layout: layoutOf(item, r) });
  const common = (r, cls, stage, extra) => ({
    ...baseFor(r), cls: code(cls, CLASSES), stage: code(stage, ENUMS.stage) ?? 'unknown',
    signature: [
      `class=${code(cls, CLASSES)}`, `detail=${code(r?.detail, ENUMS.detail) ?? '-'}`, `error=${word(r?.error_name, names) ?? '-'}`,
      `list_error=${word(typeof r?.list_error === 'string' ? r.list_error : r?.list_error?.code, names) ?? '-'}`,
      `http=${bucketHttp(r?.http_status) ?? '-'}`, ...extra,
    ].join(';'),
  });

  const detailCls = primary ? detailOf(primary) : null;
  let usedDetail = false;
  for (const s of item.skips) {
    let cls = s.reason;
    let fault = skipFault(s);
    if (detailCls && AMBIGUOUS.has(s.reason)) { cls = detailCls; if (!s.fault) fault = 'tool'; usedDetail = true; }
    else if (detailCls === s.reason) usedDetail = true;
    if (!want.has(fault)) continue;
    out.push({ ...common(primary, cls, s.stage, [`fault=${fault}`, `retryable=${s.retryable === true}`]), partial: false });
  }
  if (detailCls && !usedDetail && want.has('tool')) out.push({ ...common(primary, detailCls, 'static', ['fault=tool', 'retryable=false']), partial: false });
  for (const r of results) {
    if (r.status === 'error' && want.has('tool') && !out.some((f) => f.cls === 'tool_error')) {
      out.push({ ...common(r, 'tool_error', 'static', ['fault=tool', 'retryable=false']), partial: false });
    }
    // A graded result that is incomplete: the reader said what it could not read.
    if (r.status === 'graded' && want.has('tool')) {
      const partials = [];
      const l = r.list ?? {};
      if (l.unresolved_names > 0) partials.push('unresolved_names');
      if (l.registration_not_seen > 0) partials.push('registration_not_seen');
      if (l.tools_left_out > 0) partials.push('tools_left_out');
      for (const k of ['input_schemas', 'descriptions', 'annotations']) if (l.unreadable?.[k] > 0) partials.push(`unreadable_${k}`);
      if (l.listing_truncated === true || r.listing?.truncated === true) partials.push('listing_truncated');
      if (r.listing?.budget_hit === true) partials.push('budget_hit');
      for (const p of partials) out.push({ ...common(r, 'reader_limit', 'static', [`partial=${p}`]), partial: true });
    }
  }
  const safe = (v) => (/^[A-Za-z0-9@._,-]{1,80}$/.test(v) && !hitsName(v, names) ? v : '<other>');
  return out.map((f) => ({ ...f, tool: safe(item.tools.join(',') || 'unknown'), lane: safe(item.lane) }));
}

/** Order by time; a time that does not parse sorts last (never NaN). */
export const byTime = (a, b) => { const x = Date.parse(a); const y = Date.parse(b); const ax = Number.isFinite(x) ? x : Infinity; const ay = Number.isFinite(y) ? y : Infinity; return ax < ay ? -1 : ax > ay ? 1 : 0; };

/** The fingerprint id and its parts. */
export function fingerprintOf(f) {
  const parts = { tool: f.tool, lane: f.lane, component: f.stage, oracle: f.lane, class: f.cls, idiom: f.idiom, layout: f.layout, signature: f.signature };
  const id = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
  return { id, parts };
}

// ---------------------------------------------------------------- scoring

/** The tier and stars of every seed subject, keyed by lower-case id. */
export function loadSeed(file) {
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  for (const s of seed.subjects ?? []) map.set(String(s.id).toLowerCase(), { tier: `T${tierFor(s)}`, stars: Number.isFinite(s.stars) ? s.stars : 0, language: s.language ?? s.github_language ?? null });
  return map;
}

export function subjectWeight(info, tierWeights, config) {
  const w = tierWeights[info.tier] ?? 0;
  const pop = Math.min(1, Math.log10(1 + Math.max(0, info.stars)) / Math.log10(1 + config.stars_cap));
  return w * (1 + config.popularity_boost * pop) * (info.oracle ? config.oracle_multiplier : 1);
}

/**
 * The open oracle disagreements by subject, from each subject's latest item
 * that carried oracle facts in each oracle lane (the same facts and rules as
 * the state store's, state/oracle.mjs). Items must be sorted by time.
 * @returns {Map<string, {kind: string, oracles: string[]}[]>}  only subjects that disagree
 */
export function oracleDisagreements(items) {
  const latest = new Map();
  const newest = new Map(); // subject -> the version of its newest item with facts
  for (const it of items) {
    if (!ORACLE_LANES.includes(it.lane)) continue;
    const facts = oracleFacts(it.lane, (k) => it.fields?.get(k) ?? null, it.results.get(it.lane) ?? null);
    if (facts) {
      latest.set(`${it.subject}\u0000${it.lane}`, { ...facts, version: it.version ?? null, at: Date.parse(it.observed_at) });
      newest.set(it.subject, it.version ?? null);
    }
  }
  const subjects = new Set([...latest.keys()].map((k) => k.split('\u0000')[0]));
  const out = new Map();
  for (const subject of subjects) {
    const d = deriveDisagreements({ static: latest.get(`${subject}\u0000scan-static`) ?? null, live: latest.get(`${subject}\u0000live-probe`) ?? null, version: newest.get(subject) });
    if (d.kinds.length) out.set(subject, d.kinds);
  }
  return out;
}

const mergeConfig = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...base[k], ...v } : v;
  return out;
};

/**
 * Fingerprints ranked by impact. Only the latest item of each (subject, lane)
 * counts as affected; older sightings give first/last seen and the
 * "healed since" count. Items with the same attempt and index count once.
 */
export function analyse(items, { seed = new Map(), tierWeights, config: over = {} } = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, over);
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = `${it.attempt_id}/${it.item_index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  uniq.sort((a, b) => byTime(a.observed_at, b.observed_at) || `${a.attempt_id}/${a.item_index}`.localeCompare(`${b.attempt_id}/${b.item_index}`));
  const allNames = nameTokens(uniq.map((i) => i.subject));
  const latest = new Map();
  for (const it of uniq) latest.set(`${it.subject}\u0000${it.lane}`, it);

  const disagree = oracleDisagreements(uniq);
  const info = (subject) => ({ ...(seed.get(subject.toLowerCase()) ?? { tier: config.unseeded_tier, stars: 0, unseeded: true }), oracle: disagree.has(subject) });
  const fps = new Map();
  let failingItems = 0;
  for (const it of uniq) {
    const isLatest = latest.get(`${it.subject}\u0000${it.lane}`) === it;
    const fl = failuresOf(it, config, { langOf: (s) => seed.get(s.toLowerCase())?.language ?? null, names: allNames });
    if (fl.length) failingItems++;
    for (const f of fl) {
      const { id, parts } = fingerprintOf(f);
      if (!fps.has(id)) fps.set(id, { id, ...parts, partial: f.partial, observations: [], current: new Map(), ever: new Set() });
      const fp = fps.get(id);
      const ref = { subject: it.subject, run_id: it.run_id, attempt_id: it.attempt_id, item_index: it.item_index, observed_at: it.observed_at, current: isLatest };
      fp.observations.push(ref);
      fp.ever.add(it.subject);
      if (isLatest) fp.current.set(it.subject, ref);
    }
  }

  const sevOf = (cls) => config.severity[cls] ?? config.severity.default;
  const ranked = [...fps.values()].map((fp) => {
    const byTier = {};
    let weight = 0;
    let top = null;
    for (const subject of fp.current.keys()) {
      const si = info(subject);
      const w = subjectWeight(si, tierWeights, config);
      weight += w;
      byTier[si.tier] = (byTier[si.tier] ?? 0) + 1;
      if (!top || w > top.w || (w === top.w && subject < top.subject)) top = { subject, w, ...si };
    }
    const severity = sevOf(fp.class) * (fp.partial ? config.partial_multiplier : 1);
    const times = fp.observations.map((o) => o.observed_at).sort(byTime);
    const evidence = [...fp.current.values()].sort((a, b) => a.subject.localeCompare(b.subject));
    return {
      fingerprint: fp.id,
      tool: fp.tool, lane: fp.lane, component: fp.component, oracle: fp.oracle, class: fp.class,
      idiom: fp.idiom, layout: fp.layout, signature: fp.signature, partial: fp.partial,
      kind: fp.class + (/;partial=([a-z_]+)/.exec(fp.signature)?.[1] ? `:${/;partial=([a-z_]+)/.exec(fp.signature)[1]}` : ''),
      unlocks: fp.current.size,
      unlocks_by_tier: Object.fromEntries(Object.entries(byTier).sort(([a], [b]) => a.localeCompare(b))),
      weighted_subjects: Math.round(weight * 100) / 100,
      severity,
      impact: Math.round(severity * weight * 100) / 100,
      first_seen: times[0], last_seen: times.at(-1),
      healed_since: [...fp.ever].filter((s) => !fp.current.has(s)).length,
      example: top ? { subject: top.subject, tier: top.tier, stars: top.stars } : null,
      evidence,
      unseeded_subjects: [...fp.current.keys()].filter((s) => info(s).unseeded).length,
      oracle_subjects: [...fp.current.keys()].filter((s) => disagree.has(s)).length,
    };
  }).sort((a, b) => b.impact - a.impact || b.unlocks - a.unlocks || a.fingerprint.localeCompare(b.fingerprint));
  ranked.forEach((r, i) => { r.rank = i + 1; });

  return {
    config,
    summary: {
      items: uniq.length, duplicates: items.length - uniq.length,
      subjects: new Set(uniq.map((i) => i.subject)).size,
      lanes: [...new Set(uniq.map((i) => i.lane))].sort(),
      items_with_a_tool_side_failure: failingItems,
      fingerprints: ranked.length,
      open_fingerprints: ranked.filter((r) => r.unlocks > 0).length,
      oracle_disagreements: { subjects: disagree.size, by_kind: Object.fromEntries([...new Set([...disagree.values()].flat().map((k) => k.kind))].sort().map((k) => [k, [...disagree.values()].filter((v) => v.some((x) => x.kind === k)).length])) },
    },
    fingerprints: ranked,
  };
}

// ---------------------------------------------------------------- output

const ref = (e) => `${e.subject} (run ${e.run_id ?? '?'}, attempt ${e.attempt_id}, item ${e.item_index})`;

export function renderMarkdown(report, { generatedAt, md_evidence = report.config.md_evidence } = {}) {
  const { summary: s, config, fingerprints } = report;
  const L = [];
  L.push('# Check-in: tool-side failures ranked by impact', '');
  L.push(`Generated ${generatedAt} by \`longitudinal/checkin.mjs\`. Local view: subject names are shown.`, '');
  L.push(`Read ${s.items} accepted items over ${s.subjects} subjects (lanes: ${s.lanes.join(', ') || 'none'}); ${s.items_with_a_tool_side_failure} carry a tool-side failure. ${s.open_fingerprints} fingerprints are still open on a subject's latest result (${s.fingerprints} seen in all).`, '');
  const od = s.oracle_disagreements;
  if (od.subjects > 0) L.push(`${od.subjects} subjects have an open oracle disagreement (${Object.entries(od.by_kind).map(([k, n]) => `${k}: ${n}`).join(', ')}); their fingerprints weigh x${config.oracle_multiplier}.`, '');
  L.push('## Scoring', '');
  L.push('```', 'subject_weight = tier_weight[tier] * (1 + popularity_boost * min(1, log10(1 + stars) / log10(1 + stars_cap)))',
    'x oracle_multiplier when the subject has an open oracle disagreement (state/oracle.mjs)',
    'impact         = severity[class] * (partial_multiplier if a partial reader limit) * sum(subject_weight over the subjects still affected)', '```', '');
  L.push(`Config: \`${JSON.stringify({ ...config, severity: undefined })}\`, severity \`${JSON.stringify(config.severity)}\`.`, '');
  L.push('"Unlocks" counts the subjects whose latest result of that lane still carries the fingerprint; a subject that was fixed by a later run no longer counts (see "healed since").', '');
  L.push('## Ranking', '');
  L.push('| # | Impact | Unlocks | By tier | Class | Lane | Idiom | Layout | Fingerprint |', '|---|---|---|---|---|---|---|---|---|');
  for (const f of fingerprints) {
    const tiers = Object.entries(f.unlocks_by_tier).map(([t, n]) => `${t}:${n}`).join(' ') || '-';
    L.push(`| ${f.rank} | ${f.impact} | ${f.unlocks} | ${tiers} | ${f.kind}${f.partial ? ' (partial)' : ''} | ${f.lane} | ${f.idiom} | ${f.layout} | \`${f.fingerprint}\` |`);
  }
  L.push('', '## Fingerprints', '');
  for (const f of fingerprints) {
    L.push(`### ${f.rank}. \`${f.fingerprint}\` ${f.kind}${f.partial ? ' (partial)' : ''}, impact ${f.impact}`, '');
    L.push(`- This fix unlocks ${f.unlocks} subject${f.unlocks === 1 ? '' : 's'} (${Object.entries(f.unlocks_by_tier).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none open'}); popularity-weighted ${f.weighted_subjects} x severity ${f.severity}.`);
    if (f.oracle_subjects > 0) L.push(`- ${f.oracle_subjects} of these subject${f.oracle_subjects === 1 ? '' : 's'} also ${f.oracle_subjects === 1 ? 'has' : 'have'} an open oracle disagreement (weighted x${config.oracle_multiplier}).`);
    L.push(`- Tool ${f.tool}; component ${f.component}; oracle ${f.oracle}; idiom ${f.idiom}; layout ${f.layout}.`);
    L.push(`- Signature: \`${f.signature}\``);
    L.push(`- First seen ${f.first_seen}, last seen ${f.last_seen}; healed since: ${f.healed_since}.`);
    if (f.example) L.push(`- Example: ${f.example.subject} (${f.example.tier}, ${f.example.stars} stars).`);
    if (f.evidence.length) {
      const shown = f.evidence.slice(0, md_evidence);
      L.push(`- Evidence (${f.evidence.length}${f.evidence.length > shown.length ? `, first ${shown.length} here, ${f.evidence.length - shown.length} more in the JSON` : ''}):`);
      for (const e of shown) L.push(`  - ${ref(e)}`);
    }
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = {};
  const valued = ['--archive', '--plain', '--identity', '--out-md', '--out-json', '--seed', '--tiers', '--config', '--top'];
  for (let i = 0; i < argv.length; i++) {
    if (!valued.includes(argv[i]) || i + 1 >= argv.length) return null;
    o[argv[i].slice(2)] = argv[++i];
  }
  if (!o.archive === !o.plain) return null;
  if (!o['out-md'] || !o['out-json']) return null;
  if (o.top !== undefined && !/^\d+$/.test(o.top)) return null;
  return o;
}

export async function main(argv = process.argv.slice(2), { write = (s) => process.stdout.write(s), now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (!o) {
    write('usage: node longitudinal/checkin.mjs (--archive <dir> [--identity <file>] | --plain <dir>) --out-md <file> --out-json <file> [--seed <file>] [--tiers <file>] [--config <json file>] [--top <n>]\n');
    return 2;
  }
  const input = o.archive ?? o.plain;
  if (outUnsafe(o['out-md'], input) || outUnsafe(o['out-json'], input)) {
    write('--out-md and --out-json must not be inside the folder being read, nor a link or a second name for a file in it (the archive is never written to)\n');
    return 2;
  }
  let read, seed, tierWeights, over;
  try {
    tierWeights = JSON.parse(readFileSync(o.tiers ?? new URL('pump/tiers.json', ROOT), 'utf8')).weights;
    seed = loadSeed(o.seed ?? fileURLToPath(new URL('history/seed-v1.json', ROOT)));
    over = o.config ? JSON.parse(readFileSync(o.config, 'utf8')) : {};
    if (o.archive) {
      const identity = readFileSync(o.identity ?? DEFAULT_IDENTITY, 'utf8');
      read = readArchive(o.archive, { identity, log: (l) => write(`${l}\n`) });
    } else {
      if (!statSync(o.plain).isDirectory()) throw new Error('not a folder');
      read = readPlain(o.plain);
    }
  } catch (err) {
    write(`could not read the input (${err?.code ?? err?.name ?? 'error'})\n`);
    return 3;
  }
  const report = analyse(read.items, { seed, tierWeights, config: over });
  const generatedAt = now().toISOString();
  const json = { source: SOURCE, generated_at: generatedAt, read: read.stats, config: report.config, summary: report.summary, fingerprints: report.fingerprints };
  try {
    writeOut(o['out-json'], `${JSON.stringify(json, null, 2)}\n`);
    writeOut(o['out-md'], renderMarkdown(report, { generatedAt }));
  } catch (err) {
    write(`could not write the output (${err?.code ?? err?.name ?? 'error'})\n`);
    return 3;
  }
  const top = Number(o.top ?? 15);
  write(`${JSON.stringify({ read: read.stats, ...report.summary }, null, 2)}\n`);
  for (const f of report.fingerprints.slice(0, top)) {
    write(`${f.rank}. impact ${f.impact}  unlocks ${f.unlocks} (${Object.entries(f.unlocks_by_tier).map(([t, n]) => `${t}:${n}`).join(' ')})  ${f.kind}${f.partial ? '*' : ''}  ${f.idiom}  ${f.layout}  ${f.fingerprint}\n`);
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
