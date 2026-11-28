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

import { FetchProblem, forbiddenKind, readBytesCapped } from './lib/http.mjs';
import { readGitRefs } from './lib/gitrefs.mjs';
import { npmProvenance, pypiProvenance } from './lib/provenance.mjs';
import { compareArtifact, ComputeBudget, indexByBase, MAX_HELD } from './lib/diff.mjs';
import { createSourceIndex, looksText } from './lib/indicators.mjs';
import { githubRepoOf, record, str, int } from './lib/common.mjs';
import { namespaceMatches, registryEntries } from './registry.mjs';
import { ArchiveError, ArchiveLimit, readTarGz } from '../scripts/lib/untar.mjs';
import { readZipLenient } from '../scripts/lib/unzip.mjs';
import { safeArchivePath } from '../scripts/lib/untar.mjs';

export const LANE = 'release-diff';
export const VERSION = '1.4.0';

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
  // Pairs of commits whose source trees are compared for a tag that names another commit than the build (two archives each).
  treeChecksPerSubject: 2,
  downloadTimeoutMs: 120_000,
  // No network call starts once a subject has used this much time.
  subjectBudgetMs: 360_000,
  // All the comparisons of one subject together may compute this long (the loops run on one thread).
  computeBudgetMs: 90_000,
  // artifact: one at a time in memory (compressed bytes, then every inflated entry; read twice per commit, never two at once): so compressed + inflated
  // is the lane's memory ceiling for it (R-RD-23: at most 1 GiB; a GitHub runner has 7 GB).
  artifact: { maxCompressedBytes: 128 * 1024 ** 2, maxInflatedBytes: 512 * 1024 ** 2, maxEntries: 50_000, maxKeptEntryBytes: 16 * 1024 ** 2, maxKeptTotalBytes: 512 * 1024 ** 2, maxMetaBytes: 1024 ** 2 },
  // source: streamed, only files an artifact also has are kept (maxKeptTotalBytes): memory does not follow these three numbers, time
  // does (downloadTimeoutMs ends a slow read as reader_limit, not as a verdict about the repository).
  source: { maxCompressedBytes: 512 * 1024 ** 2, maxInflatedBytes: 4 * 1024 ** 3, maxEntries: 300_000, maxKeptEntryBytes: 2 * 1024 ** 2, maxKeptTotalBytes: 256 * 1024 ** 2, maxMetaBytes: 1024 ** 2 },
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SUMMARY_HOPS = 2;

/**
 * The lane's HTTP: every request checked against ALLOWED_HOSTS first. The
 * registry JSON reads never follow a redirect on their own: a redirect to
 * another allowed host is followed here, one hop at a time, each target checked
 * again; one that leaves the list is refused (`redirect_refused`).
 */
export function guardHttp(http) {
  async function getSummary(url, opts = {}, hop = 0) {
    if (!allowedUrl(url)) throw new HostRefused(url);
    const key = opts.cacheKey ?? url;
    const r = await http.getSummary(url, { ...opts, redirect: 'manual', cacheKey: hop === 0 ? key : `${key}#hop${hop}` });
    if (!REDIRECT_STATUSES.has(r.status)) return r;
    let target = null;
    try { target = new URL(r.res?.headers?.get('location') ?? '', url).href; } catch { target = null; }
    if (target === null || !allowedUrl(target) || hop >= MAX_SUMMARY_HOPS) {
      throw new FetchProblem('redirect_refused', `${new URL(url).hostname}: a redirect to somewhere we do not read`, { status: r.status });
    }
    return getSummary(target, opts, hop + 1);
  }
  return {
    ...http,
    request(url, opts) { if (!allowedUrl(url)) throw new HostRefused(url); return http.request(url, opts); },
    getSummary,
  };
}

/** The subject has used its time: no network call starts. */
export class SubjectBudget extends Error {
  constructor() {
    super('release-diff: the subject used its time budget');
    this.name = 'SubjectBudget';
  }
}

/** A limit of our own readers (an unsupported zip method, zip64): the artifact may be fine, we cannot read it. */
export class ReaderLimit extends Error {
  constructor(message) {
    super(`release-diff: ${message}`);
    this.name = 'ReaderLimit';
  }
}

