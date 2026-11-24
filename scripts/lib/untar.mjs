// Safe reader for third-party tar and tar.gz archives (package tarballs, source
// archives). No dependencies, and it never touches the filesystem: entries are
// hashed, and their bytes are kept in memory only when the caller asks.
//
// worker-kit/tar.mjs reads only the bundles we write ourselves and refuses
// everything else. This reader takes the formats registries and GitHub really
// serve (ustar, pax extended and global headers, GNU long names, base-256
// sizes), with the same protections as scripts/lib/unzip.mjs:
//
//   paths     an absolute path, a drive letter, a backslash, a NUL or a '..'
//             segment refuses that entry (zip-slip); '.' and empty segments
//             are dropped. Nothing is written anywhere, so a refused entry is
//             only recorded.
//   links     symbolic links, hard links, devices and FIFOs are recorded and
//             never followed or read.
//   caps      the entry count, and the bytes inflated: every byte gunzip gives
//             counts, whether the entry it belongs to is then kept, refused or
//             skipped, so the cap bounds the work as well as what is kept
//             (R-ARC-11's rule for zips). A header that declares more than the
//             cap left is refused before its data is read. The compressed
//             input has its own cap, and so does each kept entry.
//   format    a header checksum that does not match, a size field that cannot
//             be read, or data that ends inside an entry fails the archive.
//
// Over a cap: ArchiveLimit (code 'too_large'). Malformed: ArchiveError
// (code 'malformed').

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;

export const TAR_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxInflatedBytes: 256 * 1024 ** 2,
  maxCompressedBytes: 64 * 1024 ** 2,
  maxKeptEntryBytes: 16 * 1024 ** 2,
  maxKeptTotalBytes: 128 * 1024 ** 2,
  maxMetaBytes: 1024 ** 2,
});

export class ArchiveError extends Error {
  constructor(message) {
    super(`untar: ${message}`);
    this.name = 'ArchiveError';
    this.code = 'malformed';
  }
}

export class ArchiveLimit extends Error {
  constructor(message) {
    super(`untar: ${message}`);
    this.name = 'ArchiveLimit';
    this.code = 'too_large';
  }
}

/**
 * A safe relative path, normalised ('.' and empty segments dropped, a trailing
 * '/' removed), or null when it could leave the folder it is unpacked into.
 */
export function safeArchivePath(name) {
  if (typeof name !== 'string' || name === '' || name.length > 4096) return null;
  if (name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function cstr(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end === -1 || end > start + len ? start + len : end);
}

function parseNumber(buf, start, len, what) {
  if (buf[start] & 0x80) {
    // GNU base-256: big-endian, the first byte's top bit is the marker.
    if (buf[start] === 0xff) throw new ArchiveError(`${what} is negative`);
    let n = buf[start] & 0x7f;
    for (let i = start + 1; i < start + len; i++) {
      n = n * 256 + buf[i];
      if (n > Number.MAX_SAFE_INTEGER) throw new ArchiveError(`${what} is too large to read`);
    }
    return n;
  }
  const s = cstr(buf, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError(`${what} is not an octal number`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new ArchiveError(`${what} is too large to read`);
  return n;
}

function checksumOk(h) {
  const want = parseNumber(h, 148, 8, 'the header checksum');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return want === unsigned || want === signed;
}

/** pax records "<len> <key>=<value>\n"; only the keys we use are returned. */
function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.toString('ascii', i, sp));
    if (!Number.isSafeInteger(len) || len <= sp - i || i + len > data.length) throw new ArchiveError('a pax record is malformed');
    const rec = data.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const k = rec.slice(0, eq);
      if (k === 'path' || k === 'linkpath' || k === 'size' || k === 'comment') out[k] = rec.slice(eq + 1);
    }
    i += len;
  }
  return out;
}

const TYPES = {
  '0': 'file', '\0': 'file', '7': 'file', '5': 'dir', '2': 'symlink', '1': 'hardlink',
  '3': 'device', '4': 'device', '6': 'fifo',
};

