#!/usr/bin/env node
// The cross-repo regression ledger: every bug found and fixed in IsoKron's
// tools, in one place.
//
//   node scripts/ledger.mjs [--sources ledger/sources.json] [--out .] [--offline]
//
// Each tool repository keeps its own REGRESSIONS.md: one row per problem, with
// the tests that pin it and the commit(s) that fixed it. This script reads
// every listed repository's REGRESSIONS.md from its default branch (public raw
// URL, no token), checks the column shape of each, parses the rows, finds each
// fix's pull request, merge time and first release through the GitHub API, and
// writes:
//
//   ledger/ledger.json   one record per row (fields below)
//   docs/LEDGER.md       the same, as tables grouped by tool, with counts
//   ledger/cache.json    API answers that cannot change (a merged commit's
//                        pull request, a release that contains a commit), so a
//                        rerun only asks about what is new
//
// Record fields: repo, id, title, description, severity (null if the row does
// not say), found_by, test (list of {file, name, found}), fix_commit (the
// first listed), fix_commits, fix_pr (the pull request that merged the last of
// them), fix_prs, merged_at, released_in (the first GitHub release that
// contains every fix commit, or null), url.
//
// --offline       no API calls: only what the cache already knows is filled in.
//
// Environment: GITHUB_TOKEN or GH_TOKEN (optional; raises the API limit),
// LEDGER_API_BUDGET (default 300 calls a run). A rate limit, or the budget
// running out, leaves the rest unresolved for the next run; it does not fail.
// Exit codes: 0 written, 1 a ledger could not be fetched or read, 2 usage.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;

// ---------------------------------------------------------------- parsing

/** The column shape every ledger is read into, and the headers accepted for each role. */
export const CANONICAL_HEADER = ['ID', 'What it was', 'Pinned by', 'Fix'];
const ROLES = [
  ['id', /^id$/i],
  ['what', /^what( it was| went wrong)?$/i],
  ['tests', /^(pinned by|tests?)$/i],
  ['fix', /^fix(es)?( commits?)?$/i],
];

