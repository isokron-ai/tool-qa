// The filing plan for leads (DESIGN-v3 section 7): which leads get an issue
// now, which issues close or reopen, and what each issue says. Pure over the
// state store; leads/step.mjs carries it out in the pump, and leads/dry-run.mjs
// prints it.
//
// Order: the leads whose fix unlocks most, as the check-in ranks them:
//   priority = severity[class] * (partial_multiplier if a partial reader limit) * sum of tier weights of the subjects that carry it now
// (severity and partial_multiplier are longitudinal/checkin.mjs DEFAULT_CONFIG,
// tier weights pump/tiers.json). Caps per repository: CAP_NEW_PER_REPO_PER_DAY
// new issues per UTC day, and never more than CAP_OPEN_PER_REPO open.
//
// An issue holds the lead's shape only (state/leads.mjs SHAPE_COLUMNS), our
// tool and its versions, counts, and a synthetic repro (leads/repro.mjs): never
// a subject name, a run id, a payload or third-party code. assertShapeOnly()
// checks every free word once more against every subject name the state knows
// before anything is sent.

import { DEFAULT_CONFIG } from '../longitudinal/checkin.mjs';
import { DETAIL_CLASS, word } from '../state/fingerprint.mjs';
import { CAP_NEW_PER_REPO_PER_DAY, CAP_OPEN_PER_REPO, CLEAN_RECHECKS_TO_CLOSE, filingDecision, flakeStats, INFRA_MIN_DAYS, shapeOf } from '../state/leads.mjs';
import { syntheticRepro } from './repro.mjs';

export const LABEL = 'loop-lead';
/** The marker every lead issue's title starts with; filing looks it up by this after a crash. */
export const titleTag = (fp) => `[lead ${fp}]`;
export const MARKER = (fp) => `<!-- tool-qa lead ${fp} -->`;
const SITE = 'https://isokron.ai/?utm_source=github&utm_medium=issue&utm_campaign=tool-qa-lead';

const dayStart = (now) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
/** class, `:partial` for a partial reader limit, and `/cause` for a worker's fine cause (live-probe's detail code). */
export const kindOf = (l) => {
  const partial = /;partial=([a-z_]+)/.exec(l.signature)?.[1];
  const detail = /(?:^|;)detail=([a-z_]+)(?:;|$)/.exec(l.signature)?.[1];
  const own = detail && detail !== l.class && DETAIL_CLASS[detail] !== l.class; // scan-static's detail word only restates its class
  return `${l.class}${partial ? `:${partial}` : ''}${own ? `/${detail}` : ''}`;
};

/** Tier and count of the subjects that carry a lead now: {byTier: {T1: 2}, weight, current}. */
function carriers(db, fp, tierOf, tierWeights) {
  const byTier = {};
  let weight = 0;
  let current = 0;
  for (const p of db.leadSubjects(fp)) {
    if (p.current !== 1) continue;
    current += 1;
    const tier = tierOf(p.subject);
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    weight += Number(tierWeights[tier] ?? 0);
  }
  return { byTier: Object.fromEntries(Object.entries(byTier).sort(([a], [b]) => a.localeCompare(b))), weight, current };
}

/**
 * @param {import('../state/db.mjs').StateDb} db
 * @param {{now: string, tierWeights: object, tierOf?: (subject: string) => string, config?: object}} o
 * @returns {{file: object[], held: object[], capped: object[], close: object[], reopen: object[], indoubt: object[], caps: object}}
 *   each entry {lead (shape), priority, carriers, decision, flake}
 */