/**
 * An incremental tar parser.
 * @param {object} o
 * @param {(e: {path: string, size: number, mode: number}) => boolean} [o.keep]  keep this file's bytes?
 * @param {(f: {path, size, mode, sha256, data}) => void} [o.onFile]  called once per file read; it may set
 *   f.data to null to drop the bytes (they then stop counting toward maxKeptTotalBytes)
 * @param {Partial<typeof TAR_LIMITS>} [o.limits]
 * @returns {{ push(chunk: Buffer): void, end(): object }}
 */
export function createTarParser({ keep = () => false, onFile = null, limits = {} } = {}) {
  const L = { ...TAR_LIMITS, ...limits };
  const files = new Map();
  const links = [];
  const refused = [];
  const duplicates = [];
  const others = [];
  let dirs = 0;
  let entries = 0;
  let declared = 0;
  let kept = 0;
  let globalComment = null;
  let ended = false;

  let pending = Buffer.alloc(0);
  // The entry whose data is being read: { header, remaining, pad, hash, chunks, meta }
  let cur = null;
  let paxNext = null;
  let gnuName = null;
  let gnuLink = null;

  function startEntry(h) {
    if (!checksumOk(h)) throw new ArchiveError('a header checksum does not match');
    const typeflag = String.fromCharCode(h[156]);
    let size = parseNumber(h, 124, 12, 'an entry size');
    const isMeta = typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K';
    if (!isMeta && paxNext?.size !== undefined) {
      const s = Number(paxNext.size);
      if (!Number.isSafeInteger(s) || s < 0) throw new ArchiveError('a pax size is malformed');
      size = s;
    }
    entries++;
    if (entries > L.maxEntries) throw new ArchiveLimit(`more than ${L.maxEntries} entries`);
    if (isMeta && size > L.maxMetaBytes) throw new ArchiveLimit(`a ${typeflag} header of ${size} bytes is over the ${L.maxMetaBytes}-byte cap`);
    // Declared sizes count before any data is read, so one header cannot ask for more than is left.
    declared += size;
    if (declared > L.maxInflatedBytes) throw new ArchiveLimit(`the entries declare more than ${L.maxInflatedBytes} bytes`);
    const magic = h.toString('ascii', 257, 262);
    let name = cstr(h, 0, 100);
    if (magic === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    let linkname = cstr(h, 157, 100);
    if (!isMeta) {
      if (gnuName !== null) name = gnuName;
      if (gnuLink !== null) linkname = gnuLink;
      if (paxNext?.path !== undefined) name = paxNext.path;
      if (paxNext?.linkpath !== undefined) linkname = paxNext.linkpath;
      paxNext = null;
      gnuName = null;
      gnuLink = null;
    }
    const mode = (() => { try { return parseNumber(h, 100, 8, 'a mode'); } catch { return 0; } })();
    const type = isMeta ? typeflag : (TYPES[typeflag] ?? 'other');
    const path = isMeta ? null : safeArchivePath(name);
    const header = { raw: name, path, type, size, mode: mode & 0o7777, linkname };
    let keepBytes = isMeta;
    if (!isMeta && type === 'file' && path) {
      if (keep({ path, size, mode: header.mode })) {
        if (size <= L.maxKeptEntryBytes && kept + size <= L.maxKeptTotalBytes) { keepBytes = true; kept += size; }
        else header.not_kept = 'cap';
      }
    }
    cur = { header, remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, hash: !isMeta && type === 'file' && path ? createHash('sha256') : null, chunks: keepBytes ? [] : null };
    if (size === 0) finishEntry();
  }

  function finishEntry() {
    const { header, hash, chunks } = cur;
    const data = chunks ? Buffer.concat(chunks) : null;
    cur.done = true;
    const t = header.type;
    if (t === 'x') paxNext = { ...(paxNext ?? {}), ...parsePax(data) };
    else if (t === 'g') {
      const g = parsePax(data);
      if (typeof g.comment === 'string' && globalComment === null) globalComment = g.comment.slice(0, 200);
    } else if (t === 'L') gnuName = cstr(data, 0, data.length);
    else if (t === 'K') gnuLink = cstr(data, 0, data.length);
    else if (!header.path) refused.push({ name: header.raw.slice(0, 300), type: t, reason: 'unsafe_path' });
    else if (t === 'dir') dirs++;
    else if (t === 'symlink' || t === 'hardlink') links.push({ path: header.path, type: t, target: header.linkname.slice(0, 300) });
    else if (t === 'file') {
      if (files.has(header.path)) duplicates.push(header.path);
      const rec = { path: header.path, size: header.size, mode: header.mode, sha256: hash.digest('hex'), data, ...(header.not_kept ? { not_kept: header.not_kept } : {}) };
      if (onFile) {
        onFile(rec);
        if (data && rec.data === null) kept -= header.size;
      }
      files.set(header.path, rec);
    } else others.push({ path: header.path, type: t });
  }

  function push(chunk) {
    if (ended) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    while (off < pending.length && !ended) {
      if (cur && !cur.done) {
        if (cur.remaining > 0) {
          const n = Math.min(cur.remaining, pending.length - off);
          const piece = pending.subarray(off, off + n);
          if (cur.hash) cur.hash.update(piece);
          if (cur.chunks) cur.chunks.push(Buffer.from(piece));
          cur.remaining -= n;
          off += n;
          if (cur.remaining === 0) finishEntry();
          continue;
        }
      }
      if (cur && cur.done && cur.pad > 0) {
        const n = Math.min(cur.pad, pending.length - off);
        cur.pad -= n;
        off += n;
        continue;
      }
      if (pending.length - off < BLOCK) break;
      const h = pending.subarray(off, off + BLOCK);
      off += BLOCK;
      cur = null;
      if (h.every((b) => b === 0)) { ended = true; break; }
      startEntry(h);
    }
    pending = pending.subarray(off);
    if (pending.length > 0) pending = Buffer.from(pending);
  }

  function end() {
    if (cur && !cur.done) throw new ArchiveError('the archive ends inside an entry');
    if (!ended && pending.length > 0) throw new ArchiveError('the archive ends inside a header');
    return { files, links, refused, duplicates: [...new Set(duplicates)], others, dirs, entries, global_comment: globalComment, kept_bytes: kept };
  }

  return { push, end, get ended() { return ended; } };
}

/** Read a whole tar from a Buffer. */
export function readTar(buf, opts = {}) {
  const p = createTarParser(opts);
  p.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return p.end();
}

async function* counted(source, max, stats) {
  for await (const c of source) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength ?? c.length);
    stats.compressed += b.length;
    if (stats.compressed > max) throw new ArchiveLimit(`the compressed archive is over the ${max}-byte cap`);
    yield b;
  }
}

