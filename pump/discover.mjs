// The discover lane, pump side (design audit A2, DESIGN-v3 4.2): candidates
// from .github/workflows/discover.yml (discover/run.mjs: the H1 registry and
// H2 package feed rows mapped to GitHub repositories) become subjects.
//
// The pump is the state's only writer, so this runs in it, at the start of a
// run after the id pass. What a pass does:
//
//   1. Room: discover.json daily_cap less the subjects of source discover-v1
//      first seen in the last 24 hours. No room: nothing is read.
//   2. The newest successful discover.yml run on main, its artifact
//      discover-<run id>, downloaded once and checked (candidatesProblems):
//      a malformed file is refused whole.
//   3. Walk the candidates from kv pump.discover's cursor (class, then hash:
//      a new day's file resumes where the last one stopped, and wraps), at
//      most max_walk of them. One whose owner/name is a subject's name or key
//      already is known: its keys are recorded against that subject.
//   4. The unknown ones, up to the room, are looked up by name with GraphQL
//      (100 a query, at most max_queries, through the pump's graphql budget):
//        not found          skipped (deleted, private, or a bad URL in a
//                           feed: never anyone's fault, nothing recorded
//                           against anyone)
//        a fork             left out (fork exclusion, DESIGN-v3 4.2)
//        a repository id a subject holds already (a renamed or re-spelled
//                           name)  the keys go to that subject: the frame is
//                           deduped by repository id, A5's binding
//        otherwise          a new subject: key and name owner/name as GitHub
//                           spells it now, kind github, source discover-v1,
//                           tier discover.json tier (T3), bound to its id at
//                           once through applyIdentityLookup
//   5. Keys (state schema v11 discovery_keys): every (repository id,
//      subfolder, purl) a subject was seen under, with its feeds. A monorepo
//      stays one subject (bulk publishers collapse to the repository); its
//      servers' folders and packages are kept beside it.
//   6. kv frame: the frame version, bumped whenever subjects are added, with
//      the subject count per source. Event frame_grew.
//
// Never throws and never holds the pump; everything it did is in kv
// pump.discover. Switch: LANE_DISCOVER_ENABLED, only the exact value "true".

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { BudgetExceededError } from './budgets.mjs';
import { candidatesProblems, FRAME_SOURCE } from '../discover/extract.mjs';
import { readZip } from '../scripts/lib/unzip.mjs';

const DAY = 86_400_000;
export const DISCOVER_KV_KEY = 'pump.discover';
export const FRAME_KV_KEY = 'frame';
export const CONFIG_FILE = new URL('./discover.json', import.meta.url);
/** Largest artifact the pump downloads (the file was 2.4 MB gzipped on 27 Nov). */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Whether the discover lane may add subjects: LANE_DISCOVER_ENABLED is exactly "true". */
export function discoverEnabled(env = {}) {
  return env.LANE_DISCOVER_ENABLED === 'true';
}

export function loadDiscoverConfig(file = CONFIG_FILE) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['daily_cap', 'tier', 'max_queries', 'max_walk']) if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`pump/discover.json: ${k} must be a whole number`);
  if (c.tier > 4) throw new Error('pump/discover.json: tier must be 0..4');
  if (c.source !== FRAME_SOURCE) throw new Error(`pump/discover.json: source must be ${FRAME_SOURCE}`);
  return c;
}

const FIELDS = 'databaseId id nameWithOwner createdAt isFork';
const NAME_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

