import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';

import { readSingleEntryZip, unwrapArtifact, ContainerError, AGE_MAGIC } from '../container.mjs';

// Tiny zip writer for tests: one or more entries, stored or deflated.
function zip(entries, { flags = 0, zip64 = false, comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8 } of entries) {
    const nameBuf = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(data) : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, cd, eocd, Buffer.from(comment)]);
}

const ciphertext = Buffer.concat([Buffer.from(AGE_MAGIC), Buffer.from('-> X25519 abc\nrest of the file\n')]);

test('reads a single deflated or stored entry', () => {
  for (const method of [0, 8]) {
    const z = zip([{ name: 'result-att-1.tar.age', data: ciphertext, method }], { comment: 'hi' });
    const e = readSingleEntryZip(z);
    assert.equal(e.name, 'result-att-1.tar.age');
    assert.deepEqual(e.data, ciphertext);
  }
});

test('rejects zips it does not expect', () => {
  const one = { name: 'result-att-1.tar.age', data: ciphertext };
  const bad = {
    'two entries': zip([one, { ...one, name: 'other' }]),
    encrypted: zip([one], { flags: 1 }),
    zip64: zip([one], { zip64: true }),
    'path in name': zip([{ ...one, name: '../result-att-1.tar.age' }]),
    'dir in name': zip([{ ...one, name: 'a/result-att-1.tar.age' }]),
    'no end record': zip([one]).subarray(0, 40),
    'unknown method': zip([{ ...one, method: 12 }]),
  };
  for (const [name, buf] of Object.entries(bad)) {
    assert.throws(() => readSingleEntryZip(buf), ContainerError, name);
  }
  const corrupt = zip([{ ...one, method: 0 }]);
  corrupt[30 + one.name.length + 3] ^= 0xff; // flip a data byte: crc no longer matches
  assert.throws(() => readSingleEntryZip(corrupt), /crc32/);
  assert.throws(() => readSingleEntryZip(zip([one]), { maxBytes: 10 }), /larger than/);
});

test('unwrapArtifact accepts raw age ciphertext or a zip around it', () => {
  assert.deepEqual(unwrapArtifact(ciphertext, 'result-att-1.tar.age'), { container: 'raw', ciphertext });
  const z = zip([{ name: 'result-att-1.tar.age', data: ciphertext }]);
  assert.deepEqual(unwrapArtifact(z, 'result-att-1.tar.age'), { container: 'zip', ciphertext });

  assert.throws(() => unwrapArtifact(zip([{ name: 'other.tar.age', data: ciphertext }]), 'result-att-1.tar.age'), /entry name/);
  assert.throws(() => unwrapArtifact(zip([{ name: 'result-att-1.tar.age', data: Buffer.from('plain tar') }]), 'result-att-1.tar.age'), /not age ciphertext/);
  assert.throws(() => unwrapArtifact(Buffer.from('ustar plain bundle'), 'result-att-1.tar.age'), /neither age ciphertext nor a zip/);
  // ASCII-armored age is not what the worker kit uploads.
  assert.throws(() => unwrapArtifact(Buffer.from('-----BEGIN AGE ENCRYPTED FILE-----\n'), 'x'), ContainerError);
});
