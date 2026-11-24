// scripts/ledger-times.mjs: the cycle-time figures of the ledger (found, pinned, merged, released), computed on
// fixtures with a fake GitHub and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLedger, makeGitHub, renderMarkdown } from '../scripts/ledger.mjs';
import { cycleStats, hoursBetween, firstCommitWhere, foundAt, summarise } from '../scripts/ledger-times.mjs';

const LEDGER = (rows) => `# Regressions\n\n| ID | What it was | Pinned by | Fix |\n|---|---|---|---|\n${rows.join('\n')}\n`;
const ROW = (id, sha) => `| ${id} | A problem. | \`t.test.mjs\` › \`pinned: ${id}\` | ${sha} |`;

/**
 * One repository, o/r. REGRESSIONS.md history (newest first): c3 adds R-A-02, c2 adds R-A-01, c1 is empty.
 * t.test.mjs history: t2 adds R-A-02's test, t1 adds R-A-01's test.
 * R-A-01: fix aaaaaaa in PR 7 (opened 2026-11-02, merged 2026-11-06), released in v1.0.0 (2026-11-10).
 * R-A-02: fix bbbbbbb in PR 8 (opened 2026-11-12, merged 2026-11-13), not released.
 */
function world() {
  const calls = [];
  const files = {
    c1: { 'REGRESSIONS.md': LEDGER([]) },
    c2: { 'REGRESSIONS.md': LEDGER([ROW('R-A-01', 'aaaaaaa')]) },
    c3: { 'REGRESSIONS.md': LEDGER([ROW('R-A-01', 'aaaaaaa'), ROW('R-A-02', 'bbbbbbb')]) },
    t1: { 't.test.mjs': "test('pinned: R-A-01', () => {});\n" },
    t2: { 't.test.mjs': "test('pinned: R-A-01', () => {});\ntest('pinned: R-A-02', () => {});\n" },
  };
  const list = {
    'REGRESSIONS.md': [['c3', '2026-11-12T08:00:00Z'], ['c2', '2026-11-08T08:00:00Z'], ['c1', '2026-11-01T08:00:00Z']],
    't.test.mjs': [['t2', '2026-11-11T08:00:00Z'], ['t1', '2026-11-03T08:00:00Z']],
  };
  const body = (o) => ({ status: 200, body: o });
  const gh = {
    state: { calls: 0 },
    async get(path) {
      calls.push(path);
      gh.state.calls++;
      let m = /^\/repos\/o\/r\/commits\?sha=main&path=([^&]+)&per_page=100&page=(\d+)$/.exec(path);
      if (m) return body(m[2] === '1' ? (list[decodeURIComponent(m[1])] ?? []).map(([sha, date]) => ({ sha, commit: { committer: { date } } })) : []);
      m = /^\/repos\/o\/r\/commits\/(a{7}|b{7})\/pulls/.exec(path);
      if (m) return body(m[1][0] === 'a' ? [{ number: 7, merged_at: '2026-11-06T00:00:00Z', merge_commit_sha: 'ma', base: { ref: 'main', repo: { default_branch: 'main' } } }] : [{ number: 8, merged_at: '2026-11-13T00:00:00Z', merge_commit_sha: 'mb', base: { ref: 'main', repo: { default_branch: 'main' } } }]);
      m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
      if (m) return body({ created_at: m[1] === '7' ? '2026-11-02T00:00:00Z' : '2026-11-12T00:00:00Z' });
      if (path.startsWith('/repos/o/r/releases')) return body([{ tag_name: 'v1.0.0', published_at: '2026-11-10T00:00:00Z', draft: false, prerelease: false }]);
      m = /^\/repos\/o\/r\/compare\/v1\.0\.0\.\.\.(.+)$/.exec(path);
      if (m) return body({ status: m[1] === 'ma' ? 'behind' : 'diverged' });
      return { status: 404, body: null };
    },
  };
  const readFile = async (repo, ref, file) => {
    calls.push(`raw:${ref}:${file}`);
    return files[ref]?.[file] ?? (ref === 'main' ? (file === 't.test.mjs' ? files.t2[file] : files.c3[file]) : null);
  };
  return { gh, calls, readFile };
}