/** Test reference forms seen in the ledgers. The first is the canonical one. */
const TEST_FORMS = [
  ['`file` › `name`', /^`([^`]+)`\s*›\s*`([^`]+)`$/],
  ['`file` `name`', /^`([^`]+)`\s+`([^`]+)`$/],
  ['`file`: "name"', /^`([^`]+)`:\s*"(.+)"$/],
];

const SEVERITY = /^(CRITICAL|HIGH|LOW-MEDIUM|MEDIUM|LOW)\b(?:\s*\(([^)]*)\))?\.\s*/;
const FOUND_BY_MARK = /\s*Found by:?\s+([A-Za-z][A-Za-z -]*?)\.(?=\s|$)/i;
const SHA = /\b[0-9a-f]{7,40}\b/g;

/** Split a Markdown table row into cells: pipes inside backticks or escaped (\|) do not split. */
export function splitRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // A row starts and ends with a pipe: drop the empty cells outside them.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** The family of an ID: R-ING-07 -> R-ING. */
export const prefixOf = (id) => id.replace(/-\d+$/, '');

/** Classify a ledger's own description of an ID family ("- `R-CI-*`: ..."). */
export function classifyFamily(text) {
  if (/mutation|can fail/i.test(text)) return 'mutation';
  if (/\bCI\b|runners/.test(text)) return 'CI';
  if (/self[ -]?test|hostile/i.test(text)) return 'self-test';
  if (/review/i.test(text)) return 'review';
  return null;
}

/** Normalise a "Found by" word to the ledger's vocabulary. */
export function normaliseFoundBy(raw) {
  const t = String(raw).trim().toLowerCase();
  if (/^(ci|github ci|the ci|ci runners?)$/.test(t)) return 'CI';
  if (/review/.test(t)) return 'review';
  if (/self[ -]?test/.test(t)) return 'self-test';
  if (/mutation/.test(t)) return 'mutation';
  if (/first run|live|production/.test(t)) return 'live run';
  return t;
}

/** Parse one test reference. Returns {file, name, form} or {file: null, name: text, form: null}. */
export function parseTestRef(text) {
  const t = text.trim();
  for (const [form, re] of TEST_FORMS) {
    const m = re.exec(t);
    if (m) return { file: m[1], name: m[2], form };
  }
  return { file: null, name: t, form: null };
}

/** First sentence of a description, for a one-line title (at most 200 characters). */
export function firstSentence(text) {
  let code = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') code = !code;
    if (!code && text[i] === '.' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      const s = text.slice(0, i + 1);
      if (/\b(e\.g|i\.e|etc|vs|cf)\.$/i.test(s) && i < text.length - 1) continue;
      return s.length > 200 ? `${s.slice(0, 199)}…` : s;
    }
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Read one REGRESSIONS.md. Throws if no ledger table is found or a role is missing from its header.
 * @returns {{ header: string[], shape: object, families: Record<string,string>, rows: object[] }}
 */
export function parseLedger(text, { repo = '<repo>' } = {}) {
  const lines = text.split(/\r?\n/);
  const families = {};
  for (const line of lines) {
    const m = /^\s*[-*]\s+`(R-[A-Z]+)-\*`\s*:\s*(.+)$/.exec(line);
    if (m) families[m[1]] = m[2].trim();
  }
  const sep = lines.findIndex((l, i) => i > 0 && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l) && /^\s*\|/.test(lines[i - 1]));
  if (sep < 0) throw new Error(`${repo}: REGRESSIONS.md has no table`);
  const header = splitRow(lines[sep - 1]);
  const col = {};
  for (const [role, re] of ROLES) {
    const i = header.findIndex((h) => re.test(h));
    if (i < 0) throw new Error(`${repo}: REGRESSIONS.md's table has no "${role}" column (header: ${header.join(' | ')})`);
    col[role] = i;
  }
  const normalised = [];
  const canonicalOrder = ['id', 'what', 'tests', 'fix'].every((r, i) => col[r] === i) && header.length === 4;
  header.forEach((h, i) => {
    const role = Object.keys(col).find((r) => col[r] === i);
    const canon = role ? CANONICAL_HEADER[['id', 'what', 'tests', 'fix'].indexOf(role)] : null;
    if (!role) normalised.push(`column "${h}" ignored`);
    else if (h !== canon) normalised.push(`column "${h}" read as "${canon}"`);
  });
  if (!canonicalOrder && header.length === 4) normalised.push('columns reordered');

  const rows = [];
  const forms = new Set();
  for (let i = sep + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) break;
    const cells = splitRow(line);
    const id = (cells[col.id] ?? '').replace(/^\*+|\*+$/g, '').trim();
    if (!/^R-[A-Z]+-\d+$/.test(id)) continue;
    let what = cells[col.what] ?? '';
    let severity = null;
    let severityNote = null;
    const sm = SEVERITY.exec(what);
    if (sm) {
      severity = sm[1].toLowerCase();
      severityNote = sm[2] ?? null;
      what = what.slice(sm[0].length);
    }
    let foundBy = null;
    const fm = FOUND_BY_MARK.exec(what);
    if (fm) {
      foundBy = normaliseFoundBy(fm[1]);
      what = (what.slice(0, fm.index) + what.slice(fm.index + fm[0].length)).trim();
    }
    const tests = (cells[col.tests] ?? '')
      .split(/<br\s*\/?>/i)
      .map((t) => t.trim())
      .filter(Boolean)
      .map(parseTestRef);
    for (const t of tests) forms.add(t.form ?? 'unrecognised');
    const fixText = cells[col.fix] ?? '';
    const fixCommits = [...new Set(fixText.match(SHA) ?? [])];
    rows.push({
      id,
      severity,
      severity_note: severityNote,
      found_by_marked: foundBy,
      title: firstSentence(what),
      description: what,
      tests,
      fix_text: fixText,
      fix_commits: fixCommits,
    });
  }
  const testForms = [...forms];
  for (const f of testForms) {
    if (f !== TEST_FORMS[0][0]) normalised.push(f === 'unrecognised' ? 'some test references are in no known form (kept as text)' : `test references written ${f} read as ${TEST_FORMS[0][0]}`);
  }
  if (rows.some((r) => r.fix_commits.length === 0)) normalised.push('some Fix cells name no commit (left unresolved)');
  return { header, shape: { header, test_forms: testForms, canonical: normalised.length === 0, normalised }, families, rows };
}

