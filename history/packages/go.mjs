// H2(d): Go module index, https://index.golang.org/index?since=<RFC3339>&limit=2000 (NDJSON of {Path, Version, Timestamp}).
import { nameMatches } from './lib/matcher.mjs';

export function parseIndex(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export async function runGo({ http, state = {}, now = Date.now(), limit = 2000, maxPages = 200 }) {
  const next = { ...state };
  const errors = [];
  if (!state.since) {
    next.since = new Date(now - 86400000).toISOString();
    state = next;
  }
  let since = state.since;
  const rows = [];
  const seen = new Set();
  for (let p = 0; p < maxPages; p++) {
    const entries = parseIndex(await http.text(`https://index.golang.org/index?since=${encodeURIComponent(since)}&limit=${limit}`));
    for (const e of entries) {
      const key = `${e.Path}@${e.Version}`; // `since` is inclusive, so page edges repeat
      if (nameMatches(e.Path) && !seen.has(key)) { seen.add(key); rows.push({ path: e.Path, version: e.Version, timestamp: e.Timestamp }); }
    }
    if (entries.length) since = entries[entries.length - 1].Timestamp;
    if (entries.length < limit) break;
  }
  next.since = since;
  return { rows, state: next, errors };
}
