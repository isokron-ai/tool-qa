import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { ArchiveError, ArchiveLimit, readTar, readTarGz, safeArchivePath } from '../scripts/lib/untar.mjs';
import { readZip, readZipLenient } from '../scripts/lib/unzip.mjs';
import { makeTar, makeTgz, makeZip } from './archive-fixtures.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('untar: regular files, ustar prefix, pax path and GNU long names are read; hashes always, bytes when asked', async () => {
  const long = `${'d/'.repeat(80)}deep.txt`;
  const t = makeTgz([
    { name: 'package/a.js', data: 'console.log(1)\n' },
    { name: 'b.txt', prefix: 'package/sub', data: 'b' },
    { name: 'short', pax: { path: 'package/from-pax.txt' }, data: 'p' },
    { name: 'trunc', gnuLong: `package/${long}`, data: 'g' },
    { name: 'package/dir/', type: '5' },
  ]);
  const r = await readTarGz(t, { keep: (e) => e.path.endsWith('.js') });
  assert.deepEqual([...r.files.keys()].sort(), ['package/a.js', `package/${long}`, 'package/from-pax.txt', 'package/sub/b.txt'].sort());
  assert.equal(r.files.get('package/a.js').data.toString(), 'console.log(1)\n');
  assert.equal(r.files.get('package/sub/b.txt').data, null, 'not asked for: hashed only');
  assert.equal(r.files.get('package/sub/b.txt').sha256, sha('b'));
  assert.equal(r.dirs, 1);
  assert.ok(r.inflated_bytes > 0 && r.compressed_bytes === t.length);
});

test('untar refuses paths that leave the folder, and never follows or reads links, devices or FIFOs', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a/\0b']) assert.equal(safeArchivePath(bad), null, bad);
  assert.equal(safeArchivePath('./a//b/'), 'a/b');
  const r = readTar(makeTar([
    { name: '../evil.js', data: 'x' },
    { name: '/abs.js', data: 'y' },
    { name: 'package/link', type: '2', linkname: '/etc/passwd' },
    { name: 'package/hard', type: '1', linkname: 'package/a' },
    { name: 'package/dev', type: '3' },
    { name: 'package/fifo', type: '6' },
    { name: 'package/ok.js', data: 'ok' },
  ]), { keep: () => true });
  assert.deepEqual([...r.files.keys()], ['package/ok.js']);
  assert.deepEqual(r.refused.map((x) => x.reason), ['unsafe_path', 'unsafe_path']);
  assert.deepEqual(r.links.map((l) => [l.path, l.type]), [['package/link', 'symlink'], ['package/hard', 'hardlink']]);
  assert.deepEqual(r.others.map((o) => o.type), ['device', 'fifo']);
});

