#!/usr/bin/env node
// Hourly versioned snapshots of the loop's state asset.
//
//   node snapshot/snapshot.mjs [--repo owner/name]
//
// The pump keeps the loop state as one overwritten release asset (`state.sqlite`
// on the release tagged `state`, age ciphertext; scripts/state-asset.mjs). This
// copies that asset, still encrypted, to the release tagged `state-snapshots`
// as `state-<UTC time>-<sha8>.sqlite.age`. It never decrypts anything and holds
// no key: it only needs a token that may write this repository's releases.
//
// Each run:
//   1. copies the live state asset: download, check the bytes against the
//      asset's `sha256:` label, check the asset is still the same one (id,
//      label, updated_at) after the download, and that it is age ciphertext.
//      If the pump replaced it while we copied, try once more; then fail.
//   2. reads `manifest.json` on the snapshot release and reconciles it with
//      the assets really there (an asset missing from the manifest is added
//      back from its name and label; an entry whose asset is gone is dropped).
//   3. if the newest snapshot has the same sha256, uploads nothing (dedupe);
//      otherwise uploads the copy, downloads it back and checks it.
//   4. retention: keeps the 48 newest snapshots and the newest snapshot of
//      each UTC day of the last 30 days; prunes the rest.
//   5. rewrites the manifest (time, sha256, size and the source asset's id and
//      updated_at for every snapshot; `current_at`: when a run last saw the
//      newest snapshot equal the live state), then deletes the pruned assets.
//
// The manifest is written before anything is deleted, and an asset left behind
// by a failed delete is picked up again by the next run. Environment:
// GITHUB_TOKEN (contents: write), GITHUB_REPOSITORY, GITHUB_API_URL,
// GITHUB_STEP_SUMMARY (optional).

import { createHash } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createReleaseClient } from './github.mjs';

export const SOURCE_TAG = 'state';
export const SOURCE_ASSET = 'state.sqlite';
export const SOURCE_UPLOAD_PREFIX = `${SOURCE_ASSET}.upload-`;
export const SNAPSHOT_TAG = 'state-snapshots';
export const MANIFEST = 'manifest.json';
const MANIFEST_UPLOAD_PREFIX = `${MANIFEST}.upload-`;
export const KEEP_RECENT = 48;
export const KEEP_DAYS = 30;
export const NAME_RE = /^state-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.sqlite\.age$/;
const AGE_MAGIC = 'age-encryption.org/v1\n';
const DAY = 24 * 3600 * 1000;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function isAgeCiphertext(buf) {
  return Buffer.isBuffer(buf) && buf.length >= AGE_MAGIC.length && buf.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC;
}

/** 20261124T023500Z for a time in ms. */
export function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function snapshotName(ms, sha) {
  if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new Error('snapshotName needs a sha256 hex digest');
  return `state-${stamp(ms)}-${sha.slice(0, 8)}.sqlite.age`;
}

/** { created: ISO time, sha8 } from a snapshot asset name, or null. */
export function parseSnapshotName(name) {
  const m = NAME_RE.exec(String(name));
  if (!m) return null;
  const s = m[1];
  const created = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  if (!Number.isFinite(Date.parse(created))) return null;
  return { created, sha8: m[2] };
}

export function labelSha(label) {
  const m = /^sha256:([0-9a-f]{64})$/.exec(String(label ?? ''));
  return m ? m[1] : null;
}

const byNewest = (a, b) => (a.created === b.created ? (a.name < b.name ? 1 : -1) : a.created < b.created ? 1 : -1);

/**
 * Which snapshots to keep: the `keepRecent` newest, plus the newest of each
 * UTC day whose snapshot is less than `keepDays` days old. Everything else is
 * pruned. The count is of snapshots, not hours: with dedupe, an idle loop
 * makes no new snapshots, so nothing it relies on ages out.
 * @returns {{ keep: object[], prune: object[] }} both newest first
 */
export function selectRetention(entries, { now, keepRecent = KEEP_RECENT, keepDays = KEEP_DAYS } = {}) {
  const sorted = [...entries].sort(byNewest);
  const keep = new Set(sorted.slice(0, keepRecent));
  const cutoff = now - keepDays * DAY;
  const days = new Set();
  for (const e of sorted) {
    const t = Date.parse(e.created);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(e);
  }
  return { keep: sorted.filter((e) => keep.has(e)), prune: sorted.filter((e) => !keep.has(e)) };
}

/** The newest snapshot, or null. */
export function newest(entries) {
  return [...entries].sort(byNewest)[0] ?? null;
}

/** Dedupe: true when the newest snapshot already holds these bytes. */
export function isUnchanged(entries, sha) {
  return newest(entries)?.sha256 === sha;
}

