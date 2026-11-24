// The codec for sealed ingest bundles (loop upgrade 20).
//
// The pump writes each sealed output as age(zstd(tar)); outputs sealed before
// that are age(tar). Readers tell them apart by the first bytes, not by the file
// name, so an archive that holds both reads the same way. Node's own zlib does
// the zstd (no dependency); a Node without it fails loudly, never by sealing
// something a reader could not open.
//
// Plain zstd, no trained dictionary: a dictionary would have to be kept for as
// long as any bundle made with it.

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** The four magic bytes every zstd frame starts with (RFC 8878). */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Level 12: within 7% of level 19 on a typical bundle, and fast enough for the pump tick on the largest one the contract allows. */
export const ZSTD_LEVEL = 12;
/** The most a bundle may inflate to: the contract's cap is 64 MiB of files, and headers and padding add a little. */
export const DEFAULT_MAX_TAR_BYTES = 256 * 1024 ** 2;

export class BundleCodecError extends Error {
  constructor(message) {
    super(`bundle: ${message}`);
    this.name = 'BundleCodecError';
  }
}

/** True when this Node can write and read zstd. */
export const zstdAvailable = () => typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function';

/** 'zstd' or 'tar', from the magic bytes. */
export function bundleFormat(buf) {
  return buf.length >= ZSTD_MAGIC.length && buf.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC) ? 'zstd' : 'tar';
}

/** zstd of a tar, checked by reading it back before it is returned. */
export function packBundle(tar, { level = ZSTD_LEVEL } = {}) {
  if (!zstdAvailable()) throw new BundleCodecError(`this Node (${process.version}) has no zstd in zlib`);
  const packed = zstdCompressSync(tar, { params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_checksumFlag]: 1 } });
  const back = zstdDecompressSync(packed, { maxOutputLength: tar.length + 1 });
  if (!back.equals(tar)) throw new BundleCodecError('the compressed bundle does not read back to the same bytes');
  return packed;
}

/** The tar inside a decrypted bundle, old (plain tar) or new (zstd). */
export function unpackBundle(buf, { maxBytes = DEFAULT_MAX_TAR_BYTES } = {}) {
  if (bundleFormat(buf) === 'tar') return buf;
  if (!zstdAvailable()) throw new BundleCodecError(`this bundle is zstd but this Node (${process.version}) has no zstd in zlib`);
  try {
    return zstdDecompressSync(buf, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new BundleCodecError(`cannot decompress the bundle: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`);
  }
}
