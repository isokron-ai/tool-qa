// release-diff: is what a subject publishes what its source says?
//
// For one subject (a GitHub owner/name):
//   packages     the npm and PyPI packages that claim the repository: those
//                the subject's own official MCP registry entries declare, the
//                seed list's (history/seed-v1.json), those deps.dev links to
//                the repository (attested links first), then those other
//                registry entries declare; at most three per ecosystem;
//   release      each package's latest version (a pinned one for the
//                known-answer control): npm's tarball from registry.npmjs.org;
//                PyPI's sdist and one wheel from files.pythonhosted.org;
//   provenance   npm SLSA provenance and PyPI PEP 740 attestations, checked
//                as live-probe checks them (lib/provenance.mjs), with the
//                commit they were built from;
//   tags         the repository's tags over Git's smart HTTP (lib/gitrefs.mjs);
//                the tag for the version, and whether it names the commit the
//                provenance or npm's gitHead names;
//   source       the source tree at the tag's commit (or, with no tag, the
//                provenance commit, then gitHead) from codeload.github.com;
//   diff         every file of the artifact against that tree (lib/diff.mjs).
//
// Hard rules: nothing from an artifact or the source is installed, imported or
// run. Both are read with our own archive readers (scripts/lib/untar.mjs,
// scripts/lib/unzip.mjs) in memory, with path, link, count and size caps;
// nothing is written to disk. Every request goes over HTTPS to ALLOWED_HOSTS,
// and downloads never follow a redirect. Anything that looks malicious goes to
// release_diff_held (class S, private) with rule ids only, and is left out of
// every public record and count.

import { createHash } from 'node:crypto';

import { FetchProblem, readBytesCapped } from './lib/http.mjs';
import { readGitRefs } from './lib/gitrefs.mjs';
import { npmProvenance, pypiProvenance } from './lib/provenance.mjs';
import { compareArtifact, indexByBase } from './lib/diff.mjs';
import { createSourceIndex, looksText } from './lib/indicators.mjs';
import { githubRepoOf, record, str, int } from './lib/common.mjs';
import { namespaceMatches, registryEntries } from './registry.mjs';
import { ArchiveError, ArchiveLimit, readTarGz } from '../scripts/lib/untar.mjs';
import { readZipLenient } from '../scripts/lib/unzip.mjs';
import { safeArchivePath } from '../scripts/lib/untar.mjs';

export const LANE = 'release-diff';
export const VERSION = '1.0.0';

const NPM = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org';
const DEPSDEV_ALPHA = 'https://api.deps.dev/v3alpha';
export const ALLOWED_HOSTS = Object.freeze([
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'codeload.github.com',
  'api.deps.dev', 'registry.modelcontextprotocol.io',
]);

export const LIMITS = Object.freeze({
  packagesPerEcosystem: 3,
  commitsPerSubject: 4,
  downloadTimeoutMs: 120_000,
  // No new download starts once a subject has used this much time.
  subjectBudgetMs: 360_000,
  artifact: { maxCompressedBytes: 64 * 1024 ** 2, maxInflatedBytes: 256 * 1024 ** 2, maxEntries: 20_000, maxKeptEntryBytes: 16 * 1024 ** 2, maxKeptTotalBytes: 256 * 1024 ** 2, maxMetaBytes: 1024 ** 2 },
  source: { maxCompressedBytes: 128 * 1024 ** 2, maxInflatedBytes: 1024 ** 3, maxEntries: 100_000, maxKeptEntryBytes: 2 * 1024 ** 2, maxKeptTotalBytes: 256 * 1024 ** 2, maxMetaBytes: 1024 ** 2 },
});

export const SETTINGS = Object.freeze({
  lane: LANE, version: VERSION, limits: LIMITS, hosts: ALLOWED_HOSTS,
  sources: ['mcp-registry-official', 'npm-registry', 'pypi-json-api', 'pypi-integrity-api', 'deps-dev-v3alpha', 'github-git-smart-http', 'github-codeload'],
});

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]{0,213}\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+!_-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FILENAME_RE = /^[A-Za-z0-9._+!-]{1,200}$/;

const answered = (r) => r && (r.status === 200 || r.status === 304);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A source archive that did not arrive within our time limit: our limit (reader_limit), not retried. */
export class SourceTimeLimit extends Error {
  constructor() {
    super('release-diff: the source archive did not arrive within the time limit');
    this.name = 'SourceTimeLimit';
  }
}

