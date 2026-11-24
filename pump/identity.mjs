// Subject identity: GitHub's numeric repository id for every subject (loop
// upgrade #15, state schema v8).
//
// The loop's subjects used to be known only by owner/name, so a rename or a
// transfer would have split a server's history into two subjects. The design
// (DESIGN-v3 4.2) keys a subject by the repository's numeric id. Here:
//
//   subjects.id     the subject key, frozen at first sight. run_keys, leases,
//                   dispatch items, attempts and results name it, and it never
//                   changes, so no run_key moves and nothing becomes due again
//                   because of a rename (or because of this upgrade).
//   subjects.repo_id, node_id, repo_created_at
//                   the identity, looked up here.
//   subjects.name   the current owner/name: what workers are sent.
//
// refreshIdentities() runs once at the start of every pump run, after the seed
// load and before the first tick:
//
//   byName   subjects not bound yet are looked up by name (GitHub's GraphQL
//            follows renames and transfers, so an old name still finds the
//            repository and its current name). This is the backfill.
//   byId     bound subjects are looked up again by node id once a day, which
//            finds renames, transfers and deletions even when the old name has
//            been taken by another repository.
//
// One GraphQL query holds up to BATCH (100) repositories and costs one point
// (rateLimit.cost, measured on GitHub on 24 Nov 2026), so the 997 seed subjects
// take 10 queries to backfill and 10 a day to keep current. At most
// MAX_QUERIES (4) queries a run, through the pump's API budget (family
// `graphql`, 30 an hour, 5 a minute), with the job's GITHUB_TOKEN (1,000
// points an hour). A not-found repository (deleted, or turned private) is
// looked at again a day later; an error an hour later.
//
// A batch in which more than 5 and more than 20% of the repositories answer
// NOT_FOUND is not believed (a token or permission change, not a mass
// deletion): those are errors, looked up again in an hour, and the pass stops.
// The watchdog's `subject-ids` item (watchdog/identity.mjs) shows it red.
//
// It never throws and never holds the pump: any failure (a rate limit, the
// budget, an outage, a bad answer) is logged and kept in kv `pump.identity`;
// subjects not looked up yet are dispatched by name as before. Set
// LANE_SUBJECT_IDS_ENABLED to anything but empty or "true" to stop the lookups
// (the ids already found keep being used).
//
// What each answer does to the state is state/db.mjs applyIdentityLookup():
// binding, rename and transfer events, merging two subjects that turn out to
// be one repository, the not-found subject-fault skip, and the guard against
// a reused id.

import { BudgetExceededError } from './budgets.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const IDENTITY_KV_KEY = 'pump.identity';
/** Repositories per GraphQL query (one point each, whatever the count up to 100). */
export const BATCH = 100;
/** GraphQL queries one pump run may make. */
export const MAX_QUERIES = 4;
/** How long to wait before looking a subject up again, by its last id_status. */
export const RETRY_MS = Object.freeze({ none: 0, ok: DAY, error: HOUR, not_found: DAY, conflict: DAY });

/** A batch with more NOT_FOUND than this (count and share) is not believed (R-SUBJ-13). */
export const MASS_NOT_FOUND = Object.freeze({ min: 5, share: 0.2 });

const FIELDS = 'databaseId id nameWithOwner createdAt';
const NAME_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

/** Whether the lookups may run: LANE_SUBJECT_IDS_ENABLED unset, empty or "true". */
export function identityEnabled(env = {}) {
  const v = env.LANE_SUBJECT_IDS_ENABLED;
  return v === undefined || v === null || v === '' || v === 'true';
}

