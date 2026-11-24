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
//      Losing that race on both tries is not a failure: the run ends with
//      a notice and the next run tries again.
//   2. reads `manifest.json` on the snapshot release (malformed entries are
//      left out) and reconciles it with the assets really there: an asset the
//      manifest does not list is downloaded and verified against its name and
//      label before it is added back (deleted if it fails), and an entry whose
//      asset is gone is dropped. Dedupe only ever compares verified entries.
//   3. if the newest snapshot has the same sha256, uploads nothing (dedupe);
//      otherwise uploads the copy, downloads it back and checks it.
//   4. retention: keeps the 24 newest snapshots, the newest snapshot of each
//      UTC day of the last 14 days and the newest of each UTC week (Monday
//      to Sunday) of the last 8 weeks; prunes the rest. The newest snapshot
//      is always kept.
//   5. rewrites the manifest (time, sha256, size and the source asset's id and
//      updated_at for every snapshot; `current_at`: when a run last saw the
//      newest snapshot equal the live state), then deletes the pruned assets.
//
// The manifest is written before anything is deleted, and an asset left behind
// by a failed delete is picked up again by the next run. Environment:
// GITHUB_TOKEN (contents: write), GITHUB_REPOSITORY, GITHUB_API_URL,
// GITHUB_STEP_SUMMARY (optional).
//
// Since loop upgrade #14 the pump gzips the database before it encrypts it,
// so new snapshots are about a quarter of the size; this job still never
// decrypts and copies whatever ciphertext the pump pushed. Older snapshots
// stay as they were and the restore drill reads both.

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
export const KEEP_RECENT = 24;
export const KEEP_DAYS = 14;
export const KEEP_WEEKS = 8;
export const NAME_RE = /^state-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.sqlite\.age$/;
const AGE_MAGIC = 'age-encryption.org/v1\n';
const DAY = 24 * 3600 * 1000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;

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

