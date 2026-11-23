// H2(c): crates.io daily DB dump, https://static.crates.io/db-dump.tar.gz (about 2.3 GB, CSV in a tar.gz).
// The dump is streamed once: bytes are hashed (sha256 of the whole archive) and only the entries we need
// are parsed, the rest is discarded. Nothing is written to disk. Documented columns used:
//   data/crates.csv          id, name, description, repository, updated_at, ...
//   data/keywords.csv        id, keyword
//   data/crates_keywords.csv crate_id, keyword_id
//   data/crate_downloads.csv crate_id, downloads
//   data/versions.csv        crate_id, num, created_at, yanked, ...
//   metadata.json            timestamp, crates_io_commit
// Columns are looked up by header name, so added columns do not break us.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { matchReasons } from './lib/matcher.mjs';

export const DUMP_URL = 'https://static.crates.io/db-dump.tar.gz';

/** Streaming CSV parser (RFC 4180 quoting, multi-line fields). Calls onRow(array) per record. */
export class CsvParser {
  constructor(onRow) { this.onRow = onRow; this.field = ''; this.row = []; this.inQ = false; this.pendingQuote = false; this.started = false; }
  push(str) {
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === '"') { this.field += '"'; continue; }
        this.inQ = false; // the quote closed the field; fall through to handle c
      }
      if (this.inQ) {
        if (c === '"') this.pendingQuote = true; else this.field += c;
      } else if (c === '"' && this.field === '') { this.inQ = true; this.started = true; }
      else if (c === ',') { this.row.push(this.field); this.field = ''; this.started = true; }
      else if (c === '\n') this.#endRow();
      else if (c === '\r') { /* ignore */ }
      else { this.field += c; this.started = true; }
    }
  }
  #endRow() {
    if (this.started || this.row.length) { this.row.push(this.field); this.onRow(this.row); }
    this.field = ''; this.row = []; this.started = false;
  }
  end() { this.pendingQuote = false; this.inQ = false; this.#endRow(); }
}

/** Parse a tar byte stream, yielding {name, stream-like chunk callbacks}. Only regular files. */
async function readTar(source, onEntry) {
  let buf = Buffer.alloc(0);
  let cur = null; // {remaining, pad, handler}
  let longName = null;
  const stepHeader = () => {
    while (!cur) {
      if (buf.length < 512) return;
      const h = buf.subarray(0, 512);
      if (h.every((b) => b === 0)) { buf = buf.subarray(512); continue; }
      let name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
      if (prefix) name = `${prefix}/${name}`;
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      buf = buf.subarray(512);
      if (longName === null && type === 'L') { cur = { remaining: size, pad: (512 - (size % 512)) % 512, handler: null, isLong: true, chunks: [] }; continue; }
      if (longName) { name = longName; longName = null; }
      const regular = type === '0' || type === '\0';
      cur = { remaining: size, pad: (512 - (size % 512)) % 512, handler: regular ? onEntry(name.replace(/^\.\//, '')) : null };
    }
  };
  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!cur) { stepHeader(); if (!cur) break; }
      if (cur.remaining > 0) {
        const n = Math.min(cur.remaining, buf.length);
        if (n === 0) break;
        const part = buf.subarray(0, n);
        if (cur.isLong) cur.chunks.push(part); else cur.handler?.write(part);
        cur.remaining -= n; buf = buf.subarray(n);
        if (cur.remaining > 0) break;
      }
      const n = Math.min(cur.pad, buf.length);
      cur.pad -= n; buf = buf.subarray(n);
      if (cur.pad > 0) break;
      if (cur.isLong) longName = Buffer.concat(cur.chunks).toString('utf8').replace(/\0.*$/, '');
      else cur.handler?.end();
      cur = null;
    }
  }
}

function csvHandler(onRecord) {
  let header = null;
  const dec = new TextDecoder();
  const p = new CsvParser((row) => {
    if (!header) { header = Object.fromEntries(row.map((n, i) => [n, i])); return; }
    onRecord((name) => row[header[name]]);
  });
  return { write: (b) => p.push(dec.decode(b, { stream: true })), end: () => p.end() };
}

