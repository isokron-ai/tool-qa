// meta-registry: what the package registries say about each subject repository.
//
// For one subject (a GitHub owner/name):
//   official MCP registry  every version of every server entry whose repository
//                          is the subject (search by owner/name, then by name,
//                          at most three pages each), with publish dates and
//                          status, and the packages each version declares;
//   npm, PyPI, crates.io   the packages the newest registry entries declare,
//                          plus those the seed list (history/seed-v1.json)
//                          names: versions, publish dates, maintainer count
//                          (a number only: no names, no emails), provenance or
//                          attestations, deprecations and yanks;
//   Go module proxy        github.com/<owner>/<name> through /cached-only/, so
//                          the proxy never fetches from the origin for us;
//   deps.dev               the package versions above and the GitHub project;
//   OCI registries         the digest each declared image tag resolves to (a
//                          HEAD of the manifest on the allowlisted hosts in
//                          lib/oci.mjs; no layer is pulled), at most five
//                          image tags per subject (oci_tag_digests).
//
// Nothing is installed or run. Every request is conditional where the server
// gives an ETag or Last-Modified, crates.io gets at most one request a second
// (its data-access policy), and no GitHub API is called at all. ghcr.io is a
// container registry here, not the GitHub API.

import { readFileSync } from 'node:fs';

import { FetchProblem } from './lib/http.mjs';
import { OCI_HOSTS, ociTarget, resolveTags } from './lib/oci.mjs';
import { bool, githubRepoOf, int, record, skipFor, str, textDigest, time } from './lib/common.mjs';

export const LANE = 'meta-registry';
export const VERSION = '1.1.0';
export const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const NPM = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org';
const CRATES = 'https://crates.io/api/v1/crates';
const GOPROXY = 'https://proxy.golang.org/cached-only';
const DEPSDEV = 'https://api.deps.dev/v3';
export const MIN_INTERVAL_MS = Object.freeze({ 'crates.io': 1000 });
const SEARCH_PAGES = 3;
const PER_ECOSYSTEM = 5;
const RECENT = 30;
/** Image tags read per subject (oci_tag_digests). */
export const OCI_PER_SUBJECT = 5;

export const SETTINGS = Object.freeze({
  lane: LANE, version: VERSION, search_pages: SEARCH_PAGES, packages_per_ecosystem: PER_ECOSYSTEM, recent_versions: RECENT,
  oci_tags_per_subject: OCI_PER_SUBJECT, oci_hosts: OCI_HOSTS,
  sources: ['mcp-registry-official', 'npm-registry', 'pypi-json-api', 'crates-io-api', 'go-module-proxy', 'deps-dev', 'oci-registries'],
});

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]{0,213}\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GO_VERSION = /^v[0-9][0-9A-Za-z.+-]{0,100}$/;
const NPM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/;

/** The seed list's declared packages by lower-case subject id. */
export function loadSeedPackages(path = new URL('../history/seed-v1.json', import.meta.url)) {
  const map = new Map();
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    for (const s of Array.isArray(doc?.subjects) ? doc.subjects : []) {
      if (typeof s?.id !== 'string' || !Array.isArray(s.packages)) continue;
      map.set(s.id.toLowerCase(), s.packages.filter((p) => typeof p?.registry === 'string' && typeof p?.identifier === 'string'));
    }
  } catch { /* no seed: the registry search alone decides */ }
  return map;
}

const answered = (r) => r && (r.status === 200 || r.status === 304);

function problemOf(err) {
  if (err instanceof FetchProblem) return { problem: err.code, detail: err.message };
  throw err;
}

// ---------------------------------------------------------------- MCP registry

function registryVersion(entry) {
  const s = entry?.server ?? {};
  const m = entry?._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const schema = typeof s.$schema === 'string' ? /\/schemas\/([0-9-]{10})\//.exec(s.$schema)?.[1] ?? null : null;
  return {
    version: str(s.version, 100),
    published_at: time(m.publishedAt),
    updated_at: time(m.updatedAt),
    status: str(m.status, 32),
    status_changed_at: time(m.statusChangedAt),
    is_latest: bool(m.isLatest),
    schema,
    packages: (Array.isArray(s.packages) ? s.packages : []).slice(0, 20).map((p) => ({
      registry_type: str(p?.registryType, 32),
      identifier: str(p?.identifier, 300),
      version: str(p?.version, 100),
      transport: str(p?.transport?.type, 32),
    })),
    remotes: (Array.isArray(s.remotes) ? s.remotes : []).slice(0, 20).map((r) => ({ type: str(r?.type, 32) })),
  };
}

/**
 * Does a registry server name's namespace belong to the subject's owner?
 * io.github.<owner>/...: true or false (a false one claims someone else's
 * repository, R-META-05); any other namespace (a domain): null.
 */
export function namespaceMatches(serverName, repo) {
  const m = /^io\.github\.([^/]+)\//i.exec(String(serverName ?? ''));
  if (!m) return null;
  return m[1].toLowerCase() === String(repo).split('/')[0].toLowerCase();
}