/** The UTC Monday (YYYY-MM-DD) of the week a time falls in. */
export function weekOf(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7; // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/**
 * Which snapshots to keep: the `keepRecent` newest (at least one, so the
 * newest is never pruned), plus the newest of each UTC day whose snapshot is
 * less than `keepDays` days old, plus the newest of each UTC week (from
 * Monday) whose snapshot is less than `keepWeeks` weeks old. Everything else
 * is pruned. The count is of snapshots, not hours: with dedupe, an idle loop
 * makes no new snapshots, so nothing it relies on ages out.
 * @returns {{ keep: object[], prune: object[] }} both newest first
 */
export function selectRetention(entries, { now, keepRecent = KEEP_RECENT, keepDays = KEEP_DAYS, keepWeeks = KEEP_WEEKS } = {}) {
  const sorted = [...entries].sort(byNewest);
  const keep = new Set(sorted.slice(0, Math.max(1, keepRecent)));
  const newestPer = (span, bucket) => {
    const cutoff = now - span;
    const seen = new Set();
    for (const e of sorted) {
      const t = Date.parse(e.created);
      if (!Number.isFinite(t) || t < cutoff) continue;
      const b = bucket(t);
      if (seen.has(b)) continue;
      seen.add(b);
      keep.add(e);
    }
  };
  newestPer(keepDays * DAY, (t) => new Date(t).toISOString().slice(0, 10));
  newestPer(keepWeeks * 7 * DAY, weekOf);
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
 * between (the asset changed, or vanished under the download), copy once
 * more. Losing that race every time is not an error: the result is `busy`
 * and the next run tries again (the health item reports staleness). Bytes
 * that do not match an unchanged asset's label, twice, are an error.
 * @returns {Promise<{status: 'absent'} | {status: 'busy', why: string, tries: number} |
 *   {status: 'copied', bytes: Buffer, sha256: string, source: object, tries: number}>}
 */
export async function copyStateAsset({ gh, log = () => {}, tries = 2 }) {
  let why = '';
  let raced = false;
  for (let i = 1; i <= tries; i++) {
    const release = await gh.getRelease(SOURCE_TAG);
    const asset = release && pickSource(release.assets);
    if (!asset) return { status: 'absent' };
    const want = labelSha(asset.label);
    if (!want) throw new Error(`${asset.name} has no sha256 label, so a copy of it cannot be checked; not taking a snapshot`);
    let bytes = null;
    let downloadError = null;
    try {
      bytes = await gh.download(asset);
    } catch (err) {
      downloadError = err;
    }
    const after = await gh.getRelease(SOURCE_TAG);
    const now = after && pickSource(after.assets);
    const moved = !now || now.id !== asset.id || now.label !== asset.label || (now.updated_at ?? null) !== (asset.updated_at ?? null);
    if (moved) {
      raced = true;
      why = 'the asset was replaced while it was copied';
    } else if (downloadError) {
      throw downloadError;
    } else {
      const got = sha256(bytes);
      if (got !== want) {
        raced = false;
        why = `the bytes (sha256 ${got.slice(0, 12)}) do not match the label (${want.slice(0, 12)})`;
      } else {
        if (!isAgeCiphertext(bytes)) throw new Error(`${asset.name} is not age ciphertext; refusing to keep a copy of it`);
        return { status: 'copied', bytes, sha256: got, source: describeSource(asset), tries: i };
      }
    }
    log(`state-snapshot: copy ${i} of ${tries} failed: ${why}${i < tries ? '; trying again' : ''}`);
  }
  if (raced) return { status: 'busy', why, tries };
  throw new Error(`could not copy a stable state asset in ${tries} tries (${why}); the next run will try again`);
}

/**
 * One manifest entry, checked: the name must be a snapshot name and the
 * sha256 64 hex digits that the name carries. `created` always comes from the
 * name, never from the manifest. Returns null for anything else.
 */
export function cleanEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const parsed = parseSnapshotName(e.name);
  if (!parsed) return null;
  if (!/^[0-9a-f]{64}$/.test(String(e.sha256)) || e.sha256.slice(0, 8) !== parsed.sha8) return null;
  const size = Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : null;
  const source = e.source && typeof e.source === 'object' && !Array.isArray(e.source) ? e.source : null;
  return { name: e.name, asset_id: Number.isSafeInteger(e.asset_id) ? e.asset_id : null, created: parsed.created, sha256: e.sha256, size, source };
}

/**
 * Parse manifest text; null if it is not one of ours. Entries that fail
 * cleanEntry() are left out (`rejected` counts them), so a damaged entry can
 * neither crash a run nor pin itself as the newest.
 */
export function parseManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || m.version !== 1 || !Array.isArray(m.snapshots)) return null;
  const snapshots = [];
  const seen = new Set();
  let rejected = 0;
  for (const raw of m.snapshots) {
    const e = cleanEntry(raw);
    if (!e || seen.has(e.name)) {
      rejected++;
      continue;
    }
    seen.add(e.name);
    snapshots.push(e);
  }
  const currentAt = typeof m.current_at === 'string' && Number.isFinite(Date.parse(m.current_at)) ? m.current_at : null;
  return { ...m, current_at: currentAt, snapshots, rejected };
}

/** An entry for a snapshot asset the manifest does not list, from its name and label (not yet verified). */
export function orphanEntry(a) {
  const parsed = parseSnapshotName(a.name);
  return parsed && { name: a.name, asset_id: a.id, created: parsed.created, sha256: labelSha(a.label), size: Number.isSafeInteger(a.size) ? a.size : null, source: null };
}

/**
 * The snapshots really on the release, with what the manifest knows of them.
 * `entries` are the manifest's (verified when they were written); `unknown`
 * are snapshot assets the manifest does not list, which must be downloaded
 * and verified before they are trusted.
 * @returns {{ entries: object[], unknown: object[], dropped: string[] }}
 */
export function reconcile(manifest, assets) {
  const known = new Map((manifest?.snapshots ?? []).map((e) => [e.name, e]));
  const entries = [];
  const unknown = [];
  const present = new Set();
  for (const a of assets ?? []) {
    if (!parseSnapshotName(a.name) || !uploaded(a)) continue;
    present.add(a.name);
    const k = known.get(a.name);
    if (k) entries.push({ ...k, asset_id: a.id });
    else unknown.push(a);
  }
  const dropped = [...known.keys()].filter((n) => !present.has(n));
  return { entries: entries.sort(byNewest), unknown, dropped };
}

/**
 * Download each unknown snapshot asset and verify it against its own name and
 * label. A verified one is adopted. One that fails verification is deleted
 * (no manifest names it, so nothing relies on it); one that cannot be
 * downloaded is left for the next run. Neither is ever used for dedupe.
 */