/** found_by for a row: its own "Found by" mark, the sources file's family map, the ledger's own family note, else unknown. */
export function foundByOf(row, source, families) {
  if (row.found_by_marked) return row.found_by_marked;
  const fam = prefixOf(row.id);
  const configured = source.found_by?.[fam];
  if (configured) return configured;
  const note = families[fam];
  return (note && classifyFamily(note)) || 'unknown';
}

// ---------------------------------------------------------------- GitHub

export class BudgetExhausted extends Error {}

/** A small GitHub API client with a call budget; stops (BudgetExhausted) on a rate limit or an empty budget. */
export function makeGitHub({ fetch = globalThis.fetch, token = '', budget = 300, apiUrl = 'https://api.github.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const state = { calls: 0, budget, stopped: null };
  async function get(path) {
    if (state.stopped) throw new BudgetExhausted(state.stopped);
    for (let attempt = 0; ; attempt++) {
      if (state.calls >= state.budget) { state.stopped = `API budget of ${state.budget} calls used`; throw new BudgetExhausted(state.stopped); }
      state.calls++;
      const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'isokron-tool-qa-ledger' };
      if (token) headers.authorization = `Bearer ${token}`;
      let res;
      try {
        res = await fetch(`${apiUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
        throw err;
      }
      if (res.status === 404 || res.status === 422) return { status: res.status, body: null };
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(await res.clone().text())));
      if (limited) { state.stopped = `GitHub rate limit (HTTP ${res.status})`; throw new BudgetExhausted(state.stopped); }
      if (res.status >= 500 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
      return { status: res.status, body: await res.json() };
    }
  }
  return { get, state };
}

/**
 * The pull request that merged a commit, from GET /repos/{repo}/commits/{sha}/pulls.
 * Cached only once merged (a merged pull request does not change).
 * @returns {{ sha, pr, merged_at, merge_commit_sha, state }|{ error }}
 */
export async function resolveCommit(repo, sha, gh, cache, branch = 'main') {
  const key = `${repo}@${sha}`;
  if (cache.commits[key]) return cache.commits[key];
  if (!gh) return { error: `${sha}: not looked up (offline, or the API stopped) and not in the cache` };
  const { status, body } = await gh.get(`/repos/${repo}/commits/${sha}/pulls?per_page=100`);
  if (status === 404 || status === 422 || !Array.isArray(body)) return { error: `commit ${sha} not found in ${repo}` };
  const merged = body.filter((p) => p.merged_at).sort((a, b) => a.merged_at.localeCompare(b.merged_at));
  const pick = merged.find((p) => p.base?.ref === p.base?.repo?.default_branch) ?? merged[0];
  if (pick) {
    const out = { sha, pr: pick.number, merged_at: pick.merged_at, merge_commit_sha: pick.merge_commit_sha, state: 'merged' };
    cache.commits[key] = out;
    return out;
  }
  if (body.length) return { sha, pr: body[0].number, merged_at: null, merge_commit_sha: null, state: body[0].state };
  // No pull request: a commit pushed straight to the default branch. Its date stands in for the merge time.
  const c = await gh.get(`/repos/${repo}/commits/${sha}`);
  if (!c.body) return { error: `commit ${sha} not found in ${repo}` };
  const full = c.body.sha;
  const cmp = await gh.get(`/repos/${repo}/compare/${encodeURIComponent(branch)}...${full}`);
  const onMain = cmp.body && (cmp.body.status === 'behind' || cmp.body.status === 'identical');
  if (!onMain) return { sha, pr: null, merged_at: null, merge_commit_sha: null, state: 'not merged, no pull request' };
  const out = { sha, pr: null, merged_at: c.body.commit?.committer?.date ?? null, merge_commit_sha: full, state: 'pushed' };
  cache.commits[key] = out;
  return out;
}

/** Published, non-draft releases, oldest first (by publish time, then tag). */
export async function listReleases(repo, gh) {
  const { body } = await gh.get(`/repos/${repo}/releases?per_page=100`);
  return (Array.isArray(body) ? body : [])
    .filter((r) => !r.draft && r.published_at)
    .map((r) => ({ tag: r.tag_name, published_at: r.published_at, prerelease: !!r.prerelease }))
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.tag.localeCompare(b.tag, 'en', { numeric: true }));
}

/** Does release `tag` contain commit `sha`? Cached for good: a published tag is not moved. */
export async function releaseContains(repo, tag, sha, gh, cache) {
  const key = `${repo}@${tag}@${sha}`;
  if (key in cache.contains) return cache.contains[key];
  if (!gh) return null;
  const { body } = await gh.get(`/repos/${repo}/compare/${encodeURIComponent(tag)}...${sha}`);
  if (!body) return null;
  const yes = body.status === 'behind' || body.status === 'identical';
  cache.contains[key] = yes;
  return yes;
}

// ---------------------------------------------------------------- fetching sources

export const rawUrl = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

/** Fetch a public file; null on 404. */
export async function fetchRaw(url, { fetch = globalThis.fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': 'isokron-tool-qa-ledger' }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt < 2) continue;
      throw err;
    }
    if (res.status === 404) return null;
    if (res.status >= 500 && attempt < 2) continue;
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res.text();
  }
}

/** Is a test named `name` in this source text? (Quotes inside the name may be escaped in the source.) */
export function sourceHasTest(src, name) {
  if (src.includes(name)) return true;
  return [`\\'`, `\\"`].some((q) => src.includes(name.replaceAll(q[1], q)));
}

// ---------------------------------------------------------------- building

/**
 * Build the ledger.
 * @param {object} opts
 * @param {{ repos: object[] }} opts.sources
 * @param {(source) => Promise<string|null>} opts.readLedger  the REGRESSIONS.md text, or null if the repo has none
 * @param {(repo, ref, file) => Promise<string|null>} opts.readFile  a test file's text, or null
 * @param {object|null} opts.gh  makeGitHub() client, or null when offline
 * @param {{commits, contains}} opts.cache
 */
export async function buildLedger({ sources, readLedger, readFile, gh, cache, log = () => {} }) {
  const out = { schema: SCHEMA, sources: [], counts: { total: 0 }, unresolved: [], records: [] };
  const stop = (err) => { if (err instanceof BudgetExhausted) { out.api_stopped = err.message; return true; } return false; };
  for (const source of sources.repos) {
    const { repo } = source;
    const ref = source.ref ?? 'main';
    const path = source.path ?? 'REGRESSIONS.md';
    const text = await readLedger(source);
    if (text === null) {
      out.sources.push({ repo, ref, path, status: 'absent' });
      out.counts[repo] = 0;
      log(`${repo}: no ${path} on ${ref}`);
      continue;
    }
    const parsed = parseLedger(text, { repo });
    out.sources.push({
      repo, ref, path, status: 'ok',
      sha256: createHash('sha256').update(text).digest('hex'),
      header: parsed.shape.header,
      test_forms: parsed.shape.test_forms,
      normalised: parsed.shape.normalised,
    });
    out.counts[repo] = parsed.rows.length;
    out.counts.total += parsed.rows.length;

    let releases = null;
    const fileCache = new Map();
    for (const row of parsed.rows) {
      const rec = {
        repo,
        id: row.id,
        title: row.title,
        description: row.description,
        severity: row.severity,
        severity_note: row.severity_note,
        found_by: foundByOf(row, source, parsed.families),
        test: [],
        fix_commit: row.fix_commits[0] ?? null,
        fix_commits: row.fix_commits,
        fix_pr: null,
        fix_prs: [],
        merged_at: null,
        released_in: null,
        url: `https://github.com/${repo}/blob/${ref}/${path}`,
      };
      // Tests: does each named test exist on the same branch?
      for (const t of row.tests) {
        let found = null;
        if (t.file) {
          if (!fileCache.has(t.file)) fileCache.set(t.file, await readFile(repo, ref, t.file));
          const src = fileCache.get(t.file);
          found = src === null ? false : sourceHasTest(src, t.name);
        }
        rec.test.push({ file: t.file, name: t.name, found });
        if (found !== true) out.unresolved.push({ repo, id: row.id, what: 'test', detail: t.file ? `${t.file} › ${t.name}: ${found === false ? 'not found on ' + ref : 'not checked'}` : `not a file › name reference: ${t.name}` });
      }
      if (row.tests.length === 0) out.unresolved.push({ repo, id: row.id, what: 'test', detail: 'the row names no test' });

      // Fix commits: pull request, merge time, release.
      if (row.fix_commits.length === 0) {
        out.unresolved.push({ repo, id: row.id, what: 'fix_commit', detail: `no commit in the Fix cell ("${row.fix_text}")` });
      } else {
        const resolved = [];
        for (const sha of row.fix_commits) {
          try {
            resolved.push(await resolveCommit(repo, sha, out.api_stopped ? null : gh, cache, ref));
          } catch (err) {
            if (!stop(err)) throw err;
            resolved.push(await resolveCommit(repo, sha, null, cache, ref));
          }
        }
        for (const r of resolved) {
          if (r.error) out.unresolved.push({ repo, id: row.id, what: 'fix_commit', detail: r.error });
          else if (!r.merged_at) out.unresolved.push({ repo, id: row.id, what: 'fix_pr', detail: `${r.sha}: ${r.state}${r.pr ? ` (pull request #${r.pr})` : ''}` });
        }
        const ok = resolved.filter((r) => !r.error);
        rec.fix_prs = [...new Set(ok.map((r) => r.pr).filter((n) => n != null))];
        const merged = ok.filter((r) => r.merged_at);
        if (merged.length === row.fix_commits.length) {
          const last = merged.reduce((a, b) => (b.merged_at > a.merged_at ? b : a));
          rec.fix_pr = last.pr;
          rec.merged_at = last.merged_at;
          // released_in: the first release, published after the last merge, that contains every fix.
          try {
            if (!releases && gh && !out.api_stopped) releases = await listReleases(repo, gh);
            for (const rel of releases ?? []) {
              if (rel.published_at < rec.merged_at) continue;
              let all = true;
              for (const m of merged) {
                const has = await releaseContains(repo, rel.tag, m.merge_commit_sha ?? m.sha, out.api_stopped ? null : gh, cache);
                if (!has) { all = false; break; }
              }
              if (all) { rec.released_in = rel.tag; break; }
            }
          } catch (err) {
            if (!stop(err)) throw err;
          }
        }
      }
      out.records.push(rec);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Markdown

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = (sha) => (sha ? sha.slice(0, 7) : '');

export function renderMarkdown(ledger) {
  const out = [];
  const repos = ledger.sources.map((s) => s.repo);
  out.push('# Regression ledger');
  out.push('');
  out.push('Every bug found and fixed in IsoKron\'s tools, from each repository\'s own `REGRESSIONS.md`.');
  out.push('Generated by [`scripts/ledger.mjs`](../scripts/ledger.mjs); do not edit by hand. The same records,');
  out.push('one per row, are in [`ledger/ledger.json`](../ledger/ledger.json).');
  out.push('');
  out.push(`**${ledger.counts.total} rows** across ${repos.length} repositories.`);
  out.push('');
  out.push('| Tool | Rows | Critical | High | Medium | Low | No severity | Unresolved |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of ledger.sources) {
    const recs = ledger.records.filter((r) => r.repo === s.repo);
    const n = (f) => recs.filter(f).length;
    const unresolvedIds = new Set(ledger.unresolved.filter((u) => u.repo === s.repo).map((u) => u.id));
    out.push(`| [${s.repo.split('/')[1]}](https://github.com/${s.repo}) | ${recs.length}${s.status === 'absent' ? ' (no ledger yet)' : ''} | ${n((r) => r.severity === 'critical')} | ${n((r) => r.severity === 'high')} | ${n((r) => r.severity === 'medium' || r.severity === 'low-medium')} | ${n((r) => r.severity === 'low')} | ${n((r) => !r.severity)} | ${unresolvedIds.size} |`);
  }
  out.push('');
  const byFound = {};
  for (const r of ledger.records) byFound[r.found_by] = (byFound[r.found_by] ?? 0) + 1;
  out.push(`Found by: ${Object.entries(byFound).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  out.push('');

  out.push('## Column shapes');
  out.push('');
  out.push(`Every ledger is read into one shape: \`${CANONICAL_HEADER.join(' | ')}\`, with tests written \`file\` › \`name\`.`);
  out.push('');
  for (const s of ledger.sources) {
    if (s.status === 'absent') { out.push(`- ${s.repo}: no \`${s.path}\` on \`${s.ref}\`.`); continue; }
    out.push(`- ${s.repo}: ${s.normalised.length ? `normalised: ${s.normalised.join('; ')}.` : 'already in that shape.'}`);
  }
  out.push('');

  for (const s of ledger.sources) {
    const recs = ledger.records.filter((r) => r.repo === s.repo);
    if (!recs.length) continue;
    out.push(`## ${s.repo.split('/')[1]} (${recs.length})`);
    out.push('');
    out.push('| ID | Severity | What it was | Found by | Pinned by | Fix | PR | Merged | Released in |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of recs) {
      const tests = r.test.map((t) => (t.file ? `\`${esc(t.file)}\` › ${esc(t.name)}` : esc(t.name)) + (t.found === false ? ' (not found)' : '')).join('<br>');
      const fixes = r.fix_commits.map((c) => `[${short(c)}](https://github.com/${r.repo}/commit/${c})`).join(', ') || 'unresolved';
      const prs = r.fix_prs.map((n) => `[#${n}](https://github.com/${r.repo}/pull/${n})`).join(', ');
      const sev = r.severity ? r.severity + (r.severity_note ? ` (${esc(r.severity_note)})` : '') : '';
      out.push(`| ${r.id} | ${sev} | ${esc(r.title)} | ${r.found_by} | ${tests} | ${fixes} | ${prs} | ${r.merged_at ? r.merged_at.slice(0, 10) : ''} | ${r.released_in ?? ''} |`);
    }
    out.push('');
  }

  out.push('## Unresolved');
  out.push('');
  if (!ledger.unresolved.length) out.push('Nothing: every row\'s tests were found and every fix commit has a merged pull request.');
  else for (const u of ledger.unresolved) out.push(`- ${u.repo} ${u.id} (${u.what}): ${esc(u.detail)}`);
  if (ledger.api_stopped) { out.push(''); out.push(`API lookups stopped early (${ledger.api_stopped}); the next run picks up the rest.`); }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

function sortedCache(cache) {
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { commits: sort(cache.commits), contains: sort(cache.contains) };
}

export async function main(argv = process.argv.slice(2), env = process.env, { fetch = globalThis.fetch, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const args = { sources: 'ledger/sources.json', out: '.', offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') args.offline = true;
    else if (a === '--sources' || a === '--out') {
      if (!argv[i + 1]) { log(`ledger: ${a} needs a value`); return 2; }
      args[a.slice(2)] = argv[++i];
    } else { log(`ledger: unknown argument ${a}`); return 2; }
  }
  const sources = JSON.parse(readFileSync(args.sources, 'utf8'));
  const cachePath = join(args.out, 'ledger', 'cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { commits: {}, contains: {} };
  cache.commits ??= {};
  cache.contains ??= {};
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  const gh = args.offline ? null : makeGitHub({ fetch, token, budget: Number(env.LEDGER_API_BUDGET) || 300 });

  const readLedger = (s) => fetchRaw(rawUrl(s.repo, s.ref ?? 'main', s.path ?? 'REGRESSIONS.md'), { fetch });
  const readFile = (repo, ref, file) => fetchRaw(rawUrl(repo, ref, file), { fetch });

  let ledger;
  try {
    ledger = await buildLedger({ sources, readLedger, readFile, gh, cache, log });
  } catch (err) {
    log(`ledger: ${err.message}`);
    return 1;
  }
  mkdirSync(join(args.out, 'ledger'), { recursive: true });
  mkdirSync(join(args.out, 'docs'), { recursive: true });
  writeFileSync(join(args.out, 'ledger', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(join(args.out, 'docs', 'LEDGER.md'), renderMarkdown(ledger));
  writeFileSync(cachePath, `${JSON.stringify(sortedCache(cache), null, 2)}\n`);
  const per = ledger.sources.map((s) => `${s.repo.split('/')[1]} ${ledger.counts[s.repo]}`).join(', ');
  log(`ledger: ${ledger.counts.total} rows (${per}); ${ledger.unresolved.length} unresolved; ${gh ? gh.state.calls : 0} API calls${ledger.api_stopped ? `; stopped early: ${ledger.api_stopped}` : ''}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}
