// Change detection: the default-branch head and the latest release of every
// bound subject (design audit A3, DESIGN-v3 4.1 and 4.3).
//
// The due list (pump/due.mjs) makes a pair due when the subject's version
// moves (`new_version`: its sha is part of the run_key) or when a change event
// arrived after the pair's last result (`change_event`: subjects.changed_at).
// Until this pass nothing ever wrote either: every subject's sha and
// changed_at were null, so a subject was looked at again only on its tier's
// age. refreshHeads() is the writer.
//
// It runs in the pump, the state's only writer, right after the subject id
// pass (pump/identity.mjs) at the start of every run. One GraphQL query asks
// for up to BATCH (100) repositories by node id, and costs one point
// (rateLimit.cost):
//
//   nodes(ids) { ... on Repository { databaseId isEmpty
//     defaultBranchRef { target { oid } } latestRelease { tagName publishedAt } } }
//
// What an answer does to a subject (state/db.mjs noteHead, noteChange):
//
//   head_first_seen  the subject had no sha: the head becomes its sha and
//                    changed_at is set. Its run_keys move once, so every
//                    pair is due as new_version.
//   new_sha          the head differs from the sha we hold: the sha and
//                    changed_at move (new_version).
//   new_release      the head is the sha we hold, but the latest release was
//                    published after changed_at: changed_at moves
//                    (change_event).
//   nothing          otherwise, and for an empty repository, a node that is
//                    not found, or a node whose databaseId is not the
//                    subject's repo_id. Those are counted, never written:
//                    whether a repository is gone or was renamed is the id
//                    pass's call (it marks gone_at), never this one's, and a
//                    poll that could not read a head says nothing about the
//                    server (no fault is recorded anywhere).
//
// Cadence: subjects are polled tier by tier in cycles, oldest key first
// (tiers.json head_poll_hours: T0 every run, T1 hourly, T2 every 6 hours, T3
// daily, T4 every 3 days). A tier's cycle walks its subjects by key from a
// cursor kept in kv pump.heads; a new cycle starts once the last one started
// at least head_poll_hours ago and has finished. One query mixes tiers, so a
// tier with five subjects costs nothing extra.
//
// Budget guard: at most MAX_QUERIES (3) queries a run, through the pump's API
// budget (family `graphql`, 30 an hour and 5 a minute, shared with the id
// pass), with the job's GITHUB_TOKEN (1,000 points an hour). A pass also stops
// when GitHub reports fewer than POINTS_RESERVE points left, so the id pass,
// the identity re-checks and anything else on that token keep their share.
// The 997 seed subjects take 10 queries a day at steady state, plus about one
// an hour for T0 to T2.
//
// Never throws and never holds the pump. What the pass did is kept in kv
// pump.heads; the watchdog's `subject-heads` item (watchdog/heads.mjs) goes
// amber when no poll has been written for HEADS_AMBER_HOURS.
//
// Switch: LANE_HEADS_ENABLED. Only the exact value "true" turns it on.
// Otherwise nothing is polled and kv pump.heads says off.

import { BudgetExceededError } from './budgets.mjs';

const HOUR = 3_600_000;

export const HEADS_KV_KEY = 'pump.heads';
/** Repositories per GraphQL query (one point each, whatever the count up to 100). */
export const BATCH = 100;
/** GraphQL queries one pump run may make for heads. */
export const MAX_QUERIES = 3;
/** Stop when GitHub says fewer GraphQL points than this are left on the token. */
export const POINTS_RESERVE = 200;
/** Used when tiers.json has no head_poll_hours for a tier. */
export const DEFAULT_POLL_HOURS = Object.freeze({ T0: 0, T1: 1, T2: 6, T3: 24, T4: 72 });

const OID_RE = /^[0-9a-f]{40}$/;

/** Whether the head poll may run: LANE_HEADS_ENABLED is exactly "true". */
export function headsEnabled(env = {}) {
  return env.LANE_HEADS_ENABLED === 'true';
}

/** Hours between two poll cycles of a tier (tiers.json head_poll_hours, else the default). */
export function pollHours(tiers, tierName) {
  const h = Number(tiers?.head_poll_hours?.[tierName]);
  if (Number.isFinite(h) && h >= 0) return h;
  return DEFAULT_POLL_HOURS[tierName] ?? 24;
}

/** The GraphQL query for heads by node id (ids as a variable, never in the text). */
export function buildHeadsQuery(nodeIds) {
  return {
    query: 'query($ids: [ID!]!) { rateLimit { cost remaining } nodes(ids: $ids) { __typename ... on Repository { databaseId isEmpty defaultBranchRef { target { oid } } latestRelease { tagName publishedAt } } } }',
    variables: { ids: [...nodeIds] },
  };
}

/**
 * What to poll this run: subjects in tier order, then by key, from each tier's
 * cursor, at most `limit`. Returns {picks: [{subject, tier}], cycles} where
 * cycles is the tier cursor state this pick would leave once every pick is
 * applied (picked: the keys in order, ends: whether the tier's cycle ends).
 * Pure.
 * @param {{id:string, tier:number, repo_id:number|null, node_id:string|null}[]} subjects  active, bound
 */