/** Our own refusal to go somewhere: a lane bug, never data. */
export class HostRefused extends Error {
  constructor(url) {
    super('release-diff: a request to a host outside ALLOWED_HOSTS was refused');
    this.name = 'HostRefused';
    this.url = String(url).slice(0, 200);
  }
}

export function allowedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && u.port === '' && !u.username && !u.password;
}

/** The lane's HTTP: every request checked against ALLOWED_HOSTS first. */
export function guardHttp(http) {
  return {
    ...http,
    request(url, opts) { if (!allowedUrl(url)) throw new HostRefused(url); return http.request(url, opts); },
    getSummary(url, opts) { if (!allowedUrl(url)) throw new HostRefused(url); return http.getSummary(url, opts); },
  };
}

// ---------------------------------------------------------------- discovery

/** deps.dev's package versions that name the repository as their source (v3alpha). */
export async function depsdevPackagesOf(http, repo) {
  const key = encodeURIComponent(`github.com/${repo}`);
  const r = await http.getSummary(`${DEPSDEV_ALPHA}/projects/${key}:packageversions`, {
    version: 'rd-depsdev-pv/1',
    headers: { accept: 'application/json' },
    extract: (doc) => {
      const out = new Map();
      for (const v of Array.isArray(doc?.versions) ? doc.versions : []) {
        const sys = String(v?.versionKey?.system ?? '').toUpperCase();
        const name = str(v?.versionKey?.name, 214);
        if (!name || (sys !== 'NPM' && sys !== 'PYPI')) continue;
        const attested = ['SLSA_ATTESTATION', 'PYPI_PUBLISH_ATTESTATION'].includes(String(v?.relationProvenance ?? ''));
        const k = `${sys === 'NPM' ? 'npm' : 'pypi'}\n${name}`;
        out.set(k, (out.get(k) ?? false) || attested);
      }
      return [...out].map(([k, attested]) => ({ ecosystem: k.split('\n')[0], name: k.split('\n')[1], attested }));
    },
  });
  if (answered(r)) return r.value;
  if (r.status === 404) return [];
  throw new FetchProblem('upstream_unavailable', `api.deps.dev: HTTP ${r.status}`);
}

/**
 * The packages to read, at most `per` per ecosystem, in order: the subject's
 * own registry entries, the seed list, deps.dev attested links, other deps.dev
 * links, then other registry entries (so others cannot crowd the subject out).
 */
export function choosePackages({ servers = new Map(), seed = [], depsdev = [], repo, per = LIMITS.packagesPerEcosystem }) {
  const want = { npm: [], pypi: [] };
  const push = (eco, name, source) => {
    const e = eco === 'cargo' ? null : eco;
    if (!e || !want[e] || !name) return;
    const valid = e === 'npm' ? NPM_NAME.test(name) : PYPI_NAME.test(name);
    if (!valid) return;
    const key = e === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
    const cur = want[e].find((p) => p.key === key);
    if (cur) { if (!cur.sources.includes(source)) cur.sources.push(source); return; }
    want[e].push({ ecosystem: e, name, key, sources: [source] });
  };
  const newest = (versions) => versions.find((v) => v.is_latest) ?? versions.at(-1);
  const entries = [...servers];
  for (const [name, versions] of entries) if (namespaceMatches(name, repo) === true) for (const p of newest(versions)?.packages ?? []) push(p.registry_type, p.identifier, 'mcp_registry_own');
  for (const p of seed) push(p.registry, p.identifier, 'seed');
  for (const d of depsdev.filter((x) => x.attested)) push(d.ecosystem, d.name, 'depsdev_attested');
  for (const d of depsdev.filter((x) => !x.attested)) push(d.ecosystem, d.name, 'depsdev');
  for (const [name, versions] of entries) if (namespaceMatches(name, repo) !== true) for (const p of newest(versions)?.packages ?? []) push(p.registry_type, p.identifier, 'mcp_registry_other');
  return [...want.npm.slice(0, per), ...want.pypi.slice(0, per)];
}

// ---------------------------------------------------------------- tags

