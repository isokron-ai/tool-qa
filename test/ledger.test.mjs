// scripts/ledger.mjs: the cross-repo regression ledger. The parser is run on a
// fixture of each repository's REGRESSIONS.md format (test/fixtures/ledger),
// and the whole run against a fake GitHub with no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';

import { classifyFamily, fixCommits, foundByOf, main, parseLedger, parseTestRef, resolveCommit, sourceHasTest, splitRow, testNamesIn, validTestPath } from '../scripts/ledger.mjs';
import { ownPr } from '../scripts/ledger-own-pr.mjs';
import { parseYaml } from '../scripts/lib/yaml-lite.mjs';

const FIX = fileURLToPath(new URL('./fixtures/ledger/', import.meta.url));
const fixture = (repo) => readFileSync(join(FIX, `isokron-ai__${repo}.md`), 'utf8');

test('splitRow: pipes inside code spans or escaped do not split a cell', () => {
  assert.deepEqual(splitRow('| R-X-01 | a `x | y` b \\| c | `f` › `n` | abc1234 |'), ['R-X-01', 'a `x | y` b | c', '`f` › `n`', 'abc1234']);
});

test('parseTestRef reads the three forms the ledgers use', () => {
  assert.deepEqual(parseTestRef('`test/a.test.mjs` › `R-X-01: one`'), { file: 'test/a.test.mjs', name: 'R-X-01: one', form: '`file` › `name`' });
  assert.deepEqual(parseTestRef('`test/a.test.mjs` `R-X-01 one`'), { file: 'test/a.test.mjs', name: 'R-X-01 one', form: '`file` `name`' });
  assert.deepEqual(parseTestRef('`test/a.test.mjs`: "R-X-01: one"'), { file: 'test/a.test.mjs', name: 'R-X-01: one', form: '`file`: "name"' });
  assert.deepEqual(parseTestRef('some words'), { file: null, name: 'some words', form: null });
});

test('tool-qa format: canonical shape, severity, several fix commits, a Found by mark', () => {
  const p = parseLedger(fixture('tool-qa'), { repo: 'isokron-ai/tool-qa' });
  assert.deepEqual(p.header, ['ID', 'What it was', 'Pinned by', 'Fix']);
  assert.equal(p.shape.canonical, true);
  assert.deepEqual(p.shape.normalised, []);
  assert.deepEqual(p.rows.map((r) => r.id), ['R-ING-01', 'R-ING-06', 'R-ING-14', 'R-ING-19', 'R-ING-20']);
  const [r1, r6, , , r20] = p.rows;
  assert.equal(r1.severity, 'high');
  assert.match(r1.title, /^The email and JWT redaction patterns backtracked .*minutes\)\.$/);
  assert.ok(!r1.description.startsWith('HIGH'));
  assert.equal(r1.tests.length, 2);
  assert.deepEqual(r1.tests[0], { file: 'ingest/test/redact.test.mjs', name: 'R-ING-01: every redaction rule scans 1 MiB of crafted text in linear time', form: '`file` › `name`' });
  assert.deepEqual(r6.fix_commits, ['20a0fa4', '5426adf']);
  assert.equal(r20.found_by_marked, 'CI');
  assert.equal(r20.description, 'A row that says how it was found. The rest of the text.');
  assert.equal(r20.tests[0].name, "R-ING-20: it's quoted");
  assert.equal(foundByOf(r1, { found_by: { 'R-ING': 'review' } }, p.families), 'review');
  assert.equal(foundByOf(r20, { found_by: { 'R-ING': 'review' } }, p.families), 'CI', 'the row\'s own mark wins');
});

test('mcp-check format: canonical shape; a severity with a note', () => {
  const p = parseLedger(fixture('mcp-check'), { repo: 'isokron-ai/mcp-check' });
  assert.equal(p.shape.canonical, true);
  assert.deepEqual(p.rows.map((r) => [r.id, r.severity, r.severity_note]), [['R-SS-01', 'high', null], ['R-SS-10', 'low', 'hardening']]);
  assert.equal(p.rows[0].tests.length, 3);
});

test('mcp-surface-corpus format: tests written without the ›, ID families described in the ledger', () => {
  const p = parseLedger(fixture('mcp-surface-corpus'), { repo: 'isokron-ai/mcp-surface-corpus' });
  assert.equal(p.shape.canonical, false);
  assert.deepEqual(p.shape.normalised, ['test references written `file` `name` read as `file` › `name`']);
  assert.deepEqual(p.rows.map((r) => r.id), ['R-SBX-01', 'R-SBX-04', 'R-CASE-01', 'R-CI-01', 'R-MUT-00']);
  assert.ok(p.rows.every((r) => r.severity === null));
  assert.deepEqual(p.rows[1].fix_commits, ['1411417', '6d10237', '0f0f83c']);
  assert.deepEqual(p.rows[2].tests, [{ file: 'test/selftest.test.mjs', name: 'R-CASE-01 direct-ip: a connection to an outside address by IP is refused and traced', form: '`file` `name`' }]);
  // With nothing configured, found_by comes from the ledger's own description of each family.
  assert.deepEqual(p.rows.map((r) => foundByOf(r, {}, p.families)), ['review', 'review', 'self-test', 'CI', 'mutation']);
});

test('mcp-writecheck-action format (pull request 61): other headers, quoted test names, "this commit"', () => {
  const p = parseLedger(fixture('mcp-writecheck-action'), { repo: 'isokron-ai/mcp-writecheck-action' });
  assert.deepEqual(p.header, ['ID', 'What went wrong', 'Test', 'Fix']);
  assert.deepEqual(p.shape.normalised, [
    'column "What went wrong" read as "What it was"',
    'column "Test" read as "Pinned by"',
    'test references written `file`: "name" read as `file` › `name`',
    'some Fix cells name no commit (left unresolved)',
  ]);
  assert.deepEqual(p.rows.map((r) => r.id), ['R-WC-01', 'R-WC-02']);
  assert.deepEqual(p.rows[0].fix_commits, []);
  assert.deepEqual(p.rows[0].tests, [{ file: 'test/loop.test.mjs', name: 'R-WC-01: the tools volume carries what its code imports', form: '`file`: "name"' }]);
});

