// Bug fingerprints (DESIGN-v3 section 7): the one place a tool-side failure
// in an accepted result is turned into a fingerprint.
//
//   fingerprint = hash(tool, component, oracle, class, SDK idiom, layout, normalised signature)
//
// Used by the check-in (longitudinal/checkin.mjs, from the archive) and by
// ingest in the pump (ingest/ingest.mjs -> StateDb.noteLeads, every accepted
// result while LANE_LEADS_ENABLED is on), so the two can never fingerprint a
// failure differently. Pure functions only; nothing here reads the network or
// the disk except the lane table from pump/workflows.json, read once.
//
// The signature describes the shape of the bug, never the target: every part
// is a code from a closed list (state/fingerprint-codes.json for the worker's
// detail, list error and error name), a bucket or a count. No part depends on
// which subjects the loop knows (R-LEAD-37).
// Tool names are ours (a closed list, OUR_TOOLS) and lanes are our workflow
// names, so neither goes through the subject-name filter (R-CHECKIN-14,
// R-CHECKIN-15); anything else is <other>.
//
// Two ids are made from the same parts:
//   fingerprintOf(f)   includes the tool versions: the check-in ranks by it, so a
//                      release that fixes a failure shows as the old id emptying out
//   leadKeyOf(f)       the same parts with the versions (and probe tools) taken out: the lead id
//                      (state table leads, one issue per lead). A release that does
//                      not fix the bug keeps its lead and its issue; one that does
//                      fix it closes the lead after clean re-checks (state/leads.mjs).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SKIP_REASONS, skipFault } from '../worker-kit/contract.mjs';

/**
 * The codes a signature may carry (state/fingerprint-codes.json): our workers'
 * own detail codes, list errors and error names, refreshed from mcp-check by
 * scripts/fingerprint-codes.mjs. Fixed lists, so a fingerprint never depends on
 * which subjects the loop knows (R-LEAD-37).
 */
export const CODES = Object.freeze(JSON.parse(readFileSync(new URL('./fingerprint-codes.json', import.meta.url), 'utf8')));
import { observedFields } from './oracle.mjs';

/** result.detail words (scan-static) -> the contract skip reason they stand for. */
export const DETAIL_CLASS = Object.freeze({
  no_tools: 'no_tools_found', multiple_servers: 'unsupported_layout', unsupported_language: 'unsupported_language',
  names_only: 'reader_limit', too_large: 'too_large', tool_error: 'tool_error',
});
/** Reasons the manifest may give for what the result detail says more exactly. */
export const AMBIGUOUS = new Set(['no_runnable_artifact', 'install_failed_registry', 'timeout_start']);

export const ENUMS = Object.freeze({
  // Our workers' stage codes (worker-kit/README.md); a stage not listed is <other>.
  stage: ['static', 'live', 'scan', 'build', 'install', 'start', 'probe', 'meta', 'registry', 'differential', 'conformance', 'bridge', 'trace',
    'resolve', 'list', 'init', 'plan', 'catalog', 'full', 'source', 'npm', 'pypi', 'crates', 'go', 'oci', 'sandbox', 'fuzz', 'collect'],
  from: ['catalog', 'source', 'committed', 'snapshots', 'live', 'registry'],
  fidelity: ['exact', 'derived', 'literal', 'names'],
  via: ['github', 'git', 'api', 'archive', 'tarball', 'zip', 'local'],
  language: ['python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin', 'c#', 'c++', 'c', 'swift', 'php', 'ruby', 'scala', 'dart', 'elixir', 'shell', 'ts/js', 'java/kotlin', 'other'],
  // result.detail: our workers' own codes (state/fingerprint-codes.json details: mcp-check live-probe DETAILS,
  // scan-static SKIPS); anything else (a graded result's free text) is <other>.
  detail: CODES.details,
});
export const CLASSES = Object.freeze([...SKIP_REASONS]);

/**
 * Our tools and the third-party tools our workers name in a manifest (never
 * subject data). A manifest name is folded first: `@isokron/` and
 * `isokron-ai/` are taken off. Anything else is <other>.
 */
