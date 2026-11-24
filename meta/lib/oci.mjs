// OCI image tags -> digests, for the drift signal "a tag that moves to a new
// image" (meta-registry, field oci_tag_digests).
//
// Only the registries on OCI_HOSTS are asked, and only their token services on
// OCI_TOKEN_HOSTS: the same allowlist as mcp-check's live-probe
// (corpus/live-probe.mjs OCI_HOSTS and OCI_TOKEN_HOSTS, at mcp-check 0e39a56).
// A reference on any other host is recorded as `host_not_allowed` and nothing
// is sent.
//
// One tag costs one HEAD request to /v2/<path>/manifests/<tag>, which answers
// with the digest in Docker-Content-Digest. No layer and no config blob is ever
// fetched. The first HEAD of an image is usually refused with 401 and a
// Bearer challenge: then one anonymous token request goes to the realm (it must
// be https, on the default port, on OCI_TOKEN_HOSTS), and the token is reused
// for every tag of that image. A registry that answers HEAD without the digest
// header gets one GET of the manifest (at most 4 MiB), whose sha256 is the
// digest; never on docker.io, where a manifest GET counts as a pull.
// Redirects are not followed, so no request leaves the allowlist.

import { createHash } from 'node:crypto';

import { FetchProblem, readJsonCapped } from './http.mjs';
import { str } from './common.mjs';

export const OCI_HOSTS = Object.freeze(['docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.gitlab.com']);
export const OCI_TOKEN_HOSTS = Object.freeze(['auth.docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'gitlab.com', 'registry.gitlab.com']);
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const MANIFEST_CAP = 4 * 1024 * 1024;
const TOKEN_CAP = 64 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * An OCI reference split into host, path, tag and digest; null when it is not
 * one we can ask about. Same rules as mcp-check's parseOciRef: docker.io is the
 * default host, a one-part Docker Hub name is under library/, no tag is latest.
 */
export function parseOciRef(id) {
  if (typeof id !== 'string' || id.length > 300 || /\s/.test(id)) return null;
  let rest = id;
  let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  const parts = rest.split('/');
  let host = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift().toLowerCase();
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  let path = parts.join('/');
  if (host === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(host) || host === 'localhost') return null;
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(path) || /(^|\/)\.\.?(\/|$)|\/\/|\/$/.test(path)) return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(tag)) return null;
  return { host, path, tag: tag || 'latest', digest };
}

/**
 * The image reference and tag a registry package names: the identifier's own
 * tag, else the package's version (older registry schemas kept it apart), else
 * latest. Null when the identifier is not an OCI reference.
 */
export function ociTarget(identifier, version = null) {
  const ref = parseOciRef(identifier);
  if (!ref) return null;
  const explicitTag = String(identifier).split('@')[0].split('/').pop().includes(':');
  const tag = explicitTag ? ref.tag : (typeof version === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(version) ? version : ref.tag);
  return { host: ref.host, path: ref.path, tag, pinned_digest: ref.digest };
}

const apiHost = (host) => (host === 'docker.io' ? 'registry-1.docker.io' : host);

/** The Bearer challenge of a 401, as {realm: URL, service}, or null. */
export function bearerChallenge(header) {
  const m = /^Bearer\s+(.*)$/i.exec(String(header ?? ''));
  if (!m) return null;
  const params = {};
  for (const p of m[1].matchAll(/([a-z]+)="([^"]{0,500})"/gi)) params[p[1].toLowerCase()] = p[2];
  let realm;
  try { realm = new URL(params.realm); } catch { return null; }
  return { realm, service: params.service ?? null };
}

/**
 * Resolve tags to digests for one subject. `targets` are {host, path, tag}.
 * Returns one entry per target, in order: {status, digest, media_type, via}.
 * status: ok | not_found | unauthorized | host_not_allowed | no_digest_header
 * | redirect_refused | http_<n>; a rate limit or an outage that outlasts the
 * retries is `rate_limited` or `upstream_unavailable` (a retryable skip for
 * the oci stage), and stops the remaining reads of that host.
 */