async function build(w, cache = { commits: {}, contains: {} }, gh = w.gh) {
  const ledger = await buildLedger({
    sources: { repos: [{ repo: 'o/r' }] },
    readLedger: () => w.readFile('o/r', 'main', 'REGRESSIONS.md'),
    readFile: w.readFile,
    gh,
    cache,
  });
  return { ledger, cache };
}

test('summarise: median (mean of the middle two when even) and p90 by nearest rank', () => {
  assert.deepEqual(summarise([]), { n: 0, median: null, p90: null });
  assert.deepEqual(summarise([5]), { n: 1, median: 5, p90: 5 });
  assert.deepEqual(summarise([4, 1, 3, 2]), { n: 4, median: 2.5, p90: 4 });
  const ten = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.deepEqual(summarise(ten), { n: 10, median: 5.5, p90: 9 });
  assert.deepEqual(summarise([1, 2, NaN, null].filter((x) => x !== null)), { n: 2, median: 1.5, p90: 2 });
});

test('hoursBetween is null for a missing date or a gap that runs backwards', () => {
  assert.equal(hoursBetween('2026-11-01T00:00:00Z', '2026-11-02T12:00:00Z'), 36);
  assert.equal(hoursBetween('2026-11-03T00:00:00Z', '2026-11-02T00:00:00Z'), null);
  assert.equal(hoursBetween(null, '2026-11-02T00:00:00Z'), null);
});

test('foundAt takes the earliest candidate and says where it came from', () => {
  assert.deepEqual(foundAt([{ at: '2026-11-05T00:00:00Z', source: 'row' }, { at: '2026-11-02T00:00:00Z', source: 'pr' }]), { found_at: '2026-11-02T00:00:00Z', found_at_source: 'pr' });
  assert.deepEqual(foundAt([]), { found_at: null, found_at_source: null });
});

