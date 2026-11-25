// The member names of a zip in the bucket, read from its central directory
// with ranged GETs (the last 64 KiB, then the directory itself when it is
// bigger), so the off-site prune can tell what a full bundle or a keep-forever
// artifact holds without downloading it (R-RET-27). Names only: nothing is
// decrypted or even read; the members are age ciphertext.
//
// Anything that does not read cleanly throws: the prune treats an artifact it
// cannot list as unverified and keeps it (fail closed).

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const TAIL = 22 + 0xffff;
const MAX_ENTRIES = 10_000;

/**
 * @param {{ getRange: (key: string, range: { start: number, end: number }) => Promise<Buffer|null> }} store  the metered store
 * @param {string} key
 * @param {number} size  the object's size, from the listing
 * @returns {Promise<string[]>} the names of the files in the zip (folders left out)
 */
export async function zipMembers(store, key, size) {
  if (!Number.isSafeInteger(size) || size < 22) throw new Error(`${key}: too short to be a zip archive`);
  const tailLen = Math.min(size, TAIL);
  const tail = await store.getRange(key, { start: size - tailLen, end: size - 1 });
  if (!tail || tail.length !== tailLen) throw new Error(`${key}: could not read the end of the archive`);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${key}: not a zip archive (no end of central directory record)`);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error(`${key}: zip64 archives are not supported`);
  if (count > MAX_ENTRIES) throw new Error(`${key}: ${count} entries is more than the ${MAX_ENTRIES} allowed`);
  const eocdAt = size - tailLen + eocd;
  if (cdOffset + cdSize > eocdAt) throw new Error(`${key}: the central directory is outside the archive (truncated?)`);
  let cd;
  if (cdOffset >= size - tailLen) {
    cd = tail.subarray(cdOffset - (size - tailLen), cdOffset - (size - tailLen) + cdSize);
  } else if (cdSize === 0) {
    cd = Buffer.alloc(0);
  } else {
    cd = await store.getRange(key, { start: cdOffset, end: cdOffset + cdSize - 1 });
    if (!cd || cd.length !== cdSize) throw new Error(`${key}: could not read the central directory`);
  }
  const names = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new Error(`${key}: bad central directory entry ${i} (truncated?)`);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen > cd.length) throw new Error(`${key}: bad central directory entry ${i} (truncated?)`);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('/')) names.push(name);
  }
  return names;
}