export async function resolveTags(http, targets) {
  const tokens = new Map(); // host + path -> 'Bearer ...' | null (anonymous answer without challenge)
  const failedHosts = new Map();
  const out = [];
  for (const t of targets) {
    if (!OCI_HOSTS.includes(t.host)) { out.push({ status: 'host_not_allowed', digest: null, media_type: null, via: null }); continue; }
    if (failedHosts.has(t.host)) { out.push({ status: failedHosts.get(t.host), digest: null, media_type: null, via: null }); continue; }
    try {
      out.push(await resolveOne(http, t, tokens));
    } catch (err) {
      if (!(err instanceof FetchProblem)) throw err;
      const code = err.code === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable';
      failedHosts.set(t.host, code);
      out.push({ status: code, digest: null, media_type: null, via: null });
    }
  }
  return out;
}

async function resolveOne(http, t, tokens) {
  const key = `${t.host}/${t.path}`;
  const url = `https://${apiHost(t.host)}/v2/${t.path}/manifests/${encodeURIComponent(t.tag)}`;
  const ask = (method) => {
    const auth = tokens.get(key);
    return http.request(url, { method, redirect: 'manual', headers: { accept: MANIFEST_ACCEPT, ...(auth ? { authorization: auth } : {}) } });
  };
  let res = await ask('HEAD');
  if (res.status === 401 && !tokens.has(key)) {
    await res.body?.cancel?.().catch(() => {});
    const ch = bearerChallenge(res.headers.get('www-authenticate'));
    if (!ch) return { status: 'unauthorized', digest: null, media_type: null, via: null };
    if (ch.realm.protocol !== 'https:' || ch.realm.port !== '' || !OCI_TOKEN_HOSTS.includes(ch.realm.hostname)) {
      return { status: 'host_not_allowed', digest: null, media_type: null, via: null };
    }
    if (ch.service) ch.realm.searchParams.set('service', ch.service);
    ch.realm.searchParams.set('scope', `repository:${t.path}:pull`);
    const tr = await http.request(ch.realm.href, { redirect: 'manual', headers: { accept: 'application/json' } });
    if (tr.status !== 200) {
      await tr.body?.cancel?.().catch(() => {});
      tokens.set(key, null);
      return { status: tr.status === 401 || tr.status === 403 ? 'unauthorized' : `http_${tr.status}`, digest: null, media_type: null, via: null };
    }
    const doc = await readJsonCapped(tr, TOKEN_CAP, 'oci token');
    const token = typeof doc?.token === 'string' ? doc.token : typeof doc?.access_token === 'string' ? doc.access_token : null;
    if (!token || token.length > 16384) { tokens.set(key, null); return { status: 'unauthorized', digest: null, media_type: null, via: null }; }
    tokens.set(key, `Bearer ${token}`);
    res = await ask('HEAD');
  }
  await res.body?.cancel?.().catch(() => {});
  if (res.status >= 300 && res.status < 400) return { status: 'redirect_refused', digest: null, media_type: null, via: null };
  if (res.status === 404) return { status: 'not_found', digest: null, media_type: null, via: null };
  if (res.status === 401 || res.status === 403) return { status: 'unauthorized', digest: null, media_type: null, via: null };
  if (res.status !== 200) return { status: `http_${res.status}`, digest: null, media_type: null, via: null };
  const media = str(String(res.headers.get('content-type') ?? '').split(';')[0].trim(), 100);
  const header = res.headers.get('docker-content-digest');
  if (typeof header === 'string' && DIGEST_RE.test(header.trim())) return { status: 'ok', digest: header.trim(), media_type: media, via: 'head' };
  // No digest header: hash the manifest itself, except on Docker Hub, where a GET counts as a pull.
  if (t.host === 'docker.io') return { status: 'no_digest_header', digest: null, media_type: media, via: null };
  const g = await ask('GET');
  if (g.status !== 200) {
    await g.body?.cancel?.().catch(() => {});
    return { status: `http_${g.status}`, digest: null, media_type: media, via: null };
  }
  const hash = await hashCapped(g, MANIFEST_CAP);
  if (!hash) return { status: 'too_large', digest: null, media_type: media, via: null };
  return { status: 'ok', digest: `sha256:${hash}`, media_type: media, via: 'get' };
}

/** sha256 of a body's bytes as sent (never decoded, so the digest is the registry's), or null past `max` bytes. */
export async function hashCapped(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel?.().catch(() => {}); return null; }
  const h = createHash('sha256');
  if (!res.body) return h.digest('hex');
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    h.update(value);
  }
  return h.digest('hex');
}
