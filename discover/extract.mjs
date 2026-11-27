// Discovery (design audit A2, DESIGN-v3 4.2 and 9.5 #1): turn the feed rows
// that history already captures (H1 the official MCP registry, H2 the npm,
// PyPI, crates.io and Go feeds) into candidate subjects, one per GitHub
// repository, each with the keys it was seen under: subfolder + purl + feed.
//
// Pure functions here; discover/run.mjs reads the files and does the npm and
// PyPI lookups (those feeds carry no repository URL). The pump decides what
// becomes a subject (pump/discover.mjs): it dedupes by the repository's
// numeric id, leaves out forks, and caps how many are added a day.
//
// Candidate classes, in the order the pump takes them:
//   0  listed in the official registry with at least one package (a server
//      someone can install and run)
//   1  seen only in a package feed (npm, PyPI, crates.io, Go)
//   2  listed in the registry with no package (remote-only or source-only:
//      counted, and only ever read from source, never contacted; decision 7)
// Within a class the order is the sha256 of the lower-case owner/name: stable
// from day to day, and no bias by name or by who published first.

import { createHash } from 'node:crypto';

export const CANDIDATES_VERSION = 1;
export const FRAME_SOURCE = 'discover-v1';

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * owner/name (and subfolder) of a GitHub URL, or null. Accepts https and git
 * URLs, git+ prefixes, .git suffixes, /tree/<ref>/<path> and the npm
 * "github:owner/name" shorthand.
 */
export function parseGithubUrl(raw, subfolder = '') {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^git\+/, '');
  let m = /^github:([^/\s]+)\/([^/#?\s]+)/.exec(s);
  if (!m) m = /^git@github\.com:([^/\s]+)\/([^/#?\s]+)/i.exec(s);
  let rest = '';
  if (!m) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    m = [null, parts[0], parts[1]];
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 4) rest = parts.slice(4).join('/');
  }
  const owner = m[1];
  const name = m[2].replace(/\.git$/i, '');
  if (!NAME_PART.test(owner) || !NAME_PART.test(name) || name === '.' || name === '..') return null;
  const sub = cleanSubfolder(subfolder || rest);
  return { repo: `${owner}/${name}`, subfolder: sub };
}

/** A repository-relative folder: no leading or trailing slash, no dot segments, at most 200 characters. */
export function cleanSubfolder(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) return '';
  return parts.join('/').slice(0, 200);
}

/** A package URL (purl) for a registry package type and name, or null for types we do not key. */
export function purlFor(type, name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim();
  switch (String(type).toLowerCase()) {
    case 'npm': {
      const m = /^(@[^/]+)\/(.+)$/.exec(n);
      return m ? `pkg:npm/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` : `pkg:npm/${encodeURIComponent(n)}`;
    }
    case 'pypi': return `pkg:pypi/${encodeURIComponent(n.toLowerCase().replace(/[-_.]+/g, '-'))}`;
    case 'cargo': return `pkg:cargo/${encodeURIComponent(n)}`;
    case 'nuget': return `pkg:nuget/${encodeURIComponent(n)}`;
    case 'oci': return `pkg:oci/${encodeURIComponent(n.replace(/[:@].*$/, ''))}`;
    case 'golang': return `pkg:golang/${n.split('/').map(encodeURIComponent).join('/')}`;
    default: return null;
  }
}

/**
 * Observations from registry rows (H1: one server version per line). Only
 * the latest version of an active server counts.
 * @returns {{feed:'registry', repo:string, subfolder:string, purls:string[], packaged:boolean}[]}
 */
export function fromRegistry(rows) {
  const out = [];
  for (const row of rows) {
    const s = row?.server;
    const meta = row?._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
    if (!s || meta.isLatest !== true || (meta.status !== undefined && meta.status !== 'active')) continue;
    const gh = parseGithubUrl(s.repository?.url, s.repository?.subfolder);
    if (!gh) continue;
    const pkgs = Array.isArray(s.packages) ? s.packages : [];
    const purls = [...new Set(pkgs.map((p) => purlFor(p?.registryType, p?.identifier)).filter(Boolean))].sort();
    out.push({ feed: 'registry', repo: gh.repo, subfolder: gh.subfolder, purls, packaged: pkgs.length > 0 });
  }
  return out;
}

/** Observations from H2 crates rows (they carry `repository`). */
export function fromCrates(rows) {
  const out = [];
  for (const r of rows) {
    const gh = parseGithubUrl(r?.repository);
    if (!gh || typeof r?.id !== 'string') continue;
    out.push({ feed: 'crates', repo: gh.repo, subfolder: gh.subfolder, purls: [purlFor('cargo', r.id)], packaged: true });
  }
  return out;
}