/**
 * The tag for a version. Strong matches name the version alone (v1.2.3,
 * 1.2.3) or with the package's name or folder (name@1.2.3, name-v1.2.3,
 * folder/v1.2.3, release-1.2.3) or the ecosystem (py-v1.2.3, js-v1.2.3). A tag that only ends in the version after a
 * separator is weak: it is used only when a commit from provenance or gitHead
 * confirms it.
 * @returns {{name: string, match: string, commit: string, annotated: boolean}|null}
 */
const ECOSYSTEM_TAG_PREFIXES = Object.freeze({ npm: ['js', 'npm', 'ts', 'node', 'javascript', 'typescript'], pypi: ['py', 'python', 'pypi'] });

export function resolveTag(tags, { name, version, folder = null, ecosystem = null }) {
  if (!tags || !version) return null;
  const v = version;
  const unscoped = name.replace(/^@[^/]+\//, '');
  const names = [...new Set([name, unscoped, unscoped.toLowerCase(), unscoped.replace(/_/g, '-'), unscoped.replace(/-/g, '_'), folder].filter(Boolean))];
  const exact = [`v${v}`, v];
  const prefixed = [];
  for (const n of names) prefixed.push(`${n}@${v}`, `${n}@v${v}`, `${n}-v${v}`, `${n}-${v}`, `${n}/v${v}`, `${n}/${v}`, `${n}_v${v}`, `${n}.v${v}`);
  prefixed.push(`release-${v}`, `release-v${v}`, `release/v${v}`, `release/${v}`, `version-${v}`, `rel-${v}`);
  // A repository that publishes one package per language: py-v1.2.3, js-v1.2.3.
  const eco = [];
  for (const n of ECOSYSTEM_TAG_PREFIXES[ecosystem] ?? []) eco.push(`${n}-v${v}`, `${n}-${v}`, `${n}/v${v}`, `${n}/${v}`, `${n}@${v}`);
  const hit = (list, match) => {
    for (const t of list) if (tags.has(t)) return { name: t, match, ...tags.get(t) };
    return null;
  };
  const strong = hit(exact, 'exact') ?? hit(prefixed, 'name_prefixed') ?? hit(eco, 'ecosystem_prefixed');
  if (strong) return strong;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[-/@_.])v?${esc}$`);
  const weak = [...tags.keys()].filter((t) => re.test(t)).sort();
  if (weak.length === 0) return null;
  return { name: weak[0], match: weak.length > 1 ? 'weak_ambiguous' : 'weak', ...tags.get(weak[0]), others: weak.length - 1 };
}

// ---------------------------------------------------------------- releases

async function npmRelease(http, name, version, repo) {
  const url = `${NPM}/${name.replace('/', '%2F')}/${version ? encodeURIComponent(version) : 'latest'}`;
  const r = await http.getSummary(url, {
    version: 'rd-npm-version/1',
    headers: { accept: 'application/json' },
    extract: (d) => ({
      name: str(d?.name, 214),
      version: typeof d?.version === 'string' && VERSION_RE.test(d.version) ? d.version : null,
      tarball: typeof d?.dist?.tarball === 'string' ? d.dist.tarball : null,
      integrity: typeof d?.dist?.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(d.dist.integrity) ? d.dist.integrity : null,
      attestations_url: typeof d?.dist?.attestations?.url === 'string' ? d.dist.attestations.url : null,
      git_head: typeof d?.gitHead === 'string' && SHA_RE.test(d.gitHead) ? d.gitHead : null,
      repository: githubRepoOf(typeof d?.repository === 'string' ? d.repository : d?.repository?.url),
      directory: typeof d?.repository?.directory === 'string' ? safeArchivePath(d.repository.directory) : null,
    }),
  });
  if (!answered(r)) return { status: r.status === 404 ? 'not_found' : `http_${r.status}` };
  const v = r.value;
  let provenance = { present: false, verified: false, why: 'no_provenance', signer: null, commit: null, ref: null };
  if (v.attestations_url) {
    if (!v.attestations_url.startsWith(`${NPM}/-/npm/v1/attestations/`)) provenance = { ...provenance, why: 'attestations_elsewhere' };
    else {
      const a = await http.getSummary(v.attestations_url, {
        cacheKey: `${v.attestations_url}#${repo.toLowerCase()}`,
        version: 'rd-npm-provenance/1',
        headers: { accept: 'application/json' },
        extract: (doc) => npmProvenance(doc, { name: v.name ?? name, version: v.version, integrity: v.integrity, repo }),
      });
      if (answered(a)) provenance = a.value;
      else if (a.status !== 404) throw new FetchProblem('upstream_unavailable', `registry.npmjs.org: attestations HTTP ${a.status}`);
    }
  }
  return { status: 'ok', value: { ...v, provenance } };
}