/** Check downloaded snapshot bytes against their manifest entry. */
export function verifySnapshot(bytes, entry) {
  if (!entry || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) return { ok: false, reason: 'the manifest entry has no sha256' };
  if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'no bytes' };
  if (Number.isInteger(entry.size) && bytes.length !== entry.size) {
    return { ok: false, reason: `size ${bytes.length} is not the manifest's ${entry.size}` };
  }
  const got = sha256(bytes);
  if (got !== entry.sha256) return { ok: false, reason: `sha256 ${got} is not the manifest's ${entry.sha256}` };
  const parsed = parseSnapshotName(entry.name);
  if (parsed && parsed.sha8 !== got.slice(0, 8)) return { ok: false, reason: 'the name does not carry this sha256' };
  if (!isAgeCiphertext(bytes)) return { ok: false, reason: 'not age ciphertext' };
  return { ok: true, sha256: got };
}

const uploaded = (a) => !a.state || a.state === 'uploaded';

/** The live state asset as the pump picks it: `state.sqlite`, else the newest interrupted upload. */
export function pickSource(assets) {
  const list = (assets ?? []).filter(uploaded);
  const main = list.find((a) => a.name === SOURCE_ASSET);
  if (main) return main;
  return list.filter((a) => String(a.name).startsWith(SOURCE_UPLOAD_PREFIX)).sort((a, b) => b.id - a.id)[0] ?? null;
}

const describeSource = (a) => ({ asset_id: a.id, name: a.name, updated_at: a.updated_at ?? null, size: a.size ?? null });

/**
 * Copy the live state asset without trusting that it stood still: the bytes
 * must match the asset's sha256 label, and the asset must be the same (id,
 * label, updated_at) once the download is done. If the pump pushed in
 * between, copy once more.
 * @returns {Promise<{status: 'absent'} | {status: 'copied', bytes: Buffer, sha256: string, source: object, tries: number}>}
 */
export async function copyStateAsset({ gh, log = () => {}, tries = 2 }) {
  let why = '';
  for (let i = 1; i <= tries; i++) {
    const release = await gh.getRelease(SOURCE_TAG);
    const asset = release && pickSource(release.assets);
    if (!asset) return { status: 'absent' };
    const want = labelSha(asset.label);
    if (!want) throw new Error(`${asset.name} has no sha256 label, so a copy of it cannot be checked; not taking a snapshot`);
    const bytes = await gh.download(asset);
    const got = sha256(bytes);
    const after = await gh.getRelease(SOURCE_TAG);
    const now = after && pickSource(after.assets);
    if (got !== want) why = `the bytes (sha256 ${got.slice(0, 12)}) do not match the label (${want.slice(0, 12)})`;
    else if (!now || now.id !== asset.id || now.label !== asset.label || (now.updated_at ?? null) !== (asset.updated_at ?? null)) {
      why = 'the asset was replaced while it was copied';
    } else {
      if (!isAgeCiphertext(bytes)) throw new Error(`${asset.name} is not age ciphertext; refusing to keep a copy of it`);
      return { status: 'copied', bytes, sha256: got, source: describeSource(asset), tries: i };
    }
    log(`state-snapshot: copy ${i} of ${tries} failed: ${why}${i < tries ? '; trying again' : ''}`);
  }
  throw new Error(`could not copy a stable state asset in ${tries} tries (${why}); the next run will try again`);
}

/** Parse manifest text; null if it is not one of ours. */
export function parseManifest(text) {
  try {
    const m = JSON.parse(text);
    return m && m.version === 1 && Array.isArray(m.snapshots) ? m : null;
  } catch {
    return null;
  }
}

/**
 * The snapshots really on the release, with what the manifest knows of them.
 * @returns {{ entries: object[], dropped: string[], added: string[] }}
 */
export function reconcile(manifest, assets) {
  const known = new Map((manifest?.snapshots ?? []).map((e) => [e.name, e]));
  const entries = [];
  const added = [];
  const present = new Set();
  for (const a of assets ?? []) {
    const parsed = parseSnapshotName(a.name);
    if (!parsed || !uploaded(a)) continue;
    present.add(a.name);
    const k = known.get(a.name);
    if (k) {
      entries.push({ ...k, asset_id: a.id });
      continue;
    }
    added.push(a.name);
    entries.push({ name: a.name, asset_id: a.id, created: parsed.created, sha256: labelSha(a.label), size: a.size ?? null, source: null });
  }
  const dropped = [...known.keys()].filter((n) => !present.has(n));
  return { entries: entries.sort(byNewest), dropped, added };
}

export function buildManifest({ repo, entries, currentAt, now }) {
  return {
    version: 1,
    about: 'Versioned copies of the loop state asset (age ciphertext, never decrypted here). See docs/OPERATIONS.md, "State snapshots".',
    source: { repo, tag: SOURCE_TAG, asset: SOURCE_ASSET },
    retention: { keep_recent: KEEP_RECENT, keep_daily_days: KEEP_DAYS },
    updated: new Date(now).toISOString(),
    current_at: currentAt,
    snapshots: [...entries].sort(byNewest).map(({ name, asset_id, created, sha256: s, size, source }) => ({ name, asset_id, created, sha256: s, size, source })),
  };
}

async function readManifest(gh, assets, log) {
  const a = assets.find((x) => x.name === MANIFEST && uploaded(x));
  if (!a) return null;
  const parsed = parseManifest((await gh.download(a)).toString('utf8'));
  if (!parsed) log(`state-snapshot: ${MANIFEST} could not be read; rebuilding it from the assets`);
  return parsed;
}