test('a ledger with no table, or a table without a needed column, is refused', () => {
  assert.throws(() => parseLedger('# Regressions\n\nnothing yet\n', { repo: 'r' }), /no table/);
  assert.throws(() => parseLedger('| ID | What it was | Fix |\n|---|---|---|\n| R-X-01 | a | abc1234 |\n', { repo: 'r' }), /no "tests" column/);
});

test('classifyFamily', () => {
  assert.equal(classifyFamily('the proof that the self test can fail'), 'mutation');
  assert.equal(classifyFamily("root causes found getting the self test green on GitHub's runners"), 'CI');
  assert.equal(classifyFamily('the hostile self test cases'), 'self-test');
  assert.equal(classifyFamily('findings of the security review'), 'review');
  assert.equal(classifyFamily('something else'), null);
  assert.equal(classifyFamily('the dispatch inputs of the T0 workers (`selftest.yml`, `dogfood-*.yml`)'), null, 'file names in code spans do not count');
});

test('a cached commit pushed with no pull request counts only for the branch it was found on', async () => {
  const cache = { commits: {
    'o/r@aaaaaaa': { sha: 'aaaaaaa', pr: null, merged_at: '2026-11-21T00:00:00Z', state: 'pushed', branch: 'rel' },
    'o/r@bbbbbbb': { sha: 'bbbbbbb', pr: 5, merged_at: '2026-11-21T00:00:00Z', state: 'merged' },
  }, contains: {} };
  assert.equal((await resolveCommit('o/r', 'aaaaaaa', null, cache, 'rel')).state, 'pushed');
  assert.match((await resolveCommit('o/r', 'aaaaaaa', null, cache, 'main')).error, /not looked up/);
  assert.equal((await resolveCommit('o/r', 'bbbbbbb', null, cache, 'main')).pr, 5);
});

// ---- the whole run, against a fake GitHub

