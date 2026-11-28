// The runners of lead-repro (scripts/lead-repro.mjs, .github/workflows/lead-repro.yml): each runs a lead's fixture
// through the lane's own code at its pinned version, and turns what came out into the loop's own failure
// fingerprints (state/fingerprint.mjs leadFailures), so "reproduced" means the same class, component and signature
// the loop records, not a look-alike.
//
//   scan-static      mcp-check's corpus/scan-static.mjs scanSubject() and buildBundle() at the pinned commit, with
//                    the fixture served as a GitHub repository by a local fetch (the lane reads repositories
//                    through the GitHub API and raw.githubusercontent.com; nothing leaves the runner)
//   writecheck-init  mcp-writecheck's CLI `init` at the pinned commit against the fixture's start command, and
//                    mcp-writecheck-action's loop/skips.mjs (stagesRan, itemSkips) at its pin for what the lane
//                    makes of it; no sandbox (the fixture is our own code), init only
//   release-diff     this repository's meta/release-diff.mjs collectSubject() (release-diff's pin is our own
//                    version), over local stand-ins for the registry, git refs and codeload
//
// Only our own fixtures run here. Nothing is named but the fixture's own placeholder repository.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { itemFromBundle, leadFailures } from '../state/fingerprint.mjs';
import { langPart } from './repro.mjs';

/** The placeholder repository the fixtures are served as (mcp-check's own fixture fetch serves this name). */
export const FIXTURE_REPO = 'isokron-fixture/known-answer';
export const FIXTURE_SHA = 'f'.repeat(40);
/** The release fixture's repository and commits. */
export const RELEASE_REPO = 'isokron-fixture/lead-fixture';
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
/** writecheck's step time limit for a CLI stage (mcp-writecheck-action loop/run-items.mjs MS.step). */
export const WRITECHECK_STEP_MS = 150_000;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sha512i = (b) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