/**
 * Read a gzip-compressed tar from a Buffer, an async iterable of chunks or a
 * web ReadableStream. Every inflated byte counts toward maxInflatedBytes.
 * @returns {Promise<object>} what readTar returns, plus compressed_bytes and inflated_bytes
 */
export async function readTarGz(source, { keep, onFile, limits = {} } = {}) {
  const L = { ...TAR_LIMITS, ...limits };
  const stats = { compressed: 0, inflated: 0 };
  let input = source;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) input = [Buffer.from(source)];
  else if (source && typeof source.getReader === 'function') input = Readable.fromWeb(source);
  const gunzip = createGunzip();
  const fed = Readable.from(counted(input, L.maxCompressedBytes, stats));
  fed.on('error', (err) => gunzip.destroy(err));
  fed.pipe(gunzip);
  const parser = createTarParser({ keep, onFile, limits: L });
  try {
    for await (const out of gunzip) {
      stats.inflated += out.length;
      if (stats.inflated > L.maxInflatedBytes) throw new ArchiveLimit(`the archive inflates to more than ${L.maxInflatedBytes} bytes`);
      parser.push(out);
      if (parser.ended) break;
    }
  } catch (err) {
    if (err instanceof ArchiveLimit || err instanceof ArchiveError) throw err;
    throw new ArchiveError(`the gzip stream could not be read (${err?.code ?? err?.name ?? 'error'})`);
  } finally {
    fed.unpipe(gunzip);
    fed.destroy();
    gunzip.destroy();
  }
  return { ...parser.end(), compressed_bytes: stats.compressed, inflated_bytes: stats.inflated };
}