/** The lane's HTTP with the subject's time budget checked before every call, whatever it is for. */
function budgetHttp(http, overBudget) {
  return {
    ...http,
    request(url, opts) { if (overBudget()) throw new SubjectBudget(); return http.request(url, opts); },
    getSummary(url, opts) { if (overBudget()) throw new SubjectBudget(); return http.getSummary(url, opts); },
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
  // PyPI normalises versions (PEP 440): 1.0 is 1.0.0, 1.0.0rc1 is 1.0.0-rc.1. Compare the normalised forms.
  const want = ecosystem === 'pypi' ? pep440Key(v) : null;
  const norm = want === null ? [] : [...tags.keys()].map((t) => ({ t, p: pep440Tag(t) })).filter((x) => x.p?.key === want).sort((x, y) => x.t.localeCompare(y.t));
  if (norm.length > 0) {
    const nameWords = new Set(names.map(canonWord));
    const ecoWords = new Set((ECOSYSTEM_TAG_PREFIXES[ecosystem] ?? []).map(canonWord));
    const labelled = norm.map((x) => ({ ...x, w: canonWord(x.p.prefix) }))
      .filter((x) => x.w === '' || ecoWords.has(x.w) || nameWords.has(x.w) || ['release', 'rel', 'version'].includes(x.w));
    const best = labelled.find((x) => x.w === '') ?? labelled[0];
    if (best) return { name: best.t, match: best.w === '' ? 'exact' : ecoWords.has(best.w) ? 'ecosystem_prefixed' : 'name_prefixed', ...tags.get(best.t) };
  }
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[-/@_.])v?${esc}$`);
  const weak = [...new Set([...tags.keys()].filter((t) => re.test(t)).concat(norm.map((x) => x.t)))].sort();
  if (weak.length === 0) return null;
  return { name: weak[0], match: weak.length > 1 ? 'weak_ambiguous' : 'weak', ...tags.get(weak[0]), others: weak.length - 1 };
}

const PEP440_RE = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
const PRE_KIND = Object.freeze({ alpha: 'a', beta: 'b', a: 'a', b: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' });
const canonWord = (w) => String(w).toLowerCase().replace(/[-_./@]+/g, '-').replace(/^-|-$/g, '');

/**
 * A PEP 440 version as a comparable key: epoch, release without trailing
 * zeros, pre-release (alpha, beta, c, pre, preview written a, b, rc), post and
 * dev; the local part is dropped. Null when the text is not a PEP 440 version.
 */
export function pep440Key(version) {
  const m = PEP440_RE.exec(String(version).trim());
  if (!m) return null;
  const release = m[2].split('.').map((n) => String(Number(n)));
  while (release.length > 1 && release[release.length - 1] === '0') release.pop();
  const pre = m[3] ? `${PRE_KIND[m[3].toLowerCase()]}${Number(m[4] || 0)}` : '';
  const post = m[5] !== undefined ? `post${Number(m[5])}` : m[6] ? `post${Number(m[7] || 0)}` : '';
  const dev = m[8] ? `dev${Number(m[9] || 0)}` : '';
  return `${Number(m[1] ?? 0)}!${release.join('.')}|${pre}|${post}|${dev}`;
}

/** A tag as { prefix, key }: what comes before the version, and the version's PEP 440 key; null when no tail of it is one. */
function pep440Tag(tag) {
  for (let i = 0; i < tag.length; i++) {
    if (i > 0 && !/[-/@_.]/.test(tag[i - 1])) continue;
    if (!/[vV\d]/.test(tag[i])) continue;
    const key = pep440Key(tag.slice(i));
    if (key !== null) return { prefix: tag.slice(0, i), key };
  }
  return null;
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
  // No retry: a second 120 s try would eat the subject's budget.
  const res = await http.request(url, { redirect: 'manual', timeoutMs: LIMITS.downloadTimeoutMs, retries: 0 });
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 410) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'redirected' };
    if (res.status === 403 || res.status === 429) throw new FetchProblem('rate_limited', `${new URL(url).hostname}: HTTP ${res.status}`, { status: res.status });
    throw new FetchProblem('upstream_unavailable', `${new URL(url).hostname}: HTTP ${res.status}`);
  }
  const buf = await readBytesCapped(res, cap, new URL(url).hostname);
  if (!digest(buf)) return { status: 'integrity_mismatch', bytes: buf.length, sha256: sha256(buf) };
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
      // zip64 is our reader's limit, not a flaw of the package; a truncated or damaged zip is.
      if (/zip64/.test(err?.message ?? '')) throw new ReaderLimit('the zip reader does not read zip64 archives');
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
    // An entry we cannot decode (a compression method or encryption our reader lacks) is our limit, not an unsafe entry.
    if (z.refused.some((r) => /unsupported compression method|is encrypted|zip64/.test(r.reason))) throw new ReaderLimit('an entry uses a zip feature the reader does not support');
    const refused = z.refused.map((r) => ({ name: String(r.name).slice(0, 300), reason: /unsafe/.test(r.reason) ? 'unsafe_path' : 'unreadable' }));
    const s = kind === 'wheel' ? { files, top: null } : stripTop(files);
    return { files: s.files, archive: { links: stripLinks(links, s.top), refused, duplicates: [...new Set(duplicates)], others: [] }, top: s.top };
  }
  let t;
  try {
    t = await readTarGz(buf, { keep: () => true, limits: LIMITS.artifact });
  } catch (err) {
    // A number our header parser cannot hold is our limit; a bad checksum or a stream that ends early is the archive's.
    if (err instanceof ArchiveError && /too large to read|is negative/.test(err.message)) throw new ReaderLimit('a tar header holds a number the reader cannot read');
    throw err;
  }
  const s = stripTop(t.files);
  return { files: s.files, archive: { links: stripLinks(t.links, s.top), refused: t.refused, duplicates: t.duplicates, others: stripLinks(t.others, s.top) }, top: s.top };
}

const MANIFEST_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'binding.gyp']);

/**
 * The source tree at a commit, from codeload.github.com. Every text file up
 * to 2 MiB feeds the source index (what strong indicators the source itself
 * has); bytes are kept only for files whose name an artifact also has.
 */
export async function readSourceTree(http, repo, commit, wantNames, { clock = () => Date.now(), fingerprint = false } = {}) {
  const t0 = clock();
  const res = await http.request(`https://codeload.github.com/${repo}/tar.gz/${commit}`, { redirect: 'manual', timeoutMs: LIMITS.downloadTimeoutMs, retries: 0 });
  if (res.status !== 200) {
    // A 403 for a repository GitHub took down (DMCA, disabled) is the repository's: gone, settled. Throttling is not.
    if (res.status === 403 || res.status === 451) {
      const k = await forbiddenKind(res);
      if (k.kind === 'gone') return { status: 'gone', why: k.why };
      throw new FetchProblem('rate_limited', `codeload.github.com: HTTP ${res.status}`, { status: res.status });
    }
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 422) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'redirected' };
    if (res.status === 429) throw new FetchProblem('rate_limited', `codeload.github.com: HTTP ${res.status}`, { status: res.status });
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
    ...(fingerprint ? { fingerprint: treeFingerprint(s.files, stripLinks(t.links, s.top), stripLinks(t.others, s.top)) } : {}),
  };
}