/** Write [path, text] pairs under a fresh folder; returns the folder. */
export function writeFixture(files, root = mkdtempSync(join(tmpdir(), 'lead-repro-'))) {
  for (const [p, text] of files) {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new Error(`a fixture path is not a plain relative path: ${p}`);
    const f = join(root, ...p.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  return root;
}

/**
 * The verdict of a run, from the lead and the failures the loop's own code finds in what the run produced:
 * reproduced when one of them has the lead's class, component and signature.
 */
export function verdictOf(lead, observed) {
  const hit = observed.find((f) => f.class === lead.class && f.component === lead.component && f.signature === lead.signature) ?? null;
  return {
    verdict: hit ? 'reproduced' : 'not_reproduced',
    same_fingerprint: observed.some((f) => f.fingerprint === lead.fingerprint),
    matched: hit ? { fingerprint: hit.fingerprint, idiom: hit.idiom, layout: hit.layout } : null,
  };
}

/** Failures as the report lists them: shape columns only. */
const shapeList = (fs) => (fs ?? []).map((f) => ({ fingerprint: f.fingerprint, lane: f.lane, component: f.component, class: f.class, signature: f.signature, idiom: f.idiom, layout: f.layout, fault: f.fault }));
/** The lead's repository language, as the seed would give it to the fingerprint (`repo:<lang>` in its idiom). */
const langOfLead = (lead) => () => { const l = langPart(lead.idiom); return l && l !== 'unknown' ? l : null; };

// ------------------------------------------------------------------ scan-static

/** A fetch that serves `dir` as the GitHub repository FIXTURE_REPO: the repository and branch, then mcp-check's own fixture fetch. */
export function fixtureGitHub(dir, mcpCheckFixtureFetch) {
  const inner = mcpCheckFixtureFetch(dir);
  const api = 'https://api.github.com';
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url, init) => {
    const u = String(url);
    if (u === `${api}/repos/${FIXTURE_REPO}`) return json({ full_name: FIXTURE_REPO, default_branch: 'main', private: false, disabled: false, archived: false, fork: false });
    if (u === `${api}/repos/${FIXTURE_REPO}/branches/main`) return json({ name: 'main', commit: { sha: FIXTURE_SHA, commit: { committer: { date: '2026-01-01T00:00:00Z' } } } });
    return inner(u, init);
  };
}

export async function runScanStatic(lead, files, { mcpCheckDir, mcpCheckCommit }) {
  const M = await import(pathToFileURL(join(mcpCheckDir, 'corpus', 'scan-static.mjs')).href);
  const dir = writeFixture(files);
  try {
    const scan = await M.scanSubject(FIXTURE_REPO, { fetch: fixtureGitHub(dir, M.fixtureFetch) });
    const at = new Date().toISOString();
    const { files: out, meta } = M.buildBundle({ item: { subject: FIXTURE_REPO, repo: FIXTURE_REPO }, scan, controls: [], startedAt: at, finishedAt: at, commit: mcpCheckCommit });
    const item = itemFromBundle({ manifest: meta, files: new Map(Object.entries(out).map(([p, t]) => [p, Buffer.from(t)])), lane: 'scan-static' });
    const observed = leadFailures(item, { langOf: langOfLead(lead) }) ?? [];
    return { ...verdictOf(lead, observed), observed: shapeList(observed), detail: { status: scan.status, scan_detail: scan.detail, tool_count: scan.grade?.tool_count ?? null, list: scan.list ?? null } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ writecheck init

const which = (cmd) => { const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

/** The start command for a fixture folder: our templates' own (src/index.ts or server.py). */
export function startCommand(dir) {
  if (existsSync(join(dir, 'src', 'index.ts'))) return [process.execPath, '--experimental-strip-types', 'src/index.ts'];
  if (existsSync(join(dir, 'server.py'))) return [which('python3') ?? 'python3', 'server.py'];
  return null;
}

export async function runWritecheckInit(lead, files, spec, { cliMain, cliCommit, actionDir, actionCommit }) {
  const S = await import(pathToFileURL(join(actionDir, 'loop', 'skips.mjs')).href);
  const root = writeFixture(files);
  try {
    const dir = join(root, ...spec.dir.split('/').filter((s) => s !== '.'));
    const install = { ok: true, steps: [] };
    // The fixture's declared dependencies, as the lane's install would give them (no install scripts).
    if (existsSync(join(dir, 'package.json'))) {
      const r = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
      install.steps.push({ name: 'npm install', exit: r.status, timed_out: r.error?.code === 'ETIMEDOUT' });
      if (r.status !== 0) install.ok = false;
    }
    const cmd = startCommand(dir);
    if (!cmd) return { verdict: 'error', error: 'no start command for this fixture (no src/index.ts or server.py)', observed: [] };
    const t0 = Date.now();
    const r = install.ok
      ? spawnSync(process.execPath, [cliMain, 'init', '--out', join(root, 'init-draft.yaml'), '--', ...cmd], { cwd: dir, encoding: 'utf8', timeout: WRITECHECK_STEP_MS, env: { ...process.env, NO_COLOR: '1' } })
      : null;
    const steps = r ? [{ step: 'init', exit: r.status, timed_out: r.error?.code === 'ETIMEDOUT', ms: Date.now() - t0 }] : [];
    const serverLog = r ? `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-64 * 1024) : '';
    const stages = { install: install.ok, init: false, plan: false, catalog: false, full: false, ...S.stagesRan(steps) };
    // lead-repro runs init only: plan and catalog are said to be not run, and only the init stage is compared.
    const res = { error: null, install: { ok: install.ok, timed_out: install.steps.some((s) => s.timed_out) }, steps, fullRan: false };
    const { skips, notes } = S.itemSkips({ resolved: {}, res, unit: { init: true, full: false }, stages, evidenceComplete: true, installLog: '', serverLog });
    const item = {
      subject: RELEASE_REPO, lane: 'writecheck', tools: [`mcp-writecheck@${cliCommit}`, `mcp-writecheck-action@${actionCommit}`], skips: skips.filter((s) => s.stage === 'install' || s.stage === 'init'),
      results: new Map(), scan: null,
    };
    const observed = leadFailures(item, { langOf: langOfLead(lead) }) ?? [];
    return { ...verdictOf(lead, observed), observed: shapeList(observed), detail: { install: install.steps, init: steps[0] ?? null, stage_detail: notes.stage_detail ?? null } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ release-diff

/** git smart-HTTP pkt-lines. */
const pkt = (lines) => Buffer.from(lines.map((l) => (Buffer.byteLength(`${l}\n`) + 4).toString(16).padStart(4, '0') + `${l}\n`).join('') + '0000');

/** A fetch over a route list (prefix match, first wins); anything else is 404. */
function routesFetch(routes) {
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const r = routes.find((x) => (x.method ?? 'GET') === method && String(url).startsWith(x.prefix));
    if (!r) return new Response('not found', { status: 404 });
    const body = Buffer.isBuffer(r.body) ? r.body : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
}

/**
 * The release world of a fixture: the files published as the template's package (a PyPI sdist or an npm tarball)
 * at version 0.0.1, tag v0.0.1 at commit C, and the source archive at C. A spec with an over-the-cap entry adds it
 * where the spec says (the source archive or the artifact): a header that declares more than the reader's cap.
 * Without one (an issue's fixture as filed), the release holds the files only.
 */
export async function releaseWorld(files, spec) {
  const { makeTgz } = await import('../test/archive-fixtures.mjs');
  const r = spec.release ?? { ecosystem: spec.key === 'ts' ? 'npm' : 'pypi', name: 'lead-fixture', version: '0.0.1', tag: 'v0.0.1', over_cap: null };
  const big = (top, where) => (r.over_cap && r.over_cap.where === where ? [{ name: `${top}/${r.over_cap.path}`, declaredSize: r.over_cap.declared_bytes, data: '' }] : []);
  const tgz = (top, extra, where) => {
    const entries = [...files.map(([p, d]) => ({ name: `${top}/${p}`, data: d })), ...extra, ...big(top, where)];
    return makeTgz(entries, { end: !(r.over_cap && r.over_cap.where === where) });
  };
  const name = RELEASE_REPO.split('/')[1];
  const source = tgz(`${name}-${C}`, [], 'source');
  const gh = `https://github.com/${RELEASE_REPO}`;
  const routes = [{ prefix: `https://codeload.github.com/${RELEASE_REPO}/tar.gz/${C}`, body: source }];
  if (r.ecosystem === 'pypi') {
    const sdist = tgz(`${r.name}-${r.version}`, [{ name: `${r.name}-${r.version}/PKG-INFO`, data: `Metadata-Version: 2.4\nName: ${r.name}\nVersion: ${r.version}\n` }], 'artifact');
    const file = `${r.name}-${r.version}.tar.gz`;
    routes.push(
      { prefix: `https://pypi.org/pypi/${r.name}/json`, body: { info: { name: r.name, version: r.version, project_urls: { Source: gh } }, urls: [{ filename: file, packagetype: 'sdist', size: sdist.length, digests: { sha256: sha256(sdist) }, url: `https://files.pythonhosted.org/packages/aa/${file}` }] } },
      { prefix: 'https://files.pythonhosted.org/packages/aa/', body: sdist },
      { method: 'POST', prefix: `${gh}.git/git-upload-pack`, body: pkt([`${C} refs/tags/${r.tag}`]) },
    );
  } else {
    const tarball = tgz('package', [], 'artifact');
    const url = `https://registry.npmjs.org/${r.name}/-/${r.name}-${r.version}.tgz`;
    routes.push(
      { prefix: `https://registry.npmjs.org/${r.name}/latest`, body: { name: r.name, version: r.version, gitHead: C, repository: { url: `git+${gh}.git` }, dist: { tarball: url, integrity: sha512i(tarball) } } },
      { prefix: `https://registry.npmjs.org/${r.name}/-/`, body: tarball },
      { method: 'POST', prefix: `${gh}.git/git-upload-pack`, body: pkt([`${C} HEAD symref-target:refs/heads/main`, `${D} refs/tags/${r.tag} peeled:${C}`]) },
    );
  }
  return { fetch: routesFetch(routes), seed: new Map([[RELEASE_REPO.toLowerCase(), [{ registry: r.ecosystem, identifier: r.name }]]]) };
}

export async function runReleaseDiff(lead, files, spec, { pin }) {
  const RD = await import('../meta/release-diff.mjs');
  const { createCache, createHttp } = await import('../meta/lib/http.mjs');
  if (pin && pin !== RD.VERSION) return { verdict: 'error', error: `release-diff here is ${RD.VERSION}, the lane pins ${pin}`, observed: [] };
  const world = await releaseWorld(files, spec);
  const http = createHttp({ fetch: world.fetch, cache: createCache(), retries: 0, sleep: async () => {} });
  const c = await RD.collectSubject(http, RELEASE_REPO, { seed: world.seed });
  const item = { subject: RELEASE_REPO, lane: 'release-diff', tools: [`tool-qa-release-diff@${RD.VERSION}`], skips: c.skips, results: new Map(), scan: null };
  const observed = leadFailures(item, { langOf: langOfLead(lead) }) ?? [];
  return { ...verdictOf(lead, observed), observed: shapeList(observed), detail: { skips: c.skips, outcomes: (c.artifacts ?? []).map((a) => a.outcome) } };
}

/**
 * Run one fixture with the spec's runner. Never throws: a failure of the harness is verdict `error`.
 * @param {object} lead  shape columns
 * @param {Array<[string, string]>} files
 * @param {object} spec  leads/repro.mjs reproSpec(lead)
 * @param {object} tools  { mcpCheckDir, mcpCheckCommit, cliMain, cliCommit, actionDir, actionCommit, releaseDiffPin }
 */
export async function runRepro(lead, files, spec, tools = {}) {
  if (!spec.synthesizable) return { verdict: 'not_reproducible_synthetically', why: spec.why, observed: [] };
  if (!files.length) return { verdict: 'error', error: 'no fixture files', observed: [] };
  try {
    if (spec.runner === 'scan-static') {
      if (!tools.mcpCheckDir) return { verdict: 'error', error: 'mcp-check is not fetched', observed: [] };
      return await runScanStatic(lead, files, tools);
    }
    if (spec.runner === 'writecheck-init') {
      if (!tools.cliMain || !tools.actionDir) return { verdict: 'error', error: 'mcp-writecheck or mcp-writecheck-action is not fetched', observed: [] };
      return await runWritecheckInit(lead, files, spec, tools);
    }
    if (spec.runner === 'release-diff') return await runReleaseDiff(lead, files, spec, { pin: tools.releaseDiffPin });
    return { verdict: 'error', error: `no runner ${spec.runner}`, observed: [] };
  } catch (err) {
    return { verdict: 'error', error: String(err?.stack ?? err?.message ?? err).slice(0, 2000), observed: [] };
  }
}
