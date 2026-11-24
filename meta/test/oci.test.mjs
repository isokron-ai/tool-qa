import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OCI_HOSTS, OCI_TOKEN_HOSTS, ociTarget, parseOciRef, resolveTags } from '../lib/oci.mjs';
import { createHttp } from '../lib/http.mjs';
import { collectSubject, ociTargetsFor, subjectOutput } from '../registry.mjs';
import { registryFetch, registryRoutes } from './helpers.mjs';

const httpFor = (f) => createHttp({ fetch: f, sleep: async () => {}, retries: 0 });
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

/**
 * A registry that wants a token: HEAD without one is 401 with a Bearer
 * challenge at `realm`; the token service answers; HEAD with the token gives
 * the digest of `digests[tag]` (or 404). Every call is recorded.
 */
function ociFetch({ host = 'ghcr.io', realm = 'https://ghcr.io/token', digests = { '1.0.0': D1 }, digestHeader = true, getBody = null, status = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, redirect: init.redirect, auth: init.headers?.authorization ?? null });
    const u = new URL(url);
    if (u.href.startsWith(realm.split('?')[0])) return new Response(JSON.stringify({ token: 'anon-token' }), { status: 200 });
    if (u.hostname !== host) return new Response('', { status: 599 });
    if (status) return new Response('', { status, headers: status >= 300 && status < 400 ? { location: 'https://elsewhere.example/x' } : {} });
    if (!init.headers?.authorization) return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}",service="${host}",scope="repository:x:pull"` } });
    const tag = decodeURIComponent(u.pathname.split('/manifests/')[1]);
    if (u.pathname.includes('/blobs/')) throw new Error('a blob was requested');
    if (!digests[tag]) return new Response('', { status: 404 });
    if (method === 'GET') return new Response(getBody, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' } });
    return new Response(null, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json', ...(digestHeader ? { 'docker-content-digest': digests[tag] } : {}) } });
  };
  f.calls = calls;
  return f;
}

test('R-DRIFT-02: an image tag resolves to its digest with a manifest HEAD, one anonymous token per image, never a GET on docker.io', async () => {
  const f = ociFetch({ digests: { '1.0.0': D1, '1.1.0': D2 } });
  const r = await resolveTags(httpFor(f), [
    { host: 'ghcr.io', path: 'acme/img', tag: '1.0.0' },
    { host: 'ghcr.io', path: 'acme/img', tag: '1.1.0' },
    { host: 'ghcr.io', path: 'acme/img', tag: '9.9.9' },
  ]);
  assert.deepEqual(r.map((x) => [x.status, x.digest, x.via]), [['ok', D1, 'head'], ['ok', D2, 'head'], ['not_found', null, null]]);
  assert.equal(r[0].media_type, 'application/vnd.oci.image.index.v1+json');
  // 401, token, HEAD, HEAD, HEAD: the token is reused for the image.
  assert.deepEqual(f.calls.map((c) => c.method), ['HEAD', 'GET', 'HEAD', 'HEAD', 'HEAD']);
  assert.ok(f.calls.every((c) => c.redirect === 'manual'));
  assert.ok(f.calls.filter((c) => c.method === 'HEAD').slice(1).every((c) => c.auth === 'Bearer anon-token'));
  assert.match(f.calls[1].url, /^https:\/\/ghcr\.io\/token\?service=ghcr\.io&scope=repository%3Aacme%2Fimg%3Apull$/);

  const hub = ociFetch({ host: 'registry-1.docker.io', realm: 'https://auth.docker.io/token', digestHeader: false });
  const h = await resolveTags(httpFor(hub), [{ host: 'docker.io', path: 'acme/img', tag: '1.0.0' }]);
  assert.deepEqual([h[0].status, h[0].digest], ['no_digest_header', null]);
  assert.ok(hub.calls.every((c) => c.method === 'HEAD' || c.url.startsWith('https://auth.docker.io/')), 'no manifest GET on Docker Hub');
});