export function planFilings(db, { now, tierWeights, tierOf = null, config = DEFAULT_CONFIG, capNew = CAP_NEW_PER_REPO_PER_DAY, capOpen = CAP_OPEN_PER_REPO } = {}) {
  const tiers = tierOf ?? (() => { const m = new Map(db.listSubjects().map((s) => [s.id, `T${s.tier}`])); return (id) => m.get(id) ?? 'T4'; })();
  const leads = db.listLeads();
  const today = dayStart(now);
  const caps = {};
  const capFor = (repo) => {
    if (!caps[repo]) {
      const mine = leads.filter((l) => l.repo === repo);
      const newToday = mine.filter((l) => (l.filed_at ?? l.filing_started_at ?? '') >= today).length;
      const open = mine.filter((l) => l.issue_number != null && l.issue_state === 'open').length + mine.filter((l) => l.issue_number == null && l.filing_started_at).length;
      caps[repo] = { new_today: newToday, open, room: Math.max(0, Math.min(capNew - newToday, capOpen - open)) };
    }
    return caps[repo];
  };
  const out = { file: [], held: [], capped: [], close: [], reopen: [], indoubt: [], caps };
  const entries = [];
  for (const l of leads) {
    const c = carriers(db, l.fingerprint, tiers, tierWeights);
    const severity = (config.severity[l.class] ?? config.severity.default) * (l.partial ? config.partial_multiplier : 1);
    const pairs = db.leadSubjects(l.fingerprint);
    const e = { lead: shapeOf(l), priority: Math.round(severity * c.weight * 100) / 100, carriers: c, flake: flakeStats(pairs, now) };
    if (l.issue_number != null && l.needs_sync === 1) {
      (l.status === 'closed' ? out.close : out.reopen).push(e);
      continue;
    }
    if (l.issue_number == null && l.filing_started_at) { out.indoubt.push(e); continue; }
    const d = filingDecision(l, { pairs, now });
    if (!d) continue;
    e.decision = d;
    if (d.file) entries.push(e);
    else out.held.push(e);
  }
  entries.sort((a, b) => b.priority - a.priority || b.carriers.current - a.carriers.current || a.lead.fingerprint.localeCompare(b.lead.fingerprint));
  for (const e of entries) {
    const cap = capFor(e.lead.repo);
    if (cap.room > 0) { cap.room -= 1; out.file.push(e); } else out.capped.push(e);
  }
  for (const repo of new Set(leads.map((l) => l.repo))) capFor(repo);
  return out;
}

/** The issue for a lead (an entry of planFilings()): title, body and labels. Shapes only. */
export function issueFor(e, { now }) {
  const l = e.lead;
  const kind = kindOf(l);
  const versions = (Array.isArray(l.versions) ? l.versions : JSON.parse(l.versions ?? '[]')).join(', ') || 'none recorded';
  const tiers = Object.entries(e.carriers.byTier).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none now';
  const why = {
    reproduced: 'A re-run of the same server and lane, in another worker run on a fresh runner, showed it again',
    flake_rate: `It comes and goes on the same server: ${Math.round(e.flake.rate * 100)}% of ${e.flake.total} results over 14 days carried it`,
    infra_3_days: `A passing-condition (infra) failure that has gone on for ${INFRA_MIN_DAYS} days or more`,
  }[e.decision?.reason] ?? 'It met the filing rules';
  const title = `${titleTag(l.fingerprint)} ${kind} in ${l.lane} ${l.component} (${l.idiom}${l.layout && l.layout !== 'unknown' ? `, ${l.layout}` : ''})`;
  const body = [
    MARKER(l.fingerprint),
    `Automated lead from the IsoKron tool-qa loop: a failure in our own tool, seen across the servers the loop tests. Shape only: no server names, payloads or third-party code (tool-qa docs/OPERATIONS.md, "Leads").`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Fingerprint | \`${l.fingerprint}\` |`,
    `| Tool | ${l.tool} (seen on: ${versions}) |`,
    `| Lane / component / oracle | ${l.lane} / ${l.component} / ${l.oracle} |`,
    `| Class | \`${kind}\`${l.partial ? ' (partial: the result was graded, with this part missing)' : ''} |`,
    `| Fault side | ${l.fault}${l.fault === 'unknown' ? ' (the worker could not say whose; counted as ours until triaged)' : ''} |`,
    `| SDK idiom | \`${l.idiom}\` |`,
    `| Layout | \`${l.layout}\` |`,
    `| Signature | \`${l.signature}\` |`,
    '',
    `**Counts.** ${e.carriers.current} server${e.carriers.current === 1 ? '' : 's'} carry it on their latest result (${tiers}); seen ${l.sightings} times from ${l.first_seen.slice(0, 10)} to ${l.last_seen.slice(0, 10)}${l.reopened ? `; reopened ${l.reopened} time${l.reopened === 1 ? '' : 's'}` : ''}. Priority ${e.priority} (severity x tier weights of those servers).`,
    '',
    `**Why it is filed.** ${why}.`,
    '',
    '### Synthetic repro',
    '',
    syntheticRepro(l),
    '',
    '### Closing',
    '',
    `The loop closes this issue by itself after ${CLEAN_RECHECKS_TO_CLOSE} clean re-checks (assessed results without this fingerprint) once no server carries it, and reopens it if it comes back. Filed ${now.slice(0, 10)}.`,
    '',
    `Filed by the [IsoKron](${SITE}) tool-qa loop.`,
  ].join('\n');
  return { title, body, labels: [LABEL] };
}

