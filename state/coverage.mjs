// Tool coverage from state (DESIGN-v3 4.7): four numbers per lane against a
// dated, versioned frame. docs/METHODOLOGY.md says how each is computed.
//
// computeCoverage(db, { tiers, workflows }) reads only: subjects, results and
// kv. It writes nothing. recordTruth() is the one writer (kv coverage.truth,
// a human-fed judgment per result) and recordCoverageDay() the daily history
// (kv coverage.history), both called by their own jobs, never by the reader.
//
// Importers (the watchdog's coverage health check, the health issue writer,
// the live snapshot): import { computeCoverage, compactCoverage } from
// '../state/coverage.mjs'.

import { createHash } from 'node:crypto';

export const SCHEMA = 'isokron-loop-coverage/1';
export const TRUTH_KEY = 'coverage.truth';
export const FRAME_KEY = 'frame.current';
export const HISTORY_KEY = 'coverage.history';
export const HISTORY_MAX_DAYS = 400;
export const TRUTH_STATES = Object.freeze(['correct', 'incorrect']);
export const TRUTH_SOURCES = Object.freeze(['qa_gate', 'resolved_disagreement', 'hand_review']);
export const M3_TARGET = 0.98;
export const M3_TIERS = Object.freeze([0, 1, 2]);
/** The reason a number is empty. */
export const NOT_MEASURABLE = 'not_yet_measurable';

const FRAME_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round = (x) => Math.round(x * 10_000) / 10_000;
const ratio = (a, b) => (b > 0 ? round(a / b) : null);
const rawOf = (db) => db?.raw ?? db;

