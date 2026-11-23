// Minimal, strict tar for result bundles.
//
// writeTar() produces POSIX ustar with regular files only, mode 0644, uid/gid 0
// and mtime 0, so the same files always give the same bytes. Paths longer than
// 100 bytes get a pax extended header that carries only `path`.
//
// readTar() reads only what writeTar() writes and rejects everything else:
// links, directories, devices, GNU extensions, pax keys other than `path`,
// absolute or `..` paths, duplicates, bad checksums, truncated data, a missing
// end marker and non-zero bytes after it. It also caps entry count and total
// size. It never touches the filesystem.

const BLOCK = 512;

export class TarError extends Error {
  constructor(message) {
    super(`tar: ${message}`);
    this.name = 'TarError';
  }
}

/** Safe relative path: no leading '/', no empty, '.' or '..' segments, no '\' or NUL. */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 4096) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new TarError(`value ${n} does not fit a ${width}-byte field`);
  return `${s.padStart(width - 1, '0')}\0`;
}

function rawHeader(name, size, type) {
  const h = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new TarError(`header name too long: ${name}`);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\u000000', 257, 'binary');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function padding(n) {
  return Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  // The length prefix counts its own digits: find the fixed point.
  let n = Buffer.byteLength(body) + 1;
  while (String(n).length + Buffer.byteLength(body) !== n) n += 1;
  return Buffer.from(`${n}${body}`);
}

/**
 * @param {{path: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function writeTar(entries) {
  const parts = [];
  const seen = new Set();
  for (const { path, data } of entries) {
    if (!isSafeRelativePath(path)) throw new TarError(`unsafe path ${JSON.stringify(path)}`);
    if (seen.has(path)) throw new TarError(`duplicate path ${path}`);
    seen.add(path);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let name = path;
    if (Buffer.byteLength(path) > 100) {
      const rec = paxRecord('path', path);
      parts.push(rawHeader('PaxHeader', rec.length, 'x'), rec, padding(rec.length));
      name = Buffer.from(path).subarray(0, 100).toString('utf8').replace(/\uFFFD+$/, '');
    }
    parts.push(rawHeader(name, buf.length, '0'), buf, padding(buf.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function cString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

function parseOctal(field, what) {
  if (field[0] & 0x80) throw new TarError(`${what}: base-256 size fields are not supported`);
  const s = cString(field).trim();
  if (!/^[0-7]+$/.test(s)) throw new TarError(`${what}: bad octal size field`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new TarError(`${what}: size out of range`);
  return n;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) throw new TarError('bad pax record');
    const lenText = buf.subarray(i, sp).toString('ascii');
    if (!/^[1-9]\d*$/.test(lenText)) throw new TarError('bad pax record length');
    const len = Number(lenText);
    if (i + len > buf.length || buf[i + len - 1] !== 0x0a) throw new TarError('bad pax record length');
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq <= 0) throw new TarError('bad pax record');
    const key = rec.slice(0, eq);
    if (key !== 'path') throw new TarError(`pax key ${key} is not allowed`);
    out[key] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * @param {Buffer} buf
 * @param {{maxEntries?: number, maxBytes?: number}} [limits]
 * @returns {{path: string, data: Buffer}[]}
 */
export function readTar(buf, { maxEntries = 20000, maxBytes = 2 * 1024 ** 3 } = {}) {
  const entries = [];
  const seen = new Set();
  let total = 0;
  let off = 0;
  let pax = null;
  for (;;) {
    if (off + BLOCK > buf.length) throw new TarError('archive has no end marker');
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      if (off + 2 * BLOCK > buf.length || !buf.subarray(off + BLOCK, off + 2 * BLOCK).every((b) => b === 0)) {
        throw new TarError('archive has no end marker');
      }
      if (!buf.subarray(off + 2 * BLOCK).every((b) => b === 0)) throw new TarError('data after the end marker');
      if (pax) throw new TarError('pax header without a following entry');
      return entries;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    const stored = parseInt(cString(h.subarray(148, 156)).trim(), 8);
    if (stored !== sum) throw new TarError(`bad header checksum at offset ${off}`);
    if (h.subarray(257, 265).toString('binary') !== 'ustar\u000000') throw new TarError('not a POSIX ustar archive');

    const type = String.fromCharCode(h[156] || 0x30);
    const size = parseOctal(h.subarray(124, 136), `entry at offset ${off}`);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError('truncated entry data');
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      if (pax) throw new TarError('two pax headers in a row');
      pax = parsePax(data);
      continue;
    }
    if (type !== '0') throw new TarError(`entry type ${JSON.stringify(type)} is not allowed (regular files only)`);

    const name = cString(h.subarray(0, 100));
    const prefix = cString(h.subarray(345, 500));
    const path = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = null;
    if (!isSafeRelativePath(path)) throw new TarError(`unsafe path ${JSON.stringify(path)}`);
    if (seen.has(path)) throw new TarError(`duplicate path ${path}`);
    seen.add(path);
    total += size;
    if (entries.length + 1 > maxEntries) throw new TarError(`more than ${maxEntries} entries`);
    if (total > maxBytes) throw new TarError(`more than ${maxBytes} bytes of content`);
    entries.push({ path, data: Buffer.from(data) });
  }
}