/** Replace manifest.json: upload under a temporary name, delete the old one, rename. */
async function writeManifest(gh, release, assets, manifest, now) {
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const up = await gh.upload(release, `${MANIFEST_UPLOAD_PREFIX}${stamp(now)}`, data, `sha256:${sha256(data)}`);
  for (const a of assets) {
    if (a.id !== up.id && (a.name === MANIFEST || String(a.name).startsWith(MANIFEST_UPLOAD_PREFIX))) await gh.deleteAsset(a.id);
  }
  await gh.renameAsset(up.id, MANIFEST);
}

/**
 * One snapshot run. See the header.
 * @returns {Promise<object>} what happened, for the log and the step summary
 */
export async function runSnapshot({ gh, now = Date.now, log = () => {} }) {
  const copy = await copyStateAsset({ gh, log });
  if (copy.status === 'absent') {
    log('state-snapshot: there is no state asset; nothing to copy');
    return { status: 'absent' };
  }
  const t = now();
  let release = await gh.getRelease(SNAPSHOT_TAG);
  if (!release) {
    release = await gh.createRelease({
      tag: SNAPSHOT_TAG,
      name: 'Loop state snapshots',
      body: 'Hourly versioned copies of the loop state asset (age ciphertext). Kept by .github/workflows/state-snapshot.yml; this is not a software release. See docs/OPERATIONS.md, "State snapshots".',
    });
  }
  let assets = await gh.listAssets(release);
  const manifest = await readManifest(gh, assets, log);
  const { entries, dropped, added } = reconcile(manifest, assets);
  if (dropped.length) log(`state-snapshot: the manifest listed ${dropped.length} snapshot(s) no longer on the release: ${dropped.join(', ')}`);
  if (added.length) log(`state-snapshot: added ${added.length} snapshot(s) the manifest did not list: ${added.join(', ')}`);

  let status = 'unchanged';
  let made = newest(entries);
  if (!isUnchanged(entries, copy.sha256)) {
    const name = snapshotName(t, copy.sha256);
    const label = `sha256:${copy.sha256}`;
    const up = await gh.upload(release, name, copy.bytes, label);
    const entry = { name, asset_id: up.id, created: new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'), sha256: copy.sha256, size: copy.bytes.length, source: copy.source };
    // Read it back: a snapshot that cannot be restored is worse than none.
    const back = await gh.download(up);
    const v = verifySnapshot(back, entry);
    if (!v.ok) {
      await gh.deleteAsset(up.id).catch(() => {});
      throw new Error(`the uploaded snapshot ${name} did not read back intact (${v.reason}); deleted it`);
    }
    entries.unshift(entry);
    made = entry;
    status = 'snapshotted';
    assets = [...assets, up];
  }
  const { keep, prune } = selectRetention(entries, { now: t });
  const next = buildManifest({ repo: gh.repo, entries: keep, currentAt: new Date(t).toISOString(), now: t });
  await writeManifest(gh, release, assets, next, t);
  for (const p of prune) await gh.deleteAsset(p.asset_id);
  const result = {
    status,
    snapshot: made?.name ?? null,
    sha256: copy.sha256,
    size: copy.bytes.length,
    source: copy.source,
    copy_tries: copy.tries,
    kept: keep.length,
    pruned: prune.map((p) => p.name),
  };
  log(`state-snapshot: ${status === 'snapshotted' ? `saved ${made.name}` : `unchanged since ${made?.name}`} (${copy.bytes.length} bytes, sha256 ${copy.sha256}); ${keep.length} kept, ${prune.length} pruned`);
  return result;
}

function summary(r) {
  const lines = ['### State snapshot', ''];
  if (r.status === 'absent') return [...lines, 'There is no state asset yet; nothing was copied.', ''].join('\n');
  lines.push(
    r.status === 'snapshotted' ? `Saved \`${r.snapshot}\`.` : `The state is unchanged since \`${r.snapshot}\`; nothing uploaded.`,
    '',
    `- sha256: \`${r.sha256}\``,
    `- size: ${r.size} bytes`,
    `- source asset: ${r.source.name} (id ${r.source.asset_id}, updated ${r.source.updated_at})`,
    `- copy attempts: ${r.copy_tries}`,
    `- snapshots kept: ${r.kept}; pruned: ${r.pruned.length ? r.pruned.join(', ') : 'none'}`,
    '',
  );
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let repo = env.GITHUB_REPOSITORY;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repo = argv[++i];
    else {
      process.stderr.write(`state-snapshot: unknown argument ${JSON.stringify(argv[i])}\nusage: node snapshot/snapshot.mjs [--repo owner/name]\n`);
      return 2;
    }
  }
  const token = env.GITHUB_TOKEN || undefined;
  const log = (m) => process.stderr.write(`${token ? String(m).split(token).join('***') : m}\n`);
  try {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    const gh = createReleaseClient({ repo, token, apiUrl: env.GITHUB_API_URL, log });
    const r = await runSnapshot({ gh, log });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(r));
    return 0;
  } catch (err) {
    log(`state-snapshot: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