function readKv(raw, key) {
  try {
    const row = raw.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The frame in force: kv `frame.current` ({version, dated}) when it names one
 * (the discover lane's job to write), else derived from the active subjects:
 * a hash of their ids, dated by the newest first_seen among them.
 */
export function frameOf(raw, subjects) {
  const set = readKv(raw, FRAME_KEY);
  if (set && typeof set.version === 'string' && FRAME_VERSION_RE.test(set.version) && typeof set.dated === 'string' && DATE_RE.test(set.dated.slice(0, 10))) {
    return { version: set.version, dated: set.dated.slice(0, 10), size: subjects.length, source: 'state' };
  }
  const ids = subjects.map((s) => s.id).sort();
  const hash = createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 8);
  const dated = subjects.map((s) => String(s.first_seen ?? '').slice(0, 10)).filter((d) => DATE_RE.test(d)).sort().at(-1) ?? null;
  return { version: `derived-${hash}`, dated, size: subjects.length, source: 'derived' };
}

/** The newest accepted result of each (subject, workflow). */
function latestResults(raw) {
  const rows = raw.prepare('SELECT run_key, subject, workflow, accepted_at, coverage FROM results ORDER BY accepted_at, run_key').all();
  const map = new Map();
  for (const r of rows) map.set(`${r.subject}\u0000${r.workflow}`, r);
  return map;
}

function truthOf(raw) {
  const t = readKv(raw, TRUTH_KEY);
  return t && typeof t === 'object' && t.entries && typeof t.entries === 'object' ? t.entries : {};
}

const NEVER = (cell) => !cell || cell.mode === 'never';

/**
 * @param {object} db  a StateDb or a node:sqlite database
 * @param {{tiers: object, workflows: object, skipLanes?: string[], rules?: object}} cfg  rules: only the mutation check passes other than RULES
 */
export const RULES = Object.freeze({ excludedLeaveDenominator: true, unmeasuredIsNull: true, toolSkipStaysEligible: true });

export function computeCoverage(db, { tiers, workflows, skipLanes = [], rules = RULES }) {
  const raw = rawOf(db);
  const subjects = raw.prepare('SELECT id, tier, first_seen FROM subjects WHERE retired_at IS NULL AND gone_at IS NULL AND alias_of IS NULL ORDER BY id').all();
  const frame = frameOf(raw, subjects);
  const latest = latestResults(raw);
  const truth = truthOf(raw);
  const skip = new Set(skipLanes);
  const laneIds = Object.keys(workflows ?? {}).filter((id) => !skip.has(id)).sort();
  const lanes = [];
  for (const id of laneIds) {
    const L = { id, on: workflows[id]?.enabled === true, frame: 0, excluded: 0, eligible: 0, reached: 0, assessed: 0, judged: 0, correct: 0, incorrect: 0,
      unassessed: { not_reached: 0, tool: 0, infra: 0, unsupported: 0, legacy: 0 }, tiers: {}, t012: { eligible: 0, correct: 0 } };
    for (const s of subjects) {
      if (NEVER(tiers?.tiers?.[`T${s.tier}`]?.[id])) continue;
      const T = (L.tiers[s.tier] ??= { frame: 0, excluded: 0, assessed: 0, judged: 0, correct: 0, incorrect: 0 });
      L.frame++; T.frame++;
      const r = latest.get(`${s.id}\u0000${id}`);
      if (r) L.reached++;
      if (r?.coverage === 'excluded' || (!rules.toolSkipStaysEligible && (r?.coverage === 'unassessed_tool' || r?.coverage === 'unassessed_unknown'))) {
        L.excluded++; T.excluded++;
        if (rules.excludedLeaveDenominator) continue;
      }
      L.eligible++;
      const inT012 = M3_TIERS.includes(s.tier);
      if (inT012) L.t012.eligible++;
      if (!r) L.unassessed.not_reached++;
      else if (r.coverage === 'assessed') {
        L.assessed++; T.assessed++;
        const j = truth[r.run_key];
        if (j?.state === 'correct') { L.judged++; T.judged++; L.correct++; T.correct++; if (inT012) L.t012.correct++; }
        else if (j?.state === 'incorrect') { L.judged++; T.judged++; L.incorrect++; T.incorrect++; }
      } else if (r.coverage === 'unassessed_tool' || r.coverage === 'unassessed_unknown') L.unassessed.tool++;
      else if (r.coverage === 'unassessed_infra') L.unassessed.infra++;
      else if (r.coverage === 'subject') L.unassessed.unsupported++;
      else L.unassessed.legacy++;
    }
    lanes.push(L);
  }
  const out = lanes.filter((L) => L.frame > 0).map((L) => {
    const measurable = L.judged > 0 || !rules.unmeasuredIsNull;
    return {
      id: L.id, on: L.on, frame: L.frame, excluded: L.excluded, eligible: L.eligible, reached: L.reached, assessed: L.assessed,
      judged: L.judged, correct: L.correct, incorrect: L.incorrect, unassessed: L.unassessed,
      // The four numbers. null = not yet measurable (no result of this lane has a correct/incorrect judgment).
      assessment: ratio(L.assessed, L.eligible),
      conditional: measurable ? (L.judged > 0 ? ratio(L.correct, L.judged) : 1) : null,
      frame_coverage: measurable ? ratio(L.correct, L.eligible) : null,
      gross: measurable ? ratio(L.correct, L.frame) : null,
      measurable,
      tiers: Object.fromEntries(Object.entries(L.tiers).sort(([a], [b]) => a - b).map(([t, v]) => [`T${t}`, v])),
      t012: { eligible: L.t012.eligible, correct: L.t012.correct, value: measurable ? ratio(L.t012.correct, L.t012.eligible) : null },
    };
  });
  const enabledAlways = out.filter((L) => L.on);
  const m3Values = enabledAlways.map((L) => L.t012.value);
  const m3Known = m3Values.length > 0 && m3Values.every((v) => v !== null);
  return {
    schema: SCHEMA,
    frame,
    lanes: out,
    milestones: {
      m1: { reached: enabledAlways.reduce((a, L) => a + L.reached, 0), total: enabledAlways.reduce((a, L) => a + L.frame, 0) },
      m2: { status: 'outside_state', note: 'measured on the frozen benchmark, not from state' },
      m3: { target: M3_TARGET, tiers: [...M3_TIERS], met: m3Known ? m3Values.every((v) => v >= M3_TARGET) : null },
    },
  };
}

/** The part of the numbers the live snapshot carries (small, no tier table). */
export function compactCoverage(c) {
  return {
    schema: c.schema,
    frame: { version: c.frame.version, dated: c.frame.dated, size: c.frame.size },
    lanes: c.lanes.map((L) => ({
      id: L.id, frame: L.frame, excluded: L.excluded, assessed: L.assessed, judged: L.judged, correct: L.correct, incorrect: L.incorrect,
      assessment: L.assessment, conditional: L.conditional, frame_coverage: L.frame_coverage, gross: L.gross,
    })),
    milestones: { m1: c.milestones.m1, m3: { target: c.milestones.m3.target, met: c.milestones.m3.met } },
  };
}

const pct = (x) => (x === null ? 'not yet measurable' : `${(x * 100).toFixed(1)}%`);
const ofN = (a, b) => `${a} of ${b}`;

/** Markdown for the health issue: the four numbers per lane, then the tier contingency table. */
export function renderCoverageMarkdown(c) {
  const f = c.frame;
  const out = [
    `**Tool coverage** against frame \`${f.version}\` (dated ${f.dated ?? 'unknown'}, ${f.size} servers; frame from ${f.source}). Never read one number alone. Frame and gross coverage count only results judged correct, so they are lower bounds until more results are judged. How each is computed: docs/METHODOLOGY.md.`,
    '',
    '| Lane | Assessment | Conditional correctness | Frame coverage | Gross coverage | Assessed | Judged | Excluded |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const L of c.lanes) {
    out.push(`| ${L.id}${L.on ? '' : ' (off)'} | ${pct(L.assessment)} (${ofN(L.assessed, L.eligible)}) | ${pct(L.conditional)}${L.measurable ? ` (${ofN(L.correct, L.judged)} judged)` : ''} | ${pct(L.frame_coverage)} | ${pct(L.gross)} | ${L.assessed} | ${L.judged} | ${L.excluded} |`);
  }
  out.push('', '| Lane | Tier | Frame | Excluded | Assessed | Judged correct | Judged incorrect |', '|---|---|---|---|---|---|---|');
  for (const L of c.lanes) for (const [t, v] of Object.entries(L.tiers)) out.push(`| ${L.id} | ${t} | ${v.frame} | ${v.excluded} | ${v.assessed} | ${v.correct} | ${v.incorrect} |`);
  const m = c.milestones;
  out.push('', `Milestones: M1 reached ${m.m1.reached} of ${m.m1.total} lane pairs; M2 is measured on the frozen benchmark; M3 (frame coverage ${(m.m3.target * 100).toFixed(0)}% on T0 to T2) ${m.m3.met === null ? 'not yet measurable' : m.m3.met ? 'met' : 'not met'}.`);
  return out;
}

/**
 * Record judgments (the one writer of kv coverage.truth). Each judgment names a
 * result by run_key, or by subject + workflow (its newest result), a state and a
 * source. A judgment only applies to an assessed result; others are returned in
 * `rejected` with a reason and nothing is written for them.
 * @returns {{recorded: number, rejected: {index: number, reason: string}[]}}
 */
export function recordTruth(db, judgments, { now = Date.now() } = {}) {
  const raw = rawOf(db);
  const cur = readKv(raw, TRUTH_KEY);
  const entries = cur && typeof cur === 'object' && cur.entries ? { ...cur.entries } : {};
  const latest = latestResults(raw);
  const byKey = new Map(raw.prepare('SELECT run_key, subject, workflow, coverage FROM results').all().map((r) => [r.run_key, r]));
  const rejected = [];
  let recorded = 0;
  judgments.forEach((j, index) => {
    const bad = (reason) => rejected.push({ index, reason });
    if (!TRUTH_STATES.includes(j?.state)) return bad('state must be correct or incorrect');
    if (!TRUTH_SOURCES.includes(j?.source)) return bad(`source must be one of ${TRUTH_SOURCES.join(', ')}`);
    const r = typeof j.run_key === 'string' ? byKey.get(j.run_key) : latest.get(`${j.subject}\u0000${j.workflow}`);
    if (!r) return bad('no such result');
    if (r.coverage !== 'assessed') return bad('the result was not assessed, so there is nothing to judge');
    entries[r.run_key] = { state: j.state, source: j.source, at: new Date(now).toISOString() };
    recorded++;
  });
  if (recorded > 0) {
    raw.prepare('INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated')
      .run(TRUTH_KEY, JSON.stringify({ version: 1, entries }), new Date(now).toISOString());
  }
  return { recorded, rejected };
}

/**
 * Add today's compact numbers to kv coverage.history (one entry per UTC day, so
 * a score is kept against the frame it was measured on; D3 4.7). No-op when
 * today already has one. Returns true when it wrote.
 */
export function recordCoverageDay(db, coverage, { now = Date.now() } = {}) {
  const raw = rawOf(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const cur = readKv(raw, HISTORY_KEY);
  const days = Array.isArray(cur?.days) ? cur.days : [];
  if (days.some((d) => d.day === day)) return false;
  days.push({ day, ...compactCoverage(coverage) });
  const kept = days.slice(-HISTORY_MAX_DAYS);
  raw.prepare('INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated')
    .run(HISTORY_KEY, JSON.stringify({ version: 1, days: kept }), new Date(now).toISOString());
  return true;
}