/**
 * Throw unless an issue holds no subject name: its free words (the
 * signature's error and list_error) are checked again against every subject
 * name the state knows now, and the text must not hold any subject id.
 */
export function assertShapeOnly(lead, text, { names, subjects = [] }) {
  for (const m of String(lead.signature).matchAll(/(?:^|;)(error|list_error)=([^;]*)/g)) {
    const v = m[2];
    if (v === '-' || v === '<other>') continue;
    if (word(v, names) !== v) throw new Error(`lead ${lead.fingerprint}: the ${m[1]} word is not shape-only`);
  }
  const low = String(text).toLowerCase();
  for (const s of subjects) {
    const id = String(s).toLowerCase();
    if (id.includes('/') && !id.startsWith('isokron-ai/') && low.includes(id)) throw new Error(`lead ${lead.fingerprint}: the issue holds a subject name`);
  }
  // idiom and layout are built from closed lists (state/fingerprint.mjs): their alphabet is all that can be checked.
  if (/[^a-z0-9/:#+._<>-]/i.test(lead.idiom) || /[^a-z0-9:;._<>-]/i.test(lead.layout)) throw new Error(`lead ${lead.fingerprint}: idiom or layout is not shape-only`);
}

/** The plan as Markdown for a job summary (shapes only). */
export function renderPlan(plan, { now, mode, done = null }) {
  const L = [];
  const row = (e, what) => `| \`${e.lead.fingerprint}\` | ${e.lead.repo.replace('isokron-ai/', '')} | ${e.lead.lane} / ${e.lead.component} | ${kindOf(e.lead)} | ${e.lead.fault} | ${e.lead.idiom} | ${e.carriers.current} | ${e.priority} | ${what} |`;
  L.push(`## Leads (${mode}) at ${now}`, '');
  L.push(`${plan.file.length} to file now, ${plan.capped.length} over the caps, ${plan.held.length} held, ${plan.close.length} to close, ${plan.reopen.length} to reopen, ${plan.indoubt.length} filings to confirm.${mode === 'on' ? '' : ' Dry run: no issue is touched.'}`, '');
  L.push('Caps per repository (new today / open): ' + Object.entries(plan.caps).map(([r, c]) => `${r.replace('isokron-ai/', '')} ${c.new_today}/${c.open}`).join(', '), '');
  L.push('| fingerprint | repo | lane / component | class | fault | idiom | now on | priority | action |', '|---|---|---|---|---|---|---|---|---|');
  for (const e of plan.file) L.push(row(e, done?.get(e.lead.fingerprint) ?? `file: ${e.decision.reason}`));
  for (const e of plan.close) L.push(row(e, `close #${e.lead.issue_number}`));
  for (const e of plan.reopen) L.push(row(e, `reopen #${e.lead.issue_number}`));
  for (const e of plan.capped) L.push(row(e, 'capped'));
  for (const e of plan.held) L.push(row(e, `held: ${e.decision.reason}`));
  return `${L.join('\n')}\n`;
}