async function pypiRelease(http, name, version, repo) {
  const norm = name.toLowerCase().replace(/[-_.]+/g, '-');
  const r = await http.getSummary(`${PYPI}/pypi/${norm}/${version ? `${encodeURIComponent(version)}/` : ''}json`, {
    version: 'rd-pypi-json/1',
    headers: { accept: 'application/json' },
    extract: (d) => ({
      name: str(d?.info?.name, 200),
      version: typeof d?.info?.version === 'string' && VERSION_RE.test(d.info.version) ? d.info.version : null,
      repositories: [...new Set([...Object.values(d?.info?.project_urls && typeof d.info.project_urls === 'object' ? d.info.project_urls : {}), d?.info?.home_page]
        .map((u) => githubRepoOf(u)).filter(Boolean))].slice(0, 20),
      files: (Array.isArray(d?.urls) ? d.urls : []).slice(0, 200).map((f) => ({
        filename: typeof f?.filename === 'string' && FILENAME_RE.test(f.filename) ? f.filename : null,
        packagetype: str(f?.packagetype, 32),
        size: int(f?.size),
        sha256: typeof f?.digests?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.digests.sha256) ? f.digests.sha256 : null,
        url: typeof f?.url === 'string' ? f.url : null,
        yanked: f?.yanked === true,
      })).filter((f) => f.filename && f.sha256 && f.url),
    }),
  });
  if (!answered(r)) return { status: r.status === 404 ? 'not_found' : `http_${r.status}` };
  const v = r.value;
  const sdist = v.files.find((f) => f.packagetype === 'sdist' && /\.(?:tar\.gz|zip)$/.test(f.filename));
  const wheels = v.files.filter((f) => f.packagetype === 'bdist_wheel' && f.filename.endsWith('.whl'));
  const wheel = wheels.find((f) => /-(?:py3|py2\.py3)-none-any\.whl$/.test(f.filename)) ?? wheels[0];
  const files = [sdist, wheel].filter(Boolean);
  for (const f of files) {
    const url = `${PYPI}/integrity/${encodeURIComponent(norm)}/${encodeURIComponent(v.version)}/${encodeURIComponent(f.filename)}/provenance`;
    const a = await http.getSummary(url, {
      cacheKey: `${url}#${repo.toLowerCase()}`,
      version: 'rd-pypi-provenance/1',
      headers: { accept: 'application/json' },
      extract: (doc) => pypiProvenance(doc, { filename: f.filename, sha256: f.sha256, repo }),
    });
    if (answered(a)) f.provenance = a.value;
    else if (a.status === 404) f.provenance = { present: false, verified: false, why: 'no_provenance', signer: null, commit: null, ref: null };
    else throw new FetchProblem('upstream_unavailable', `pypi.org: integrity HTTP ${a.status}`);
  }
  return { status: 'ok', value: { ...v, sdist: sdist ?? null, wheel: wheel ?? null, wheels: wheels.length } };
}

/** Download one artifact: the allowed registry host only, no redirect, the size cap, then the registry's digest. */
async function download(http, url, { prefix, cap, digest }) {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return { status: 'url_elsewhere' };
  const res = await http.request(url, { redirect: 'manual', timeoutMs: LIMITS.downloadTimeoutMs });
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 410) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'redirected' };
    throw new FetchProblem('upstream_unavailable', `${new URL(url).hostname}: HTTP ${res.status}`);
  }
  const buf = await readBytesCapped(res, cap, new URL(url).hostname);
  if (!digest(buf)) return { status: 'integrity_mismatch' };
  return { status: 'ok', buf };
}

/** Drop a single top folder every path shares (npm's package/, an sdist's name-version/). */
export function stripTop(files) {
  const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  if (tops.size !== 1 || tops.has('')) return { files, top: null };
  const top = [...tops][0];
  const out = new Map();
  for (const [p, f] of files) out.set(p.slice(top.length + 1), { ...f, path: p.slice(top.length + 1) });
  return { files: out, top };
}

