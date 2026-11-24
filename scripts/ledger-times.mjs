// Cycle times for the cross-repo ledger: when each row was found, when its test
// was pinned, when its fix merged and when a release shipped it, and the
// median and p90 of the gaps, per repository.
//
// Everything here is read-only and cheap by design:
//   - release time comes from the release list the ledger already fetches;
//   - a fix pull request's creation time is one call per pull request, cached;
//   - when a row first appeared in REGRESSIONS.md, and when its named test
//     first existed, come from one commit-list call per file (cached per run)
//     plus raw file reads at a few commits (a binary search over the file's
//     history; raw reads do not count against the API budget). The answer for
//     a row or a test never changes, so it is cached in ledger/cache.json and
//     asked once.
// A rate limit or an empty budget leaves the rest unfilled for the next run.
import { BudgetExhausted } from './ledger.mjs';

const DAY = 86_400_000;
const MAX_PAGES = 5;

const ts = (s) => (s ? Date.parse(s) : NaN);
const isoMin = (xs) => xs.filter((x) => Number.isFinite(ts(x))).sort((a, b) => ts(a) - ts(b))[0] ?? null;

/** Days from a to b (ISO strings), or null if either is missing or b is before a. */
export function daysBetween(a, b) {
  const d = (ts(b) - ts(a)) / DAY;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** Median (the mean of the middle two for an even count) and p90 (nearest rank) of a list of numbers. */
export function summarise(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p90: null };
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const p90 = v[Math.max(0, Math.ceil(0.9 * v.length) - 1)];
  return { n: v.length, median, p90 };
}

/**
 * Per repository (and "all"): found→merged and merged→released, in days.
 * A gap that would be negative (a row dated after its merge) is left out and counted.
 */
export function cycleStats(records) {
  const out = {};
  const groups = new Map([['all', records]]);
  for (const r of records) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
  for (const [key, recs] of groups) {
    const fm = []; const mr = [];
    let excluded = 0; let unreleased = 0; let undated = 0;
    for (const r of recs) {
      if (!r.merged_at) { undated++; continue; }
      if (r.found_at) { const d = daysBetween(r.found_at, r.merged_at); if (d === null) excluded++; else fm.push(d); } else undated++;
      if (r.released_at) { const d = daysBetween(r.merged_at, r.released_at); if (d === null) excluded++; else mr.push(d); } else unreleased++;
    }
    out[key] = { rows: recs.length, found_to_merged: summarise(fm), merged_to_released: summarise(mr), merged_not_released: unreleased, without_dates: undated, excluded };
  }
  return out;
}

/** Fill `released_at` etc. are set by the ledger; this derives found_at from what collectTimes cached. */
export function foundAt(candidates) {
  const best = [...candidates].filter((c) => Number.isFinite(ts(c.at))).sort((a, b) => ts(a.at) - ts(b.at))[0];
  return best ? { found_at: best.at, found_at_source: best.source } : { found_at: null, found_at_source: null };
}

/** Commits that touched `path` on `ref`, newest first: [{sha, date}]. Up to MAX_PAGES pages of 100. */
async function commitList(repo, ref, path, gh, memo) {
  const key = `${repo}@${ref}:${path}`;
  if (memo.has(key)) return memo.get(key);
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = `sha=${encodeURIComponent(ref)}&path=${path.split('/').map(encodeURIComponent).join('/')}&per_page=100&page=${page}`;
    const { body } = await gh.get(`/repos/${repo}/commits?${q}`);
    if (!Array.isArray(body)) break;
    for (const c of body) out.push({ sha: c.sha, date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null });
    if (body.length < 100) break;
  }
  memo.set(key, out);
  return out;
}

/**
 * The date of the first commit on `ref` after which `path` satisfies `has(text)`, found by binary search over the
 * file's history (assumes it stays true once true). null if it is not true now, or the history is unavailable.
 */
export async function firstCommitWhere({ repo, ref, path, gh, readFile, has, memo }) {
  const list = await commitList(repo, ref, path, gh, memo);
  if (!list.length) return null;
  const at = async (i) => { const t = await readFile(repo, list[i].sha, path); return t !== null && has(t); };
  if (!(await at(0))) return null;
  let lo = 0; let hi = list.length - 1; // largest index with the property true is wanted
  if (await at(hi)) return list[hi].date;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (await at(m)) lo = m; else hi = m;
  }
  return list[lo].date;
}

/**
 * Fills found_at, found_at_source and pinned_at (and each test's pinned_at) on the records, from the cache first and
 * then from the API as far as the budget goes. Mutates `records` and `cache`. Never throws on a budget stop.
 */
export async function collectTimes({ records, sources, readFile, gh, cache, testHas, log = () => {} }) {
  cache.prs ??= {};
  cache.times ??= {};
  const refOf = new Map(sources.repos.map((s) => [s.repo, { ref: s.ref ?? 'main', path: s.path ?? 'REGRESSIONS.md' }]));
  const memo = new Map();
  let stopped = null;
  const live = () => (gh && !stopped ? gh : null);
  const guard = async (fn) => {
    try { return await fn(); } catch (err) {
      if (err instanceof BudgetExhausted) { stopped = err.message; return null; }
      log(`ledger times: ${String(err?.message ?? err).slice(0, 160)}`);
      return null;
    }
  };

  for (const r of records) {
    const { ref, path } = refOf.get(r.repo);
    // Pull request creation times.
    const created = [];
    for (const n of r.fix_prs) {
      const key = `${r.repo}#${n}`;
      if (!cache.prs[key] && live()) {
        const body = await guard(async () => (await gh.get(`/repos/${r.repo}/pulls/${n}`)).body);
        if (body?.created_at) cache.prs[key] = { created_at: body.created_at };
      }
      if (cache.prs[key]) created.push({ at: cache.prs[key].created_at, source: 'pr' });
    }
    // When the row first appeared in the repository's REGRESSIONS.md.
    const rowKey = `${r.repo}:row:${r.id}`;
    if (!cache.times[rowKey] && live()) {
      const idRe = new RegExp(`^\\|\\s*${r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`, 'm');
      const at = await guard(() => firstCommitWhere({ repo: r.repo, ref, path, gh, readFile, has: (t) => idRe.test(t), memo }));
      if (at) cache.times[rowKey] = at;
    }
    if (cache.times[rowKey]) created.push({ at: cache.times[rowKey], source: 'row' });
    Object.assign(r, foundAt(created));

    // When each named test first existed.
    const pins = [];
    for (const t of r.test) {
      t.pinned_at = null;
      if (t.found !== true || !t.file) continue;
      const key = `${r.repo}:test:${t.file}:${t.name}`;
      if (!cache.times[key] && live()) {
        const at = await guard(() => firstCommitWhere({ repo: r.repo, ref, path: t.file, gh, readFile, has: (txt) => testHas(txt, t.name), memo }));
        if (at) cache.times[key] = at;
      }
      if (cache.times[key]) { t.pinned_at = cache.times[key]; pins.push(t.pinned_at); }
    }
    r.pinned_at = isoMin(pins);
  }
  return { stopped };
}
