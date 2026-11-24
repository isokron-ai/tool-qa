// Archive builders for tests: tar headers of any kind (links, devices, pax,
// GNU long names, unsafe paths, wrong checksums) and stored zips with Unix
// modes, so the readers in scripts/lib can be fed what a hostile package
// might hold. Test code only.

import { crc32, gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

/**
 * One tar header block.
 * @param {{name: string, type?: string, size?: number, mode?: number, linkname?: string, prefix?: string, magic?: boolean, badChecksum?: boolean, sizeField?: Buffer}} h
 */
export function tarHeader({ name, type = '0', size = 0, mode = 0o644, linkname = '', prefix = '', magic = true, badChecksum = false, sizeField = null }) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  if (sizeField) sizeField.copy(b, 124); else b.write(octal(size, 12), 124);
  b.write(octal(0, 12), 136);
  b.write(type, 156);
  b.write(linkname, 157, 100, 'utf8');
  if (magic) { b.write('ustar\0', 257); b.write('00', 263); }
  b.write(prefix, 345, 155, 'utf8');
  b.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(octal(badChecksum ? sum + 1 : sum, 7), 148);
  b[155] = 0x20;
  return b;
}

const pad = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** pax extended header records. */
export function paxRecords(rec) {
  let out = '';
  for (const [k, v] of Object.entries(rec)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    out += `${len}${body}`;
  }
  return Buffer.from(out);
}

/**
 * A tar from entries: { name, data?, type?, mode?, linkname?, prefix?, pax?, gnuLong?, badChecksum?, declaredSize? }.
 * `end: false` leaves the two zero blocks off.
 */
export function makeTar(entries, { end = true } = {}) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    if (e.pax) {
      const p = paxRecords(e.pax);
      parts.push(tarHeader({ name: 'PaxHeader', type: e.paxType ?? 'x', size: p.length }), p, pad(p.length));
    }
    if (e.gnuLong) {
      const n = Buffer.from(`${e.gnuLong}\0`);
      parts.push(tarHeader({ name: '././@LongLink', type: 'L', size: n.length }), n, pad(n.length));
    }
    const size = e.declaredSize ?? data.length;
    parts.push(tarHeader({ name: e.name, type: e.type ?? '0', size, mode: e.mode ?? 0o644, linkname: e.linkname ?? '', prefix: e.prefix ?? '', badChecksum: e.badChecksum, sizeField: e.sizeField ?? null }));
    if (e.type === undefined || e.type === '0' || e.type === 'x') parts.push(data, pad(data.length));
  }
  if (end) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export const makeTgz = (entries, opts) => gzipSync(makeTar(entries, opts));

/** A stored (uncompressed) zip; entries { name, data, mode? } (mode: Unix type and permission bits). */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