test('cycleStats: per repository and overall; unreleased, undated and backwards rows are counted, not averaged', () => {
  const rec = (repo, found, merged, released) => ({ repo, found_at: found, merged_at: merged, released_at: released });
  const c = cycleStats([
    rec('o/a', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-04T00:00:00Z'),
    rec('o/a', '2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z', null),
    rec('o/a', '2026-11-09T00:00:00Z', '2026-11-05T00:00:00Z', null),
    rec('o/a', null, null, null),
    rec('o/b', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-12T00:00:00Z'),
  ]);
  assert.deepEqual(c['o/a'], {
    rows: 4,
    found_to_merged: { n: 2, median: 72, p90: 96 },
    merged_to_released: { n: 1, median: 24, p90: 24 },
    merged_not_released: 2, without_dates: 1, excluded: 1,
  });
  assert.deepEqual(c['o/b'].merged_to_released, { n: 1, median: 240, p90: 240 });
  assert.equal(c.all.rows, 5);
  assert.equal(c.all.found_to_merged.n, 3);
});

test('firstCommitWhere binary-searches a file\'s history and reads only a few versions', async () => {
  const w = world();
  const memo = new Map();
  const at = await firstCommitWhere({ repo: 'o/r', ref: 'main', path: 'REGRESSIONS.md', gh: w.gh, readFile: w.readFile, has: (t) => t.includes('R-A-01'), memo });
  assert.equal(at, '2026-11-08T08:00:00Z');
  assert.equal(await firstCommitWhere({ repo: 'o/r', ref: 'main', path: 'REGRESSIONS.md', gh: w.gh, readFile: w.readFile, has: (t) => t.includes('R-Z-99'), memo }), null);
  assert.equal(w.calls.filter((c) => c.includes('/commits?')).length, 1, 'the commit list is asked once per file per run');
});

test('R-LED-08: each row gets found, pinned, merged and released dates, and the stats follow', async () => {
  const w = world();
  const { ledger } = await build(w);
  const [a, b] = ledger.records;
  assert.deepEqual([a.id, a.found_at, a.found_at_source, a.pinned_at, a.merged_at, a.released_in, a.released_at],
    ['R-A-01', '2026-11-02T00:00:00Z', 'pr', '2026-11-03T08:00:00Z', '2026-11-06T00:00:00Z', 'v1.0.0', '2026-11-10T00:00:00Z']);
  assert.equal(a.test[0].pinned_at, '2026-11-03T08:00:00Z');
  assert.deepEqual([b.id, b.found_at, b.found_at_source, b.pinned_at, b.merged_at, b.released_in, b.released_at],
    ['R-A-02', '2026-11-12T00:00:00Z', 'pr', '2026-11-11T08:00:00Z', '2026-11-13T00:00:00Z', null, null]);
  assert.deepEqual(ledger.cycle['o/r'], {
    rows: 2,
    found_to_merged: { n: 2, median: 60, p90: 96 },
    merged_to_released: { n: 1, median: 96, p90: 96 },
    merged_not_released: 1, without_dates: 0, excluded: 0,
  });
  const md = renderMarkdown(ledger);
  assert.match(md, /## Cycle time/);
  assert.match(md, /\| All tools \| 2 \| 2 \| 60\.0 \| 96\.0 \| 1 \| 96\.0 \| 96\.0 \| 1 \| 0 \| 0 \|/);
  assert.match(md, /\| 2026-11-02 \| 2026-11-03 \| 2026-11-06 \| v1\.0\.0 \(2026-11-10\) \|/);
});

test('R-LED-08: without a pull request, the row\'s first commit in REGRESSIONS.md is the found date', async () => {
  const w = world();
  const real = w.gh.get;
  w.gh.get = async (p) => (/\/pulls\/\d+$/.test(p) ? { status: 404, body: null } : real(p));
  const { ledger } = await build(w);
  assert.deepEqual([ledger.records[0].found_at, ledger.records[0].found_at_source], ['2026-11-08T08:00:00Z', 'row']);
  // R-A-01 was added to the ledger after its fix merged (11-06): the gap would be backwards, so it is left out and counted.
  assert.equal(ledger.cycle['o/r'].excluded >= 1, true);
});

test('R-LED-08: answers are cached for good, so a rerun makes no history, pull request or file calls', async () => {
  const w = world();
  const { cache } = await build(w);
  assert.equal(cache.prs['o/r#7'].created_at, '2026-11-02T00:00:00Z');
  assert.equal(cache.times['o/r:row:R-A-02'], '2026-11-12T08:00:00Z');
  assert.equal(cache.times['o/r:test:t.test.mjs:pinned: R-A-01'], '2026-11-03T08:00:00Z');
  const again = world();
  const second = await build(again, JSON.parse(JSON.stringify(cache)));
  assert.equal(again.calls.filter((c) => c.includes('/commits?') || c.includes('/pulls/')).length, 0);
  assert.equal(again.calls.filter((c) => /^raw:[ct]\d/.test(c)).length, 0, 'no history reads either');
  assert.equal(second.ledger.records[0].found_at, '2026-11-02T00:00:00Z');
});

test('R-LED-08: an empty API budget leaves the times for the next run, and the rest of the ledger is still written', async () => {
  const w = world();
  // Enough for the fix lookups and releases, not for history.
  const gh = makeGitHub({ fetch: async (url) => { const u = new URL(url); const r = await w.gh.get(u.pathname + u.search); return new Response(JSON.stringify(r.body), { status: r.status }); }, budget: 5 });
  const { ledger } = await build(w, undefined, gh);
  assert.match(ledger.api_stopped, /budget/);
  const a = ledger.records[0];
  assert.equal(a.merged_at, '2026-11-06T00:00:00Z');
  assert.ok(a.found_at === null || typeof a.found_at === 'string');
  assert.equal(ledger.cycle['o/r'].rows, 2);
});

test('R-LED-08: the time lookups need only read access and add no code to the publish job', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../.github/workflows/ledger.yml', import.meta.url), 'utf8');
  const publish = wf.slice(wf.indexOf('\n  publish:'));
  assert.doesNotMatch(publish, /node scripts\/ledger(-times)?\.mjs|node --test/, 'publish runs no ledger code');
  const generate = wf.slice(wf.indexOf('\n  generate:'), wf.indexOf('\n  publish:'));
  assert.match(generate, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(generate, /contents: write|pull-requests: write/);
});