/** The tools in OUR_TOOLS that are our own code (the rest are third-party tools our workers run). */
export const OWN_TOOLS = Object.freeze(['mcp-check', 'mcp-surface-corpus', 'mcp-surface-corpus-sandbox', 'mcp-writecheck', 'mcp-writecheck-action', 'mcp-catalog-snap',
  'tool-qa', 'tool-qa-meta-github', 'tool-qa-meta-registry', 'tool-qa-release-diff', 'fuzz']);
export const OUR_TOOLS = Object.freeze([
  'mcp-check', 'mcp-surface-corpus', 'mcp-surface-corpus-sandbox', 'mcp-writecheck', 'mcp-writecheck-action', 'mcp-catalog-snap',
  'tool-qa', 'tool-qa-meta-github', 'tool-qa-meta-registry', 'tool-qa-release-diff', 'fuzz', 'gvisor',
  'conformance', 'inspector', 'sdk-typescript', 'client-typescript', 'sdk-python', 'sdk-go',
]);

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
export const hitsName = (value, names) => { const flat = flatten(value); for (const n of names) if (flat.includes(n)) return true; return false; };

/** A closed list: the value if it is on it, else <other> (null stays null). */
const oneOf = (v, list) => (v === null || v === undefined ? null : list.includes(v) ? v : '<other>');

/**
 * An error name (result.error_name): one of our error classes or a JavaScript
 * built-in (CODES.error_names), lower-cased; anything else is <other>. A fixed
 * list, never a filter against subject names: such a filter made one bug's
 * fingerprint change as subjects were added (SyntaxError hit the token "axe"),
 * which would have opened a second lead and a second public issue (R-LEAD-37).
 */