/**
 * A digest of what a source archive holds: every path with its executable bit and content hash, links with their
 * targets, other entries by type. Equal digests mean equal trees (R-RD-22). Anything the archive leaves out or rewrites
 * (export-ignore, export-subst) can only make two equal trees look different, never the reverse.
 */
export function treeFingerprint(files, links = [], others = []) {
  const lines = [];
  for (const [p, f] of files) lines.push(`f\0${p}\0${(f.mode & 0o111) !== 0 ? 'x' : '-'}\0${f.sha256}`);
  for (const l of links) lines.push(`l\0${l.path}\0${l.type}\0${l.target ?? ''}`);
  for (const o of others) lines.push(`o\0${o.path}\0${o.type}`);
  return sha256(Buffer.from(lines.sort().join('\n')));
}

/**
 * Is the source tree of two commits the same? A tag that was rebased or re-created after the build names another commit
 * with the same content; that is not the tag moving to other code. true / false, or null when we could not tell (a
 * problem, a limit, an archive that is not the commit asked for): null never lowers a finding and never adds blame.
 */
export async function treesIdentical(http, repo, a, b, { clock = () => Date.now(), canRead = () => true } = {}) {
  const prints = [];
  for (const commit of [a, b]) {
    // A read may take the whole download timeout: it starts only when that much of the subject's budget is left.
    if (!canRead()) return { identical: null, why: 'subject_time_budget' };
    let t;
    try {
      t = await readSourceTree(http, repo, commit, new Set(), { clock, fingerprint: true });
    } catch {
      return { identical: null, why: 'source_not_read' };
    }
    if (t.status !== 'ok') return { identical: null, why: `source_${t.status}` };
    if (t.archive_commit && t.archive_commit !== commit) return { identical: null, why: 'archive_commit_mismatch' };
    prints.push(t.fingerprint);
  }
  return { identical: prints[0] === prints[1], why: null };
}

