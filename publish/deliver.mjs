#!/usr/bin/env node
// Hand the files run.mjs built to isokron-ai/mcp-results as one pull request. It
// never merges, and it never writes to main.
//
//   node publish/deliver.mjs --out <dir> --base-sha <mcp-results main commit run.mjs read> [--dry-run]
//
// Uses the loop's existing GitHub App (APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY):
// an installation token narrowed to the one repository mcp-results with
// contents: write and pull_requests: write, minted when it is needed and never
// stored. No other credential. If the App does not have those permissions, or is
// not installed on mcp-results, the mint is refused and this says so; nothing is
// created.
//
// The commit is made through the git data API (tree, commit, ref), never with
// `git push`, so GitHub signs it, and the job checks that it shows as verified
// before it moves the branch (the ledger workflow does the same). If main moved
// since run.mjs read it, nothing is written: the next run starts again from the
// new main. The branch `results/refresh` is ours; it is replaced on every run,
// because every run starts from main.
//
// Environment: GITHUB_REPOSITORY_OWNER (default isokron-ai), APP_ID,
// APP_INSTALLATION_ID, APP_PRIVATE_KEY, GITHUB_API_URL.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appTokenMinter } from '../pump/app-token.mjs';
import { createClient, scrub } from '../pump/github.mjs';

export const TARGET_REPO = 'mcp-results';
export const BRANCH = 'results/refresh';
export const PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write' });