/**
 * Process a dump given as a Readable/async-iterable of the raw .tar.gz bytes.
 * Returns {rows, dump:{sha256, bytes, timestamp, commit}, totals}.
 * `seedNames` (a Set of crate names from history/seed.txt) are kept even when the matcher
 * does not select them, with match reason `seed`, so H3 can count every seeded crate.
 */
export async function processDump(raw, { seedNames = new Set() } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  async function* tee() { for await (const c of raw) { hash.update(c); bytes += c.length; yield c; } }
  const gunzip = createGunzip();
  const unzipped = Readable.from(tee()).on('error', (e) => gunzip.destroy(e)).pipe(gunzip);

  const crates = new Map(); // id -> {name, description, repository, updated_at}
  const keywordNames = new Map();
  const crateKeywords = new Map(); // crate_id -> [keyword]
  const downloads = new Map();
  const versions = new Map(); // crate_id -> {count, latest}
  let metadata = '';
  const dec = new TextDecoder();
  await readTar(unzipped, (name) => {
    const base = name.replace(/^.*\/data\//, 'data/');
    if (/(^|\/)metadata\.json$/.test(name)) return { write: (b) => { metadata += dec.decode(b, { stream: true }); }, end() {} };
    if (/data\/crates\.csv$/.test(base)) return csvHandler((f) => crates.set(f('id'), { name: f('name'), description: f('description') ?? '', repository: f('repository') ?? '', updated_at: f('updated_at') ?? '' }));
    if (/data\/keywords\.csv$/.test(base)) return csvHandler((f) => keywordNames.set(f('id'), f('keyword')));
    if (/data\/crates_keywords\.csv$/.test(base)) return csvHandler((f) => { const a = crateKeywords.get(f('crate_id')) ?? []; a.push(f('keyword_id')); crateKeywords.set(f('crate_id'), a); });
    if (/data\/crate_downloads\.csv$/.test(base)) return csvHandler((f) => downloads.set(f('crate_id'), Number(f('downloads'))));
    if (/data\/versions\.csv$/.test(base)) return csvHandler((f) => {
      const v = versions.get(f('crate_id')) ?? { count: 0, latest: '' };
      v.count++; const t = f('created_at') ?? ''; if (t > v.latest) v.latest = t;
      versions.set(f('crate_id'), v);
    });
    return null;
  });

  const rows = [];
  for (const [id, c] of crates) {
    const keywords = (crateKeywords.get(id) ?? []).map((k) => keywordNames.get(k)).filter(Boolean);
    const match = matchReasons({ name: c.name, keywords, description: c.description });
    if (seedNames.has(c.name)) match.push('seed');
    if (!match.length) continue;
    rows.push({
      id: c.name, crate_id: Number(id), match, keywords,
      description_len: c.description.length, repository: c.repository, updated_at: c.updated_at,
      downloads_total: downloads.get(id) ?? null, versions: versions.get(id)?.count ?? 0, latest_version_at: versions.get(id)?.latest || null,
    });
  }
  rows.sort((a, b) => a.crate_id - b.crate_id);
  let meta = {};
  try { meta = JSON.parse(metadata); } catch { /* optional */ }
  return { rows, dump: { sha256: hash.digest('hex'), bytes, timestamp: meta.timestamp ?? null, commit: meta.crates_io_commit ?? null }, totals: { crates: crates.size } };
}

/** A short key for the seeded crate set, so a seed change re-reads an unchanged dump. */
export function seedKey(seedNames = new Set()) {
  return createHash('sha256').update([...seedNames].sort().join('\n')).digest('hex').slice(0, 16);
}

export async function runCrates({ http, state = {}, seedNames = new Set() }) {
  const head = await http.request(DUMP_URL, { method: 'HEAD' });
  const etag = head.headers.get('etag');
  const seed_key = seedKey(seedNames);
  if (etag && etag === state.etag && seed_key === (state.seed_key ?? seedKey())) return { rows: [], state, errors: [], skipped: true, note: 'dump unchanged (same ETag) and seed unchanged' };
  const res = await http.request(DUMP_URL);
  if (!res.ok) throw new Error(`GET ${DUMP_URL} -> HTTP ${res.status}`);
  const { rows, dump, totals } = await processDump(res.body, { seedNames });
  return { rows, state: { ...state, etag: res.headers.get('etag') ?? etag, dump_sha256: dump.sha256, seed_key }, errors: [], dump, totals };
}
