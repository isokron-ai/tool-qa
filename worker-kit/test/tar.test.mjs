import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTar, readTar, TarError } from '../tar.mjs';

const longPath = `raw/${'a'.repeat(90)}/${'b'.repeat(90)}/${'c'.repeat(50)}`;

test('round trip keeps paths and bytes, including long paths and empty files', () => {
  const entries = [
    { path: 'manifest.json', data: Buffer.from('{"a":1}') },
    { path: 'raw/empty', data: Buffer.alloc(0) },
    { path: 'raw/bin', data: Buffer.from([0, 255, 10, 13, 0]) },
    { path: longPath, data: Buffer.alloc(1500, 7) },
  ];
  const out = readTar(writeTar(entries));
  assert.deepEqual(out.map((e) => e.path), entries.map((e) => e.path));
  out.forEach((e, i) => assert.ok(e.data.equals(entries[i].data)));
});

test('output is deterministic', () => {
  const e = [{ path: 'raw/x', data: Buffer.from('x') }];
  assert.ok(writeTar(e).equals(writeTar(e)));
});

test('system tar can list what we write', (t) => {
  let ok = true;
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { ok = false; }
  if (!ok) { t.skip('no tar binary on this machine'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'wk-tar-'));
  try {
    const file = join(dir, 'b.tar');
    writeFileSync(file, writeTar([{ path: 'manifest.json', data: Buffer.from('{}') }, { path: longPath, data: Buffer.from('z') }]));
    const listed = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listed, ['manifest.json', longPath]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writer refuses unsafe paths', () => {
  for (const p of ['/abs', '../x', 'a/../b', 'a//b', 'a\\b', '', 'a\0b']) {
    assert.throws(() => writeTar([{ path: p, data: Buffer.alloc(0) }]), TarError, p);
  }
});

// --- hand-built hostile archives ---

function header({ name = 'raw/x', size = 0, type = '0', magic = 'ustar\u000000', prefix = '', sizeField } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  if (sizeField) sizeField.copy(h, 124); else h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(magic, 257, 'binary');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
const END = Buffer.alloc(1024);
function file(name, content, opts = {}) {
  const data = Buffer.from(content);
  return Buffer.concat([header({ name, size: data.length, ...opts }), data, pad(data.length)]);
}

const hostile = [
  ['symlink entry', () => Buffer.concat([header({ name: 'raw/l', type: '2' }), END]), /type/],
  ['hard link entry', () => Buffer.concat([header({ name: 'raw/l', type: '1' }), END]), /type/],
  ['directory entry', () => Buffer.concat([header({ name: 'raw/', type: '5' }), END]), /type/],
  ['GNU long name', () => Buffer.concat([file('././@LongLink', 'raw/x', { type: 'L' }), END]), /type/],
  ['path traversal', () => Buffer.concat([file('raw/../../x', 'a'), END]), /path/],
  ['absolute path', () => Buffer.concat([file('/etc/x', 'a'), END]), /path/],
  ['traversal via prefix', () => Buffer.concat([file('x', 'a', { prefix: '..' }), END]), /path/],
  ['duplicate entry', () => Buffer.concat([file('raw/x', 'a'), file('raw/x', 'b'), END]), /duplicate/],
  ['bad checksum', () => { const b = Buffer.concat([file('raw/x', 'a'), END]); b[0] = 0x73; return b; }, /checksum/],
  ['not ustar', () => Buffer.concat([file('raw/x', 'a', { magic: 'ustar  \0' }), END]), /ustar/],
  ['truncated data', () => Buffer.concat([header({ name: 'raw/x', size: 2000 }), Buffer.alloc(512)]), /truncated/],
  ['no end marker', () => file('raw/x', 'a'), /end/],
  ['data after end', () => Buffer.concat([file('raw/x', 'a'), END, Buffer.from('junk'), Buffer.alloc(508)]), /after the end/],
  ['base-256 size', () => { const s = Buffer.alloc(12); s[0] = 0x80; s[11] = 1; return Buffer.concat([header({ name: 'raw/x', sizeField: s }), Buffer.alloc(512), END]); }, /size/],
  ['pax with another key', () => {
    const rec = Buffer.from('16 linkpath=abc\n');
    return Buffer.concat([header({ name: 'PaxHeader', size: rec.length, type: 'x' }), rec, pad(rec.length), file('raw/x', 'a'), END]);
  }, /pax/],
  ['pax with bad record length', () => {
    const rec = Buffer.from('99 path=raw/y\n');
    return Buffer.concat([header({ name: 'PaxHeader', size: rec.length, type: 'x' }), rec, pad(rec.length), file('raw/x', 'a'), END]);
  }, /pax/],
  ['pax header at the end', () => {
    const rec = Buffer.from('15 path=raw/yy\n');
    return Buffer.concat([header({ name: 'PaxHeader', size: rec.length, type: 'x' }), rec, pad(rec.length), END]);
  }, /pax/],
];

for (const [name, make, re] of hostile) {
  test(`reader rejects: ${name}`, () => {
    assert.throws(() => readTar(make()), (err) => err instanceof TarError && re.test(err.message));
  });
}

test('reader enforces entry count and total size caps', () => {
  const tar = writeTar([{ path: 'raw/a', data: Buffer.alloc(10) }, { path: 'raw/b', data: Buffer.alloc(10) }]);
  assert.throws(() => readTar(tar, { maxEntries: 1 }), /entries/);
  assert.throws(() => readTar(tar, { maxBytes: 15 }), /bytes/);
  assert.equal(readTar(tar, { maxEntries: 2, maxBytes: 20 }).length, 2);
});

test('pax path from a hand-built archive is honoured', () => {
  const rec = Buffer.from('19 path=raw/longer\n');
  const tar = Buffer.concat([header({ name: 'PaxHeader', size: rec.length, type: 'x' }), rec, pad(rec.length), file('raw/short', 'a'), END]);
  assert.deepEqual(readTar(tar).map((e) => e.path), ['raw/longer']);
});