export function word(v) {
  if (v === null || v === undefined) return null;
  return CODES.error_names.includes(String(v)) ? String(v).toLowerCase() : '<other>';
}
/** A list error code (result.list_error): one of our InputError codes (CODES.list_errors), else <other>. */
export function listWord(v) {
  if (v === null || v === undefined) return null;
  return CODES.list_errors.includes(String(v)) ? String(v) : '<other>';
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

/** Our tool's name as a manifest gives it, folded (`@isokron/mcp-check` is mcp-check), or <other>. */
export function toolName(name) {
  const n = typeof name === 'string' ? name.trim().toLowerCase().replace(/^@isokron\//, '').replace(/^isokron-ai\//, '') : '';
  return OUR_TOOLS.includes(n) ? n : '<other>';
}
/** A tool version: a release or commit as our workers write it, else <other>. */
const toolVersion = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(v) ? v : '<other>');
/** name@version for each tool of a manifest (the shape item.tools has). */
export const toolTags = (tools) => (Array.isArray(tools) ? tools.map((t) => `${toolName(t?.name)}@${toolVersion(t?.version)}`) : []);

/**
 * The tool-side failures of one item, each {cls, partial, stage, signature, tool, lane, fault, ...}.
 * A skip with a declared (or defaulted) fault outside config.faults is not ours.
 * The result's own detail word says more than an ambiguous manifest reason.
 * @param {object} item  itemFromBundle()
 * @param {{faults: string[]}} config  the fault sides that count
 * @param {{langOf?: (subject: string) => string|null}} [o]  (a `names` option is accepted and has no effect since R-LEAD-37)
 */
export function failuresOf(item, config, { langOf = () => null } = {}) {
  const want = new Set(config.faults);
  // Every result in the bundle is read, not only the first.
  const results = [...item.results.values()].filter((r) => r && typeof r.status === 'string');
  const out = [];
  const detailOf = (r) => (r.status === 'skipped' ? DETAIL_CLASS[r.detail] ?? null : null);
  const primary = results.find((r) => detailOf(r)) ?? results.find((r) => r.status === 'error') ?? results[0] ?? null;
  const baseFor = (r) => ({ idiom: idiomOf(r, langOf(item.subject)), layout: layoutOf(item, r) });
  const common = (r, cls, stage, fault, extra) => ({
    ...baseFor(r), cls: code(cls, CLASSES), stage: code(stage, ENUMS.stage) ?? 'unknown', fault,
    signature: [
      `class=${code(cls, CLASSES)}`, `detail=${code(r?.detail, ENUMS.detail) ?? '-'}`, `error=${word(r?.error_name) ?? '-'}`,
      `list_error=${listWord(typeof r?.list_error === 'string' ? r.list_error : r?.list_error?.code) ?? '-'}`,
      `http=${bucketHttp(r?.http_status) ?? '-'}`, ...extra,
    ].join(';'),
  });

  const detailCls = primary ? detailOf(primary) : null;
  let usedDetail = false;
  // A worker that cannot go on reports the same reason again at every later stage (install, init, plan,
  // catalog): that is one failure, at the first stage that hit it (R-CHECKIN-17).
  const cascade = new Set();
  for (const s of item.skips) {
    let cls = s.reason;
    let fault = skipFault(s);
    if (detailCls && AMBIGUOUS.has(s.reason)) { cls = detailCls; if (!s.fault) fault = 'tool'; usedDetail = true; }
    else if (detailCls === s.reason) usedDetail = true;
    if (!want.has(fault)) continue;
    const again = `${cls}\u0000${fault}\u0000${s.retryable === true}`;
    if (cascade.has(again)) continue;
    cascade.add(again);
    out.push({ ...common(primary, cls, s.stage, fault, [`fault=${fault}`, `retryable=${s.retryable === true}`]), partial: false });
  }
  if (detailCls && !usedDetail && want.has('tool')) out.push({ ...common(primary, detailCls, 'static', 'tool', ['fault=tool', 'retryable=false']), partial: false });
  for (const r of results) {
    if (r.status === 'error' && want.has('tool') && !out.some((f) => f.cls === 'tool_error')) {
      out.push({ ...common(r, 'tool_error', 'static', 'tool', ['fault=tool', 'retryable=false']), partial: false });
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
      for (const p of partials) out.push({ ...common(r, 'reader_limit', 'static', 'tool', [`partial=${p}`]), partial: true });
    }
  }
  // Tool names and versions are ours (toolTags), never name-redacted (R-CHECKIN-15); the lane is our workflow name (R-CHECKIN-14).
  const tool = item.tools.length ? item.tools.join(',') : 'unknown';
  return out.map((f) => ({ ...f, tool: /^[a-z0-9@._,+<>-]{1,400}$/.test(tool) ? tool : '<other>', lane: /^[A-Za-z0-9._-]{1,80}$/.test(item.lane ?? '') ? item.lane : '<other>' }));
}

const idOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

/** The fingerprint id (tool versions included) and its parts. */
export function fingerprintOf(f) {
  const parts = { tool: f.tool, lane: f.lane, component: f.stage, oracle: f.lane, class: f.cls, idiom: f.idiom, layout: f.layout, signature: f.signature };
  return { id: idOf(parts), parts };
}

/** `a@1,b@2` -> `a,b`: the tool names without their versions. */
export const toolNames = (tool) => String(tool).split(',').map((t) => t.replace(/@[^@]*$/, '')).join(',');

/**
 * The lead id: fingerprintOf()'s parts with the tool part cut to the lane's own
 * tool (the first a manifest names) without its version, and those parts.
 * Probe tools a lane adds or drops (fuzz) and every version stay out of the id,
 * so neither splits one bug into two issues; `versions` keeps them all
 * (name@version).
 */
export function leadKeyOf(f) {
  const { parts } = fingerprintOf(f);
  const tags = String(parts.tool).split(',').filter((t) => t && t !== 'unknown');
  // Only our own tools go into a lead (and so into an issue): a third-party tool a worker runs (gvisor, an SDK) is left out.
  const own = tags.filter((t) => OWN_TOOLS.includes(t.replace(/@[^@]*$/, '')));
  const lead = { ...parts, tool: own.length ? own[0].replace(/@[^@]*$/, '') : '<other>' };
  return { id: idOf(lead), parts: lead, versions: own };
}

// ---------------------------------------------------------------- items

const parseJson = (buf) => { try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); } catch { return null; } };