export function pickHeads({ subjects, cursors = {}, tiers, now, limit }) {
  const byTier = new Map();
  for (const s of subjects) {
    const k = `T${s.tier}`;
    if (!byTier.has(k)) byTier.set(k, []);
    byTier.get(k).push(s);
  }
  const picks = [];
  const plan = {};
  for (const tierName of [...byTier.keys()].sort()) {
    if (picks.length >= limit) break;
    const list = byTier.get(tierName).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const cur = cursors[tierName] ?? {};
    let after = typeof cur.cursor === 'string' ? cur.cursor : null;
    let startedAt = cur.started_at ?? null;
    if (after === null) {
      // Not inside a cycle: start one once the last started long enough ago.
      const last = Date.parse(startedAt ?? '');
      if (Number.isFinite(last) && now - last < pollHours(tiers, tierName) * HOUR) continue;
      after = '';
      startedAt = new Date(now).toISOString();
    }
    const left = list.filter((s) => s.id > after);
    const take = left.slice(0, limit - picks.length);
    for (const s of take) picks.push({ subject: s, tier: tierName });
    plan[tierName] = { started_at: startedAt, ends: take.length === left.length, picked: take.map((s) => s.id) };
  }
  return { picks, plan };
}

/** Parse one heads answer into per-entry {status, oid, release} in the order asked. */
export function parseHeads(doc, list) {
  const errors = Array.isArray(doc?.errors) ? doc.errors : [];
  const nodes = Array.isArray(doc?.data?.nodes) ? doc.data.nodes : null;
  const all = (status) => list.map(() => ({ status }));
  if (!nodes || nodes.length !== list.length) return all('error');
  if (errors.some((e) => !(e?.type === 'NOT_FOUND' && Array.isArray(e?.path) && e.path[0] === 'nodes'))) return all('error');
  return list.map((s, i) => {
    const n = nodes[i];
    if (!n || typeof n !== 'object' || (n.__typename !== undefined && n.__typename !== 'Repository')) return { status: 'not_found' };
    if (n.databaseId !== s.repo_id) return { status: 'mismatch' };
    const oid = n.defaultBranchRef?.target?.oid;
    if (n.isEmpty === true || !n.defaultBranchRef) return { status: 'empty' };
    if (typeof oid !== 'string' || !OID_RE.test(oid)) return { status: 'error' };
    const pub = Date.parse(n.latestRelease?.publishedAt ?? '');
    return { status: 'ok', oid, release: Number.isFinite(pub) ? { tag: String(n.latestRelease.tagName ?? '').slice(0, 100), published_at: new Date(pub).toISOString() } : null };
  });
}

/**
 * What one answer means for one subject: 'head_first_seen', 'new_sha',
 * 'new_release' or null (nothing to write). Pure.
 */
export function headChange(subject, answer, { now }) {
  if (answer?.status !== 'ok') return null;
  if (subject.sha == null) return 'head_first_seen';
  if (subject.sha !== answer.oid) return 'new_sha';
  const pub = Date.parse(answer.release?.published_at ?? '');
  const changed = Date.parse(subject.changed_at ?? '');
  // A release time in the future (a clock skew) is not believed.
  if (Number.isFinite(pub) && pub <= now && (!Number.isFinite(changed) || pub > changed)) return 'new_release';
  return null;
}

/**
 * Poll heads for the subjects due a poll, within `maxQueries`. Never throws.
 * @param {import('../state/db.mjs').StateDb} db
 * @param {{ client: {request: Function}|null, tiers?: object, now?: () => number, log?: (line: string) => void,
 *   batch?: number, maxQueries?: number, reserve?: number }} opts
 */
