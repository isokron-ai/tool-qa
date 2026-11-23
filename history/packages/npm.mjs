// H2(a): npm. Follows the replicate _changes feed from a stored sequence.
//
// The feed (https://replicate.npmjs.com/_changes) returns only {seq, id, changes[{rev}], deleted?}.
// It rejects include_docs and since=now (HTTP 400, checked Nov 2026). So:
//   1. ids whose name has an `mcp` token are candidates;
//   2. ids already known to match by keyword/description (state.known, refreshed from the
//      registry search API) are candidates too;
//   3. each live candidate's packument is fetched to apply the full matcher and list changed versions.
// A package that matches only by keyword/description and was never seen before is found by the
// search refresh, not by the feed. This is a documented limit (see README).
import { matchesMcp, matchReasons, nameMatches } from './lib/matcher.mjs';

const FEED = 'https://replicate.npmjs.com';
const REGISTRY = 'https://registry.npmjs.org';
const enc = (id) => id.replace('/', '%2F');

export async function refreshKnown(http, known, { pages = 4, size = 250 } = {}) {
  const set = new Set(known);
  for (const kw of ['mcp', 'modelcontextprotocol']) {
    for (let p = 0; p < pages; p++) {
      const r = await http.json(`${REGISTRY}/-/v1/search?text=${encodeURIComponent('keywords:' + kw)}&size=${size}&from=${p * size}`);
      const objs = r.objects ?? [];
      for (const o of objs) if (o.package?.name) set.add(o.package.name);
      if (objs.length < size) break;
    }
  }
  return [...set];
}

export function versionsChangedSince(doc, sinceMs) {
  const time = doc.time ?? {};
  return Object.keys(doc.versions ?? {}).filter((v) => Date.parse(time[v]) >= sinceMs);
}

export async function runNpm({ http, state = {}, now = Date.now(), limit = 10000, maxPages = 50, refresh = true }) {
  const errors = [];
  const rows = [];
  const next = { ...state };
  if (refresh) {
    try { next.known = await refreshKnown(http, state.known ?? []); } catch (e) { errors.push(`search refresh: ${e.message}`); next.known = state.known ?? []; }
  }
  const known = new Set(next.known ?? []);
  let since = state.since;
  if (since == null) {
    // First run: start at the current head instead of replaying 147M+ changes.
    since = (await http.json(`${FEED}/`)).update_seq;
    next.since = since;
    next.last_run_ms = now;
    return { rows, state: next, errors, note: 'initialised at current update_seq' };
  }
  const sinceMs = (state.last_run_ms ?? now - 86400000) - 3600000;
  let pages = 0;
  let stopped = false;
  while (pages < maxPages) {
    const feed = await http.json(`${FEED}/_changes?since=${since}&limit=${limit}`);
    const results = feed.results ?? [];
    for (const c of results) {
      if (!nameMatches(c.id) && !known.has(c.id)) continue;
      if (c.deleted) { rows.push({ seq: c.seq, id: c.id, deleted: true, versions_changed: [], modified: null, match: [] }); continue; }
      try {
        const res = await http.request(`${REGISTRY}/${enc(c.id)}`);
        if (res.status === 404 || res.status === 410) {
          // Unpublished after its feed entry: record it as deleted and move on, or the feed would stall here.
          rows.push({ seq: c.seq, id: c.id, deleted: true, versions_changed: [], modified: null, match: [] });
          continue;
        }
        if (!res.ok) throw new Error(`GET ${REGISTRY}/${enc(c.id)} -> HTTP ${res.status}`);
        const doc = await res.json();
        const reasons = matchReasons({ name: doc.name ?? c.id, keywords: doc.keywords, description: doc.description });
        if (!reasons.length) continue;
        if (!nameMatches(c.id)) known.add(c.id);
        rows.push({ seq: c.seq, id: c.id, deleted: false, versions_changed: versionsChangedSince(doc, sinceMs), modified: doc.time?.modified ?? null, match: reasons });
      } catch (e) {
        errors.push(`${c.id}: ${e.message}`);
        stopped = true; // do not advance past a change we failed to read
        break;
      }
    }
    if (stopped) break;
    since = feed.last_seq ?? since;
    pages++;
    if (results.length < limit) break;
  }
  if (!stopped) { next.since = since; next.last_run_ms = now; }
  next.known = [...known];
  return { rows, state: next, errors };
}
export { matchesMcp };