test('R-DRIFT-08: OCI reads stay on the allowlist: other hosts get no request, an off-list token realm is refused, redirects are not followed', async () => {
  assert.deepEqual(OCI_HOSTS, ['docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.gitlab.com']);
  assert.deepEqual(OCI_TOKEN_HOSTS, ['auth.docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'gitlab.com', 'registry.gitlab.com']);
  const none = ociFetch();
  const r = await resolveTags(httpFor(none), [{ host: 'us-central1-docker.pkg.dev', path: 'p/r/img', tag: '1.0.0' }, { host: 'evil.example', path: 'a/b', tag: '1.0.0' }]);
  assert.deepEqual(r.map((x) => x.status), ['host_not_allowed', 'host_not_allowed']);
  assert.equal(none.calls.length, 0);

  const offList = ociFetch({ realm: 'https://token.evil.example/token' });
  const o = await resolveTags(httpFor(offList), [{ host: 'ghcr.io', path: 'acme/img', tag: '1.0.0' }]);
  assert.equal(o[0].status, 'host_not_allowed');
  assert.deepEqual(offList.calls.map((c) => new URL(c.url).hostname), ['ghcr.io'], 'the off-list realm is never asked');
  const port = ociFetch({ realm: 'https://ghcr.io:8443/token' });
  assert.equal((await resolveTags(httpFor(port), [{ host: 'ghcr.io', path: 'acme/img', tag: '1.0.0' }]))[0].status, 'host_not_allowed');

  const redirect = ociFetch({ status: 307 });
  const x = await resolveTags(httpFor(redirect), [{ host: 'ghcr.io', path: 'acme/img', tag: '1.0.0' }]);
  assert.equal(x[0].status, 'redirect_refused');
  assert.ok(redirect.calls.every((c) => new URL(c.url).hostname === 'ghcr.io'));
});

test('R-DRIFT-08: without a digest header, a non-Docker-Hub registry gets one capped manifest GET, hashed as sent', async () => {
  const body = Buffer.from('{"schemaVersion":2,"manifests":[]}\né', 'utf8');
  const f = ociFetch({ digestHeader: false, getBody: body });
  const r = await resolveTags(httpFor(f), [{ host: 'ghcr.io', path: 'acme/img', tag: '1.0.0' }]);
  const { createHash } = await import('node:crypto');
  assert.deepEqual([r[0].status, r[0].via, r[0].digest], ['ok', 'get', `sha256:${createHash('sha256').update(body).digest('hex')}`]);
});

test('R-DRIFT-10: an OCI rate limit or outage is a retryable skip of the oci stage and stops further reads of that host only', async () => {
  let n = 0;
  const f = async (url) => {
    n++;
    if (new URL(url).hostname === 'ghcr.io') return new Response('', { status: 429 });
    return new Response('', { status: 404 });
  };
  const r = await resolveTags(httpFor(f), [
    { host: 'ghcr.io', path: 'a/b', tag: '1.0.0' }, { host: 'ghcr.io', path: 'a/b', tag: '1.1.0' }, { host: 'quay.io', path: 'a/b', tag: '1.0.0' },
  ]);
  assert.deepEqual(r.map((x) => x.status), ['rate_limited', 'rate_limited', 'not_found']);
  assert.equal(n, 2, 'the second ghcr.io tag is not asked after the rate limit');

  const c = { repo: 'acme/img', stages: {}, registry: { servers: new Map(), truncated: false }, npm: [], pypi: [], crates: [], go: { status: 'not_found', module: 'github.com/acme/img' }, depsdev: { project: null, packages: [] },
    oci: [{ reference: 'ghcr.io/a/b', tag: '1.0.0', server_name: 's', registry_version: '1.0.0', ...r[0] }] };
  const o = subjectOutput(c, '2026-11-24T00:00:00Z');
  assert.deepEqual(o.skips.filter((s) => s.stage === 'oci'), [{ stage: 'oci', reason: 'rate_limited', retryable: true }]);
  assert.equal(o.records.find((x) => x.field === 'oci_tag_digests').value[0].status, 'rate_limited');
});

test('parseOciRef and ociTarget: the identifier\'s own tag wins, else the package version, else latest; digests and bad names are handled', () => {
  assert.deepEqual(parseOciRef('ghcr.io/acme/img:1.0.0'), { host: 'ghcr.io', path: 'acme/img', tag: '1.0.0', digest: null });
  assert.deepEqual(parseOciRef('acme/img'), { host: 'docker.io', path: 'acme/img', tag: 'latest', digest: null });
  assert.deepEqual(parseOciRef('nginx'), { host: 'docker.io', path: 'library/nginx', tag: 'latest', digest: null });
  assert.equal(parseOciRef('ghcr.io/acme/attempt_id=x:1'), null);
  assert.equal(parseOciRef('localhost:5000/a/b:1'), null);
  assert.deepEqual(ociTarget('docker.io/acme/img', '2.0.0'), { host: 'docker.io', path: 'acme/img', tag: '2.0.0', pinned_digest: null });
  assert.equal(ociTarget('docker.io/acme/img:1.0.0', '2.0.0').tag, '1.0.0');
  assert.equal(ociTarget(`ghcr.io/acme/img@${D1}`, null).tag, 'latest');
  assert.equal(ociTarget(`ghcr.io/acme/img@${D1}`, '3.0.0').tag, '3.0.0');
});

test('ociTargetsFor: the owner\'s own entries first, newest version first, then the seed list, then others; at most five tags', () => {
  const v = (version, published_at, ids) => ({ version, published_at, is_latest: false, packages: ids.map((id) => ({ registry_type: 'oci', identifier: id })) });
  const servers = new Map([
    ['io.github.someone/claim', [v('9.0.0', '2026-11-25T00:00:00Z', ['ghcr.io/someone/img:9.0.0'])]],
    ['io.github.acme/img', [v('1.0.0', '2026-11-01T00:00:00Z', ['ghcr.io/acme/img:1.0.0']), v('1.1.0', '2026-11-10T00:00:00Z', ['ghcr.io/acme/img:1.1.0', 'ghcr.io/acme/img:1.1.0'])]],
  ]);
  const t = ociTargetsFor(servers, [{ registry: 'oci', identifier: 'docker.io/acme/img:seed' }, { registry: 'npm', identifier: 'x' }], 'acme/img');
  assert.deepEqual(t.map((x) => `${x.reference}:${x.tag}`), ['ghcr.io/acme/img:1.1.0', 'ghcr.io/acme/img:1.0.0', 'docker.io/acme/img:seed', 'ghcr.io/someone/img:9.0.0']);
  assert.deepEqual([t[0].server_name, t[0].registry_version], ['io.github.acme/img', '1.1.0']);
  const many = new Map([['io.github.acme/img', Array.from({ length: 9 }, (_, i) => v(`1.${i}.0`, `2026-11-0${i + 1}T00:00:00Z`, [`ghcr.io/acme/img:1.${i}.0`]))]]);
  assert.equal(ociTargetsFor(many, [], 'acme/img').length, 5);
});

test('meta-registry: a subject without OCI packages records an empty oci_tag_digests list and asks no image registry', async () => {
  const f = registryFetch(registryRoutes());
  const c = await collectSubject(httpFor(f), 'isokron-ai/mcp-check');
  const o = subjectOutput(c, '2026-11-24T00:00:00Z');
  assert.deepEqual(o.records.find((r) => r.field === 'oci_tag_digests').value, []);
  assert.equal(o.stages.oci, 'not_applicable');
  assert.ok(f.calls.every((x) => !/ghcr\.io|docker\.io|quay\.io/.test(x.url)));
});