/**
 * A tag that names another commit than the one built, with the same source tree, is a rebase, not a moved tag (R-RD-22).
 * `checks` are {finding, tag, provenance}. At most LIMITS.treeChecksPerSubject pairs of commits are compared (two archives
 * each, one at a time), never past the subject's budget; a pair we did not or could not check keeps its level and says
 * tree_identical null. A finding whose trees are identical drops to low.
 */
export async function settleTreeChecks(http, repo, checks, { overBudget = () => false, canRead = () => !overBudget(), clock = () => Date.now() } = {}) {
  const pairs = new Map();
  for (const c of checks) {
    const key = `${c.tag}\0${c.provenance}`;
    if (!pairs.has(key)) pairs.set(key, { tag: c.tag, provenance: c.provenance, items: [] });
    pairs.get(key).items.push(c.finding);
  }
  let checked = 0;
  for (const pair of pairs.values()) {
    if (checked >= LIMITS.treeChecksPerSubject || !canRead()) {
      for (const f of pair.items) f.tree_identical = null;
      continue;
    }
    checked++;
    const r = await treesIdentical(http, repo, pair.tag, pair.provenance, { clock, canRead });
    for (const f of pair.items) {
      f.tree_identical = r.identical;
      if (r.why) f.tree_check = r.why;
      if (r.identical === true && f.level !== 'low') Object.assign(f, { level_before_tree_check: f.level, level: 'low' });
    }
  }
}

// ---------------------------------------------------------------- one subject

const PROBLEM_CODES = new Set(['rate_limited', 'upstream_unavailable', 'too_large', 'redirect_refused']);

function problemOf(err) {
  if (err instanceof FetchProblem && PROBLEM_CODES.has(err.code)) return err.code;
  if (err instanceof ArchiveLimit) return 'too_large';
  if (err instanceof SourceTimeLimit || err instanceof ReaderLimit) return 'reader_limit';
  if (err instanceof SubjectBudget) return 'subject_budget';
  if (err instanceof ComputeBudget) return 'compute_budget';
  throw err;
}

/**
 * The skip for a problem. Every skip says its fault side. Passing ones are
 * retried (rate limit, outage: infra); a repository GitHub took down is the
 * subject's and settled; our own caps are ours (fault tool, not
 * retried); a redirect we do not follow is a tool-side retryable skip.
 */
