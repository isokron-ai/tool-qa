// A fake R2 bucket with the store interface of offsite/store-r2.mjs. No network.
//
//   const s3 = fakeS3({ now: () => t, pageSize: 2 });
//   s3.objects   Map key -> { data, sha256, md5, etag, lastModified }
//   s3.calls     [{ op, key }]
//   s3.faults    { headSize: Set<key>, headEtag: Set<key>, headSha: Set<key>, dropMeta: bool,
//                  putError: (key) => Error|null }
//
// Like R2: a PUT with a Content-MD5 that does not match the body is refused;
// If-None-Match: * on an existing key is refused (code 'exists'); a DELETE of an
// object younger than `lockDays` is refused (the bucket lock rule).

import { createHash } from 'node:crypto';

const hash = (alg, data) => createHash(alg).update(data).digest('hex');

export function fakeS3({ now = Date.now, pageSize = 1000, lockDays = 30 } = {}) {
  const objects = new Map();
  const calls = [];
  const faults = { headSize: new Set(), headEtag: new Set(), headSha: new Set(), dropMeta: false, putError: () => null };
  const error = (message, code = 'error') => Object.assign(new Error(message), { code });
  return {
    objects,
    calls,
    faults,
    /** Put an object in place directly, as an earlier run (or someone else) would have. */
    seed(key, data, { lastModified = new Date(now()).toISOString(), sha256 } = {}) {
      const buf = Buffer.from(data);
      objects.set(key, { data: buf, sha256: sha256 === undefined ? hash('sha256', buf) : sha256, md5: hash('md5', buf), etag: hash('md5', buf), lastModified });
    },
    async list({ prefix = '', token } = {}) {
      calls.push({ op: 'list', key: prefix });
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = token ? Number(token) : 0;
      const page = keys.slice(start, start + pageSize);
      return {
        items: page.map((k) => ({ key: k, size: objects.get(k).data.length, etag: objects.get(k).etag, lastModified: objects.get(k).lastModified })),
        next: start + pageSize < keys.length ? String(start + pageSize) : null,
      };
    },
    async head(key) {
      calls.push({ op: 'head', key });
      const o = objects.get(key);
      if (!o) return null;
      return {
        size: faults.headSize.has(key) ? o.data.length + 1 : o.data.length,
        etag: faults.headEtag.has(key) ? '0'.repeat(32) : o.etag,
        sha256: faults.dropMeta ? null : faults.headSha.has(key) ? 'f'.repeat(64) : o.sha256,
        checksumSha256: null,
      };
    },
    async put(key, body, { md5, sha256 } = {}) {
      calls.push({ op: 'put', key });
      const injected = faults.putError(key);
      if (injected) throw injected;
      if (objects.has(key)) throw error(`R2 PUT ${key}: the key already exists`, 'exists');
      if (md5 !== hash('md5', body)) throw error(`R2 PUT ${key} failed: BadDigest`);
      objects.set(key, { data: Buffer.from(body), sha256, md5, etag: hash('md5', body), lastModified: new Date(now()).toISOString() });
      return { etag: hash('md5', body) };
    },
    async get(key) {
      calls.push({ op: 'get', key });
      return objects.get(key)?.data ?? null;
    },
    async delete(key) {
      calls.push({ op: 'delete', key });
      const o = objects.get(key);
      if (o && now() - Date.parse(o.lastModified) < lockDays * 86_400_000) throw error(`R2 DELETE ${key} failed: the bucket lock holds it`);
      objects.delete(key);
    },
    ops: (op) => calls.filter((c) => c.op === op),
  };
}
