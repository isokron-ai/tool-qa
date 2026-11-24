// scripts/ledger.mjs: the cross-repo regression ledger. The parser is run on a
// fixture of each repository's REGRESSIONS.md format (test/fixtures/ledger),
// and the whole run against a fake GitHub with no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyFamily, foundByOf, main, parseLedger, parseTestRef, resolveCommit, splitRow } from '../scripts/ledger.mjs';

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
function fakeGitHub({ rateLimit = false } = {}) {
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
    assert.match(md, /R-ING-19 \(test\): pump\/test\/dispatch\.test\.mjs › .* not found on main/);

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