export async function adoptOrphans({ gh, unknown, log = () => {} }) {
  const adopted = [];
  const deleted = [];
  const skipped = [];
  for (const a of unknown) {
    const entry = orphanEntry(a);
    let bytes;
    try {
      bytes = await gh.download(a);
    } catch (err) {
      skipped.push(a.name);
      log(`state-snapshot: could not read ${a.name}, which the manifest does not list; leaving it for the next run (${err?.message ?? err})`);
      continue;
    }
    const v = verifySnapshot(bytes, entry);
    if (v.ok) {
      adopted.push(entry);
      continue;
    }
    deleted.push(a.name);
    log(`state-snapshot: ${a.name} is not in the manifest and fails verification (${v.reason}); deleting it`);
    await gh.deleteAsset(a.id);
  }
  return { adopted, deleted, skipped };
}

export function buildManifest({ repo, entries, currentAt, now }) {
  return {
    version: 1,
    about: 'Versioned copies of the loop state asset (age ciphertext, never decrypted here). See docs/OPERATIONS.md, "State snapshots".',
    source: { repo, tag: SOURCE_TAG, asset: SOURCE_ASSET },
    retention: { keep_recent: KEEP_RECENT, keep_daily_days: KEEP_DAYS, keep_weekly_weeks: KEEP_WEEKS },
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
  else if (parsed.rejected) log(`state-snapshot: left out ${parsed.rejected} malformed ${MANIFEST} entr${parsed.rejected === 1 ? 'y' : 'ies'}; their assets are verified again`);
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
  if (copy.status === 'busy') {
    log(`state-snapshot: the pump replaced the state asset during each of ${copy.tries} copies; no snapshot this run, the next run tries again`);
    return { status: 'busy', why: copy.why, copy_tries: copy.tries };
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
  const { entries: listed, unknown, dropped } = reconcile(manifest, assets);
  if (dropped.length) log(`state-snapshot: the manifest listed ${dropped.length} snapshot(s) no longer on the release: ${dropped.join(', ')}`);
  const orphans = await adoptOrphans({ gh, unknown, log });
  if (orphans.adopted.length) log(`state-snapshot: added ${orphans.adopted.length} verified snapshot(s) the manifest did not list: ${orphans.adopted.map((e) => e.name).join(', ')}`);
  const gone = new Set(orphans.deleted);
  assets = assets.filter((a) => !gone.has(a.name));
  // A snapshot dated in the future would stay "newest" for good and break
  // dedupe; it is left out (and left alone) until its time has passed.
  const future = (e) => Date.parse(e.created) > t + FUTURE_SLACK_MS;
  const all = [...listed, ...orphans.adopted];
  for (const e of all.filter(future)) log(`state-snapshot: ${e.name} is dated in the future; leaving it out`);
  const entries = all.filter((e) => !future(e)).sort(byNewest);

  let status = 'unchanged';
  let made = newest(entries);
  if (!isUnchanged(entries, copy.sha256)) {
    const name = snapshotName(t, copy.sha256);
    const label = `sha256:${copy.sha256}`;
    const up = await gh.upload(release, name, copy.bytes, label);
    const entry = { name, asset_id: up.id, created: parseSnapshotName(name).created, sha256: copy.sha256, size: copy.bytes.length, source: copy.source };
    // Read it back: a snapshot that cannot be restored is worse than none.
    // Any failure deletes the upload; if even that fails, the next run finds
    // an unlisted asset and verifies it before trusting it.
    let v;
    try {
      v = verifySnapshot(await gh.download(up), entry);
    } catch (err) {
      v = { ok: false, reason: `read-back failed: ${err?.message ?? err}` };
    }
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
  if (r.status === 'busy') return [...lines, `The pump replaced the state asset during each of ${r.copy_tries} copies, so no snapshot was taken this run. The next run tries again.`, ''].join('\n');
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

export async function main(argv = process.argv.slice(2), env = process.env, { gh: injected } = {}) {
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
    if (!token && !injected) throw new Error('GITHUB_TOKEN is required');
    const gh = injected ?? createReleaseClient({ repo, token, apiUrl: env.GITHUB_API_URL, log });
    const r = await runSnapshot({ gh, log });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    // Losing the race with the pump is not a failure (R-SNAP-15): a notice,
    // exit 0, and the health item reports it if it keeps happening.
    if (r.status === 'busy' && env.GITHUB_ACTIONS === 'true') process.stdout.write('::notice title=state-snapshot::the pump replaced the state asset during every copy; no snapshot this run\n');
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