/**
 * Every version of every registry entry whose repository is `repo`.
 *
 * First the conventional entry io.github.<owner>/<name> is read by its exact
 * name (/servers/{name}/versions), so the subject's own entry is found however
 * many other entries a search returns (R-META-07). Then a search by
 * owner/name (and by name, if nothing was found), at most three pages each.
 * Anyone can publish an entry that claims a repository, so a search can be
 * crowded or fail on its own: its problem is `search_problem`, and the entries
 * already found are kept. A problem reading the exact name is `problem`.
 */
export async function registryEntries(http, repo) {
  const want = repo.toLowerCase();
  const servers = new Map();
  let truncated = false;
  const add = (matches) => {
    for (const m of matches) {
      if (!m.name) continue;
      const list = servers.get(m.name) ?? [];
      const { name, ...v } = m;
      if (!list.some((x) => x.version === v.version)) list.push(v);
      servers.set(m.name, list);
    }
  };
  const extractMatches = (doc) => (Array.isArray(doc?.servers) ? doc.servers : [])
    .filter((e) => githubRepoOf(e?.server?.repository?.url) === want)
    .map((e) => ({ name: str(e.server.name, 200), ...registryVersion(e) }));

  const own = `io.github.${repo}`;
  const direct = await http.getSummary(`${MCP_REGISTRY}/${encodeURIComponent(own)}/versions`, {
    version: 'mcp-registry-name/1',
    headers: { accept: 'application/json' },
    extract: (doc) => ({ matches: extractMatches(doc) }),
  });
  // Only 404 means the subject has no entry of that name. Any other answer (a
  // 400 if the registry stopped accepting the encoded name, a 403, a 5xx) is a
  // problem with this read, so the known answer is retried rather than left to
  // a search others can crowd (R-META-09).
  if (answered(direct)) add(direct.value.matches);
  else if (direct.status !== 404) throw new FetchProblem('upstream_unavailable', `MCP registry HTTP ${direct.status} for the exact-name read`);

  const search = async (term) => {
    let cursor = null;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const q = new URLSearchParams({ search: term, limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const r = await http.getSummary(`${MCP_REGISTRY}?${q}`, {
        version: 'mcp-registry/1',
        headers: { accept: 'application/json' },
        extract: (doc) => ({
          next: typeof doc?.metadata?.nextCursor === 'string' ? doc.metadata.nextCursor : null,
          matches: extractMatches(doc),
        }),
      });
      if (!answered(r)) {
        if (r.status >= 400 && r.status < 500) return;
        throw new FetchProblem('upstream_unavailable', `MCP registry HTTP ${r.status}`);
      }
      add(r.value.matches);
      cursor = r.value.next;
      if (!cursor) return;
    }
    truncated = true;
  };
  let searchProblem = null;
  try {
    await search(repo);
    if (servers.size === 0) await search(repo.split('/')[1]);
  } catch (err) {
    searchProblem = problemOf(err).problem;
  }
  for (const list of servers.values()) list.sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
  return { servers, truncated, ...(searchProblem ? { search_problem: searchProblem } : {}) };
}

// ---------------------------------------------------------------- npm
//
// npm's abbreviated document (application/vnd.npm.install-v1+json) lists the
// versions with their dist facts and deprecations, without the readme and
// per-version metadata that make full documents run to hundreds of MB
// (R-META-01). Two targeted reads fill the rest: the latest version's own
// document (repository, licence, gitHead, maintainers at that publish) and
// deps.dev's version list for publish dates (the abbreviated document has
// none).

const has = (o, k) => o && typeof o === 'object' && Object.hasOwn(o, k);

/** What we keep from the abbreviated document: names, tags and per-version flags, no text. */
export function npmAbbrevSummary(doc) {
  const versions = doc?.versions && typeof doc.versions === 'object' ? doc.versions : {};
  const tags = doc?.['dist-tags'] && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : {};
  return {
    name: str(doc?.name, 214),
    modified: time(doc?.modified),
    dist_tags: Object.entries(tags).slice(0, 20).map(([tag, v]) => ({ tag: str(tag, 64), version: str(v, 100) })),
    latest: typeof tags.latest === 'string' && has(versions, tags.latest) ? tags.latest : null,
    // [version, deprecated, provenance predicate type or null, has install script]
    versions: Object.keys(versions).slice(-5000).map((v) => {
      const x = versions[v] ?? {};
      const att = x.dist?.attestations;
      return [str(v, 100), typeof x.deprecated === 'string' && x.deprecated.length > 0, att ? (str(att.provenance?.predicateType, 200) ?? 'present') : null, x.hasInstallScript === true];
    }),
  };
}

/** What we keep from the latest version's own document: facts and counts, no text. */
export function npmVersionSummary(v) {
  const scripts = v?.scripts && typeof v.scripts === 'object' ? v.scripts : {};
  const engines = v?.engines && typeof v.engines === 'object' && !Array.isArray(v.engines) ? v.engines : {};
  const repoUrl = typeof v?.repository === 'string' ? v.repository : v?.repository?.url;
  return {
    repository_url: str(repoUrl, 300),
    licence: str(typeof v?.license === 'string' ? v.license : v?.license?.type, 100),
    has_bin: !!v?.bin && (typeof v.bin === 'string' || Object.keys(v.bin).length > 0),
    engines: Object.entries(engines).slice(0, 10).map(([name, range]) => ({ name: str(name, 32), range: str(range, 64) })),
    install_scripts: ['preinstall', 'install', 'postinstall', 'prepare'].filter((k) => typeof scripts[k] === 'string'),
    git_head: typeof v?.gitHead === 'string' && /^[0-9a-f]{40}$/.test(v.gitHead) ? v.gitHead : null,
    integrity_present: typeof v?.dist?.integrity === 'string',
    signatures: Array.isArray(v?.dist?.signatures) ? v.dist.signatures.length : 0,
    unpacked_size: int(v?.dist?.unpackedSize),
    file_count: int(v?.dist?.fileCount),
    mcp_name: str(v?.mcpName, 200),
    dependencies: v?.dependencies && typeof v.dependencies === 'object' ? Object.keys(v.dependencies).length : 0,
    // Maintainers listed in this version's document (those at its publish): a count, never names.
    maintainers_count: Array.isArray(v?.maintainers) ? v.maintainers.length : null,
  };
}

/** Assemble the three npm records from the abbreviated summary, the version summary and deps.dev dates. */
export function npmSummary(abbrev, latestDoc, dates, subjectRepo) {
  const when = new Map((dates?.versions ?? []).map((x) => [x[0], x[1]]));
  const flags = new Map(abbrev.versions.map((x) => [x[0], x]));
  const dated = abbrev.versions.map((x) => x[0]).filter((v) => when.get(v)).sort((a, b) => Date.parse(when.get(a)) - Date.parse(when.get(b)));
  const recent = (dated.length ? dated : abbrev.versions.map((x) => x[0])).slice(-RECENT);
  const latest = abbrev.latest;
  const lf = latest ? flags.get(latest) : null;
  return {
    doc: {
      package: abbrev.name,
      repository_matches_subject: latestDoc?.repository_url ? githubRepoOf(latestDoc.repository_url) === subjectRepo.toLowerCase() : null,
      repository_url: latestDoc?.repository_url ?? null,
      created_at: dated.length ? when.get(dated[0]) : null,
      modified_at: abbrev.modified,
      dates_source: dated.length ? 'deps.dev' : null,
      versions_count: abbrev.versions.length,
      first_version: dated.length ? { version: dated[0], published_at: when.get(dated[0]) } : null,
      dist_tags: abbrev.dist_tags,
      deprecated_versions_count: abbrev.versions.filter((x) => x[1]).length,
      latest: latest ? {
        version: latest,
        published_at: when.get(latest) ?? null,
        deprecated: !!lf?.[1],
        has_install_script: !!lf?.[3],
        ...(latestDoc ? (({ maintainers_count, repository_url, ...rest }) => rest)(latestDoc) : {}),
      } : null,
      recent_versions: recent.map((v) => ({ version: v, published_at: when.get(v) ?? null, deprecated: !!flags.get(v)?.[1], provenance: !!flags.get(v)?.[2] })),
    },
    maintainers: { package: abbrev.name, count: latestDoc?.maintainers_count ?? null, basis: 'latest_version_document' },
    attestations: {
      package: abbrev.name,
      version: latest,
      provenance_present: !!lf?.[2],
      predicate_type: lf?.[2] && lf[2] !== 'present' ? lf[2] : null,
      recent_with_provenance: recent.filter((v) => !!flags.get(v)?.[2]).length,
      recent_versions: recent.length,
      versions_with_provenance: abbrev.versions.filter((x) => x[2]).length,
    },
  };
}

export async function npmRead(http, name, subjectRepo) {
  if (!NPM_NAME.test(name)) return { status: 'invalid_name' };
  const base = `${NPM}/${name.replace('/', '%2F')}`;
  try {
    const a = await http.getSummary(base, {
      cacheKey: `${base}#abbreviated`, version: 'npm-abbrev/1',
      headers: { accept: 'application/vnd.npm.install-v1+json' }, extract: npmAbbrevSummary,
    });
    if (!answered(a)) return { status: a.status === 404 ? 'not_found' : `http_${a.status}` };
    let latestDoc = null;
    if (a.value.latest && NPM_VERSION.test(a.value.latest)) {
      const v = await http.getSummary(`${base}/${encodeURIComponent(a.value.latest)}`, {
        version: 'npm-version/1', headers: { accept: 'application/json' }, extract: npmVersionSummary,
      });
      if (answered(v)) latestDoc = v.value;
    }
    let dates = null;
    try {
      const d = await depsdevVersions(http, 'npm', name);
      if (answered(d)) dates = d.value;
    } catch (err) {
      problemOf(err); // dates are optional: a deps.dev problem leaves them null
    }
    return { status: 'ok', value: npmSummary(a.value, latestDoc, dates, subjectRepo) };
  } catch (err) {
    return problemOf(err);
  }
}

// ---------------------------------------------------------------- PyPI

/** From pypiJsonSlim() output and the simple API summary. */
export function pypiSummary(json, simple, subjectRepo) {
  const info = json?.info ?? {};
  const releases = json?.releases && typeof json.releases === 'object' ? json.releases : {};
  const uploads = [];
  let yanked = 0;
  for (const files of Object.values(releases)) {
    const list = Array.isArray(files) ? files : [];
    for (const f of list) if (time(f?.upload_time_iso_8601)) uploads.push(f.upload_time_iso_8601);
    if (list.length > 0 && list.every((f) => f?.yanked === true)) yanked++;
  }
  uploads.sort();
  const urls = info.project_urls && typeof info.project_urls === 'object' ? info.project_urls : {};
  const repoMatch = Object.values(urls).some((u) => githubRepoOf(u) === subjectRepo.toLowerCase()) || githubRepoOf(info.home_page) === subjectRepo.toLowerCase();
  const roles = Array.isArray(json?.ownership?.roles) ? json.ownership.roles : [];
  const latest = str(info.version, 100);
  const sfiles = (Array.isArray(simple?.files) ? simple.files : []);
  const latestFiles = Array.isArray(json?.urls) ? json.urls : [];
  const latestNames = new Set(latestFiles.map((f) => f?.filename).filter((x) => typeof x === 'string'));
  const provFiles = sfiles.filter((f) => latestNames.has(f?.filename));
  const status = str(simple?.['project-status']?.status, 32);
  return {
    info: {
      project: str(info.name, 200),
      repository_matches_subject: Object.keys(urls).length || info.home_page ? repoMatch : null,
      latest_version: latest,
      versions_count: Object.keys(releases).length,
      yanked_versions_count: yanked,
      first_upload_at: uploads[0] ?? null,
      latest_upload_at: uploads.at(-1) ?? null,
      requires_python: str(info.requires_python, 100),
      licence_expression: str(info.license_expression, 200),
      licence: str(info.license_short, 64),
      licence_text: info.license_digest ?? null,
      summary: info.summary_digest ?? null,
      project_url_labels: Object.keys(urls).slice(0, 20).map((k) => str(k, 64)),
      dependencies: int(info.requires_dist) ?? 0,
      latest_files: latestFiles.slice(0, 50).map((f) => ({
        packagetype: str(f?.packagetype, 32), size: int(f?.size), upload_time: time(f?.upload_time_iso_8601), yanked: bool(f?.yanked),
      })),
      roles_count: roles.length,
      owner_roles: roles.filter((r) => r?.role === 'Owner').length,
      maintainer_roles: roles.filter((r) => r?.role === 'Maintainer').length,
      organization_owned: typeof json?.ownership?.organization === 'string' && json.ownership.organization.length > 0,
      known_vulnerabilities: int(json?.vulnerabilities),
    },
    status,
    provenance: {
      project: str(info.name, 200),
      version: latest,
      files: provFiles.length,
      files_with_provenance: provFiles.filter((f) => typeof f?.provenance === 'string' && f.provenance.length > 0).length,
      simple_api_version: str(simple?.meta?.['api-version'], 16),
    },
  };
}

export async function pypiRead(http, name, subjectRepo) {
  if (!PYPI_NAME.test(name)) return { status: 'invalid_name' };
  const norm = name.toLowerCase().replace(/[-_.]+/g, '-');
  try {
    const j = await http.getSummary(`${PYPI}/pypi/${norm}/json`, {
      version: 'pypi-json/1', headers: { accept: 'application/json' }, extract: (doc) => ({ doc: pypiJsonSlim(doc) }),
    });
    if (!answered(j)) return { status: j.status === 404 ? 'not_found' : `http_${j.status}` };
    const s = await http.getSummary(`${PYPI}/simple/${norm}/`, {
      version: 'pypi-simple/1',
      headers: { accept: 'application/vnd.pypi.simple.v1+json' },
      extract: (doc) => ({ doc: { meta: { 'api-version': doc?.meta?.['api-version'] }, 'project-status': doc?.['project-status'], files: (Array.isArray(doc?.files) ? doc.files : []).map((f) => ({ filename: f?.filename, provenance: typeof f?.provenance === 'string' ? 'present' : null })) } }),
    });
    return { status: 'ok', value: pypiSummary(j.value.doc, answered(s) ? s.value.doc : null, subjectRepo) };
  } catch (err) {
    return problemOf(err);
  }
}

/** The parts of PyPI's JSON we read, so the cache holds no author or maintainer email. */
function pypiJsonSlim(doc) {
  const info = doc?.info ?? {};
  const releases = {};
  for (const [v, files] of Object.entries(doc?.releases ?? {}).slice(-2000)) {
    releases[v] = (Array.isArray(files) ? files : []).map((f) => ({ upload_time_iso_8601: f?.upload_time_iso_8601, yanked: f?.yanked }));
  }
  return {
    info: {
      name: info.name, version: info.version, requires_python: info.requires_python, license_expression: info.license_expression,
      // Free text is kept as a digest, also in the cache (R-META-06); a short licence name is kept.
      license_short: typeof info.license === 'string' && info.license.length <= 64 && !/[\r\n]/.test(info.license) ? info.license : null,
      license_digest: typeof info.license === 'string' && (info.license.length > 64 || /[\r\n]/.test(info.license)) ? textDigest(info.license) : null,
      summary_digest: textDigest(info.summary),
      project_urls: info.project_urls, home_page: info.home_page,
      requires_dist: Array.isArray(info.requires_dist) ? info.requires_dist.length : 0,
    },
    releases,
    urls: (Array.isArray(doc?.urls) ? doc.urls : []).map((f) => ({ filename: f?.filename, packagetype: f?.packagetype, size: f?.size, upload_time_iso_8601: f?.upload_time_iso_8601, yanked: f?.yanked })),
    ownership: { roles: (Array.isArray(doc?.ownership?.roles) ? doc.ownership.roles : []).map((r) => ({ role: r?.role })), organization: doc?.ownership?.organization ? 'yes' : null },
    vulnerabilities: Array.isArray(doc?.vulnerabilities) ? doc.vulnerabilities.length : null,
  };
}

// ---------------------------------------------------------------- crates.io

export function crateSummary(doc, owners, subjectRepo) {
  const c = doc?.crate ?? {};
  const versions = Array.isArray(doc?.versions) ? doc.versions : [];
  const newest = versions.find((v) => v?.num === c.newest_version) ?? versions[0] ?? null;
  return {
    crate: str(c.name, 64),
    repository_matches_subject: c.repository ? githubRepoOf(c.repository) === subjectRepo.toLowerCase() : null,
    created_at: time(c.created_at),
    updated_at: time(c.updated_at),
    max_version: str(c.max_version, 100),
    max_stable_version: str(c.max_stable_version, 100),
    newest_version: str(c.newest_version, 100),
    versions_count: int(c.num_versions) ?? versions.length,
    yanked_versions_count: versions.filter((v) => v?.yanked === true).length,
    trustpub_only: bool(c.trustpub_only),
    owners_count: owners,
    newest: newest ? {
      version: str(newest.num, 100),
      published_at: time(newest.created_at),
      yanked: bool(newest.yanked),
      licence: str(newest.license, 200),
      rust_version: str(newest.rust_version, 32),
      trusted_publishing: !!newest.trustpub_data,
      crate_size: int(newest.crate_size),
      has_lib: bool(newest.has_lib),
      bin_names: Array.isArray(newest.bin_names) ? newest.bin_names.length : 0,
    } : null,
    recent_versions: versions.slice(0, RECENT).map((v) => ({ version: str(v?.num, 100), published_at: time(v?.created_at), yanked: bool(v?.yanked), trusted_publishing: !!v?.trustpub_data })),
  };
}

/** The crate fields we read, so the cache holds no description or other free text (R-META-06). */
function crateSlim(c) {
  if (!c || typeof c !== 'object') return {};
  const pick = ['name', 'repository', 'created_at', 'updated_at', 'max_version', 'max_stable_version', 'newest_version', 'num_versions', 'trustpub_only'];
  return Object.fromEntries(pick.filter((k) => Object.hasOwn(c, k)).map((k) => [k, c[k]]));
}

export async function crateRead(http, name, subjectRepo) {
  if (!CRATE_NAME.test(name)) return { status: 'invalid_name' };
  try {
    const r = await http.getSummary(`${CRATES}/${name}`, {
      version: 'crates/1', headers: { accept: 'application/json' },
      extract: (doc) => ({ doc: { crate: crateSlim(doc?.crate), versions: (Array.isArray(doc?.versions) ? doc.versions : []).slice(0, 500).map((v) => ({ num: v?.num, created_at: v?.created_at, yanked: v?.yanked, license: v?.license, rust_version: v?.rust_version, trustpub_data: v?.trustpub_data ? 1 : null, crate_size: v?.crate_size, has_lib: v?.has_lib, bin_names: v?.bin_names })) } }),
    });
    if (!answered(r)) return { status: r.status === 404 ? 'not_found' : `http_${r.status}` };
    const o = await http.getSummary(`${CRATES}/${name}/owners`, {
      version: 'crates-owners/1', headers: { accept: 'application/json' },
      extract: (doc) => ({ count: Array.isArray(doc?.users) ? doc.users.length : null }),
    });
    return { status: 'ok', value: crateSummary(r.value.doc, answered(o) ? o.value.count : null, subjectRepo) };
  } catch (err) {
    return problemOf(err);
  }
}

// ---------------------------------------------------------------- Go

/** Module path case-encoding of the Go proxy protocol: an upper-case letter becomes ! and its lower case. */
export function goEscape(path) {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

export function goModFacts(modText) {
  const lines = (typeof modText === 'string' ? modText : '').split('\n');
  const at = lines.findIndex((l) => /^\s*module\s/.test(l));
  let deprecated = at >= 0 && /\/\/\s*Deprecated:/.test(lines[at]);
  for (let i = at - 1; at >= 0 && i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
    if (/^\s*\/\/\s*Deprecated:/.test(lines[i])) deprecated = true;
  }
  const retracts = lines.filter((l) => /^\s*retract\b/.test(l)).length;
  const goLine = lines.find((l) => /^\s*go\s+[0-9][0-9.]{0,15}\s*$/.test(l));
  // The proxy serves a repository without a go.mod with a go.mod of one module line (a +incompatible module).
  const synthesized = lines.filter((l) => l.trim() !== '').length === 1 && at >= 0;
  return { deprecated, retract_directives: retracts, go_directive: goLine ? goLine.trim().split(/\s+/)[1] : null, go_mod_synthesized: synthesized };
}

export async function goRead(http, repo) {
  const mod = `github.com/${repo}`;
  const esc = goEscape(mod);
  try {
    const latest = await http.getSummary(`${GOPROXY}/${esc}/@latest`, {
      version: 'go-latest/1', headers: { accept: 'application/json' },
      extract: (doc) => ({ version: str(doc?.Version, 100), time: time(doc?.Time), origin_vcs: str(doc?.Origin?.VCS, 16), origin_matches: doc?.Origin?.URL ? githubRepoOf(doc.Origin.URL) === repo.toLowerCase() : null }),
    });
    if (!answered(latest)) return { status: latest.status === 404 || latest.status === 410 ? 'not_found' : `http_${latest.status}`, module: mod };
    const list = await http.getSummary(`${GOPROXY}/${esc}/@v/list`, {
      version: 'go-list/1', parse: 'text', extract: (text) => ({ versions: text.split('\n').map((l) => l.trim()).filter((l) => GO_VERSION.test(l)).length }),
    });
    let modFacts = null;
    if (latest.value.version && GO_VERSION.test(latest.value.version)) {
      const m = await http.getSummary(`${GOPROXY}/${esc}/@v/${latest.value.version}.mod`, { version: 'go-mod/1', parse: 'text', extract: (t) => goModFacts(t) });
      if (answered(m)) modFacts = m.value;
    }
    return { status: 'ok', module: mod, value: { ...latest.value, versions_count: answered(list) ? list.value.versions : null, ...(modFacts ?? {}) } };
  } catch (err) {
    return { ...problemOf(err), module: mod };
  }
}

// ---------------------------------------------------------------- deps.dev

const SYSTEMS = { npm: 'NPM', pypi: 'PYPI', cargo: 'CARGO', go: 'GO' };

/** deps.dev's version list for a package: [version, publishedAt, isDefault, isDeprecated] each. Shared by npm and deps.dev stages. */
export function depsdevVersions(http, system, name) {
  return http.getSummary(`${DEPSDEV}/systems/${SYSTEMS[system]}/packages/${encodeURIComponent(name)}`, {
    version: 'depsdev-versions/1',
    extract: (doc) => ({
      versions: (Array.isArray(doc?.versions) ? doc.versions : []).slice(-5000)
        .map((v) => [str(v?.versionKey?.version, 100), time(v?.publishedAt), v?.isDefault === true, v?.isDeprecated === true])
        .filter((v) => v[0]),
    }),
  });
}

export async function depsdevPackage(http, system, name) {
  const base = `${DEPSDEV}/systems/${SYSTEMS[system]}/packages/${encodeURIComponent(name)}`;
  const p = await depsdevVersions(http, system, name);
  if (!answered(p)) return { system, name, found: false };
  const vs = p.value.versions;
  const def = vs.find((v) => v[2]) ?? vs.at(-1) ?? null;
  const out = { system, name, found: true, versions_count: vs.length, deprecated_versions: vs.filter((v) => v[3]).length, default_version: def?.[0] ?? null };
  if (out.default_version) {
    const v = await http.getSummary(`${base}/versions/${encodeURIComponent(out.default_version)}`, {
      version: 'depsdev-ver/1',
      extract: (doc) => ({
        published_at: time(doc?.publishedAt),
        is_deprecated: bool(doc?.isDeprecated),
        licences: (Array.isArray(doc?.licenses) ? doc.licenses : []).slice(0, 10).map((l) => str(l, 100)),
        advisory_keys: (Array.isArray(doc?.advisoryKeys) ? doc.advisoryKeys : []).slice(0, 100).map((a) => str(a?.id, 64)).filter(Boolean),
        slsa_provenances: (Array.isArray(doc?.slsaProvenances) ? doc.slsaProvenances : []).slice(0, 5).map((s) => ({
          verified: bool(s?.verified),
          source_repository: githubRepoOf(s?.sourceRepository),
          commit: typeof s?.commit === 'string' && /^[0-9a-f]{40}$/.test(s.commit) ? s.commit : null,
        })),
        attestations: (Array.isArray(doc?.attestations) ? doc.attestations : []).length,
        verified_attestations: (Array.isArray(doc?.attestations) ? doc.attestations : []).filter((a) => a?.verified === true).length,
      }),
    });
    if (answered(v)) out.default = v.value;
  }
  return out;
}

export async function depsdevProject(http, repo) {
  const r = await http.getSummary(`${DEPSDEV}/projects/${encodeURIComponent(`github.com/${repo}`)}`, {
    version: 'depsdev-project/1',
    extract: (doc) => ({
      found: true,
      scorecard_overall: typeof doc?.scorecard?.overallScore === 'number' ? doc.scorecard.overallScore : null,
      scorecard_date: time(doc?.scorecard?.date),
      oss_fuzz: doc?.ossFuzz ? true : false,
      licence: str(doc?.license, 100),
    }),
  });
  return answered(r) ? r.value : { found: false };
}

// ---------------------------------------------------------------- one subject

/** The packages to read: newest registry versions' packages, then the seed list's. */
/**
 * The packages to read, at most PER_ECOSYSTEM per ecosystem, in this order
 * (R-META-07, R-META-08): those declared by the newest version of entries in
 * the subject owner's own io.github namespace, then the seed list's, then
 * those of any other entry that claims the repository. So entries published
 * by others cannot crowd out the subject's own packages.
 */
export function packagesFor(servers, seedPackages = [], repo = null) {
  const want = { npm: [], pypi: [], cargo: [] };
  const push = (type, id) => { if (want[type] && id && !want[type].includes(id)) want[type].push(id); };
  const newestOf = (versions) => versions.find((v) => v.is_latest) ?? versions.at(-1);
  const entries = [...servers];
  const own = entries.filter(([name]) => repo && namespaceMatches(name, repo) === true);
  const others = entries.filter(([name]) => !(repo && namespaceMatches(name, repo) === true));
  for (const [, versions] of own) for (const p of newestOf(versions)?.packages ?? []) push(p.registry_type, p.identifier);
  for (const p of seedPackages) push(p.registry, p.identifier);
  for (const [, versions] of others) for (const p of newestOf(versions)?.packages ?? []) push(p.registry_type, p.identifier);
  return Object.fromEntries(Object.entries(want).map(([k, list]) => [k, list.slice(0, PER_ECOSYSTEM)]));
}

/**
 * The image tags to resolve, at most OCI_PER_SUBJECT, in the order of
 * packagesFor: entries in the subject owner's own namespace, then the seed
 * list, then other entries that claim the repository. Within an entry, newest
 * version first, so the tags of recent releases are the ones watched. Each is
 * {reference (host/path), tag, host, path, server_name, registry_version}.
 */
export function ociTargetsFor(servers, seedPackages = [], repo = null) {
  const out = [];
  const seen = new Set();
  const push = (identifier, version, serverName, registryVersion) => {
    if (out.length >= OCI_PER_SUBJECT) return;
    const t = ociTarget(identifier, version);
    if (!t) return;
    const reference = `${t.host}/${t.path}`;
    const key = `${reference}:${t.tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ reference, tag: t.tag, host: t.host, path: t.path, server_name: serverName, registry_version: registryVersion });
  };
  const newestFirst = (versions) => [...versions].sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
  const entries = [...servers];
  const own = entries.filter(([name]) => repo && namespaceMatches(name, repo) === true);
  const others = entries.filter(([name]) => !(repo && namespaceMatches(name, repo) === true));
  const fromEntries = (list) => {
    for (const [name, versions] of list) {
      for (const v of newestFirst(versions)) for (const p of v.packages ?? []) if (p.registry_type === 'oci') push(p.identifier, p.version, name, v.version);
    }
  };
  fromEntries(own);
  for (const p of seedPackages) if (p.registry === 'oci') push(p.identifier, p.version ?? null, null, null);
  fromEntries(others);
  return out;
}

/** Read everything for one subject. Never throws for an upstream problem: problems are per stage. */
export async function collectSubject(http, repo, { seed = new Map() } = {}) {
  const stages = {};
  const out = { repo, stages };
  try {
    out.registry = await registryEntries(http, repo);
    stages.mcp_registry = 'ok';
  } catch (err) {
    const p = problemOf(err);
    out.registry = { servers: new Map(), truncated: false, ...p };
    stages.mcp_registry = p.problem;
  }
  if (out.registry.search_problem) stages.mcp_registry_search = out.registry.search_problem;
  const pk = packagesFor(out.registry.servers, seed.get(repo.toLowerCase()) ?? [], repo);
  out.npm = [];
  for (const name of pk.npm) out.npm.push({ name, ...(await npmRead(http, name, repo)) });
  out.pypi = [];
  for (const name of pk.pypi) out.pypi.push({ name, ...(await pypiRead(http, name, repo)) });
  out.crates = [];
  for (const name of pk.cargo) out.crates.push({ name, ...(await crateRead(http, name, repo)) });
  out.go = await goRead(http, repo);
  const oci = ociTargetsFor(out.registry.servers, seed.get(repo.toLowerCase()) ?? [], repo);
  const resolved = oci.length ? await resolveTags(http, oci) : [];
  out.oci = oci.map((t, i) => ({ ...t, ...resolved[i] }));
  try {
    const found = [
      ...out.npm.filter((x) => x.status === 'ok').map((x) => ['npm', x.name]),
      ...out.pypi.filter((x) => x.status === 'ok').map((x) => ['pypi', x.name]),
      ...out.crates.filter((x) => x.status === 'ok').map((x) => ['cargo', x.name]),
      ...(out.go.status === 'ok' ? [['go', out.go.module]] : []),
    ];
    const packages = [];
    for (const [sys, name] of found) packages.push(await depsdevPackage(http, sys, name));
    out.depsdev = { project: await depsdevProject(http, repo), packages };
  } catch (err) {
    out.depsdev = problemOf(err);
  }
  for (const k of ['npm', 'pypi', 'crates']) stages[k] = out[k].length === 0 ? 'not_applicable' : out[k].map((x) => x.problem ?? x.status).join(',');
  // Per package, so a control can look at one package's outcome alone (R-META-07).
  stages.npm_packages = out.npm.map((x) => ({ package: x.name, status: x.problem ?? x.status }));
  stages.go = out.go.problem ?? out.go.status;
  stages.oci = out.oci.length === 0 ? 'not_applicable' : out.oci.map((x) => x.status).join(',');
  stages.depsdev = out.depsdev.problem ?? 'ok';
  return out;
}

const ATTRIBUTION = 'Data from deps.dev, CC BY 4.0 for the data deps.dev generates; relayed data keeps its source terms.';

/** The output for a subject whose data made the lane throw: one skip that is not retried (R-META-01). */
export function subjectErrorOutput() {
  return {
    records: [record('registry_entry_history', null, 'this subject\'s data could not be read (the lane failed on it)')],
    skips: [{ stage: 'collect', reason: 'upstream_unavailable', retryable: false }],
    stages: { collect: 'subject_error' },
  };
}

/** Observation records and skips for one subject's collected data. */
export function subjectOutput(c, observedAt) {
  const records = [];
  const skips = [];
  const skip = (stage, code) => skips.push(skipFor(stage, code));

  if (c.registry.search_problem) skip('mcp_registry_search', c.registry.search_problem);
  if (c.registry.problem) {
    skip('mcp_registry', c.registry.problem);
    records.push(record('registry_entry_history', null, `the official MCP registry was not read: ${c.registry.problem}`));
  } else {
    // One element per registry entry whose repository is the subject; an empty list means none.
    records.push(record('registry_entry_history', [...c.registry.servers].map(([name, versions]) => ({
      server_name: name, namespace_matches_subject: namespaceMatches(name, c.repo),
      source: 'mcp-registry-official', source_licence: 'CC0-1.0', search_truncated: c.registry.truncated, versions,
    }))));
  }

  for (const n of c.npm) {
    if (n.problem) {
      skip('npm', n.problem);
      records.push(record('npm_version_doc', null, `npm package ${n.name} was not read: ${n.problem}`));
    } else if (n.status !== 'ok') {
      records.push(record('npm_version_doc', null, `npm package ${n.name}: ${n.status}`));
    } else {
      records.push(record('npm_version_doc', n.value.doc));
      // The count only: the change is derived later from successive counts, and no name is kept.
      records.push(record('npm_maintainer_count_and_change', n.value.maintainers));
      records.push(record('npm_attestations', n.value.attestations));
    }
  }
  for (const p of c.pypi) {
    if (p.problem) {
      skip('pypi', p.problem);
      records.push(record('pypi_info', null, `PyPI project ${p.name} was not read: ${p.problem}`));
    } else if (p.status !== 'ok') {
      records.push(record('pypi_info', null, `PyPI project ${p.name}: ${p.status}`));
    } else {
      records.push(record('pypi_info', p.value.info));
      records.push(record('pypi_project_status', p.value.status, `PyPI's simple API gave no project status for ${p.name}`));
      records.push(record('pypi_provenance', p.value.provenance));
    }
  }
  for (const k of c.crates) {
    if (k.problem) {
      skip('crates', k.problem);
      records.push(record('crates_crate_facts', null, `crate ${k.name} was not read: ${k.problem}`));
    } else if (k.status !== 'ok') {
      records.push(record('crates_crate_facts', null, `crate ${k.name}: ${k.status}`));
    } else {
      records.push(record('crates_crate_facts', k.value));
    }
  }
  if (c.go.problem) {
    skip('go', c.go.problem);
    records.push(record('go_module_facts', null, `the Go module proxy was not read: ${c.go.problem}`));
  } else {
    records.push(record('go_module_facts', { module: c.go.module, found: c.go.status === 'ok', basis: 'proxy.golang.org/cached-only', ...(c.go.status === 'ok' ? c.go.value : {}) }));
  }
  // Image tags: one element per reference and tag; a rate limit or an outage is a retryable skip (R-DRIFT-10).
  const oci = c.oci ?? [];
  for (const code of new Set(oci.map((x) => x.status).filter((st) => st === 'rate_limited' || st === 'upstream_unavailable'))) skip('oci', code);
  if (c.registry.problem && oci.length === 0) {
    records.push(record('oci_tag_digests', null, `the official MCP registry was not read: ${c.registry.problem}`));
  } else {
    records.push(record('oci_tag_digests', oci.map((x) => ({
      server_name: x.server_name, registry_version: x.registry_version, reference: x.reference, tag: x.tag,
      digest: x.digest ?? null, media_type: x.media_type ?? null, via: x.via ?? null, status: x.status,
    }))));
  }
  if (c.depsdev.problem) {
    skip('depsdev', c.depsdev.problem);
    records.push(record('depsdev_facts', null, `deps.dev was not read: ${c.depsdev.problem}`));
  } else {
    records.push(record('depsdev_facts', { ...c.depsdev, attribution: ATTRIBUTION }));
  }
  return { records, skips, stages: c.stages };
}
