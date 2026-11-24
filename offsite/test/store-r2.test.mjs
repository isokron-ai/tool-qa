// The R2 store against a small local S3 stand-in: what the pinned SDK really
// sends. Skipped when the SDK is not installed (npm ci --prefix offsite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';

import { createR2Store, endpointFor } from '../store-r2.mjs';

const installed = existsSync(new URL('../node_modules/@aws-sdk/client-s3/package.json', import.meta.url));
const hash = (alg, b) => createHash(alg).update(b).digest('hex');

/** A minimal path-style S3: PUT (If-None-Match, Content-MD5), HEAD, GET, DELETE, ListObjectsV2. */
async function localS3() {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, bucket, key, headers: req.headers, query: Object.fromEntries(url.searchParams) });
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(key)) return res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>');
        if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) return res.writeHead(400).end('<Error><Code>BadDigest</Code></Error>');
        objects.set(key, { body, meta: req.headers['x-amz-meta-sha256'] });
        return res.writeHead(200, { etag: `"${hash('md5', body)}"` }).end();
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
          const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><ETag>"${hash('md5', o.body)}"</ETag><LastModified>2026-03-02T12:00:00.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`;
          return res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
        }
        const o = objects.get(key);
        if (!o) return res.writeHead(404).end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined);
        res.writeHead(200, { 'content-length': o.body.length, etag: `"${hash('md5', o.body)}"`, ...(o.meta ? { 'x-amz-meta-sha256': o.meta } : {}) });
        return res.end(req.method === 'GET' ? o.body : undefined);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      return res.writeHead(405).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { objects, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('R-OFF-11: the R2 store sends If-None-Match, Content-MD5, x-amz-checksum-sha256 (when asked) and sha256 metadata; reads them back; an existing key is "exists"', { skip: !installed && 'the S3 client is not installed (npm ci --prefix offsite)' }, async () => {
  const s3 = await localS3();
  const store = await createR2Store({ accountId: 'a'.repeat(32), bucket: 'isokron-loop-backup', accessKeyId: 'AKIA_SYNTHETIC', secretAccessKey: 'synthetic-secret', endpoint: s3.url, maxAttempts: 1 });
  try {
    const body = Buffer.from('age-encryption.org/v1\nbody');
    const d = { md5: hash('md5', body), sha256: hash('sha256', body) };
    const put = await store.put('ingest/2026-03-02/x/x.zip', body, { ...d, sendSha256: true });
    assert.equal(put.etag, d.md5);
    const req = s3.requests.find((r) => r.method === 'PUT');
    assert.equal(req.bucket, 'isokron-loop-backup');
    assert.equal(req.headers['if-none-match'], '*');
    assert.equal(req.headers['content-md5'], Buffer.from(d.md5, 'hex').toString('base64'));
    assert.equal(req.headers['x-amz-checksum-sha256'], Buffer.from(d.sha256, 'hex').toString('base64'));
    assert.equal(req.headers['x-amz-meta-sha256'], d.sha256);
    assert.match(String(req.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIA_SYNTHETIC\/\d{8}\/auto\/s3\/aws4_request/);
    assert.deepEqual(await store.head('ingest/2026-03-02/x/x.zip'), { size: body.length, etag: d.md5, sha256: d.sha256, checksumSha256: null });
    assert.equal(await store.head('nope'), null);
    await assert.rejects(store.put('ingest/2026-03-02/x/x.zip', body, d), (err) => err.code === 'exists');
    const page = await store.list({ prefix: 'ingest/' });
    assert.deepEqual(page.items.map((i) => [i.key, i.size, i.etag]), [['ingest/2026-03-02/x/x.zip', body.length, d.md5]]);
    assert.equal(page.next, null);
    assert.ok((await store.get('ingest/2026-03-02/x/x.zip')).equals(body));
    assert.equal(await store.get('nope'), null);
    // By default (OFFSITE_SHA256_HEADER unset: R2 refuses the header with Content-MD5) it is not sent; the metadata still goes.
    await store.put('k2', body, d);
    const r2 = s3.requests.filter((r) => r.method === 'PUT').at(-1);
    assert.equal(r2.headers['x-amz-checksum-sha256'], undefined);
    assert.equal(r2.headers['x-amz-meta-sha256'], d.sha256);
    // A refused PUT does not show the credentials.
    await assert.rejects(store.put('k3', body, { ...d, md5: '0'.repeat(32) }), (err) => !String(err.message).includes('synthetic-secret') && !String(err.message).includes('AKIA_SYNTHETIC'));
  } finally {
    store.destroy();
    await s3.close();
  }
});

test('R-OFF-11: the endpoint is the account\'s R2 S3 endpoint', () => {
  assert.equal(endpointFor('0123456789abcdef0123456789abcdef'), 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
});