/** Observations from H2 Go rows: github.com/<owner>/<name>[/<folder>][/vN]. */
export function fromGo(rows) {
  const out = [];
  for (const r of rows) {
    const m = /^github\.com\/([^/]+)\/([^/]+)((?:\/[^/]+)*)$/i.exec(String(r?.path ?? ''));
    if (!m) continue;
    const gh = parseGithubUrl(`https://github.com/${m[1]}/${m[2]}`);
    if (!gh) continue;
    const sub = cleanSubfolder(m[3].replace(/\/v\d+$/, ''));
    out.push({ feed: 'go', repo: gh.repo, subfolder: sub, purls: [purlFor('golang', r.path)], packaged: true });
  }
  return out;
}

/** Package names an npm or PyPI feed saw (not deleted), lower-cased for PyPI. */
export function feedNames(rows, kind) {
  const names = new Set();
  for (const r of rows) {
    if (typeof r?.id !== 'string' || r.deleted === true) continue;
    if (kind === 'pypi' && r.action !== undefined && !/^(new release|create)/.test(String(r.action))) continue;
    names.add(kind === 'pypi' ? r.id.toLowerCase() : r.id);
  }
  return [...names].sort();
}

/** The GitHub repository named by an npm "latest" manifest, or null. */
export function repoFromNpm(doc) {
  const r = doc?.repository;
  if (typeof r === 'string') return parseGithubUrl(r);
  if (r && typeof r === 'object') return parseGithubUrl(r.url, r.directory);
  return null;
}

/** The GitHub repository named by a PyPI JSON document, or null (source-like links first). */
export function repoFromPypi(doc) {
  const info = doc?.info ?? {};
  const urls = Object.entries(info.project_urls ?? {});
  const rank = (k) => (/source|repo|code|github/i.test(k) ? 0 : /home/i.test(k) ? 1 : 2);
  urls.sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [, u] of urls) {
    const gh = parseGithubUrl(u);
    if (gh) return gh;
  }
  return parseGithubUrl(info.home_page);
}

const hashOf = (repo) => createHash('sha256').update(repo.toLowerCase()).digest('hex');

/**
 * Group observations into one candidate per repository (case aside), with
 * its keys and class, sorted by class then hash.
 * @returns {{name:string, class:number, hash:string, feeds:string[], keys:{subfolder:string, purl:string, feed:string}[]}[]}
 */
export function buildCandidates(observations, { maxKeys = 50 } = {}) {
  const by = new Map();
  for (const o of observations) {
    const k = o.repo.toLowerCase();
    let c = by.get(k);
    if (!c) {
      c = { name: o.repo, feeds: new Set(), keys: new Map(), registryPackaged: false, registry: false, packageFeed: false };
      by.set(k, c);
    }
    c.feeds.add(o.feed);
    if (o.feed === 'registry') {
      c.registry = true;
      if (o.packaged) c.registryPackaged = true;
    } else c.packageFeed = true;
    const purls = o.purls.length ? o.purls : [''];
    for (const p of purls) {
      const key = `${o.subfolder}\u0000${p}\u0000${o.feed}`;
      if (!c.keys.has(key) && c.keys.size < maxKeys) c.keys.set(key, { subfolder: o.subfolder, purl: p, feed: o.feed });
    }
  }
  const out = [];
  for (const [k, c] of by) {
    const cls = c.registryPackaged ? 0 : c.packageFeed ? 1 : 2;
    out.push({ name: c.name, class: cls, hash: hashOf(k), feeds: [...c.feeds].sort(), keys: [...c.keys.values()].sort((a, b) => (a.subfolder + a.purl + a.feed < b.subfolder + b.purl + b.feed ? -1 : 1)) });
  }
  out.sort((a, b) => a.class - b.class || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

/** Problems with a candidates document (what the pump refuses). Empty when it is fine. */
export function candidatesProblems(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  if (doc.version !== CANDIDATES_VERSION) p.push(`version must be ${CANDIDATES_VERSION}`);
  if (doc.frame !== FRAME_SOURCE) p.push(`frame must be ${FRAME_SOURCE}`);
  if (!Array.isArray(doc.candidates)) return [...p, 'candidates must be a list'];
  doc.candidates.forEach((c, i) => {
    if (p.length > 20) return;
    if (typeof c?.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(c.name)) p.push(`candidates[${i}].name is not owner/name`);
    if (![0, 1, 2].includes(c?.class)) p.push(`candidates[${i}].class must be 0, 1 or 2`);
    if (typeof c?.hash !== 'string' || !/^[0-9a-f]{64}$/.test(c.hash)) p.push(`candidates[${i}].hash must be a sha256`);
    if (!Array.isArray(c?.keys) || c.keys.some((k) => typeof k?.subfolder !== 'string' || typeof k?.purl !== 'string' || typeof k?.feed !== 'string' || k.subfolder.length > 200 || k.purl.length > 300)) p.push(`candidates[${i}].keys are malformed`);
  });
  return p;
}
