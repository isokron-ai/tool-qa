// Minimal zip reader for workflow artifact archives. No dependencies.
//
// Reads the central directory, inflates stored (0) and deflated (8) entries,
// and checks each entry's CRC-32 and size. Refuses encrypted entries, zip64
// archives (artifacts here are far below 4 GB) and any entry name that could
// write outside the target folder.
//
// Caps (a zip bomb is refused before anything is inflated): at most
// MAX_ENTRIES entries, and at most MAX_TOTAL_BYTES once inflated, counted from
// the sizes the central directory declares (each entry is then inflated with
// its declared size as the hard limit). History artifacts are a few files of
// at most tens of megabytes, so both caps leave a wide margin.

import { crc32, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const MAX_ENTRIES = 10_000;
export const MAX_TOTAL_BYTES = 1024 ** 3;

function fail(message) {
  throw new Error(`zip: ${message}`);
}

/** True if `name` is a plain relative path that stays inside the folder. */
export function safeEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '..');
}

function findEnd(buf) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('not a zip archive (no end of central directory record)');
}

/**
 * @param {Buffer} buf  the whole archive
 * @param {{maxEntries?: number, maxTotalBytes?: number}} [limits]
 * @returns {{ name: string, data: Buffer }[]}  files in archive order; folders are skipped
 */
export function readZip(buf, { maxEntries = MAX_ENTRIES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22) throw new Error('not a zip archive (too short)');
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('zip64 archives are not supported');
  if (cdOffset + cdSize > end) fail('central directory is outside the archive (truncated?)');
  if (count > maxEntries) fail(`${count} entries is more than the ${maxEntries} allowed`);

  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) fail(`bad central directory entry ${i} (truncated?)`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) fail(`${name} is encrypted`);
    if (packedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail('zip64 archives are not supported');
    if (!safeEntryName(name)) fail(`unsafe entry name ${JSON.stringify(name)}`);
    if (name.endsWith('/')) continue;
    total += size;
    if (total > maxTotalBytes) fail(`the entries hold more than ${maxTotalBytes} bytes once inflated`);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) fail(`bad local header for ${name}`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + packedSize > buf.length) fail(`${name} runs past the end of the archive`);
    const packed = buf.subarray(start, start + packedSize);
    let data;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
      } catch (err) {
        fail(`${name} could not be inflated: ${err.message}`);
      }
    } else fail(`${name} uses unsupported compression method ${method}`);
    if (data.length !== size) fail(`${name} is ${data.length} bytes, expected ${size}`);
    if (crc32(data) !== crc) fail(`CRC mismatch for ${name}`);
    out.push({ name, data });
  }
  return out;
}
