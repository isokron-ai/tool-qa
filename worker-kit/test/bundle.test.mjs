import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ZSTD_MAGIC, BundleCodecError, bundleFormat, packBundle, unpackBundle, zstdAvailable } from '../bundle.mjs';
import { readTar, writeTar } from '../tar.mjs';

const sampleTar = () => writeTar([
  { path: 'accepted/a/0/ingest.json', data: Buffer.from(JSON.stringify({ outcome: 'accepted' }, null, 2)) },
  { path: 'accepted/a/0/results/scan-static.json', data: Buffer.from(JSON.stringify({ tools: Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: 'does a thing '.repeat(8) })) })) },
]);

test('this Node has zstd in zlib, so no dependency is needed', () => {
  assert.equal(zstdAvailable(), true);
});

test('R-RET-01: a bundle is read the same whether it was sealed as a plain tar (before loop upgrade 20) or as zstd', () => {
  const tar = sampleTar();
  const packed = packBundle(tar);
  assert.equal(bundleFormat(tar), 'tar');
  assert.equal(bundleFormat(packed), 'zstd');
  assert.deepEqual(packed.subarray(0, 4), ZSTD_MAGIC);
  assert.ok(packed.length < tar.length / 4, `zstd shrinks it (${tar.length} to ${packed.length})`);
  const old = readTar(unpackBundle(tar)).map((e) => [e.path, e.data.toString('hex')]);
  const now = readTar(unpackBundle(packed)).map((e) => [e.path, e.data.toString('hex')]);
  assert.deepEqual(now, old);
  assert.ok(unpackBundle(tar).equals(tar), 'a plain tar passes through untouched');
});

test('R-RET-01: a zstd bundle that inflates past the cap, or is damaged, is refused with a codec error', () => {
  const packed = packBundle(Buffer.alloc(1_000_000, 0x61));
  assert.throws(() => unpackBundle(packed, { maxBytes: 100_000 }), BundleCodecError);
  const bad = Buffer.from(packed);
  bad[bad.length - 2] ^= 0xff; // the frame carries a checksum
  assert.throws(() => unpackBundle(bad), BundleCodecError);
});