/** A GraphQL query for repositories by owner/name, with variables (never interpolated). */
export function buildNameQuery(names) {
  const decl = [];
  const body = [];
  const variables = {};
  names.forEach((full, i) => {
    const m = NAME_RE.exec(full);
    if (!m) throw new TypeError(`not owner/name: ${JSON.stringify(full)}`);
    variables[`o${i}`] = m[1];
    variables[`n${i}`] = m[2];
    decl.push(`$o${i}: String!`, `$n${i}: String!`);
    body.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ${FIELDS} }`);
  });
  return { query: `query(${decl.join(', ')}) { rateLimit { cost remaining } ${body.join(' ')} }`, variables };
}

/** A GraphQL query for repositories by node id. */
export function buildIdQuery(nodeIds) {
  return { query: `query($ids: [ID!]!) { rateLimit { cost remaining } nodes(ids: $ids) { __typename ... on Repository { ${FIELDS} } } }`, variables: { ids: [...nodeIds] } };
}

/**
 * The lookups in one GraphQL answer, in the order asked: {status, node} each.
 * status ok, not_found (GitHub said NOT_FOUND for that entry) or error. A
 * whole-answer problem (no data, or an error that is not NOT_FOUND without a
 * path) makes every entry an error.
 */
export function parseAnswer(doc, count, kind) {
  const errors = Array.isArray(doc?.errors) ? doc.errors : [];
  const data = doc?.data && typeof doc.data === 'object' ? doc.data : null;
  const all = (status) => Array.from({ length: count }, () => ({ status, node: null }));
  if (!data || errors.some((e) => e?.type !== 'NOT_FOUND' && !Array.isArray(e?.path))) return all('error');
  const errAt = new Map();
  for (const e of errors) {
    if (!Array.isArray(e?.path)) continue;
    const at = kind === 'id' ? (e.path[0] === 'nodes' && Number.isInteger(e.path[1]) ? e.path[1] : null) : (typeof e.path[0] === 'string' && /^r\d+$/.test(e.path[0]) ? Number(e.path[0].slice(1)) : null);
    if (at === null) return all('error');
    if (!errAt.has(at) || e.type !== 'NOT_FOUND') errAt.set(at, e.type === 'NOT_FOUND' ? 'not_found' : 'error');
  }
  const nodes = kind === 'id' ? (Array.isArray(data.nodes) ? data.nodes : null) : null;
  if (kind === 'id' && (!nodes || nodes.length !== count)) return all('error');
  return Array.from({ length: count }, (_, i) => {
    const node = kind === 'id' ? nodes[i] : data[`r${i}`];
    if (node && typeof node === 'object') {
      // A node id that now names something other than a repository: not ours any more.
      if (kind === 'id' && node.__typename !== undefined && node.__typename !== 'Repository') return { status: 'not_found', node: null };
      return { status: 'ok', node };
    }
    return { status: errAt.get(i) ?? 'error', node: null };
  });
}

/**
 * Look up subject ids for the subjects that need it, within `maxQueries`.
 * Never throws.
 * @param {import('../state/db.mjs').StateDb} db
 * @param {{ client: {request: Function}|null, now?: () => number, log?: (line: string) => void,
 *   batch?: number, maxQueries?: number, retryMs?: object }} opts
 * @returns {Promise<{queries: number, looked_up: number, events: Record<string, number>,
 *   unbound: number, gone: number, conflicts: number, stopped: string|null, summary: string}>}
 */
export async function refreshIdentities(db, { client, now = Date.now, log = () => {}, batch = BATCH, maxQueries = MAX_QUERIES, retryMs = RETRY_MS } = {}) {
  const out = { queries: 0, cost: 0, looked_up: 0, events: {}, unbound: 0, gone: 0, conflicts: 0, merged: 0, suspect_not_found: 0, stopped: null, error: null };
  const size = Math.max(1, Math.min(BATCH, Math.trunc(Number(batch)) || BATCH));
  try {
    if (!client) {
      out.stopped = 'no_token';
    } else {
      let left = Math.max(0, Math.trunc(Number(maxQueries)) || 0);
      const seen = new Set(); // each subject is looked up at most once a pass
      // Unbound subjects first (the backfill), then the daily re-checks.
      for (const kind of ['name', 'id']) {
        while (left > 0 && out.stopped === null) {
          const { byName, byId } = db.identityCandidates({ now: now(), retryMs, limit: size });
          const list = (kind === 'name' ? byName : byId).filter((x) => !seen.has(x.id));
          if (list.length === 0) break;
          for (const x of list) seen.add(x.id);
          const { query, variables } = kind === 'name' ? buildNameQuery(list.map((s) => s.name)) : buildIdQuery(list.map((s) => s.node_id));
          left -= 1;
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
          const answers = parseAnswer(doc, list.length, kind);
          // A query that answered nothing usable stops the pass: the next run tries again.
          if (answers.every((a) => a.status === 'error')) {
            out.stopped = 'bad_answer';
            out.error = Array.isArray(doc?.errors) ? String(doc.errors[0]?.type ?? doc.errors[0]?.message ?? 'error').slice(0, 100) : 'no data';
            for (const s of list) db.applyIdentityLookup(s.id, { status: 'error', via: kind }, { now: now() });
            break;
          }
          // Many NOT_FOUND in one batch is far more likely our token or its
          // permissions than repositories deleted together: taken as an
          // error (looked at again in an hour), never as gone, and the pass
          // stops (R-SUBJ-13).
          const nf = answers.filter((a) => a.status === 'not_found').length;
          const mass = nf > MASS_NOT_FOUND.min && nf > MASS_NOT_FOUND.share * list.length;
          if (mass) {
            out.suspect_not_found += nf;
            out.stopped = 'mass_not_found';
            out.error = `${nf} of ${list.length} answered NOT_FOUND`;
            for (const a of answers) if (a.status === 'not_found') a.status = 'error';
          }
          db.tx(() => {
            list.forEach((s, i) => {
              out.looked_up += 1;
              for (const e of db.applyIdentityLookup(s.id, { ...answers[i], via: kind }, { now: now() })) {
                out.events[e.kind] = (out.events[e.kind] ?? 0) + 1;
                if (['renamed', 'transferred', 'merged', 'not_found', 'found_again', 'id_conflict'].includes(e.kind)) {
                  log(`pump: subject ${e.subject}: ${e.kind}${e.oldName || e.newName ? ` (${e.oldName ?? '?'} -> ${e.newName ?? '?'})` : ''}${e.repoId ? `, repository id ${e.repoId}` : ''}`);
                }
              }
            });
          });
          if (mass) break;
        }
        if (out.stopped !== null) break;
      }
    }
  } catch (err) {
    out.stopped = 'error';
    out.error = String(err?.message ?? err).slice(0, 200);
  }
  try {
    const c = db.raw.prepare(`
      SELECT SUM(repo_id IS NULL) AS unbound, SUM(gone_at IS NOT NULL) AS gone, SUM(id_status = 'conflict') AS conflicts, COUNT(*) AS active
      FROM subjects WHERE kind = 'github' AND retired_at IS NULL AND alias_of IS NULL
    `).get();
    out.merged = Number(db.raw.prepare('SELECT COUNT(*) AS n FROM subjects WHERE alias_of IS NOT NULL').get().n ?? 0);
    out.unbound = Number(c.unbound ?? 0);
    out.gone = Number(c.gone ?? 0);
    out.conflicts = Number(c.conflicts ?? 0);
    out.active = Number(c.active ?? 0);
  } catch { /* counted as unknown below */ }
  const ev = Object.entries(out.events).sort().map(([k, v]) => `${k} ${v}`).join(', ');
  out.summary = `${out.queries} lookup queries (${out.looked_up} repositories${out.cost ? `, ${out.cost} points` : ''})${ev ? `: ${ev}` : ''}; ${out.active ?? '?'} active, ${out.unbound} without an id yet, ${out.gone} not found, ${out.conflicts} in conflict, ${out.merged} merged${out.stopped ? `; stopped (${out.stopped}${out.error ? `: ${out.error}` : ''})` : ''}`;
  try {
    db.setKv(IDENTITY_KV_KEY, { at: new Date(now()).toISOString(), ...out }, { now: now() });
  } catch { /* the summary is still returned and logged */ }
  return out;
}
