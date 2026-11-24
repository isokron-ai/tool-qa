// The off-site store: a Cloudflare R2 bucket through its S3-compatible API.
//
// It uses the official AWS SDK v3 S3 client, pinned to an exact version in
// offsite/package.json, with offsite/package-lock.json holding every package's
// integrity hash (`npm ci --ignore-scripts --prefix offsite` installs it). The
// SDK is loaded only when a store is made, so the rest of tool-qa, and the
// offsite tests that use the fake store, need no install.
//
// The store is the small interface offsite/backup.mjs and offsite/prune.mjs
// use (the tests' fake in offsite/test/fake-s3.mjs has the same shape):
//
//   list({ prefix, token })  one page (up to 1,000 keys): { items: [{ key, size, etag, lastModified }], next, truncated }
//   head(key)                { size, etag, sha256, checksumSha256 } or null if there is no such key
//   put(key, body, { md5, sha256, sendSha256, contentType })
//                            a new object only (If-None-Match: *): { etag }, or
//                            throws an error with code 'exists' if the key is taken
//   get(key)                 the bytes, or null
//   delete(key)              removes one object (R2 refuses while the bucket lock holds it)
//
// `md5` and `sha256` are the body's digests in hex. The PUT carries
// Content-MD5 (R2 refuses a body that does not match it), x-amz-checksum-sha256
// (only when `sendSha256` is true; R2 refuses it together with Content-MD5, so it is off by default) and the sha256 again as user metadata
// (x-amz-meta-sha256), which HEAD returns so an object can be checked later
// without downloading it.
//
// Errors never carry the credentials: the SDK does not put them in messages,
// and every message is scrubbed of them again here.

export const endpointFor = (accountId) => `https://${accountId}.r2.cloudflarestorage.com`;

export class StoreError extends Error {
  constructor(message, { code = 'error', status = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const unquote = (etag) => String(etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');

/**
 * @param {{ accountId: string, bucket: string, accessKeyId: string, secretAccessKey: string,
 *   endpoint?: string, sdk?: object, maxAttempts?: number }} opts
 */
// maxAttempts 1: the SDK does not retry on its own; offsite/backup.mjs meter() retries, and counts
// every attempt against the run's operation caps.
export async function createR2Store({ accountId, bucket, accessKeyId, secretAccessKey, endpoint, sdk, maxAttempts = 1 }) {
  const S3 = sdk ?? (await import('@aws-sdk/client-s3'));
  const secrets = [accessKeyId, secretAccessKey, accountId].filter((s) => s && String(s).length >= 4);
  const scrub = (text) => secrets.reduce((t, s) => t.split(s).join('***'), String(text ?? ''));
  const client = new S3.S3Client({
    region: 'auto',
    endpoint: endpoint ?? endpointFor(accountId),
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // Checksums only where we give them: we send our own sha256 and MD5.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts,
  });
  const statusOf = (err) => err?.$metadata?.httpStatusCode ?? null;
  const fail = (what, err) => {
    const status = statusOf(err);
    const name = err?.name ?? err?.Code ?? 'Error';
    return new StoreError(scrub(`R2 ${what} failed: ${name}${status ? ` (HTTP ${status})` : ''}: ${String(err?.message ?? err).slice(0, 200)}`), { status });
  };

  return {
    bucket,
    async list({ prefix, token } = {}) {
      try {
        const res = await client.send(new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token || undefined, MaxKeys: 1000 }));
        const items = (res.Contents ?? []).map((o) => ({
          key: o.Key,
          size: Number(o.Size ?? 0),
          etag: unquote(o.ETag),
          lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
        }));
        return { items, next: res.IsTruncated ? res.NextContinuationToken ?? null : null, truncated: Boolean(res.IsTruncated) };
      } catch (err) {
        throw fail(`LIST ${prefix ?? ''}`, err);
      }
    },
    async head(key) {
      try {
        const res = await client.send(new S3.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: Number(res.ContentLength ?? NaN),
          etag: unquote(res.ETag),
          sha256: res.Metadata?.sha256 ?? null,
          checksumSha256: res.ChecksumSHA256 ?? null,
        };
      } catch (err) {
        if (statusOf(err) === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
        throw fail(`HEAD ${key}`, err);
      }
    },
    async put(key, body, { md5, sha256, sendSha256 = false, contentType = 'application/octet-stream' }) {
      try {
        const res = await client.send(new S3.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: contentType,
          ContentMD5: b64(md5),
          ...(sendSha256 ? { ChecksumSHA256: b64(sha256) } : {}),
          Metadata: { sha256 },
          IfNoneMatch: '*',
        }));
        return { etag: unquote(res.ETag) };
      } catch (err) {
        const status = statusOf(err);
        if (status === 412 || err?.name === 'PreconditionFailed') throw new StoreError(`R2 PUT ${key}: the key already exists`, { code: 'exists', status });
        throw fail(`PUT ${key}`, err);
      }
    },
    async get(key) {
      try {
        const res = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (statusOf(err) === 404 || err?.name === 'NoSuchKey' || err?.name === 'NotFound') return null;
        throw fail(`GET ${key}`, err);
      }
    },
    async delete(key) {
      try {
        await client.send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        throw fail(`DELETE ${key}`, err);
      }
    },
    destroy() {
      client.destroy?.();
    },
  };
}
