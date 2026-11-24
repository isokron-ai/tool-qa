import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { readZip } from '../scripts/lib/unzip.mjs';
import { makeZip } from './lib/zip.mjs';

test('reads stored and deflated entries, including binary data', () => {
  const gz = gzipSync(Buffer.from('{"a":1}\n'.repeat(500)));
  const zip = makeZip([
    { name: 'manifest.json', data: '{"file":"x.ndjson.gz"}\n', method: 'store' },
    { name: 'x.ndjson.gz', data: gz },
    { name: 'sub/dir/empty.txt', data: '' },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['manifest.json', 'x.ndjson.gz', 'sub/dir/empty.txt']);
  assert.equal(entries[0].data.toString(), '{"file":"x.ndjson.gz"}\n');
  assert.ok(entries[1].data.equals(gz));
  assert.equal(entries[2].data.length, 0);
});

test('a CRC mismatch is an error', () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }], { corruptCrc: ['a.txt'] });
  assert.throws(() => readZip(zip), /CRC/);
});

test('names that would escape the folder are refused', () => {
  for (const name of ['../evil.txt', '/etc/passwd', 'a/../../b', 'C:\\x.txt', 'a\\..\\b']) {
    assert.throws(() => readZip(makeZip([{ name, data: 'x' }])), /unsafe/, name);
  }
});

test('directory entries are skipped', () => {
  const entries = readZip(makeZip([{ name: 'dir/', data: '' }, { name: 'dir/a.txt', data: 'a' }]));
  assert.deepEqual(entries.map((e) => e.name), ['dir/a.txt']);
});

test('not a zip, or a truncated one, is an error', () => {
  assert.throws(() => readZip(Buffer.from('<html>not found</html>')), /not a zip/);
  const zip = makeZip([{ name: 'a.txt', data: 'hello world' }]);
  assert.throws(() => readZip(zip.subarray(10)), /zip/);
});

test('R-ING-14: too many entries, or too many bytes once inflated, are refused before inflating', () => {
  const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  assert.equal(readZip(many, { maxEntries: 6 }).length, 6);
  assert.throws(() => readZip(many, { maxEntries: 5 }), /6 entries is more than the 5 allowed/);

  // A small zip that inflates to 2 MiB: refused by the total cap, counted from
  // the declared sizes, before any entry is inflated.
  const big = makeZip([
    { name: 'a.bin', data: Buffer.alloc(1024 ** 2) },
    { name: 'b.bin', data: Buffer.alloc(1024 ** 2) },
  ]);
  assert.ok(big.length < 10_000, 'the archive itself is small');
  assert.equal(readZip(big, { maxTotalBytes: 2 * 1024 ** 2 }).length, 2);
  assert.throws(() => readZip(big, { maxTotalBytes: 2 * 1024 ** 2 - 1 }), /more than 2097151 bytes once inflated/);
});

test('R-ING-14: the default caps are in place', async () => {
  const { MAX_ENTRIES, MAX_TOTAL_BYTES } = await import('../scripts/lib/unzip.mjs');
  assert.equal(MAX_ENTRIES, 10_000);
  assert.equal(MAX_TOTAL_BYTES, 1024 ** 3);
});