export function skipOf(stage, code) {
  if (code === 'too_large') return { stage, reason: 'too_large', fault: 'tool' };
  if (code === 'reader_limit' || code === 'subject_budget') return { stage, reason: 'reader_limit', fault: 'tool' };
  if (code === 'compute_budget') return { stage: 'compute_budget', reason: 'reader_limit', fault: 'tool' };
  // GitHub took the repository down (DMCA, disabled): the subject's, settled, never retried (R-RD-18).
  if (code === 'gone') return { stage, reason: 'upstream_unavailable', fault: 'subject' };
  if (code === 'redirected' || code === 'redirect_refused') return { stage, reason: 'upstream_unavailable', fault: 'tool', retryable: true };
  return { stage, reason: code === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable', fault: 'infra', retryable: true };
}

/**
 * Everything for one subject. Never throws for an upstream problem: those are
 * per stage skips. `pins` maps "npm:<name>" / "pypi:<name>" to a version (the
 * known-answer control reads fixed releases).
 */
export async function collectSubject(rawHttp, repo, { seed = new Map(), pins = {}, clock = () => Date.now() } = {}) {
  const t0 = clock();
  const overBudget = () => clock() - t0 > LIMITS.subjectBudgetMs;
  // The budget is checked before every network call, not only before downloads.
  const http = budgetHttp(guardHttp(rawHttp), overBudget);
  let budgetSkipped = false;
  const budgetSkip = () => { if (!budgetSkipped) { budgetSkipped = true; skips.push(skipOf('collect', 'reader_limit')); } };
  // A problem at a stage: its code, and its skip (the subject's budget makes one skip for the whole subject).
  const fail = (stage, err) => {
    const c = problemOf(err);
    if (c === 'subject_budget') budgetSkip(); else skips.push(skipOf(stage, c));
    return c;
  };
  const stages = {};
  const skips = [];
  const artifacts = [];
  const summaries = [];
  const findings = [];
  const treeChecks = [];
  const held = [];
  let heldDropped = 0;
  // A package linked to the subject only by what its own author wrote (the repository field, project URLs)
  // can say anything: its findings are attention items (low), never medium or high in public.
  const trustedLink = (linkedBy) => linkedBy === 'provenance' || linkedBy === 'depsdev_attestation';
  // A changed executable file stays at medium even then: most npm packages have no provenance, so the repository
  // field is often the only link there is, and a real tamper must not drop to low (R-RD-17).
  const capFinding = (f, j) => (trustedLink(j.linkedBy) || !['high', 'medium'].includes(f.level)
    ? f : { ...f, level: f.kind === 'content_differs' && (f.executable || f.code_extension) ? 'medium' : 'low', level_capped_from: f.level, linked_by: j.linkedBy });

  // Packages.
  let servers = new Map();
  try {
    servers = (await registryEntries(http, repo)).servers;
    stages.mcp_registry = 'ok';
  } catch (err) {
    stages.mcp_registry = fail('mcp_registry', err);
  }
  let depsdev = [];
  try {
    depsdev = await depsdevPackagesOf(http, repo);
    stages.depsdev = 'ok';
  } catch (err) {
    stages.depsdev = fail('depsdev', err);
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
    stages.git_refs = fail('git_refs', err);
  }
  // A renamed repository is read where it went (and its source from there); one we could not follow is a retryable skip.
  if (refs?.status === 'moved') skips.push(skipOf('git_refs', 'redirected'));
  if (refs?.status === 'gone') skips.push(skipOf('git_refs', 'gone'));
  const tags = refs?.status === 'ok' ? refs.tags : null;
  const sourceRepo = refs?.status === 'ok' && refs.moved_to ? refs.moved_to : repo;
  if (refs?.status === 'ok' && refs.moved_to) stages.git_moved = 'followed';

  // Releases.
  const jobs = []; // { art, buf? , kind, filename, folder }
  for (const p of packages) {
    const pin = pins[`${p.ecosystem}:${p.name}`] ?? null;
    let rel;
    try {
      rel = p.ecosystem === 'npm' ? await npmRelease(http, p.name, pin, repo) : await pypiRelease(http, p.name, pin, repo);
    } catch (err) {
      const c = fail(p.ecosystem, err);
      artifacts.push({ ecosystem: p.ecosystem, package: p.name, version: pin, artifact: null, sources: p.sources, outcome: c === 'subject_budget' ? 'subject_time_budget' : 'not_read', why: c });
      continue;
    }
    if (rel.status !== 'ok') {
      // A registry that answers 403 or 429 is limiting us, which is not the package's doing.
      if (rel.status === 'http_403' || rel.status === 'http_429') skips.push(skipOf(p.ecosystem, 'rate_limited'));
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
    if (tags && !strong) findings.push(capFinding({ ...at, kind: 'no_matching_tag', weak_tag: j.tag ? j.tag.name : null, weak_tag_confirmed: j.tag ? !!confirmedWeak : null, level: 'low' }, j));
    if (j.tag && prov && j.tag.commit !== prov && (strong || confirmedWeak)) {
      // Built from this very tag, yet the tag now names another commit: the tag moved after the build.
      const ref = j.provenance.ref ?? '';
      const refKind = ref === `refs/tags/${j.tag.name}` ? 'this_tag' : ref.startsWith('refs/tags/') ? 'other_tag' : ref.startsWith('refs/heads/') ? 'branch' : 'unknown';
      const finding = capFinding({ ...at, kind: 'tag_commit_differs_from_provenance', tag: j.tag.name, provenance_ref: refKind, level: refKind === 'this_tag' ? 'high' : 'medium' }, j);
      findings.push(finding);
      treeChecks.push({ finding, tag: j.tag.commit, provenance: prov });
    }
    // Releases are often cut from a commit after the one npm recorded (a version-bump commit, a squash): an attention item.
    if (j.tag && j.gitHead && j.tag.commit !== j.gitHead && (strong || confirmedWeak)) findings.push(capFinding({ ...at, kind: 'tag_commit_differs_from_git_head', tag: j.tag.name, level: 'low' }, j));
  }

  // One basis commit at a time: its artifacts, then its source tree, then the comparisons, so at most one
  // commit's bytes are held at once.
  const commits = [...new Set(jobs.filter((j) => j.linkedBy && j.basis).map((j) => j.basis.commit))];
  let treesRead = 0;
  for (const j of jobs) {
    if (!j.linkedBy) j.outcome = 'not_linked_to_subject';
    else if (refs?.status === 'not_found') j.outcome = 'source_repository_not_found';
    else if (refs?.status === 'moved') j.outcome = 'source_repository_moved';
    else if (refs?.status === 'gone') j.outcome = 'source_repository_gone';
    else if (!j.basis) j.outcome = 'no_source_basis';
    else if (commits.indexOf(j.basis.commit) >= LIMITS.commitsPerSubject) j.outcome = 'commit_limit';
  }
  if (jobs.some((j) => j.outcome === 'commit_limit')) skips.push(skipOf('source', 'reader_limit'));
  let computeSpent = 0;
  let computeOut = false;
  let held_now = 0;
  const memory = { peak_artifacts_held: 0, peak_inflated_bytes: 0 };
  for (const commit of commits.slice(0, LIMITS.commitsPerSubject)) {
    const group = jobs.filter((j) => !j.outcome && j.basis?.commit === commit);
    const names = new Set();
    // Pass 1: read each artifact only for the names of its files (the source reader keeps bytes of those names), and
    // let go of it before the next one. Pass 2 (below) reads each again, one at a time, and compares it at once, so
    // at most one inflated artifact is in memory at any moment, whatever the number of jobs (R-RD-23).
    for (const j of group) {
      if (overBudget()) { j.outcome = 'subject_time_budget'; budgetSkip(); continue; }
      try {
        const d = await download(http, j.url, j.download);
        if (d.status !== 'ok') {
          // Bytes that do not match the registry's own digest can be a real tamper (a mirror, a swapped file): the
          // artifact is held, not skipped as an outage, and the public record says only that it was not read (R-RD-19).
          if (d.status === 'integrity_mismatch') {
            // The same outcome, with no skip and no finding, as an artifact the registry no longer serves (404 or 410):
            // the public data cannot tell the two apart.
            j.outcome = 'artifact_not_found';
            held.push({ package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind, path: null, sha256: d.sha256, size: d.bytes, placement: 'artifact', indicators: ['integrity_mismatch'] });
            continue;
          }
          j.outcome = `artifact_${d.status}`;
          // A redirect we do not follow is not the package's doing: retried.
          if (d.status === 'redirected') skips.push(skipOf(j.p.ecosystem, 'redirected'));
          continue;
        }
        j.bytes = d.buf.length;
        j.sha256 = sha256(d.buf);
        let read;
        try {
          read = await readArtifact(d.buf, j.kind, j.filename ?? '');
        } catch (err) {
          // Our caps and our reader's limits are skips; only a damaged archive is a finding about the package.
          if (err instanceof ArchiveLimit || err instanceof ReaderLimit) throw err;
          j.outcome = 'artifact_unreadable';
          findings.push(capFinding({ package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind, kind: 'artifact_unreadable', level: 'medium' }, j));
          continue;
        }
        for (const p of read.files.keys()) names.add(p.slice(p.lastIndexOf('/') + 1));
        j.loaded = true;
      } catch (err) {
        const c = fail(j.p.ecosystem, err);
        j.outcome = c === 'too_large' || c === 'reader_limit' ? c : c === 'subject_budget' ? 'subject_time_budget' : 'not_read';
        j.why = c;
      }
    }
    const ready = group.filter((j) => !j.outcome && j.loaded);
    if (ready.length === 0) continue;
    let t;
    if (overBudget()) {
      for (const j of ready) j.outcome = 'subject_time_budget';
      budgetSkip();
      continue;
    }
    try {
      t = await readSourceTree(http, sourceRepo, commit, names, { clock });
      if (t.status === 'ok') treesRead++;
    } catch (err) {
      const code = fail('source', err);
      t = { status: code === 'subject_budget' ? 'time_budget' : code };
    }
    if (t.status === 'redirected') skips.push(skipOf('source', 'redirected'));
    if (t.status === 'gone' && !skips.some((x) => x.stage === 'source' && x.fault === 'subject')) skips.push(skipOf('source', 'gone'));
    for (const j of ready) {
      if (t.status !== 'ok') {
        j.outcome = t.status === 'not_found' ? 'source_commit_not_found' : t.status === 'too_large' ? 'source_too_large' : t.status === 'reader_limit' ? 'source_time_limit' : t.status === 'time_budget' ? 'subject_time_budget' : `source_${t.status}`;
        if (t.status === 'not_found') findings.push(capFinding({ package: j.p.name, version: j.version, ecosystem: j.p.ecosystem, artifact: j.kind, kind: 'source_commit_not_found', basis: j.basis.kind, level: 'medium' }, j));
      } else if (computeOut) {
        j.outcome = 'compute_budget';
      } else if (overBudget()) {
        j.outcome = 'subject_time_budget';
        budgetSkip();
      } else {
        // Pass 2: this artifact alone is read again and compared; it is let go of before the next one is read.
        let read = null;
        try {
          const d = await download(http, j.url, j.download);
          if (d.status === 'ok' && sha256(d.buf) === j.sha256) read = await readArtifact(d.buf, j.kind, j.filename ?? '');
        } catch (err) {
          const c = fail(j.p.ecosystem, err);
          j.outcome = c === 'subject_budget' ? 'subject_time_budget' : 'not_read';
          j.why = c;
          continue;
        }
        // The same bytes read a minute ago: anything else (an outage, a changed file) is not read, never a finding.
        if (!read) {
          j.outcome = 'not_read'; j.why = 'reread_failed';
          skips.push(skipOf(j.p.ecosystem, 'upstream_unavailable'));
          continue;
        }
        held_now++; memory.peak_artifacts_held = Math.max(memory.peak_artifacts_held, held_now);
        memory.peak_inflated_bytes = Math.max(memory.peak_inflated_bytes, [...read.files.values()].reduce((n, f) => n + f.size, 0));
        const c0 = clock();
        let r;
        try {
          r = compareArtifact({ ecosystem: j.p.ecosystem, kind: j.kind, version: j.version, files: read.files, archive: read.archive }, t, {
            hint: j.folder,
            expired: () => computeSpent + (clock() - c0) > LIMITS.computeBudgetMs,
          });
        } catch (err) {
          if (!(err instanceof ComputeBudget)) throw err;
          // Out of compute time: the subject ends here, with our own limit as its skip (fault tool, not retried).
          computeOut = true;
          j.outcome = 'compute_budget';
          skips.push(skipOf('compute_budget', 'compute_budget'));
        } finally {
          computeSpent += clock() - c0;
        }
        if (r) {
          const at = { package: j.p.name, version: j.version, ecosystem: j.p.ecosystem };
          summaries.push({ ...at, ...r.summary });
          for (const f of r.findings) findings.push(capFinding({ ...at, ...f }, j));
          for (const h of r.held) held.push({ ...at, commit, ...h });
          heldDropped += r.held_truncated;
          j.outcome = 'compared';
        }
        read = null;
        held_now--;
      }
    }
  }

  await settleTreeChecks(http, sourceRepo, treeChecks, { canRead: () => clock() - t0 + LIMITS.downloadTimeoutMs <= LIMITS.subjectBudgetMs, clock });

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
  // The private held list is capped like the findings; the count of what it left out is its last entry.
  if (held.length > MAX_HELD) { heldDropped += held.length - MAX_HELD; held.length = MAX_HELD; }
  if (heldDropped > 0) held.push({ kind: 'held_truncated', truncated: heldDropped });
  return { repo, stages, skips, artifacts, summaries, findings, held, memory };
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
