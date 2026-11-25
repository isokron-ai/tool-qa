import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { cacheControlFor, contentTypeFor, createR2Putter, signV4 } from '../r2.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const KEY_ID = 'AKIA_SYNTHETIC_LIVE';
const SECRET = 'synthetic-live-secret-value-0001';

// AWS Signature Version 4 test suite, "get-vanilla"
// (https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html).
test('SigV4 vector: the AWS test suite get-vanilla request signs to the published signature', () => {
  const out = signV4({
    method: 'GET', url: 'https://example.amazonaws.com/',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z', doubleEncode: true,
  });
  assert.equal(createHash('sha256').update(out.canonicalRequest).digest('hex'), 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(out.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(out.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

// The S3 documentation's "PUT Object" example (Signature Version 4, header-based).
test('SigV4 vector: the S3 documentation PUT Object example signs to the published signature', () => {
  const body = 'Welcome to Amazon S3.';
  const hash = createHash('sha256').update(body).digest('hex');
  assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const out = signV4({
    method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
    headers: {
      date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': hash, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    payloadHash: hash, region: 'us-east-1', service: 's3', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
  });
  assert.equal(out.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

const NOW = Date.parse('2026-11-25T13:30:05Z');
function fakeFetch(statuses = [200]) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (status === 'throw') throw new Error(`socket secret ${SECRET}`);
    return new Response(`body mentions ${SECRET}`, { status });
  };
  fn.calls = calls;
  return fn;
}
const putter = (fetch, over = {}) => createR2Putter({ accountId: ACCOUNT, bucket: 'isokron-loop-live', accessKeyId: KEY_ID, secretAccessKey: SECRET, fetch, now: () => NOW, sleep: async () => {}, random: () => 0, ...over });

test('a PUT goes to the account endpoint and bucket path, signed, with Content-Type and Cache-Control', async () => {
  const f = fakeFetch();
  const r = await putter(f)('v1/snap/0123456789abcdef.json', '{"a":1}');
  assert.equal(r.status, 200);
  const { url, init } = f.calls[0];
  assert.equal(url, `https://${ACCOUNT}.r2.cloudflarestorage.com/isokron-loop-live/v1/snap/0123456789abcdef.json`);
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(init.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(init.headers['x-amz-date'], '20261125T133005Z');
  assert.equal(init.headers['x-amz-content-sha256'], createHash('sha256').update('{"a":1}').digest('hex'));
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_SYNTHETIC_LIVE\/20261125\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(init.headers.host, undefined, 'host is signed, not set by hand');
});

test('Cache-Control and Content-Type per key follow the R2 layout', () => {
  assert.equal(cacheControlFor('v1/latest.json'), 'public, max-age=5, s-maxage=10');
  assert.equal(cacheControlFor('v1/snap/0123456789abcdef.json'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('v1/heartbeat.json'), 'public, max-age=30');
  assert.equal(cacheControlFor('v1/events/2026-11-25/13.ndjson', { now: NOW }), 'public, max-age=60', 'the open hour');
  assert.equal(cacheControlFor('v1/events/2026-11-25/12.ndjson', { now: NOW }), 'public, max-age=31536000, immutable', 'a past hour');
  assert.throws(() => cacheControlFor('v1/other.json'));
  assert.throws(() => cacheControlFor('v1/snap/42.json'), /no cache policy/, 'snapshots are keyed by content hash, not seq');
  assert.equal(contentTypeFor('v1/events/2026-11-25/13.ndjson'), 'application/x-ndjson; charset=utf-8');
});

test('5xx and network errors are retried with the pump policy; a 4xx is final; messages carry no secret', async () => {
  let f = fakeFetch([503, 'throw', 200]);
  assert.equal((await putter(f)('v1/latest.json', '{}')).status, 200);
  assert.equal(f.calls.length, 3);
  f = fakeFetch([403]);
  await assert.rejects(putter(f)('v1/latest.json', '{}'), (e) => { assert.equal(e.status, 403); assert.ok(!e.message.includes(SECRET)); return true; });
  assert.equal(f.calls.length, 1);
  f = fakeFetch(['throw']);
  await assert.rejects(putter(f, { attempts: 2 })('v1/latest.json', '{}'), (e) => { assert.ok(!e.message.includes(SECRET)); assert.ok(!e.message.includes(KEY_ID)); return true; });
  assert.equal(f.calls.length, 2, 'bounded by the attempt limit');
});

test('createR2Putter refuses a malformed account id or missing credentials', () => {
  assert.throws(() => createR2Putter({ accountId: 'nope', bucket: 'isokron-loop-live', accessKeyId: 'a', secretAccessKey: 'b' }));
  assert.throws(() => createR2Putter({ accountId: ACCOUNT, bucket: 'isokron-loop-live', accessKeyId: '', secretAccessKey: 'b' }));
});