function listData(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listData(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

/** Every commit this publisher makes ends with this line; a branch head without it was not made by us. */
export const TRAILER = 'Published-by: tool-qa publish-results';

export function prBody(report) {
  const lines = [
    'New results from the tool-qa loop, built by the publish-results workflow in isokron-ai/tool-qa from the results its ingest accepted.',
    '',
    `- New records: ${report.records_added}`,
    `- Records already published (unchanged): ${report.records_unchanged}`,
    `- Files that change: ${report.files_changed.length}`,
    `- Field registry: version ${report.registry.version}, sha256 ${report.registry.sha256}`,
  ];
  lines.push('',
    'Check the files with `node scripts/verify.mjs` (the validate workflow runs it on this branch). Merge by hand. The commit was made through the API, so GitHub signed it.');
  return lines.join('\n');
}

/**
 * @param {{out: string, baseSha: string, owner?: string, env?: object, dryRun?: boolean, client?: object, mint?: Function, log?: Function}} o
 * @returns {Promise<{status: string, pr?: number, commit?: string}>}
 */
export async function deliver({ out, baseSha, owner = 'isokron-ai', env = process.env, dryRun = false, client, mint, log = () => {} }) {
  const dataDir = join(out, 'data');
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const paths = report.files_changed;
  if (!Array.isArray(paths)) throw new Error('report.json has no files_changed');
  if (paths.length === 0) return { status: 'nothing_to_publish' };
  const onDisk = listData(dataDir);
  if (JSON.stringify(onDisk) !== JSON.stringify([...paths].sort())) throw new Error('the files in out/data are not the ones report.json lists');
  const files = paths.map((p) => {
    if (!/^(manifest\.json|corrections\.jsonl|results\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}\.jsonl)$/.test(p)) throw new Error(`refusing a path outside the data layout: ${p}`);
    return { path: `data/${p}`, content: readFileSync(join(dataDir, p), 'utf8') };
  });
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('--base-sha must be a full commit id');
  if (dryRun) {
    log(`deliver: dry run: would open or update ${BRANCH} on ${owner}/${TARGET_REPO} with ${files.length} file(s)`);
    return { status: 'dry_run' };
  }

  let token;
  try {
    ({ token } = await (mint ?? appTokenMinter({ env }))({ repositories: [TARGET_REPO], permissions: PERMISSIONS }));
  } catch (err) {
    throw new Error(`the GitHub App could not be given contents: write and pull_requests: write on ${TARGET_REPO}: ${String(err?.message ?? err).slice(0, 300)}. The owner has to grant those permissions to the App and install it on ${TARGET_REPO} (docs/PUBLISHING.md); nothing was created.`);
  }
  const gh = client ?? createClient({ token, userAgent: 'isokron-tool-qa-publish-results', ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
  const repo = `${owner}/${TARGET_REPO}`;
  const get = (path, opts) => gh.request('GET', path, opts);

  const main = (await get(`/repos/${repo}/git/ref/heads/main`)).data.object.sha;
  if (main !== baseSha) throw new Error(`main of ${repo} moved (${baseSha.slice(0, 12)} to ${main.slice(0, 12)}) since the files were built; nothing written, the next run starts from the new main`);
  // The branch is ours to replace, but not over someone's own push to it.
  const existing = await get(`/repos/${repo}/git/ref/heads/${BRANCH}`, { allow: [404] });
  if (existing.status !== 404) {
    const head = (await get(`/repos/${repo}/git/commits/${existing.data.object.sha}`)).data;
    if (!String(head.message ?? '').includes(TRAILER)) throw new Error(`${BRANCH} holds a commit this publisher did not make (${String(existing.data.object.sha).slice(0, 12)}); it is left alone. Delete or merge the branch, then run again`);
  }
  const baseTree = (await get(`/repos/${repo}/git/commits/${main}`)).data.tree.sha;
  const tree = (await gh.request('POST', `/repos/${repo}/git/trees`, {
    body: { base_tree: baseTree, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) },
  })).data.sha;
  const made = (await gh.request('POST', `/repos/${repo}/git/commits`, {
    body: { message: `Results: ${report.records_added} new record(s)\n\n${TRAILER}`, tree, parents: [main] },
  })).data;
  let verified = made.verification?.verified === true;
  if (!verified) verified = (await get(`/repos/${repo}/git/commits/${made.sha}`)).data.verification?.verified === true;
  if (!verified) throw new Error(`commit ${made.sha} is not verified; ${BRANCH} was not moved`);

  if (existing.status === 404) await gh.request('POST', `/repos/${repo}/git/refs`, { body: { ref: `refs/heads/${BRANCH}`, sha: made.sha } });
  else await gh.request('PATCH', `/repos/${repo}/git/refs/heads/${BRANCH}`, { body: { sha: made.sha, force: true } });

  const open = (await get(`/repos/${repo}/pulls`, { query: { head: `${owner}:${BRANCH}`, state: 'open' } })).data;
  const body = prBody(report);
  if (Array.isArray(open) && open.length) {
    await gh.request('PATCH', `/repos/${repo}/pulls/${open[0].number}`, { body: { body } });
    return { status: 'updated', pr: open[0].number, commit: made.sha };
  }
  const pr = (await gh.request('POST', `/repos/${repo}/pulls`, {
    body: { title: 'Results: refresh', head: BRANCH, base: 'main', body },
  })).data;
  return { status: 'opened', pr: pr.number, commit: made.sha };
}

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--base-sha') o.baseSha = argv[++i];
    else if (a === '--base-sha-file') o.baseSha = readFileSync(argv[++i], 'utf8').trim();
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.out || !o.baseSha) throw new Error('--out and --base-sha are required');
  return o;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  let o;
  try { o = parseArgs(argv); } catch (err) {
    process.stderr.write(`deliver: ${err.message}\n`);
    return 2;
  }
  const say = (line) => process.stderr.write(`${scrub(line, [env.APP_PRIVATE_KEY, env.GITHUB_TOKEN])}\n`);
  try {
    const r = await deliver({ ...o, owner: env.GITHUB_REPOSITORY_OWNER || 'isokron-ai', env, log: say, ...deps });
    say(`deliver: ${r.status}${r.pr ? ` (pull request #${r.pr})` : ''}`);
    return 0;
  } catch (err) {
    say(`deliver: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