/** GraphQL by owner/name, names as variables. */
export function buildLookupQuery(names) {
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

/** Per-name {status: ok|not_found|error, node}; an error with no r<i> path makes every entry an error. */
export function parseLookup(doc, count) {
  const errors = Array.isArray(doc?.errors) ? doc.errors : [];
  const data = doc?.data && typeof doc.data === 'object' ? doc.data : null;
  const all = (status) => Array.from({ length: count }, () => ({ status, node: null }));
  if (!data) return all('error');
  const at = new Map();
  for (const e of errors) {
    const p = Array.isArray(e?.path) ? e.path[0] : null;
    const i = typeof p === 'string' && /^r\d+$/.test(p) ? Number(p.slice(1)) : null;
    if (i === null || i >= count) return all('error');
    at.set(i, e.type === 'NOT_FOUND' && at.get(i) !== 'error' ? 'not_found' : 'error');
  }
  return Array.from({ length: count }, (_, i) => {
    const n = data[`r${i}`];
    if (at.get(i) === 'error') return { status: 'error', node: null };
    if (n && typeof n === 'object' && Number.isSafeInteger(n.databaseId) && typeof n.id === 'string' && NAME_RE.test(String(n.nameWithOwner))) return { status: 'ok', node: n };
    return { status: at.get(i) === 'not_found' || n === null ? 'not_found' : 'error', node: null };
  });
}

/** Where a candidate sits in the walk order. */
const pos = (c) => `${c.class}:${c.hash}`;

/**
 * The candidates to visit this pass: from just after the cursor, wrapping
 * once, at most maxWalk. Pure.
 */
export function walkFrom(candidates, cursor, maxWalk) {
  const start = cursor ? candidates.findIndex((c) => pos(c) > cursor) : 0;
  const s = start < 0 ? 0 : start;
  const out = [];
  for (let k = 0; k < candidates.length && out.length < maxWalk; k++) out.push(candidates[(s + k) % candidates.length]);
  return out;
}

/** The newest discover artifact: {artifact_id, run_id, created_at, doc}, or null when there is none. */
export async function fetchCandidates({ client, fetch = globalThis.fetch, repo, workflow = 'discover.yml', maxBytes = MAX_ARTIFACT_BYTES }) {
  const runs = await client.request('GET', `/repos/${repo}/actions/workflows/${workflow}/runs`, { query: { status: 'success', branch: 'main', per_page: 5 } });
  const run = (runs.data?.workflow_runs ?? []).find((r) => r.conclusion === 'success' && r.head_branch === 'main' && String(r.path ?? '').endsWith(`/${workflow}`) && (r.event === 'schedule' || r.event === 'workflow_dispatch'));
  if (!run) return null;
  const arts = await client.request('GET', `/repos/${repo}/actions/runs/${run.id}/artifacts`);
  const art = (arts.data?.artifacts ?? []).find((a) => a.name === `discover-${run.id}` && !a.expired);
  if (!art) return null;
  if (Number(art.size_in_bytes) > maxBytes) throw new Error(`discover artifact ${art.id} is ${art.size_in_bytes} bytes, over ${maxBytes}`);
  const hop = await client.request('GET', `/repos/${repo}/actions/artifacts/${art.id}/zip`, { redirect: 'manual', family: 'artifacts' });
  const location = hop.headers?.get?.('location');
  if (!location || !/^https:\/\//.test(location)) throw new Error(`discover artifact ${art.id}: no download location`);
  const res = await fetch(location, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`discover artifact ${art.id}: download HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > maxBytes) throw new Error(`discover artifact ${art.id}: ${zip.length} bytes, over ${maxBytes}`);
  const entry = readZip(zip, { maxTotalBytes: maxBytes }).find((e) => e.name === 'candidates.json.gz');
  if (!entry) throw new Error(`discover artifact ${art.id} has no candidates.json.gz`);
  const doc = JSON.parse(gunzipSync(entry.data, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
  return { artifact_id: art.id, run_id: run.id, created_at: art.created_at ?? run.created_at ?? null, doc };
}

/**
 * One discover pass. Never throws.
 * @param {import('../state/db.mjs').StateDb} db
 * @param {{ client: {request: Function}|null, getCandidates: () => Promise<object|null>, config?: object,
 *   now?: () => number, log?: (line: string) => void }} opts
 *   client: GraphQL (the job's GITHUB_TOKEN); getCandidates: fetchCandidates() or a test double
 */
export async function applyDiscovery(db, { client, getCandidates, config = loadDiscoverConfig(), now = Date.now, log = () => {} } = {}) {
  const out = {
    room: 0, walked: 0, known: 0, looked_up: 0, queries: 0, cost: 0, added: 0, duplicate: 0, fork_excluded: 0, not_found: 0, errors: 0,
    keys_recorded: 0, artifact_id: null, generated_at: null, stopped: null, error: null,
  };
  let prev = {};
  try { prev = db.getKv(DISCOVER_KV_KEY) ?? {}; } catch { /* none */ }
  let cursor = prev.cursor ?? null;
  try {
    const t0 = now();
    const since = new Date(t0 - DAY).toISOString();
    const recent = Number(db.raw.prepare('SELECT COUNT(*) AS n FROM subjects WHERE source = ? AND first_seen > ?').get(config.source, since).n);
    out.room = Math.max(0, config.daily_cap - recent);
    if (out.room === 0) {
      out.stopped = 'daily_cap';
    } else if (!client) {
      out.stopped = 'no_token';
    } else {
      const got = await getCandidates();
      if (!got) {
        out.stopped = 'no_candidates';
      } else {
        out.artifact_id = got.artifact_id ?? null;
        out.generated_at = got.doc?.generated_at ?? null;
        const bad = candidatesProblems(got.doc);
        if (bad.length) throw new Error(`candidates refused: ${bad.slice(0, 3).join('; ')}`);
        const cands = got.doc.candidates;
        // What the state knows: names and keys (case aside) and repository ids.
        const byName = new Map();
        for (const s of db.listSubjects()) {
          const target = s.alias_of ?? s.id;
          for (const k of [s.id, s.name]) if (typeof k === 'string' && !byName.has(k.toLowerCase())) byName.set(k.toLowerCase(), target);
        }
        const unknown = [];
        const limit = Math.min(out.room, config.max_queries * 100);
        let lastPos = cursor;
        for (const c of walkFrom(cands, cursor, config.max_walk)) {
          if (unknown.length >= limit) break;
          out.walked += 1;
          lastPos = pos(c);
          const hit = byName.get(c.name.toLowerCase());
          if (hit) {
            out.known += 1;
            out.keys_recorded += recordKeys(db, hit, null, c, t0);
            continue;
          }
          unknown.push(c);
        }
        for (let i = 0; i < unknown.length && out.stopped === null; i += 100) {
          const chunk = unknown.slice(i, i + 100);
          const { query, variables } = buildLookupQuery(chunk.map((c) => c.name));
          out.queries += 1;
          let res;
          try {
            res = await client.request('POST', '/graphql', { family: 'graphql', body: { query, variables }, retryUnsafe: true });
          } catch (err) {
            out.stopped = err instanceof BudgetExceededError || err?.name === 'BudgetExceededError' ? 'budget' : 'api_error';
            out.error = String(err?.message ?? err).slice(0, 200);
            // Not looked up: walk them again next pass.
            lastPos = i === 0 ? cursor : pos(unknown[i - 1]);
            break;
          }
          const doc = res?.data && typeof res.data === 'object' ? res.data : null;
          const cost = Number(doc?.data?.rateLimit?.cost);
          if (Number.isFinite(cost)) out.cost += cost;
          const answers = parseLookup(doc, chunk.length);
          const t = now();
          db.tx(() => {
            chunk.forEach((c, j) => {
              out.looked_up += 1;
              const a = answers[j];
              if (a.status === 'not_found') { out.not_found += 1; return; }
              if (a.status !== 'ok') { out.errors += 1; return; }
              const n = a.node;
              if (n.isFork === true) { out.fork_excluded += 1; return; }
              const holder = db.getSubjectByRepoId(n.databaseId);
              if (holder) {
                out.duplicate += 1;
                out.keys_recorded += recordKeys(db, holder.alias_of ?? holder.id, n.databaseId, c, t);
                return;
              }
              let key = n.nameWithOwner;
              for (let k = 2; db.getSubject(key); k++) key = `${n.nameWithOwner}#${k}`;
              db.setSubjectVersion({ id: key, kind: 'github', source: config.source, tier: config.tier, name: n.nameWithOwner, now: t });
              const ev = db.applyIdentityLookup(key, { status: 'ok', node: n, via: 'name' }, { now: t });
              if (!ev.some((e) => e.kind === 'id_bound')) {
                // The binding was refused (a guard): leave it to the id pass, keep the subject.
                log(`pump: discover: ${key} added but not bound (${ev.map((e) => e.kind).join(', ') || 'no event'}); the id pass looks it up`);
              }
              out.added += 1;
              out.keys_recorded += recordKeys(db, key, n.databaseId, c, t);
            });
          });
        }
        cursor = lastPos;
        if (out.added > 0) noteFrame(db, { added: out.added, artifact: out.artifact_id, now: now() });
      }
    }
  } catch (err) {
    out.stopped = out.stopped ?? 'error';
    out.error = String(err?.message ?? err).slice(0, 200);
  }
  const counts = frameCounts(db);
  out.summary = `room ${out.room}; walked ${out.walked} (${out.known} known), looked up ${out.looked_up} in ${out.queries} queries${out.cost ? ` (${out.cost} points)` : ''}: added ${out.added}, duplicate ${out.duplicate}, forks left out ${out.fork_excluded}, not found ${out.not_found}, errors ${out.errors}; keys ${out.keys_recorded}; frame ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}${out.stopped ? `; stopped (${out.stopped}${out.error ? `: ${out.error}` : ''})` : ''}`;
  try {
    db.setKv(DISCOVER_KV_KEY, { at: new Date(now()).toISOString(), off: false, ...out, cursor }, { now: now() });
  } catch { /* the summary is still returned */ }
  return { ...out, cursor };
}