function stripLinks(list, top) {
  return top ? list.map((l) => ({ ...l, path: l.path?.startsWith(`${top}/`) ? l.path.slice(top.length + 1) : l.path })) : list;
}

/** Read an artifact's archive in memory. */
export async function readArtifact(buf, kind, filename = '') {
  if (kind === 'wheel' || filename.endsWith('.zip')) {
    let z;
    try {
      z = readZipLenient(buf, { maxEntries: LIMITS.artifact.maxEntries, maxTotalBytes: LIMITS.artifact.maxInflatedBytes });
    } catch (err) {
      if (/entries is more than/.test(err?.message ?? '')) throw new ArchiveLimit('the wheel has too many entries');
      throw new ArchiveError(err?.message ?? 'zip unreadable');
    }
    const files = new Map();
    const links = [];
    const duplicates = [];
    for (const e of z.entries) {
      const path = safeArchivePath(e.name);
      if (!path) { z.refused.push({ name: e.name, reason: 'unsafe_path' }); continue; }
      if ((e.mode & 0o170000) === 0o120000) { links.push({ path, type: 'symlink', target: '' }); continue; }
      if (files.has(path)) duplicates.push(path);
      files.set(path, { path, size: e.data.length, mode: e.mode & 0o7777, sha256: sha256(e.data), data: e.data });
    }
    // An entry refused for our inflated-size cap makes the whole artifact too large for us, not unsafe.
    if (z.refused.some((r) => /once inflated/.test(r.reason))) throw new ArchiveLimit('the wheel inflates past the cap');
    const refused = z.refused.map((r) => ({ name: String(r.name).slice(0, 300), reason: /unsafe/.test(r.reason) ? 'unsafe_path' : 'unreadable' }));
    const s = kind === 'wheel' ? { files, top: null } : stripTop(files);
    return { files: s.files, archive: { links: stripLinks(links, s.top), refused, duplicates: [...new Set(duplicates)], others: [] }, top: s.top };
  }
  const t = await readTarGz(buf, { keep: () => true, limits: LIMITS.artifact });
  const s = stripTop(t.files);
  return { files: s.files, archive: { links: stripLinks(t.links, s.top), refused: t.refused, duplicates: t.duplicates, others: stripLinks(t.others, s.top) }, top: s.top };
}

const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'binding.gyp']);

/**
 * The source tree at a commit, from codeload.github.com. Every text file up
 * to 2 MiB feeds the source index (what strong indicators the source itself
 * has); bytes are kept only for files whose name an artifact also has.
 */