test('untar caps: entries, a declared size over the cap before its data is read, kept bytes, compressed bytes', async () => {
  const many = makeTar(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  assert.throws(() => readTar(many, { limits: { maxEntries: 10 } }), ArchiveLimit);
  // A header that declares 10 GiB fails at the header: no data follows at all.
  const huge = makeTar([{ name: 'big', declaredSize: 10 * 1024 ** 3, data: '' }], { end: false });
  assert.throws(() => readTar(huge), (e) => e instanceof ArchiveLimit && /declare/.test(e.message));
  const big = makeTar([{ name: 'a', data: Buffer.alloc(5000, 1) }, { name: 'b', data: Buffer.alloc(5000, 2) }]);
  const r = readTar(big, { keep: () => true, limits: { maxKeptEntryBytes: 4096 } });
  assert.equal(r.files.get('a').data, null);
  assert.equal(r.files.get('a').not_kept, 'cap');
  assert.equal(r.files.get('a').sha256, sha(Buffer.alloc(5000, 1)), 'a file past the kept cap is still hashed');
  const { randomBytes } = await import('node:crypto');
  await assert.rejects(readTarGz(makeTgz([{ name: 'a', data: randomBytes(70_000) }]), { limits: { maxCompressedBytes: 1000 } }), ArchiveLimit);
});

test('untar counts every inflated byte toward the cap, kept or not (a gzip bomb of zeros stops at the cap)', async () => {
  // 64 MiB of zeros in one entry that is never kept: the inflated count stops it, not the kept count.
  const bomb = gzipSync(makeTar([{ name: 'zeros', data: Buffer.alloc(64 * 1024 ** 2) }]));
  assert.ok(bomb.length < 1024 ** 2, 'the bomb is small');
  await assert.rejects(readTarGz(bomb, { keep: () => false, limits: { maxInflatedBytes: 8 * 1024 ** 2 } }), (e) => e instanceof ArchiveLimit);
  // Without the end blocks, a second gzip member of zeros reads as more (empty) blocks: it inflates, and counts.
  const tail = Buffer.concat([gzipSync(makeTar([{ name: 'a', data: 'x' }], { end: false })), gzipSync(Buffer.alloc(16 * 1024 ** 2, 0x41))]);
  await assert.rejects(readTarGz(tail, { limits: { maxInflatedBytes: 4 * 1024 ** 2 } }), (e) => e instanceof ArchiveLimit || e instanceof ArchiveError);
  // After the end blocks nothing more is inflated: what follows costs no work.
  const after = Buffer.concat([makeTgz([{ name: 'a', data: 'x' }]), gzipSync(Buffer.alloc(64 * 1024 ** 2))]);
  const r = await readTarGz(after, { limits: { maxInflatedBytes: 8 * 1024 ** 2 } });
  assert.ok(r.inflated_bytes < 8 * 1024 ** 2, `stopped after the end blocks (${r.inflated_bytes} bytes inflated)`);
});

test('untar: a wrong checksum, data that ends inside an entry, an unreadable size and a broken gzip fail the archive', async () => {
  assert.throws(() => readTar(makeTar([{ name: 'a', data: 'x', badChecksum: true }])), ArchiveError);
  const cut = makeTar([{ name: 'a', data: Buffer.alloc(2000, 7) }], { end: false }).subarray(0, 1000);
  assert.throws(() => readTar(cut), ArchiveError);
  assert.throws(() => readTar(makeTar([{ name: 'a', sizeField: Buffer.from('zzzzzzzzzzz\0') }])), ArchiveError);
  await assert.rejects(readTarGz(Buffer.from('not gzip at all')), ArchiveError);
});

test('untar: base-256 sizes, duplicates (the last wins, as extractors do) and a pax global comment', () => {
  const sizeField = Buffer.alloc(12);
  sizeField[0] = 0x80;
  sizeField.writeUInt32BE(3, 8);
  const r = readTar(makeTar([
    { name: 'g', pax: { comment: 'a'.repeat(40) }, paxType: 'g', type: '0', data: '' },
    { name: 'n', sizeField, data: 'abc', declaredSize: 3 },
    { name: 'dup', data: 'one' },
    { name: 'dup', data: 'two' },
  ]), { keep: () => true });
  assert.equal(r.global_comment, 'a'.repeat(40));
  assert.equal(r.files.get('n').data.toString(), 'abc');
  assert.equal(r.files.get('dup').data.toString(), 'two');
  assert.deepEqual(r.duplicates, ['dup']);
});

test('untar: onFile may drop the bytes, which then stop counting toward the kept cap', () => {
  const t = makeTar(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(1000, i) })));
  const seen = [];
  const r = readTar(t, { keep: () => true, limits: { maxKeptTotalBytes: 2500 }, onFile: (f) => { seen.push(f.data?.length ?? 0); if (f.path !== 'f9') f.data = null; } });
  assert.deepEqual(seen, Array(10).fill(1000), 'every file was handed over with its bytes');
  assert.equal(r.files.get('f9').data.length, 1000);
});

test('unzip: entries report their Unix mode, so a symbolic link in a wheel can be refused', () => {
  const z = makeZip([{ name: 'pkg/__init__.py', data: 'x = 1\n' }, { name: 'pkg/link', data: '/etc/passwd', mode: 0o120777 }, { name: 'pkg/run.sh', data: '#!/bin/sh\n', mode: 0o100755 }]);
  const e = readZip(z);
  assert.deepEqual(e.map((x) => [x.name, x.mode]), [['pkg/__init__.py', 0o100644], ['pkg/link', 0o120777], ['pkg/run.sh', 0o100755]]);
  const r = readZipLenient(makeZip([{ name: '../up.py', data: 'x' }, { name: 'ok.py', data: 'y' }]));
  assert.deepEqual(r.entries.map((x) => x.name), ['ok.py']);
  assert.match(r.refused[0].reason, /unsafe entry name/);
});