/** Active subjects per source. */
export function frameCounts(db) {
  try {
    return Object.fromEntries(db.raw.prepare('SELECT source, COUNT(*) AS n FROM subjects WHERE retired_at IS NULL AND alias_of IS NULL GROUP BY source ORDER BY source').all().map((r) => [r.source, Number(r.n)]));
  } catch {
    return {};
  }
}

/** Bump the frame version (kv frame) after subjects were added, with an event. */
export function noteFrame(db, { added, artifact = null, now }) {
  db.tx(() => {
    const prev = db.getKv(FRAME_KV_KEY) ?? {};
    const version = (Number.isSafeInteger(prev.version) ? prev.version : 0) + 1;
    const value = { version, at: new Date(now).toISOString(), added, sources: frameCounts(db), discover_artifact: artifact };
    db.setKv(FRAME_KV_KEY, value, { now });
    db.recordEvent({ type: 'frame_grew', n: added, data: { version } }, now);
  });
}

/** Record a candidate's keys against a subject; returns how many rows were new. */
function recordKeys(db, subject, repoId, c, now) {
  let n = 0;
  for (const k of c.keys) n += db.noteDiscoveryKey({ subject, repoId, subfolder: k.subfolder, purl: k.purl, feed: k.feed, now }) ? 1 : 0;
  return n;
}