let laneTable = null;
/** workflow file basename and repo -> our workflow name, from pump/workflows.json (read once). */
function lanes() {
  if (!laneTable) {
    laneTable = [];
    try {
      const wf = JSON.parse(readFileSync(new URL('../pump/workflows.json', import.meta.url), 'utf8')).workflows ?? {};
      for (const [name, w] of Object.entries(wf)) laneTable.push({ name, repo: String(w?.repo ?? '').toLowerCase(), file: String(w?.file ?? '') });
    } catch { /* no table: lanes are file names */ }
  }
  return laneTable;
}

/**
 * The lane of a manifest: our workflow name for its repo and file (pump/workflows.json:
 * writecheck runs corpus.yml), else the file's name without .yml.
 */
export function laneOf(workflow) {
  const file = String(workflow?.file ?? '').split('/').pop();
  const repo = String(workflow?.repo ?? '').toLowerCase();
  const hit = lanes().find((l) => l.file === file && l.repo === repo);
  return hit ? hit.name : file.replace(/\.ya?ml$/, '') || 'unknown';
}

/**
 * One accepted item in the shape failuresOf() reads, from its manifest and
 * files (a Map of path to bytes, manifest.json not needed in it).
 * @param {{manifest: object, files: Map<string, Buffer>, subject?: string, lane?: string}} o
 *   subject: the state key the result is recorded under (default the manifest's);
 *   lane: the workflow name (default laneOf(manifest.workflow))
 */
export function itemFromBundle({ manifest: man, files, subject, lane }) {
  const results = new Map();
  for (const [p, d] of files) {
    const m = /^results\/([A-Za-z0-9._-]+)\.json$/.exec(p);
    if (m) { const r = parseJson(d); if (r && typeof r === 'object') results.set(m[1], r); }
  }
  return {
    subject: subject ?? man.subject?.id,
    version: man.subject?.sha ?? man.subject?.artifact_digest ?? null,
    sent_as: man.subject?.id,
    lane: lane ?? laneOf(man.workflow),
    observed_at: man.finished_at,
    tools: toolTags(man.tools),
    skips: Array.isArray(man.skips) ? man.skips : [],
    results,
    scan: parseJson(files.get('raw/subject/scan.json')),
    fields: observedFields(files),
  };
}

let seedLangs = null;
/**
 * Subject key (lower case) -> repository language from the seed list
 * (history/seed-v1.json, read once), as the check-in's loadSeed reads it: the
 * idiom of a result with no reader language says `repo:<language>`.
 */
export function seedLanguageOf(file = new URL('../history/seed-v1.json', import.meta.url)) {
  if (!seedLangs) {
    seedLangs = new Map();
    try {
      for (const s of JSON.parse(readFileSync(file, 'utf8')).subjects ?? []) seedLangs.set(String(s.id).toLowerCase(), s.language ?? s.github_language ?? null);
    } catch { /* no seed: no repository languages */ }
  }
  return (subject) => seedLangs.get(String(subject).toLowerCase()) ?? null;
}

/** The fault sides a lead is made for: ours, the unstated, and passing conditions (filed only after 3 days; state/leads.mjs). */
export const LEAD_FAULTS = Object.freeze(['tool', 'unknown', 'infra']);

/**
 * The leads of one accepted item: one entry per distinct lead id, with its
 * parts, fault side, tool versions and partial flag. Never throws: an item
 * that cannot be read gives null, which is not "no leads" (an empty list would
 * count as a clean re-check of every lead its subject and lane carried).
 */
export function leadFailures(item, { langOf } = {}) {
  try {
    const out = new Map();
    for (const f of failuresOf(item, { faults: LEAD_FAULTS }, { ...(langOf ? { langOf } : {}) })) {
      const k = leadKeyOf(f);
      if (!out.has(k.id)) out.set(k.id, { fingerprint: k.id, ...k.parts, partial: f.partial, fault: f.fault, versions: k.versions });
    }
    return [...out.values()];
  } catch {
    return null;
  }
}
