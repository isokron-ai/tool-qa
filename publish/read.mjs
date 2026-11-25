// Reading what ingest accepted, from its sealed outputs.
//
// Sources:
//   - a folder: every `keep-*.tar.age` under it (the pump's keep-forever files, or the
//     archive pull's `ingest/<day>/<artifact>/` layout), and every `*.tar` part of the
//     keep-forever release (`keep-<YYYY-MM>-<id>.tar`, which holds those files);
//   - the Actions artifacts `ingest-keep-<run>-<attempt>` of this repository (decided in
//     run.mjs, which hands the downloaded zips to `entriesFromZip`);
//   - a plain folder laid out as `accepted/<attempt>/<index>/...` (tests, fixtures).
//
// Only `accepted/<attempt>/<index>/` is read. `rejected/` and `quarantine/` are never
// opened as results, whatever they hold. An item is `accepted` only if its own
// ingest.json says so and agrees with its manifest (attempt, run key, fence); every
// file the publisher reads is checked against the sha256 in the manifest.
// Nothing decrypted is written to disk.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ageDecrypt } from '../ingest/age.mjs';
import { unpackBundle } from '../worker-kit/bundle.mjs';
import { readTar } from '../worker-kit/tar.mjs';

const ITEM_RE = /^accepted\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(\d{1,6})\/(.+)$/;
const WANT_RE = /^(manifest\.json|ingest\.json|observations\/[A-Za-z0-9._-]+\.ndjson)$/;
export const KEEP_FILE_RE = /(^|\/)keep-[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.tar\.age$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function parseJson(buf) {
  try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); } catch { return null; }
}

/**
 * Items from tar entries laid out as accepted/<attempt>/<index>/<path>.
 * @returns {{attempt: string, index: number, files: Map<string, Buffer>}[]}
 */
export function itemsFromEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const m = ITEM_RE.exec(e.path);
    if (!m || !WANT_RE.test(m[3])) continue;
    const k = `${m[1]}/${Number(m[2])}`;
    if (!groups.has(k)) groups.set(k, { attempt: m[1], index: Number(m[2]), files: new Map() });
    groups.get(k).files.set(m[3], Buffer.from(e.data));
  }
  return [...groups.values()];
}

/**
 * The checked form of one item, or a reason it is not publishable. Checks:
 * manifest and ingest.json are JSON; ingest.json says `accepted`; the manifest's
 * attempt, run key and fence are the ones ingest recorded; every observation file
 * is listed in the manifest with the digest it has.
 * @returns {{ok: true, item: object}|{ok: false, reason: string}}
 */
export function checkItem(group) {
  const manifest = parseJson(group.files.get('manifest.json'));
  const ingest = parseJson(group.files.get('ingest.json'));
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest_unreadable' };
  if (!ingest || typeof ingest !== 'object') return { ok: false, reason: 'ingest_report_missing' };
  if (ingest.outcome !== 'accepted') return { ok: false, reason: 'not_accepted' };
  if (manifest.schema_version !== 1) return { ok: false, reason: 'manifest_version' };
  if (manifest.attempt_id !== group.attempt) return { ok: false, reason: 'attempt_mismatch' };
  if (Number.isInteger(ingest.item_index) && ingest.item_index !== group.index) return { ok: false, reason: 'index_mismatch' };
  const led = ingest.ledger ?? {};
  if (led.run_key !== undefined && led.run_key !== manifest.run_key) return { ok: false, reason: 'run_key_mismatch' };
  if (led.fence !== undefined && led.fence !== manifest.fence) return { ok: false, reason: 'fence_mismatch' };
  if (typeof manifest.run_key !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.run_key)) return { ok: false, reason: 'run_key_missing' };
  const listed = new Map((manifest.files ?? []).map((f) => [f.path, f]));
  const observationFiles = new Map();
  for (const [path, data] of group.files) {
    if (!path.startsWith('observations/')) continue;
    const f = listed.get(path);
    if (!f || f.sha256 !== sha256(data) || f.bytes !== data.length) return { ok: false, reason: 'observation_digest' };
    observationFiles.set(path, data);
  }
  return {
    ok: true,
    item: {
      attempt_id: group.attempt,
      item_index: group.index,
      manifest,
      manifest_sha256: sha256(group.files.get('manifest.json')),
      ingest,
      observationFiles,
    },
  };
}

/** Entries of a decrypted sealed file (age, then zstd or plain tar). */
export function entriesFromSealed(ciphertext, { identity, ageBin = process.env.AGE_BIN || 'age' }) {
  return readTar(unpackBundle(ageDecrypt({ ciphertext, identity, ageBin })));
}

/** Entries of a keep-forever release part (a plain tar of `ingest-keep/<artifact>/<file>.tar.age`). */
export function sealedFilesInPart(partBuffer) {
  return readTar(partBuffer).filter((e) => KEEP_FILE_RE.test(e.path)).map((e) => ({ name: e.path, data: e.data }));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Sealed files under a folder: `keep-*.tar.age` files and keep-forever `*.tar` parts.
 * @returns {{name: string, data: Buffer}[]} sorted by name
 */
export function sealedFilesIn(dir) {
  const out = [];
  for (const file of walk(dir).sort()) {
    if (KEEP_FILE_RE.test(file)) out.push({ name: file, data: readFileSync(file) });
    else if (/\.tar$/.test(file) && /keep-\d{4}-\d{2}/.test(file)) out.push(...sealedFilesInPart(readFileSync(file)));
  }
  return out;
}

/** A plain folder laid out as accepted/<attempt>/<index>/<path>: entries for itemsFromEntries. */
export function entriesFromPlain(dir) {
  return walk(dir).map((p) => ({ path: p.slice(dir.length + 1).split('\\').join('/'), data: readFileSync(p) }));
}

export const isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