const SOURCES = {
  repos: [
    { repo: 'isokron-ai/tool-qa', found_by: { 'R-ING': 'review' } },
    { repo: 'isokron-ai/mcp-check', found_by: { 'R-SS': 'review' } },
    { repo: 'isokron-ai/mcp-surface-corpus' },
    { repo: 'isokron-ai/mcp-writecheck-action' },
    { repo: 'isokron-ai/mcp-write-safety' },
  ],
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake raw.githubusercontent.com and api.github.com. Every test a fixture row names exists, except one. */
function fakeGitHub({ rateLimit = false, override = {} } = {}) {
  const calls = [];
  const ledgers = {
    'isokron-ai/tool-qa': fixture('tool-qa'),
    'isokron-ai/mcp-check': fixture('mcp-check'),
    'isokron-ai/mcp-surface-corpus': fixture('mcp-surface-corpus'),
    'isokron-ai/mcp-writecheck-action': fixture('mcp-writecheck-action'),
  };
  const testSources = {};
  for (const [repo, text] of Object.entries(ledgers)) {
    for (const row of parseLedger(text, { repo }).rows) {
      for (const t of row.tests) {
        if (t.name === 'R-ING-19: the branch is read with the actions-only dispatch token; a private worker repo fails closed with what to do') continue;
        const key = `${repo}/main/${t.file}`;
        // Names are written as they would be in a test file (quotes escaped), in it() calls.
        testSources[key] = `${testSources[key] ?? ''}it('${t.name.replaceAll("'", "\\'")}', () => {});\n`;
      }
    }
  }
  Object.assign(ledgers, override);
  // Commits: 0866426 and cd85233 are in mcp-check release v1.4.0; 99f6817 was pushed to main with no pull request.
  const prs = {
    'isokron-ai/mcp-check': { 3: { merged_at: '2026-11-23T10:00:00Z', merge_commit_sha: 'm3'.padEnd(40, '0') } },
  };
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.host === 'api.github.com' ? `${u.pathname}` : `raw:${u.pathname}`);
    if (u.host === 'raw.githubusercontent.com') {
      const [, owner, name, ref, ...rest] = u.pathname.split('/');
      const repo = `${owner}/${name}`;
      const path = rest.join('/');
      if (path === 'REGRESSIONS.md') return ledgers[repo] ? new Response(ledgers[repo]) : new Response('404: Not Found', { status: 404 });
      const src = testSources[`${repo}/${ref}/${path}`];
      return src ? new Response(src) : new Response('404: Not Found', { status: 404 });
    }
    if (rateLimit) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    let m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/pulls$/.exec(u.pathname);
    if (m) {
      const [, repo, sha] = m;
      if (sha === 'abc1234') return json(422, { message: 'No commit found' });
      if (sha === '99f6817') return json(200, []);
      const base = { ref: 'main', repo: { default_branch: 'main' } };
      if (repo === 'isokron-ai/mcp-check') return json(200, [{ number: 3, base, ...prs[repo][3] }]);
      if (sha === '5426adf') return json(200, [{ number: 4, base, merged_at: '2026-11-24T00:00:00Z', merge_commit_sha: 'm4'.padEnd(40, '0') }, { number: 9, base: { ref: 'other', repo: { default_branch: 'main' } }, merged_at: '2026-11-20T00:00:00Z', merge_commit_sha: 'x' }]);
      return json(200, [{ number: 1, base, merged_at: '2026-11-22T00:00:00Z', merge_commit_sha: `m1${sha}`.padEnd(40, '0') }]);
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)$/.exec(u.pathname);
    if (m) return json(200, { sha: m[2].padEnd(40, '0'), commit: { committer: { date: '2026-11-21T00:00:00Z' } } });
    m = /^\/repos\/([^/]+\/[^/]+)\/compare\/([^/]+)\.\.\.(.+)$/.exec(u.pathname);
    if (m) {
      const [, repo, base, head] = m;
      if (base === 'main' || base === 'state' || base === 'nightly') return json(200, { status: 'behind' });
      if (repo === 'isokron-ai/mcp-check' && base === 'v1.4.0' && head.startsWith('m3')) return json(200, { status: 'behind' });
      return json(200, { status: 'diverged' });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(u.pathname);
    if (m) {
      if (m[1] === 'isokron-ai/mcp-check') {
        return json(200, [
          { tag_name: 'v1.4.0', published_at: '2026-11-25T00:00:00Z', draft: false, prerelease: false },
          { tag_name: 'v1.3.9', published_at: '2026-11-23T12:00:00Z', draft: false, prerelease: false },
          { tag_name: 'v1.3.0', published_at: '2026-11-22T00:00:00Z', draft: false, prerelease: false },
          { tag_name: 'v2.0.0-draft', published_at: null, draft: true, prerelease: false },
        ]);
      }
      // tool-qa keeps its state database on a prerelease named state; neither it nor a tag that is not a version counts.
      if (m[1] === 'isokron-ai/tool-qa') {
        return json(200, [
          { tag_name: 'state', published_at: '2026-11-30T00:00:00Z', draft: false, prerelease: true },
          { tag_name: 'nightly', published_at: '2026-11-30T00:00:00Z', draft: false, prerelease: false },
        ]);
      }
      return json(200, []);
    }
    return json(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(SOURCES));
  return dir;
}

async function run(dir, gh, extra = []) {
  const logs = [];
  const code = await main(['--sources', join(dir, 'sources.json'), '--out', dir, ...extra], {}, { fetch: gh.fetch, log: (m) => logs.push(m) });
  return { code, logs };
}

test('a full run: every repo read, rows resolved to pull requests, merges and releases, the rest listed as unresolved', async () => {
  const dir = scratch();
  try {
    const gh = fakeGitHub();
    const { code } = await run(dir, gh);
    assert.equal(code, 0);
    const l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    assert.deepEqual(l.counts, { total: 14, 'isokron-ai/tool-qa': 5, 'isokron-ai/mcp-check': 2, 'isokron-ai/mcp-surface-corpus': 5, 'isokron-ai/mcp-writecheck-action': 2, 'isokron-ai/mcp-write-safety': 0 });
    assert.deepEqual(l.sources.find((s) => s.repo === 'isokron-ai/mcp-write-safety'), { repo: 'isokron-ai/mcp-write-safety', ref: 'main', path: 'REGRESSIONS.md', status: 'absent' });
    const rec = (id) => l.records.find((r) => r.id === id);
    const keys = ['repo', 'id', 'title', 'description', 'severity', 'severity_note', 'found_by', 'test', 'fix_commit', 'fix_commits', 'fix_pr', 'fix_prs', 'merged_at', 'released_in', 'url'];
    for (const r of l.records) assert.deepEqual(Object.keys(r), keys);

    // Two fix commits in two pull requests: the row is merged when the last one is.
    assert.deepEqual([rec('R-ING-06').fix_commit, rec('R-ING-06').fix_prs, rec('R-ING-06').fix_pr, rec('R-ING-06').merged_at], ['20a0fa4', [1, 4], 4, '2026-11-24T00:00:00Z']);
    // The first release published after the merge that contains the fix (v1.3.9 does not; v1.3.0 is older; the draft is skipped).
    assert.deepEqual([rec('R-SS-01').fix_pr, rec('R-SS-01').merged_at, rec('R-SS-01').released_in], [3, '2026-11-23T10:00:00Z', 'v1.4.0']);
    assert.equal(rec('R-SS-10').severity_note, 'hardening');
    assert.equal(rec('R-ING-01').found_by, 'review');
    assert.equal(rec('R-ING-01').released_in, null, 'the state prerelease and a non-version tag are not tool releases');
    assert.ok(!gh.calls.some((c) => /compare\/(state|nightly)\.\.\./.test(c)));
    assert.equal(rec('R-ING-20').found_by, 'CI');
    assert.equal(rec('R-MUT-00').found_by, 'mutation');
    assert.equal(rec('R-WC-01').found_by, 'unknown');
    assert.deepEqual(rec('R-ING-01').test.map((t) => t.found), [true, true]);
    // A commit pushed to main with no pull request: its own date is the merge time.
    assert.deepEqual([rec('R-ING-14').fix_pr, rec('R-ING-14').fix_prs, rec('R-ING-14').merged_at], [null, [], '2026-11-21T00:00:00Z']);

    const un = l.unresolved.map((u) => `${u.id} ${u.what}`);
    assert.deepEqual(un.sort(), ['R-ING-19 test', 'R-ING-20 fix_commit', 'R-WC-01 fix_commit', 'R-WC-02 fix_commit'].sort());
    assert.match(l.unresolved.find((u) => u.id === 'R-WC-01').detail, /no commit in the Fix cell \("this commit"\)/);
    assert.match(l.unresolved.find((u) => u.id === 'R-ING-20').detail, /commit abc1234 not found/);

    const md = readFileSync(join(dir, 'docs/LEDGER.md'), 'utf8');
    assert.match(md, /\*\*14 rows\*\* across 5 repositories/);
    assert.match(md, /\| \[mcp-check\]\(https:\/\/github\.com\/isokron-ai\/mcp-check\) \| 2 \| 0 \| 1 \| 0 \| 1 \| 0 \| 0 \|/);
    assert.match(md, /mcp-write-safety\) \| 0 \(no ledger yet\)/);
    assert.match(md, /- isokron-ai\/mcp-surface-corpus: normalised: test references written `file` `name` read as `file` › `name`\./);
    assert.match(md, /- isokron-ai\/tool-qa: already in that shape\./);
    assert.match(md, /\| R-SS-01 \| high \| .* \| review \| .* \| \[0866426\]\(https:\/\/github\.com\/isokron-ai\/mcp-check\/commit\/0866426\) \| \[#3\]\(https:\/\/github\.com\/isokron-ai\/mcp-check\/pull\/3\) \| 2026-11-23 \| v1\.4\.0 \|/);
    assert.match(md, /## Unresolved\n\n- /);
    assert.match(md, /R-ING-19 \(test\): pump\/test\/dispatch\.test\.mjs › .*: no test of exactly that name on main/);

    // The cache holds only what cannot change.
    const cache = JSON.parse(readFileSync(join(dir, 'ledger/cache.json'), 'utf8'));
    assert.ok(cache.commits['isokron-ai/mcp-check@0866426']);
    assert.equal(cache.commits['isokron-ai/tool-qa@abc1234'], undefined);
    assert.equal(cache.contains[`isokron-ai/mcp-check@v1.4.0@${'m3'.padEnd(40, '0')}`], true);
    assert.equal(cache.contains[`isokron-ai/mcp-check@v1.3.9@${'m3'.padEnd(40, '0')}`], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rerun asks the API only about what the cache does not hold, and writes the same files', async () => {
  const dir = scratch();
  try {
    await run(dir, fakeGitHub());
    const first = ['ledger/ledger.json', 'docs/LEDGER.md', 'ledger/cache.json'].map((f) => readFileSync(join(dir, f), 'utf8'));
    const gh = fakeGitHub();
    const { code } = await run(dir, gh);
    assert.equal(code, 0);
    const api = gh.calls.filter((c) => !c.startsWith('raw:'));
    // The unmerged commit is asked again; every merged commit and every release check comes from the cache.
    assert.deepEqual(api.filter((c) => c.endsWith('/pulls')), ['/repos/isokron-ai/tool-qa/commits/abc1234/pulls']);
    assert.equal(api.filter((c) => c.includes('/compare/')).length, 0);
    const second = ['ledger/ledger.json', 'docs/LEDGER.md', 'ledger/cache.json'].map((f) => readFileSync(join(dir, f), 'utf8'));
    assert.deepEqual(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--offline makes no API call; a rate limit stops the lookups without failing the run', async () => {
  const dir = scratch();
  try {
    const off = fakeGitHub();
    assert.equal((await run(dir, off, ['--offline'])).code, 0);
    assert.deepEqual(off.calls.filter((c) => !c.startsWith('raw:')), []);
    let l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    assert.equal(l.records.find((r) => r.id === 'R-SS-01').merged_at, null);
    assert.ok(l.unresolved.some((u) => u.id === 'R-SS-01' && /not looked up/.test(u.detail)));

    const limited = fakeGitHub({ rateLimit: true });
    const { code, logs } = await run(dir, limited);
    assert.equal(code, 0);
    l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    assert.match(l.api_stopped, /rate limit/);
    assert.equal(limited.calls.filter((c) => !c.startsWith('raw:')).length, 1, 'one refused call, then no more');
    assert.match(logs.at(-1), /stopped early: GitHub rate limit/);
    assert.match(readFileSync(join(dir, 'docs/LEDGER.md'), 'utf8'), /API lookups stopped early/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger that cannot be fetched fails the run; a bad argument is a usage error', async () => {
  const dir = scratch();
  try {
    const broken = { fetch: async () => new Response('nope', { status: 403 }), calls: [] };
    const { code, logs } = await run(dir, broken);
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /HTTP 403/);
    const l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    assert.deepEqual(l.sources.map((x) => x.status), ['unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable']);
    assert.equal((await run(dir, fakeGitHub(), ['--nope'])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed sources list every tool repository once', () => {
  const s = JSON.parse(readFileSync(fileURLToPath(new URL('../ledger/sources.json', import.meta.url)), 'utf8'));
  const repos = s.repos.map((r) => r.repo);
  assert.deepEqual(repos, ['isokron-ai/tool-qa', 'isokron-ai/mcp-check', 'isokron-ai/mcp-surface-corpus', 'isokron-ai/mcp-writecheck-action', 'isokron-ai/mcp-write-safety']);
  const vocab = new Set(['review', 'CI', 'self-test', 'mutation', 'live run', 'unknown']);
  for (const r of s.repos) for (const v of Object.values(r.found_by ?? {})) assert.ok(vocab.has(v), `${r.repo}: ${v}`);
});

// ---- review fixes (R-LED)

test('R-LED-01: one unreadable ledger is recorded as such; the others are built and written, and the run fails', async () => {
  const dir = scratch();
  try {
    const gh = fakeGitHub({ override: { 'isokron-ai/mcp-check': '# Regressions\n\n| ID | What it was | Fix |\n|---|---|---|\n| R-SS-01 | x | abc1234 |\n' } });
    const { code, logs } = await run(dir, gh);
    assert.equal(code, 1, 'the run shows red');
    assert.match(logs.join('\n'), /mcp-check could not be read; failing the run/);
    const l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    const mc = l.sources.find((x) => x.repo === 'isokron-ai/mcp-check');
    assert.equal(mc.status, 'unreadable');
    assert.match(mc.error, /no "tests" column/);
    assert.deepEqual(l.unresolved.filter((u) => u.what === 'ledger').map((u) => [u.repo, u.id]), [['isokron-ai/mcp-check', null]]);
    assert.equal(l.counts['isokron-ai/mcp-check'], 0);
    assert.equal(l.counts['isokron-ai/tool-qa'], 5, 'the other sources are still built');
    assert.equal(l.counts['isokron-ai/mcp-surface-corpus'], 5);
    const md = readFileSync(join(dir, 'docs/LEDGER.md'), 'utf8');
    assert.match(md, /mcp-check\) \| 0 \(ledger unreadable\)/);
    assert.match(md, /- isokron-ai\/mcp-check: \*\*unreadable\*\*: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-LED-01: the ledger table is the one whose header has an ID column, not the first table on the page', () => {
  const text = '# Regressions\n\n| Prefix | Meaning |\n|---|---|\n| R-X | things |\n\n| ID | What it was | Pinned by | Fix |\n|---|---|---|---|\n| R-X-01 | LOW. A thing. | `test/a.test.mjs` › `R-X-01: a` | abc1234 |\n';
  const p = parseLedger(text, { repo: 'r' });
  assert.deepEqual(p.rows.map((r) => r.id), ['R-X-01']);
  assert.throws(() => parseLedger('| Prefix | Meaning |\n|---|---|\n| R-X | things |\n', { repo: 'r' }), /no table with an ID column/);
});

test('R-LED-02: only an open pull request from this repository counts as the workflow\'s own, never a fork\'s', () => {
  const fork = { number: 7, isCrossRepository: true, headRepositoryOwner: { login: 'someone' } };
  const forkSameOwnerName = { number: 8, isCrossRepository: true, headRepositoryOwner: { login: 'isokron-ai' } };
  const mine = { number: 12, isCrossRepository: false, headRepositoryOwner: { login: 'isokron-ai' } };
  assert.equal(ownPr([fork, forkSameOwnerName], 'isokron-ai'), null);
  assert.equal(ownPr([fork, mine], 'isokron-ai'), 12);
  assert.equal(ownPr([mine], 'ISOKRON-AI'), 12);
  assert.equal(ownPr([{ ...mine, headRepositoryOwner: { login: 'other' } }], 'isokron-ai'), null);
  assert.equal(ownPr('nope', 'isokron-ai'), null);
});

const WF = parseYaml(readFileSync(fileURLToPath(new URL('../.github/workflows/ledger.yml', import.meta.url)), 'utf8'));
const PUBLISH_STEP = WF.jobs.publish.steps.find((s) => s.name === 'Open or update the pull request');

const BASE = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const NEW = 'e'.repeat(40);
const OLD = 'f'.repeat(40);

// Runs the publish step's script with a fake `git` and a fake `gh`. The fake gh answers the API calls from
// `opts`, applies the step's own --jq filters with the real jq, and keeps every request body.
function runPublish(opts = {}) {
  const o = {
    status: ' M docs/LEDGER.md\n', prList: [], branch: null, apiTree: TREE,
    made: { sha: NEW, verification: { verified: true } }, recheck: null, ...opts,
  };
  const dir = mkdtempSync(join(tmpdir(), 'ledger-wf-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const commits = { [NEW]: o.recheck ?? o.made };
    if (o.branch) commits[OLD] = o.branch;
    writeFileSync(join(dir, 'prlist.json'), JSON.stringify(o.prList));
    writeFileSync(join(dir, 'refs.json'), JSON.stringify(o.branch ? [{ ref: 'refs/heads/ledger/refresh-old', object: { sha: BASE } }, { ref: 'refs/heads/ledger/refresh', object: { sha: OLD } }] : []));
    writeFileSync(join(dir, 'tree.json'), JSON.stringify({ sha: o.apiTree }));
    writeFileSync(join(dir, 'made.json'), JSON.stringify(o.made));
    for (const [sha, c] of Object.entries(commits)) writeFileSync(join(dir, `commit-${sha}.json`), JSON.stringify(c));
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
D='${dir}'
echo "gh $*" >> "$D/calls"
if [ "$1 $2" = "pr list" ]; then cat "$D/prlist.json"; exit 0; fi
[ "$1" = api ] || exit 0
shift
method=GET; ep=""; jqf=""; input=""; silent=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    --jq) jqf="$2"; shift ;;
    --input) input="$2"; shift ;;
    --silent) silent=1 ;;
    -f|-F) shift ;;
    repos/*) ep="$1" ;;
  esac
  shift
done
n=$(wc -l < "$D/calls" | tr -d ' ')
if [ "$input" = - ]; then cat > "$D/body-$n.json"; fi
case "$method $ep" in
  "GET repos/isokron-ai/tool-qa/git/matching-refs/heads/ledger/refresh") resp="$(cat "$D/refs.json")" ;;
  "GET repos/isokron-ai/tool-qa/git/commits/"*) resp="$(cat "$D/commit-\${ep##*/}.json")" ;;
  "POST repos/isokron-ai/tool-qa/git/trees") resp="$(cat "$D/tree.json")" ;;
  "POST repos/isokron-ai/tool-qa/git/commits") resp="$(cat "$D/made.json")" ;;
  *) resp='{}' ;;
esac
if [ -n "$jqf" ]; then printf '%s' "$resp" | jq -r "$jqf"; elif [ -z "$silent" ]; then printf '%s\\n' "$resp"; fi
`);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
echo "git $*" >> '${dir}/calls'
case "$1" in
  status) printf '%s' "$GIT_STATUS" ;;
  rev-parse) if [ "$2" = HEAD ]; then echo ${BASE}; else echo ${BASE_TREE}; fi ;;
  write-tree) echo ${TREE} ;;
esac
exit 0
`);
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'git'), 0o755);
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = spawnSync('bash', ['-e', '-c', PUBLISH_STEP.run], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, REPO: 'isokron-ai/tool-qa', OWNER: 'isokron-ai', BRANCH: 'ledger/refresh', GIT_STATUS: o.status, GITHUB_STEP_SUMMARY: join(dir, 'summary') },
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    const bodies = {};
    calls.split('\n').forEach((line, i) => {
      const m = /^gh api -X POST repos\/isokron-ai\/tool-qa\/git\/(trees|commits) --input -/.exec(line);
      if (m) bodies[m[1]] = JSON.parse(readFileSync(join(dir, `body-${i + 1}.json`), 'utf8'));
    });
    return { status: r.status, out: r.stdout + r.stderr, calls, bodies };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WRITES = /gh api -X (POST|PATCH)|gh workflow run|git (commit|push)|gh pr create/;

test('R-LED-02: with only a fork\'s pull request on ledger/refresh, the workflow neither closes it nor counts it as its own', () => {
  assert.match(PUBLISH_STEP.run, /--json number,isCrossRepository,headRepositoryOwner \| node scripts\/ledger-own-pr\.mjs "\$OWNER"/);
  const prList = [{ number: 7, isCrossRepository: true, headRepositoryOwner: { login: 'someone' } }];
  const same = runPublish({ status: '', prList });
  assert.equal(same.status, 0, same.out);
  assert.doesNotMatch(same.calls, /gh pr close/, 'the fork\'s pull request is not closed');
  const changed = runPublish({ prList });
  assert.equal(changed.status, 0, changed.out);
  assert.match(changed.calls, /gh pr create -R isokron-ai\/tool-qa --base main --head ledger\/refresh/, 'a pull request of its own is opened');
  assert.doesNotMatch(changed.out, /Updated pull request #7/);
});

test('R-LED-08: the refresh commit is made through the API so GitHub signs it, never with git commit and a push', () => {
  assert.doesNotMatch(PUBLISH_STEP.run, /git\b[^\n]*\b(commit|push)\b/, 'no git commit or push in the step');
  assert.doesNotMatch(PUBLISH_STEP.run, /credential\.helper/);

  // A new branch: tree, commit and ref are created through the API, in that order.
  const fresh = runPublish();
  assert.equal(fresh.status, 0, fresh.out);
  const writes = fresh.calls.split('\n').filter((l) => /^gh api -X \S+ repos\/isokron-ai\/tool-qa\/git\//.test(l));
  assert.deepEqual(writes, [
    'gh api -X POST repos/isokron-ai/tool-qa/git/trees --input - --jq .sha',
    'gh api -X POST repos/isokron-ai/tool-qa/git/commits --input - --jq [.sha, (.verification.verified | tostring)] | join(" ")',
    `gh api -X POST repos/isokron-ai/tool-qa/git/refs -f ref=refs/heads/ledger/refresh -f sha=${NEW} --silent`,
  ]);
  assert.equal(fresh.bodies.trees.base_tree, BASE_TREE);
  assert.deepEqual(fresh.bodies.trees.tree.map((e) => [e.path, e.mode, e.type]),
    [['ledger/ledger.json', '100644', 'blob'], ['ledger/cache.json', '100644', 'blob'], ['docs/LEDGER.md', '100644', 'blob']]);
  assert.equal(fresh.bodies.trees.tree[2].content, readFileSync(fileURLToPath(new URL('../docs/LEDGER.md', import.meta.url)), 'utf8'), 'the file as generated');
  assert.deepEqual(fresh.bodies.commits, { message: "Ledger: refresh from the tool repositories' REGRESSIONS.md", tree: TREE, parents: [BASE] });
  assert.ok(!('author' in fresh.bodies.commits) && !('committer' in fresh.bodies.commits), 'no author or committer, or GitHub would not sign it');

  // An existing branch (an old unsigned commit) is moved with a forced ref update, only to the new commit.
  const old = runPublish({ branch: { sha: OLD, tree: { sha: TREE }, parents: [{ sha: BASE }], verification: { verified: false } } });
  assert.equal(old.status, 0, old.out);
  assert.match(old.calls, new RegExp(`gh api -X PATCH repos/isokron-ai/tool-qa/git/refs/heads/ledger/refresh -f sha=${NEW} -F force=true`));

  // A commit that is not verified, even on a second look, never reaches the branch.
  const unsigned = runPublish({ made: { sha: NEW, verification: { verified: false } }, recheck: { sha: NEW, verification: { verified: false } } });
  assert.notEqual(unsigned.status, 0);
  assert.match(unsigned.out, /is not verified/);
  assert.doesNotMatch(unsigned.calls, /git\/refs|gh pr create|gh workflow run/);
  // The answer to the create call can lag; a verified second look is enough.
  const late = runPublish({ made: { sha: NEW, verification: { verified: false } }, recheck: { sha: NEW, verification: { verified: true } } });
  assert.equal(late.status, 0, late.out);
  assert.match(late.calls, /git\/refs -f ref=refs\/heads\/ledger\/refresh/);

  // The API must build exactly the tree generated here.
  const wrongTree = runPublish({ apiTree: 'a'.repeat(40) });
  assert.notEqual(wrongTree.status, 0);
  assert.match(wrongTree.out, /is not the one generated here/);
  assert.doesNotMatch(wrongTree.calls, /git\/commits --input|git\/refs/);

  // Nothing changed against main: no write at all.
  const same = runPublish({ status: '' });
  assert.equal(same.status, 0, same.out);
  assert.doesNotMatch(same.calls, WRITES);

  // The branch already holds this tree on this main commit, verified: no new commit, no new checks.
  const held = runPublish({ branch: { sha: OLD, tree: { sha: TREE }, parents: [{ sha: BASE }], verification: { verified: true } },
    prList: [{ number: 12, isCrossRepository: false, headRepositoryOwner: { login: 'isokron-ai' } }] });
  assert.equal(held.status, 0, held.out);
  assert.match(held.out, /already holds this ledger/);
  assert.doesNotMatch(held.calls, WRITES);
  // ...but on an older main commit it is rebuilt.
  const stale = runPublish({ branch: { sha: OLD, tree: { sha: TREE }, parents: [{ sha: '9'.repeat(40) }], verification: { verified: true } } });
  assert.match(stale.calls, /git\/refs\/heads\/ledger\/refresh -f sha=/);
});

test('R-LED-09: after a new refresh commit the workflow dispatches test.yml and lint.yml on ledger/refresh, and their results show on the pull request as commit statuses', () => {
  // The dispatched workflows: they can be dispatched, still run on pull requests, and a dispatched run reports its
  // result as a commit status (a dispatched run's check runs do not show on a pull request).
  for (const [f, need, ctx] of [['test.yml', 'node', 'dispatched/test'], ['lint.yml', 'workflows', 'dispatched/lint']]) {
    const wf = parseYaml(readFileSync(fileURLToPath(new URL(`../.github/workflows/${f}`, import.meta.url)), 'utf8'));
    assert.ok('workflow_dispatch' in wf.on, `${f} can be dispatched`);
    assert.ok('pull_request' in wf.on, `${f} still runs on pull requests`);
    const { report } = wf.jobs;
    assert.deepEqual(report.needs, [need], f);
    assert.equal(report.if, "${{ !cancelled() && github.event_name == 'workflow_dispatch' }}", f);
    assert.deepEqual(report.permissions, { statuses: 'write' }, f);
    assert.ok(report.steps.every((st) => !st.uses), `${f}: the report job checks out nothing`);
    assert.equal(report.steps[0].env.RESULT, `\${{ needs.${need}.result }}`);
    assert.equal(report.steps[0].env.SHA, '${{ github.sha }}');
    for (const [result, state] of [['success', 'success'], ['failure', 'failure'], ['skipped', 'failure'], ['cancelled', 'failure']]) {
      const dir = mkdtempSync(join(tmpdir(), 'ledger-report-'));
      try {
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\necho "gh $*" >> '${dir}/calls'\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        const r = spawnSync('bash', ['-e', '-c', report.steps[0].run], { encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, REPO: 'isokron-ai/tool-qa', SHA: NEW, RESULT: result, RUN_URL: 'https://example.test/run' } });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(readFileSync(join(dir, 'calls'), 'utf8').trim(),
          `gh api -X POST repos/isokron-ai/tool-qa/statuses/${NEW} -f state=${state} -f context=${ctx} -f description=${report.steps[0].run.match(/description="([^:]+):/)[1]}: ${result} -f target_url=https://example.test/run --silent`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  assert.equal(WF.jobs.publish.permissions.actions, 'write');
  assert.equal(WF.jobs.publish.permissions.statuses, 'write');

  const fresh = runPublish();
  assert.equal(fresh.status, 0, fresh.out);
  const lines = fresh.calls.trim().split('\n');
  const ref = lines.findIndex((l) => /git\/refs/.test(l));
  const pr = lines.findIndex((l) => /^gh pr create/.test(l));
  const pending = lines.map((l, i) => [l, i]).filter(([l]) => /\/statuses\//.test(l));
  assert.deepEqual(pending.map(([l]) => l), ['test', 'lint'].map((w) =>
    `gh api -X POST repos/isokron-ai/tool-qa/statuses/${NEW} -f state=pending -f context=dispatched/${w} -f description=${w}.yml dispatched on ledger/refresh --silent`));
  const runs = lines.map((l, i) => [l, i]).filter(([l]) => /^gh workflow run/.test(l));
  assert.deepEqual(runs.map(([l]) => l), [
    'gh workflow run test.yml -R isokron-ai/tool-qa --ref ledger/refresh',
    'gh workflow run lint.yml -R isokron-ai/tool-qa --ref ledger/refresh',
  ]);
  assert.ok(pending.every(([, i]) => i > ref && i > pr), 'statuses go on the commit the branch now holds');
  assert.ok(runs.every(([, i]) => pending.every(([, j]) => i > j)), 'pending is set before the dispatch, so it never overwrites a result');

  const updated = runPublish({ prList: [{ number: 12, isCrossRepository: false, headRepositoryOwner: { login: 'isokron-ai' } }],
    branch: { sha: OLD, tree: { sha: 'a'.repeat(40) }, parents: [{ sha: BASE }], verification: { verified: true } } });
  assert.equal(updated.status, 0, updated.out);
  assert.match(updated.out, /Updated pull request #12/);
  assert.equal((updated.calls.match(/^gh workflow run/gm) ?? []).length, 2, 'an updated pull request gets checks on its new head too');

  const failed = runPublish({ apiTree: 'a'.repeat(40) });
  assert.doesNotMatch(failed.calls, /gh workflow run|\/statuses\//, 'no dispatch when nothing was published');
});

test('R-LED-03: a Fix cell yields commit SHAs only, not dates, pull request numbers or hex-looking words', () => {
  assert.deepEqual(fixCommits('70d658a, 20a0fa4'), ['70d658a', '20a0fa4']);
  assert.deepEqual(fixCommits('merged 20261123 in #1234567 (defaced)'), []);
  assert.deepEqual(fixCommits('`deadbee` and https://github.com/isokron-ai/tool-qa/commit/0123abc'), ['deadbee', '0123abc']);
  assert.deepEqual(fixCommits('fixed by 1234567 in prose'), [], 'in prose, a bare all-digit word is not taken for a SHA');
  assert.deepEqual(fixCommits('0866426'), ['0866426'], 'a cell that is only SHAs may hold an all-digit one');
  assert.deepEqual(fixCommits('1411417, 6d10237, 0f0f83c'), ['1411417', '6d10237', '0f0f83c']);
  assert.deepEqual(fixCommits('a8305a847eb48019fa454736699fded8032cb6dc'), ['a8305a847eb48019fa454736699fded8032cb6dc']);
  const p = parseLedger('| ID | What it was | Pinned by | Fix |\n|---|---|---|---|\n| R-X-01 | x | `t/a.test.mjs` › `n` | 20261123, pull request 1234567 |\n', { repo: 'r' });
  assert.deepEqual(p.rows[0].fix_commits, []);
});

test('R-LED-04: a test path with .., a leading /, ? or # is rejected and never fetched', async () => {
  for (const bad of ['../x.test.mjs', 'a/../../b.test.mjs', '/etc/passwd', 'a.test.mjs?x=1', 'a.test.mjs#frag', './a.test.mjs', 'a//b.test.mjs', 'a\\b.test.mjs']) {
    assert.equal(validTestPath(bad), false, bad);
  }
  assert.equal(validTestPath('ingest/test/redact.test.mjs'), true);
  assert.deepEqual(parseTestRef('`../secret.test.mjs` › `R-X-01: n`'), { file: null, name: 'R-X-01: n', form: '`file` › `name`', rejected: '../secret.test.mjs' });

  const dir = scratch();
  try {
    const bad = `${fixture('tool-qa').trimEnd()}\n| R-ING-21 | LOW. x. | \`../../other/repo.test.mjs\` › \`R-ING-21: n\`<br>\`test/q.test.mjs?ref=x\` › \`R-ING-21: m\` | 70d658a |\n`;
    const gh = fakeGitHub({ override: { 'isokron-ai/tool-qa': bad } });
    assert.equal((await run(dir, gh)).code, 0);
    assert.ok(!gh.calls.some((c) => c.startsWith('raw:') && /other\/repo|q\.test/.test(c)), 'no request for a rejected path');
    const l = JSON.parse(readFileSync(join(dir, 'ledger/ledger.json'), 'utf8'));
    const details = l.unresolved.filter((u) => u.id === 'R-ING-21').map((u) => u.detail);
    assert.deepEqual(details, ['test path rejected ("../../other/repo.test.mjs"): R-ING-21: n', 'test path rejected ("test/q.test.mjs?ref=x"): R-ING-21: m']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-LED-05: generate holds a read-only token; only publish can write, and it runs no ledger code', () => {
  const { generate, publish } = WF.jobs;
  assert.deepEqual(Object.keys(WF.jobs), ['generate', 'publish']);
  assert.deepEqual(generate.permissions, { contents: 'read' });
  assert.deepEqual(publish.permissions, { actions: 'write', contents: 'write', 'pull-requests': 'write', statuses: 'write' });
  assert.equal(publish.needs, 'generate');
  for (const job of [generate, publish]) {
    const guard = job.steps[1];
    assert.equal(guard.id, 'guard');
    assert.match(guard.run, /node scripts\/guard\.mjs --job ledger --no-slots/);
    for (const v of ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_LEDGER_ENABLED']) assert.equal(guard.env[v], `\${{ vars.${v} }}`);
  }
  assert.ok(generate.steps.some((s) => /node scripts\/ledger\.mjs/.test(s.run ?? '')));
  const publishRuns = publish.steps.map((s) => s.run ?? '').join('\n');
  assert.doesNotMatch(publishRuns, /node scripts\/ledger\.mjs|node --test/);
  const up = generate.steps.find((s) => /upload-artifact@/.test(s.uses ?? ''));
  const down = publish.steps.find((s) => /download-artifact@/.test(s.uses ?? ''));
  assert.equal(up.with.name, down.with.name);
  assert.equal(up.with.path.trim().split('\n').join(' '), 'ledger/ledger.json ledger/cache.json docs/LEDGER.md');
  assert.match(publishRuns, /for f in ledger\/ledger\.json ledger\/cache\.json docs\/LEDGER\.md; do/);
});

test('R-LED-06: a test is found only under exactly its name, not as part of a longer one', () => {
  // Names here do not start with R-...-NN:, which test/regressions.test.mjs would read as ledger rows.
  const src = "test('X-01: the whole name, and more', () => {});\nit(\"X-02: it's here\", () => {});\nfor (const n of ['a.yml']) test(`${n}: built in a loop`, () => {});\nconst s = 'X-03: only in a string';\n";
  assert.equal(sourceHasTest(src, 'X-01: the whole name'), false);
  assert.equal(sourceHasTest(src, 'X-01: the whole name, and more'), true);
  assert.equal(sourceHasTest(src, "X-02: it's here"), true);
  assert.equal(sourceHasTest(src, 'corpus.yml: built in a loop'), true);
  assert.equal(sourceHasTest(src, 'built in a loop'), false);
  assert.equal(sourceHasTest(src, 'X-03: only in a string'), false, 'a string that is not a test name does not count');
  assert.equal(sourceHasTest("caseTest('R-CASE-01 direct-ip: refused', 'direct-ip', () => {});", 'R-CASE-01 direct-ip: refused'), true, 'a helper named ...Test that wraps test()');
  assert.equal(sourceHasTest("t.test('sub', () => {});", 'sub'), true);
  assert.equal(sourceHasTest("latest('x');", 'x'), false, 'latest() is not a test helper');
  assert.deepEqual([...testNamesIn(src).exact], ['X-01: the whole name, and more', "X-02: it's here"]);
});

test('R-LED-07: a SHA in backticks or in a commit link counts even when it is all digits', () => {
  assert.deepEqual(fixCommits('fixed in `0866426`, see the review'), ['0866426']);
  assert.deepEqual(fixCommits('fixed in [0866426](https://github.com/isokron-ai/mcp-check/commit/0866426) after review'), ['0866426']);
  assert.deepEqual(fixCommits('`0866426` and `cd85233`, then 20261124'), ['0866426', 'cd85233']);
  assert.deepEqual(fixCommits('`defaced` is a word'), ['defaced'], 'backticks say it is a SHA, whatever it looks like');
});
