// A dependency-free S3 PUT for Cloudflare R2, signed with AWS Signature
// Version 4 (node:crypto and fetch only).
//
//   https://<account>.r2.cloudflarestorage.com/<bucket>/<key>, region "auto"
//
// Used by live/publish.mjs to write the public live snapshot (build plan
// section 4). R2 is another service from GitHub, so a GitHub outage does not
// hold it back; it uses the pump's retry policy (pump/retry.mjs) for 5xx, 429
// and network errors, bounded by `until` so the pump never waits on it past its
// own deadline. Nothing here logs a key, a header or a response body.

import { createHash, createHmac } from 'node:crypto';

import { createRetrier, markRetry } from '../pump/retry.mjs';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding, as SigV4 wants it (`/` kept only when asked). */
function uriEncode(text, { slash = true } = {}) {
  let out = '';
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (!slash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const trimValue = (v) => String(v).trim().replace(/\s+/g, ' ');

/**
 * Sign a request. `headers` are exactly the headers that will be signed
 * (include `host`, and `x-amz-date` unless `amzDate` is only used for the
 * scope). Returns the Authorization header value and the pieces of the
 * calculation (the tests compare them with AWS's published ones).
 *
 * `doubleEncode`: true for every service but S3, which encodes the path once.
 * `payloadHash`: hex sha256 of the body (the last line of the canonical request).
 */
export function signV4({
  method, url, headers, payloadHash, region, service, accessKeyId, secretAccessKey, amzDate, doubleEncode = false,
}) {
  const u = url instanceof URL ? url : new URL(url);
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const byName = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), trimValue(v)]));
  const canonicalHeaders = names.map((n) => `${n}:${byName[n]}\n`).join('');
  const signedHeaders = names.join(';');
  // u.pathname is already percent-encoded by the URL parser; decode and encode again strictly.
  const rawPath = u.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/');
  const canonicalPath = doubleEncode ? rawPath.split('/').map((seg) => uriEncode(seg)).join('/') : rawPath;
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method.toUpperCase(), canonicalPath || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature, canonicalRequest, stringToSign, signedHeaders,
  };
}

/** x-amz-date: 20260101T120000Z */
export const amzDateOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Content-Type for a live object key. */
export function contentTypeFor(key) {
  if (key.endsWith('.ndjson')) return 'application/x-ndjson; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Cache-Control for a live object key (build plan section 4):
 *   v1/latest.json                      public, max-age=5, s-maxage=10
 *   v1/snap/<16 hex of the body's sha256>.json  immutable
 *   v1/events/<date>/<HH>.ndjson        max-age=60 for the open hour, immutable once it is past
 *   v1/heartbeat.json                   max-age=30
 *   v1/retry.json                       max-age=5 (the open retry, from memory)
 */
export function cacheControlFor(key, { now = Date.now() } = {}) {
  if (key === 'v1/latest.json') return 'public, max-age=5, s-maxage=10';
  if (key === 'v1/heartbeat.json') return 'public, max-age=30';
  if (key === 'v1/retry.json') return 'public, max-age=5';
  if (/^v1\/snap\/[0-9a-f]{16}\.json$/.test(key)) return IMMUTABLE;
  const m = /^v1\/events\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.ndjson$/.exec(key);
  if (m) {
    const hourStart = Date.parse(`${m[1]}T${m[2]}:00:00Z`);
    return Number.isFinite(hourStart) && now >= hourStart + 3_600_000 ? IMMUTABLE : 'public, max-age=60';
  }
  throw new Error(`no cache policy for key ${key}`);
}

export class R2Error extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'R2Error';
    this.status = status;
  }
}

/**
 * A PUT function for one bucket: put(key, body, { contentType, cacheControl, signal })
 * -> { status, bytes }. Throws R2Error when it fails for good (4xx, or retries
 * used up). Messages carry the key and HTTP status only.
 *
 * @param {{ accountId: string, bucket: string, accessKeyId: string, secretAccessKey: string,
 *   fetch?: typeof fetch, now?: () => number, sleep?: (ms:number)=>Promise<void>,
 *   random?: () => number, until?: null|number|(() => number), attempts?: number,
 *   totalMs?: number, requestTimeoutMs?: number, log?: (line:string)=>void,
 *   endpoint?: string }} opts
 */
export function createR2Putter({
  accountId, bucket, accessKeyId, secretAccessKey,
  fetch = globalThis.fetch, now = Date.now, sleep, random, until = null,
  attempts = 3, totalMs = 20_000, requestTimeoutMs = 10_000, log = () => {},
  endpoint,
} = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? '')) && !endpoint) throw new TypeError('createR2Putter: accountId must be the 32-hex account id');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(bucket ?? ''))) throw new TypeError('createR2Putter: bucket is not a bucket name');
  if (!accessKeyId || !secretAccessKey) throw new TypeError('createR2Putter: both credentials are required');
  const base = (endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const retrier = createRetrier({ attempts, totalMs, until, sleep, random, now, log });

  return async function put(key, body, { contentType = contentTypeFor(key), cacheControl = cacheControlFor(key, { now: now() }), signal } = {}) {
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    // One strict encoder for the URL path and the signed canonical path (signV4 re-derives it from the URL).
    const url = new URL(`${base}/${bucket}/${key.split('/').map((seg) => uriEncode(seg)).join('/')}`);
    return retrier.run(`PUT ${key}`, async () => {
      const amzDate = amzDateOf(now());
      const payloadHash = sha256hex(data);
      const headers = {
        host: url.host,
        'cache-control': cacheControl,
        'content-type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      };
      const { authorization } = signV4({ method: 'PUT', url, headers, payloadHash, region: 'auto', service: 's3', accessKeyId, secretAccessKey, amzDate });
      const { host: _host, ...sent } = headers;
      const init = { method: 'PUT', headers: { ...sent, authorization }, body: data };
      const signals = [];
      if (signal) signals.push(signal);
      if (requestTimeoutMs > 0 && typeof AbortSignal?.timeout === 'function') signals.push(AbortSignal.timeout(requestTimeoutMs));
      if (signals.length) init.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      let res;
      try {
        res = await fetch(url.href, init);
      } catch (err) {
        if (signal?.aborted) throw new R2Error(`PUT ${key}: aborted at the deadline`, { status: 0 });
        throw markRetry(new R2Error(`PUT ${key}: network error`, { status: 0 }), { status: 0, repeatable: true });
      }
      // The body of an error response is never read into a message.
      try { await res.arrayBuffer?.(); } catch { /* ignore */ }
      if (res.status >= 200 && res.status < 300) return { status: res.status, bytes: data.length };
      throw markRetry(new R2Error(`PUT ${key}: HTTP ${res.status}`, { status: res.status }), { status: res.status, headers: res.headers, repeatable: true });
    });
  };
}