export async function readSourceTree(http, repo, commit, wantNames, { clock = () => Date.now() } = {}) {
  const t0 = clock();
  const res = await http.request(`https://codeload.github.com/${repo}/tar.gz/${commit}`, { redirect: 'manual', timeoutMs: LIMITS.downloadTimeoutMs });
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 422) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'redirected' };
    throw new FetchProblem('upstream_unavailable', `codeload.github.com: HTTP ${res.status}`);
  }
  const index = createSourceIndex();
  const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  let t;
  try {
    t = await readTarGz(res.body, {
      limits: LIMITS.source,
      keep: () => true,
      onFile: (f) => {
        if (!f.data) return;
        if (looksText(f.data)) index.add(f.data.toString('utf8'));
        if (!wantNames.has(nameOf(f.path)) && !MANIFEST_NAMES.has(nameOf(f.path))) f.data = null;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveLimit) throw err;
    // The archive comes from GitHub over a stream: our time limit, or a cut stream.
    if (err instanceof ArchiveError) {
      if (clock() - t0 >= LIMITS.downloadTimeoutMs * 0.9) throw new SourceTimeLimit();
      throw new FetchProblem('upstream_unavailable', 'codeload.github.com: the source archive could not be read');
    }
    throw err;
  }
  const s = stripTop(t.files);
  return {
    status: 'ok',
    files: s.files,
    byBase: indexByBase([...s.files.keys()]),
    index,
    archive_commit: t.global_comment && SHA_RE.test(t.global_comment) ? t.global_comment : null,
    bytes: t.compressed_bytes,
  };
}

// ---------------------------------------------------------------- one subject

const PROBLEM_CODES = new Set(['rate_limited', 'upstream_unavailable', 'too_large']);

function problemOf(err) {
  if (err instanceof FetchProblem && PROBLEM_CODES.has(err.code)) return err.code;
  if (err instanceof ArchiveLimit) return 'too_large';
  if (err instanceof SourceTimeLimit) return 'reader_limit';
  throw err;
}

/** The skip for a problem: passing ones are retried; our own caps are ours (fault tool). */
export function skipOf(stage, code) {
  if (code === 'too_large') return { stage, reason: 'too_large', fault: 'tool' };
  if (code === 'reader_limit') return { stage, reason: 'reader_limit', fault: 'tool' };
  return { stage, reason: code === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable', retryable: true };
}

/**
 * Everything for one subject. Never throws for an upstream problem: those are
 * per stage skips. `pins` maps "npm:<name>" / "pypi:<name>" to a version (the
 * known-answer control reads fixed releases).
 */
export async function collectSubject(rawHttp, repo, { seed = new Map(), pins = {}, clock = () => Date.now() } = {}) {
  const http = guardHttp(rawHttp);
  const t0 = clock();
  const overBudget = () => clock() - t0 > LIMITS.subjectBudgetMs;
  let budgetSkipped = false;
  const budgetSkip = () => { if (!budgetSkipped) { budgetSkipped = true; skips.push(skipOf('collect', 'reader_limit')); } };
  const stages = {};
  const skips = [];
  const artifacts = [];
  const summaries = [];
  const findings = [];
  const held = [];

  // Packages.
  let servers = new Map();
  try {
    servers = (await registryEntries(http, repo)).servers;
    stages.mcp_registry = 'ok';
  } catch (err) {
    const c = problemOf(err);
    stages.mcp_registry = c;
    skips.push(skipOf('mcp_registry', c));
  }
  let depsdev = [];
  try {
    depsdev = await depsdevPackagesOf(http, repo);
    stages.depsdev = 'ok';
  } catch (err) {
    const c = problemOf(err);
    stages.depsdev = c;
    skips.push(skipOf('depsdev', c));
  }
  const packages = choosePackages({ servers, seed: seed.get(repo.toLowerCase()) ?? [], depsdev, repo });
  stages.packages = packages.length;
  if (packages.length === 0) return { repo, stages, skips, artifacts, summaries, findings, held };

  // Tags.
  let refs = null;
  try {
    refs = await readGitRefs(http, repo);
    stages.git_refs = refs.status;
  } catch (err) {
    const c = problemOf(err);
    stages.git_refs = c;
    skips.push(skipOf('git_refs', c));
  }
  const tags = refs?.status === 'ok' ? refs.tags : null;

  // Releases.
  const jobs = []; // { art, buf? , kind, filename, folder }
  for (const p of packages) {
    const pin = pins[`${p.ecosystem}:${p.name}`] ?? null;
    let rel;
    try {
      rel = p.ecosystem === 'npm' ? await npmRelease(http, p.name, pin, repo) : await pypiRelease(http, p.name, pin, repo);
    } catch (err) {
      const c = problemOf(err);
      skips.push(skipOf(p.ecosystem, c));
      artifacts.push({ ecosystem: p.ecosystem, package: p.name, version: pin, artifact: null, sources: p.sources, outcome: 'not_read', why: c });
      continue;
    }
    if (rel.status !== 'ok') {
      artifacts.push({ ecosystem: p.ecosystem, package: p.name, version: pin, artifact: null, sources: p.sources, outcome: 'release_not_found', why: rel.status });
      continue;
    }
    const v = rel.value;
    if (p.ecosystem === 'npm') {
      const linkedBy = v.provenance.verified ? 'provenance' : v.repository === repo.toLowerCase() ? 'repository_field' : p.sources.includes('depsdev_attested') ? 'depsdev_attestation' : null;
      const tag = resolveTag(tags, { name: v.name ?? p.name, version: v.version, folder: v.directory ? v.directory.split('/').pop() : null, ecosystem: 'npm' });
      jobs.push({
        p, kind: 'npm_tarball', filename: null, url: v.tarball, size: null, version: v.version, linkedBy, tag,
        provenance: v.provenance, gitHead: v.git_head, folder: v.directory ? `${v.directory}/` : null,
        download: { prefix: `${NPM}/`, cap: LIMITS.artifact.maxCompressedBytes, digest: (b) => v.integrity !== null && `sha512-${createHash('sha512').update(b).digest('base64')}` === v.integrity },
      });
    } else {
      const linked = v.repositories.includes(repo.toLowerCase());
      for (const [kind, f] of [['sdist', v.sdist], ['wheel', v.wheel]]) {
        if (!f) continue;
        const linkedBy = f.provenance?.verified ? 'provenance' : linked ? 'project_urls' : p.sources.includes('depsdev_attested') ? 'depsdev_attestation' : null;
        jobs.push({
          p, kind, filename: f.filename, url: f.url, size: f.size, version: v.version, linkedBy, tag: resolveTag(tags, { name: v.name ?? p.name, version: v.version, ecosystem: 'pypi' }),
          provenance: f.provenance, gitHead: null, folder: null, yanked: f.yanked,
          download: { prefix: 'https://files.pythonhosted.org/packages/', cap: LIMITS.artifact.maxCompressedBytes, digest: (b) => sha256(b) === f.sha256 },
        });
      }
      if (!v.sdist && !v.wheel) artifacts.push({ ecosystem: 'pypi', package: p.name, version: v.version, artifact: null, sources: p.sources, outcome: 'no_files' });
    }
  }

  // Basis per job, release-level findings.
  for (const j of jobs) {
    const strong = j.tag && ['exact', 'name_prefixed', 'ecosystem_prefixed'].includes(j.tag.match);
    const prov = j.provenance?.verified ? j.provenance.commit : null;
    const confirmedWeak = j.tag && !strong && (j.tag.commit === prov || j.tag.commit === j.gitHead);
    j.basis = strong || confirmedWeak ? { kind: strong ? 'tag' : 'tag_confirmed', commit: j.tag.commit }
      : prov ? { kind: 'provenance_commit', commit: prov }
        : j.gitHead ? { kind: 'git_head', commit: j.gitHead } : null;
    const at = { package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind };
    if (tags && !strong) findings.push({ ...at, kind: 'no_matching_tag', weak_tag: j.tag ? j.tag.name : null, weak_tag_confirmed: j.tag ? !!confirmedWeak : null, level: 'low' });
    if (j.tag && prov && j.tag.commit !== prov && (strong || confirmedWeak)) {
      // Built from this very tag, yet the tag now names another commit: the tag moved after the build.
      const ref = j.provenance.ref ?? '';
      const refKind = ref === `refs/tags/${j.tag.name}` ? 'this_tag' : ref.startsWith('refs/tags/') ? 'other_tag' : ref.startsWith('refs/heads/') ? 'branch' : 'unknown';
      findings.push({ ...at, kind: 'tag_commit_differs_from_provenance', tag: j.tag.name, provenance_ref: refKind, level: refKind === 'this_tag' ? 'high' : 'medium' });
    }
    if (j.tag && j.gitHead && j.tag.commit !== j.gitHead && (strong || confirmedWeak)) findings.push({ ...at, kind: 'tag_commit_differs_from_git_head', tag: j.tag.name, level: 'medium' });
  }

  // One basis commit at a time: its artifacts, then its source tree, then the comparisons, so at most one
  // commit's bytes are held at once.
  const commits = [...new Set(jobs.filter((j) => j.linkedBy && j.basis).map((j) => j.basis.commit))];
  let treesRead = 0;
  for (const j of jobs) {
    if (!j.linkedBy) j.outcome = 'not_linked_to_subject';
    else if (refs && refs.status !== 'ok') j.outcome = 'source_repository_not_found';
    else if (!j.basis) j.outcome = 'no_source_basis';
    else if (commits.indexOf(j.basis.commit) >= LIMITS.commitsPerSubject) j.outcome = 'commit_limit';
  }
  if (jobs.some((j) => j.outcome === 'commit_limit')) skips.push(skipOf('source', 'reader_limit'));
  for (const commit of commits.slice(0, LIMITS.commitsPerSubject)) {
    const group = jobs.filter((j) => !j.outcome && j.basis?.commit === commit);
    const names = new Set();
    for (const j of group) {
      if (overBudget()) { j.outcome = 'subject_time_budget'; budgetSkip(); continue; }
      try {
        const d = await download(http, j.url, j.download);
        if (d.status !== 'ok') {
          j.outcome = d.status === 'integrity_mismatch' ? 'integrity_mismatch' : `artifact_${d.status}`;
          if (d.status === 'integrity_mismatch') skips.push(skipOf(j.p.ecosystem, 'upstream_unavailable'));
          continue;
        }
        j.bytes = d.buf.length;
        j.sha256 = sha256(d.buf);
        try {
          j.read = await readArtifact(d.buf, j.kind, j.filename ?? '');
        } catch (err) {
          if (err instanceof ArchiveLimit) throw err;
          j.outcome = 'artifact_unreadable';
          findings.push({ package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind, kind: 'artifact_unreadable', level: 'medium' });
          continue;
        }
        for (const p of j.read.files.keys()) names.add(p.slice(p.lastIndexOf('/') + 1));
      } catch (err) {
        const c = problemOf(err);
        j.outcome = c === 'too_large' ? 'too_large' : 'not_read';
        j.why = c;
        skips.push(skipOf(j.p.ecosystem, c));
      }
    }
    const ready = group.filter((j) => !j.outcome && j.read);
    if (ready.length === 0) continue;
    let t;
    if (overBudget()) {
      for (const j of ready) { j.outcome = 'subject_time_budget'; j.read = null; }
      budgetSkip();
      continue;
    }
    try {
      t = await readSourceTree(http, repo, commit, names, { clock });
      if (t.status === 'ok') treesRead++;
    } catch (err) {
      const code = problemOf(err);
      t = { status: code };
      skips.push(skipOf('source', code));
    }
    for (const j of ready) {
      if (t.status !== 'ok') {
        j.outcome = t.status === 'not_found' ? 'source_commit_not_found' : t.status === 'too_large' ? 'source_too_large' : t.status === 'reader_limit' ? 'source_time_limit' : `source_${t.status}`;
        if (t.status === 'not_found') findings.push({ package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind, kind: 'source_commit_not_found', basis: j.basis.kind, level: 'medium' });
      } else {
        const r = compareArtifact({ ecosystem: j.p.ecosystem, kind: j.kind, version: j.version, files: j.read.files, archive: j.read.archive }, t, { hint: j.folder });
        const at = { package: j.p.name, version: j.version, ecosystem: j.p.ecosystem };
        summaries.push({ ...at, ...r.summary });
        for (const f of r.findings) findings.push({ ...at, ...f });
        for (const h of r.held) held.push({ ...at, commit, ...h });
        j.outcome = 'compared';
      }
      j.read = null;
    }
  }

  for (const j of jobs) {
    artifacts.push({
      ecosystem: j.p.ecosystem,
      package: j.p.name,
      version: j.version,
      artifact: j.kind,
      filename: j.filename,
      sources: j.p.sources,
      linked_by: j.linkedBy,
      provenance: j.provenance ? { present: !!j.provenance.present, verified: !!j.provenance.verified, why: j.provenance.why ?? null, signer: j.provenance.signer ?? null, commit: j.provenance.commit ?? null, ref: j.provenance.ref ?? null } : null,
      tag: j.tag ? { name: j.tag.name, match: j.tag.match, commit: j.tag.commit, annotated: j.tag.annotated } : null,
      git_head: j.gitHead,
      basis: j.basis,
      bytes: j.bytes ?? null,
      sha256: j.sha256 ?? null,
      yanked: j.yanked ?? null,
      outcome: j.outcome,
      ...(j.why ? { why: j.why } : {}),
    });
  }
  stages.artifacts = artifacts.length;
  stages.compared = jobs.filter((j) => j.outcome === 'compared').length;
  stages.source_trees = treesRead;
  return { repo, stages, skips, artifacts, summaries, findings, held };
}

/** Observation records for one subject. */
export function subjectOutput(c) {
  const records = [
    record('release_artifacts', c.artifacts),
    record('release_diff_summary', c.summaries),
    record('release_diff_findings', c.findings),
    record('release_diff_held', c.held),
  ];
  return { records, skips: c.skips, stages: c.stages };
}

/** A subject whose data made the lane throw: our own failure (tool_error), not retried here. */
export function subjectErrorOutput() {
  return {
    records: [record('release_artifacts', null, 'this subject could not be read: the lane failed on it')],
    skips: [{ stage: 'collect', reason: 'tool_error', fault: 'tool' }],
    stages: { collect: 'subject_error' },
  };
}
