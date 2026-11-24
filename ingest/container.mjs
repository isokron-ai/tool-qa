// What a downloaded artifact can look like, and how to get the age file out.
//
// The worker kit uploads the encrypted bundle with archive: false, so the
// download is the age file itself. An artifact uploaded as a zip (the default
// of upload-artifact) is accepted too if it holds exactly that one file.
// Anything else is a bad container.

import { crc32, inflateRawSync } from 'node:zlib';

export const AGE_MAGIC = 'age-encryption.org/v1\n';
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

export class ContainerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainerError';
  }
}

export function isAgeCiphertext(buf) {
  return buf.length >= AGE_MAGIC.length && buf.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC;
}

function isZip(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL;
}

/**
 * Read a zip that holds exactly one file (stored or deflated, no encryption,
 * no zip64, no directories in the name).
 * @returns {{name: string, data: Buffer}}
 */
export function readSingleEntryZip(buf, { maxBytes = 2 * 1024 ** 3 } = {}) {
  const fail = (m) => { throw new ContainerError(`zip: ${m}`); };
  // End of central directory: 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) fail('no end of central directory record');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (onDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail('zip64 is not supported');
  if (disk !== 0 || cdDisk !== 0) fail('multi-part zips are not supported');
  if (onDisk !== 1 || total !== 1) fail(`expected exactly one entry, found ${total}`);
  if (cdOff + cdSize > eocd || cdSize < 46) fail('central directory out of range');
  if (buf.readUInt32LE(cdOff) !== ZIP_CENTRAL) fail('bad central directory header');
  const flags = buf.readUInt16LE(cdOff + 8);
  const method = buf.readUInt16LE(cdOff + 10);
  const crc = buf.readUInt32LE(cdOff + 16);
  const csize = buf.readUInt32LE(cdOff + 20);
  const usize = buf.readUInt32LE(cdOff + 24);
  const nameLen = buf.readUInt16LE(cdOff + 28);
  const localOff = buf.readUInt32LE(cdOff + 42);
  if (flags & 0x1) fail('encrypted entries are not supported');
  if (csize === 0xffffffff || usize === 0xffffffff || localOff === 0xffffffff) fail('zip64 is not supported');
  if (cdOff + 46 + nameLen > cdOff + cdSize) fail('central directory out of range');
  const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('utf8');
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name === '.' || name === '..') fail('entry name must be a plain file name');
  if (usize > maxBytes) fail(`entry is larger than ${maxBytes} bytes`);
  if (localOff + 30 > cdOff || buf.readUInt32LE(localOff) !== ZIP_LOCAL) fail('bad local header');
  const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
  if (start + csize > cdOff) fail('entry data out of range');
  const body = buf.subarray(start, start + csize);
  let data;
  if (method === 0) {
    data = Buffer.from(body);
  } else if (method === 8) {
    try {
      data = inflateRawSync(body, { maxOutputLength: Math.max(1, usize) });
    } catch (err) {
      fail(`entry does not inflate (${err.code ?? err.message})`);
    }
  } else {
    fail(`compression method ${method} is not supported`);
  }
  if (data.length !== usize) fail('entry size does not match the central directory');
  if (crc32(data) !== crc) fail('entry crc32 does not match');
  return { name, data };
}

/**
 * Get the age ciphertext out of a downloaded artifact.
 * @returns {{container: 'raw'|'zip', ciphertext: Buffer}}
 */
export function unwrapArtifact(buf, expectedName, opts = {}) {
  if (isAgeCiphertext(buf)) return { container: 'raw', ciphertext: buf };
  if (isZip(buf)) {
    const { name, data } = readSingleEntryZip(buf, opts);
    if (name !== expectedName) throw new ContainerError(`zip: entry name ${JSON.stringify(name)} is not ${expectedName}`);
    if (!isAgeCiphertext(data)) throw new ContainerError('zip: the entry is not age ciphertext');
    return { container: 'zip', ciphertext: data };
  }
  throw new ContainerError('artifact is neither age ciphertext nor a zip holding it');
}