export async function refreshHeads(db, { client, tiers = {}, now = Date.now, log = () => {}, batch = BATCH, maxQueries = MAX_QUERIES, reserve = POINTS_RESERVE } = {}) {
  const out = {
    queries: 0, cost: 0, remaining: null, polled: 0, written: 0,
    changes: { head_first_seen: 0, new_sha: 0, new_release: 0 },
    skipped: { empty: 0, not_found: 0, mismatch: 0, error: 0 },
    stopped: null, error: null,
  };
  let prev = {};
  try { prev = db.getKv(HEADS_KV_KEY) ?? {}; } catch { /* none */ }
  const cursors = { ...(prev.tiers ?? {}) };
  let lastWrite = prev.last_write_at ?? null;
  const size = Math.max(1, Math.min(BATCH, Math.trunc(Number(batch)) || BATCH));
  const queries = Math.max(0, Math.trunc(Number(maxQueries)) || 0);
  try {
    if (!client) {
      out.stopped = 'no_token';
    } else {
      const subjects = db.listSubjects().filter((s) => s.kind === 'github' && s.retired_at == null && s.alias_of == null && s.gone_at == null
        && Number.isSafeInteger(s.repo_id) && typeof s.node_id === 'string' && s.node_id !== '');
      const { picks, plan } = pickHeads({ subjects, cursors, tiers, now: now(), limit: size * queries });
      const done = new Set(); // keys whose answer was applied
      for (let i = 0; i < picks.length && out.stopped === null; i += size) {
        const chunk = picks.slice(i, i + size).map((p) => p.subject);
        const { query, variables } = buildHeadsQuery(chunk.map((s) => s.node_id));
        out.queries += 1;
        let res;
        try {
          res = await client.request('POST', '/graphql', { family: 'graphql', body: { query, variables }, retryUnsafe: true });
        } catch (err) {
          out.stopped = err instanceof BudgetExceededError || err?.name === 'BudgetExceededError' ? 'budget' : 'api_error';
          out.error = String(err?.message ?? err).slice(0, 200);
          break;
        }
        const doc = res?.data && typeof res.data === 'object' ? res.data : null;
        const cost = Number(doc?.data?.rateLimit?.cost);
        if (Number.isFinite(cost)) out.cost += cost;
        const remaining = Number(doc?.data?.rateLimit?.remaining);
        if (Number.isFinite(remaining)) out.remaining = remaining;
        const answers = parseHeads(doc, chunk);
        if (answers.every((a) => a.status === 'error')) {
          out.stopped = 'bad_answer';
          out.error = Array.isArray(doc?.errors) ? String(doc.errors[0]?.type ?? doc.errors[0]?.message ?? 'error').slice(0, 100) : 'no data';
          break;
        }
        const t = now();
        const mine = { head_first_seen: 0, new_sha: 0, new_release: 0 }; // this query's changes
        db.tx(() => {
          chunk.forEach((s, j) => {
            const a = answers[j];
            out.polled += 1;
            done.add(s.id);
            if (a.status !== 'ok') { out.skipped[a.status] = (out.skipped[a.status] ?? 0) + 1; return; }
            const why = headChange(s, a, { now: t });
            if (why === null) return;
            if (why === 'new_release') db.noteChange(s.id, { reason: 'new_release', now: t });
            else db.noteHead(s.id, { sha: a.oid, reason: why, now: t });
            out.changes[why] += 1;
            mine[why] += 1;
          });
          db.recordEvent({ type: 'heads_polled', n: chunk.length, data: { changed: mine.head_first_seen + mine.new_sha + mine.new_release, ...mine } }, t);
        });
        out.written += 1;
        lastWrite = new Date(t).toISOString();
        // GitHub's own count: stop before the token runs low for everyone else.
        if (Number.isFinite(remaining) && remaining < reserve) {
          out.stopped = 'points_reserve';
          out.error = `${remaining} GraphQL points left (reserve ${reserve})`;
        }
      }
      // A tier's cursor moves past every key whose answer was applied; its
      // cycle ends once the whole of it was.
      for (const [tierName, p] of Object.entries(plan)) {
        const applied = p.picked.filter((id) => done.has(id));
        const cur = cursors[tierName] ?? {};
        // Nothing left past the cursor (its subjects retired or merged): the cycle is over.
        if (p.picked.length === 0) {
          if (p.ends) cursors[tierName] = { cursor: null, started_at: p.started_at, finished_at: new Date(now()).toISOString() };
          continue;
        }
        if (applied.length === 0) continue;
        const all = applied.length === p.picked.length;
        cursors[tierName] = all && p.ends
          ? { cursor: null, started_at: p.started_at, finished_at: new Date(now()).toISOString() }
          : { cursor: applied.at(-1), started_at: p.started_at, finished_at: cur.finished_at ?? null };
      }
    }
  } catch (err) {
    out.stopped = 'error';
    out.error = String(err?.message ?? err).slice(0, 200);
  }
  try {
    const c = db.raw.prepare(`
      SELECT COUNT(*) AS active, SUM(sha IS NOT NULL) AS with_sha, SUM(changed_at IS NOT NULL) AS with_changed_at
      FROM subjects WHERE kind = 'github' AND retired_at IS NULL AND alias_of IS NULL AND gone_at IS NULL
    `).get();
    out.active = Number(c.active ?? 0);
    out.with_sha = Number(c.with_sha ?? 0);
    out.with_changed_at = Number(c.with_changed_at ?? 0);
  } catch { /* counted as unknown below */ }
  const ch = Object.entries(out.changes).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
  const sk = Object.entries(out.skipped).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
  out.summary = `${out.queries} head queries (${out.polled} repositories${out.cost ? `, ${out.cost} points` : ''}${out.remaining !== null ? `, ${out.remaining} left` : ''})${ch ? `: ${ch}` : ''}${sk ? `; not written: ${sk}` : ''}; ${out.with_sha ?? '?'} of ${out.active ?? '?'} active subjects have a sha${out.stopped ? `; stopped (${out.stopped}${out.error ? `: ${out.error}` : ''})` : ''}`;
  try {
    db.setKv(HEADS_KV_KEY, { at: new Date(now()).toISOString(), off: false, last_write_at: lastWrite, ...out, tiers: cursors }, { now: now() });
  } catch { /* the summary is still returned and logged */ }
  return { ...out, last_write_at: lastWrite, tiers: cursors };
}
