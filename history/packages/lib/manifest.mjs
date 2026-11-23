// Shared NDJSON.gz and manifest writers for H2 and H3.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write rows as NDJSON.gz (gzip header carries no mtime, so output is reproducible). Returns the file name. */
export function writeNdjsonGz(dir, name, rows) {
  mkdirSync(dir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(dir, name), gzipSync(Buffer.from(body), { level: 9 }));
  return name;
}

/**
 * Write `manifest-<source>.json` with per-file sha256, row counts, timing and errors.
 * `files` is [{name, rows}]; the file must already exist in `dir`.
 */
export function writeManifest({ dir, source, files, startedAt, finishedAt, errors = [], extra = {} }) {
  const manifest = {
    schema: 1,
    source,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    ok: errors.length === 0,
    errors: errors.map((e) => String(e)),
    files: files.map((f) => {
      const bytes = readFileSync(join(dir, f.name));
      return { name: f.name, rows: f.rows, bytes: bytes.length, sha256: sha256(bytes) };
    }),
    ...extra,
  };
  const name = `manifest-${source}.json`;
  writeFileSync(join(dir, name), JSON.stringify(manifest, null, 2) + '\n');
  return { name, manifest };
}
