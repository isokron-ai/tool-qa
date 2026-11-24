#!/usr/bin/env node
// Restore drill for the state snapshots (snapshot/snapshot.mjs). Run it on an
// operator's machine, never in a workflow.
//
//   node snapshot/restore.mjs list  [--repo owner/name]
//   node snapshot/restore.mjs drill [--snapshot <name> | --latest] [--identity <file>]
//                                   [--repo owner/name] [--apply]
//
// list   prints the snapshots in the manifest, newest first.
// drill  downloads one snapshot (default: the newest), checks it against the
//        manifest (sha256, size, name) and its asset label, decrypts it locally
//        with the age identity (default ~/.isokron/loop-age-identity.key; the key
//        is never printed), checks the database opens and passes
//        `PRAGMA integrity_check`, and reports its schema version, the fence
//        counter and the row count of every table (subjects and results first).
//        The decrypted copy is written to a private temporary directory and
//        deleted before the drill ends.
//
// --apply  then puts the snapshot back as the live state asset, but only while
//          the loop is stopped: LOOP_ENABLED is not "true", LANE_PUMP_ENABLED is
//          off, or LOOP_PAUSE_UNTIL is at least 10 minutes away; and no pump or
//          ingest run is queued or in progress. The live state is first copied
//          into the snapshots (a normal snapshot run), so the restore can be
//          undone. The snapshot's ciphertext is uploaded byte for byte under a
//          temporary name; the old asset is replaced only if it is still the one
//          seen at the start; then the old asset is renamed to
//          state.sqlite.replaced-<time> (the pump never reads that name) and the
//          upload is renamed to state.sqlite.
//
// Environment: GITHUB_TOKEN (else `gh auth token`; --apply needs one that may
// write releases and read repository variables), AGE_BIN (default age),
// AGE_IDENTITY_FILE (instead of --identity), GITHUB_API_URL.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { evaluateGuard, parseIsoTime } from '../scripts/guard.mjs';
import { stateCrypto } from '../scripts/state-asset.mjs';
import { createReleaseClient } from './github.mjs';
import {
  MANIFEST, SNAPSHOT_TAG, SOURCE_ASSET, SOURCE_TAG, SOURCE_UPLOAD_PREFIX,
  labelSha, newest, orphanEntry, parseManifest, pickSource, reconcile, runSnapshot, sha256, stamp, verifySnapshot,
} from './snapshot.mjs';

const DEFAULT_REPO = 'isokron-ai/tool-qa';
export const DEFAULT_IDENTITY = join(homedir(), '.isokron', 'loop-age-identity.key');
export const PAUSE_MARGIN_MS = 10 * 60 * 1000;
export const REPLACED_PREFIX = `${SOURCE_ASSET}.replaced-`;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
export const LOOP_VARIABLES = ['LOOP_ENABLED', 'LOOP_PAUSE_UNTIL', 'LANE_PUMP_ENABLED'];
export const ACTIVE_BLOCKERS = ['pump.yml', 'ingest.yml', 'state-snapshot.yml'];
const FIRST_TABLES = ['subjects', 'results', 'attempts', 'dispatches', 'dispatch_items', 'run_keys', 'leases'];

/**
 * The snapshots on the release, newest first: those the manifest lists, then
 * (marked `in_manifest: false`) any it does not, described by their name and
 * label only. The drill verifies whichever it uses, so a lost manifest does
 * not stop a restore.
 */
export async function listSnapshots(gh) {
  const release = await gh.getRelease(SNAPSHOT_TAG);
  if (!release) return { release: null, manifest: null, entries: [], orphans: [], assets: [] };
  const assets = await gh.listAssets(release);
  const m = assets.find((a) => a.name === MANIFEST);
  const manifest = m ? parseManifest((await gh.download(m)).toString('utf8')) : null;
  const { entries, unknown } = reconcile(manifest, assets);
  const orphans = unknown.map((a) => ({ ...orphanEntry(a), in_manifest: false }));
  return { release, manifest, entries, orphans, assets };
}

/**
 * Open a decrypted state database read-only and check it.
 * @returns {{ integrity: string, ok: boolean, schema_version: number, fence: number|null, counts: Record<string, number> }}
 */
export function inspectDatabase(file) {
  const head = readFileSync(file).subarray(0, 16);
  if (!head.equals(SQLITE_MAGIC)) throw new Error('the decrypted snapshot is not a SQLite database');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    const integrity = rows.join('; ');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const ordered = [...FIRST_TABLES.filter((t) => tables.includes(t)), ...tables.filter((t) => !FIRST_TABLES.includes(t))];
    const counts = {};
    for (const t of ordered) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
    let fence = null;
    if (tables.includes('counters')) fence = db.prepare("SELECT value FROM counters WHERE name = 'fence'").get()?.value ?? null;
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    return { integrity, ok: rows.length === 1 && rows[0] === 'ok', schema_version: schemaVersion, fence, counts };
  } finally {
    db.close();
  }
}

/**
 * Is the loop stopped, so that a restore cannot race the pump?
 * @returns {{ stopped: boolean, why: string }}
 */
export function loopStopped(vars, { now = Date.now() } = {}) {
  // Only the switches, so nothing else in the environment can count.
  const env = Object.fromEntries(LOOP_VARIABLES.map((k) => [k, vars?.[k]]));
  const g = evaluateGuard(env, { job: 'pump', noSlots: true, now });
  if (g.proceed) return { stopped: false, why: 'the loop is running (LOOP_ENABLED is "true", no pause, pump lane on)' };
  if (g.reason === 'paused') {
    const until = parseIsoTime(vars.LOOP_PAUSE_UNTIL);
    if (until - now < PAUSE_MARGIN_MS) return { stopped: false, why: `LOOP_PAUSE_UNTIL ends in under ${PAUSE_MARGIN_MS / 60000} minutes; pause for longer first` };
  }
  return { stopped: true, why: g.notice };
}

function readIdentity(file) {
  const text = readFileSync(file, 'utf8');
  const keys = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (keys.length !== 1) throw new Error(`${file} must hold exactly one age identity`);
  return keys[0];
}

/**
 * Put a verified snapshot back as the live state asset. The caller has checked
 * the loop is stopped. `expectedLive` is the live asset seen before; if it has
 * changed by the time the old copy would be deleted, nothing is replaced.
 */
export async function applySnapshot({ gh, bytes, sha, expectedLive, now = Date.now, log = () => {} }) {
  const release = await gh.getRelease(SOURCE_TAG);
  if (!release) throw new Error(`there is no "${SOURCE_TAG}" release to restore into`);
  const label = `sha256:${sha}`;
  const up = await gh.upload(release, `${SOURCE_UPLOAD_PREFIX}${stamp(now())}`, bytes, label);
  const cur = pickSource((await gh.getRelease(SOURCE_TAG))?.assets?.filter((a) => a.id !== up.id));
  const same = expectedLive ? cur && cur.id === expectedLive.id && cur.label === expectedLive.label : !cur;
  if (!same) {
    await gh.deleteAsset(up.id).catch(() => {});
    throw new Error('the live state asset changed during the restore; nothing was replaced. Check that the loop is stopped and run the drill again');
  }
  // The live asset (whatever its name: an interrupted push leaves only a
  // state.sqlite.upload-*) is kept under a name the pump never reads, for a
  // look afterwards; delete it by hand when done. Only other stale uploads,
  // which the pump would never read either, are deleted.
  let keptAs = null;
  if (cur) {
    keptAs = `${REPLACED_PREFIX}${stamp(now())}`;
    await gh.renameAsset(cur.id, keptAs);
  }
  for (const a of release.assets ?? []) {
    if (a.id === up.id || a.id === cur?.id) continue;
    if (a.name === SOURCE_ASSET || String(a.name).startsWith(SOURCE_UPLOAD_PREFIX)) await gh.deleteAsset(a.id);
  }
  await gh.renameAsset(up.id, SOURCE_ASSET, label);
  log(`restore: ${SOURCE_ASSET} on release "${SOURCE_TAG}" is now the snapshot (sha256 ${sha})${keptAs ? `; the replaced asset is kept as ${keptAs}` : ''}`);
  return { asset_id: up.id, replaced_kept_as: keptAs };
}

/**
 * The drill. Returns a report object; throws on any failed check.
 */
export async function drill({
  gh, name, identityFile = DEFAULT_IDENTITY, ageBin, apply = false, now = Date.now, log = () => {}, tmpRoot = tmpdir(),
  decrypt,
}) {
  const { entries, orphans } = await listSnapshots(gh);
  if (!entries.length && !orphans.length) throw new Error(`no snapshots on release "${SNAPSHOT_TAG}"`);
  // By default the newest the manifest lists; one it does not list only by name
  // (or when there is no manifest at all), and then checked against its label.
  const entry = name ? [...entries, ...orphans].find((e) => e.name === name) : newest(entries.length ? entries : orphans);
  if (!entry) throw new Error(`no snapshot named ${name}`);
  const report = { snapshot: entry.name, created: entry.created, size: entry.size, sha256: entry.sha256, source: entry.source ?? null, in_manifest: entry.in_manifest !== false };

  const bytes = await gh.download({ id: entry.asset_id });
  const v = verifySnapshot(bytes, entry);
  if (!v.ok) throw new Error(`${entry.name} failed verification: ${v.reason}`);
  report.verified = entry.in_manifest === false
    ? 'not in the manifest: sha256, size and name match the asset label; age ciphertext'
    : 'sha256, size and name match the manifest; age ciphertext';

  const dir = mkdtempSync(join(tmpRoot, 'state-restore-'));
  try {
    let plain;
    if (decrypt) plain = await decrypt(bytes);
    else {
      const identity = readIdentity(identityFile);
      try {
        plain = await stateCrypto({ identity, ageBin, tmpDir: dir }).decrypt(bytes);
      } catch (err) {
        throw new Error(String(err?.message ?? err).split(identity).join('[identity]'));
      }
    }
    const file = join(dir, 'state.sqlite');
    writeFileSync(file, plain, { mode: 0o600 });
    report.decrypted_bytes = plain.length;
    Object.assign(report, inspectDatabase(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!report.ok) throw Object.assign(new Error(`${entry.name} failed PRAGMA integrity_check: ${report.integrity}`), { report });
  log(`restore: ${entry.name} decrypts and passes integrity_check (${report.counts.subjects ?? 0} subjects, ${report.counts.results ?? 0} results)`);

  if (!apply) return { ...report, applied: false };

  // The variables as the pump job sees them (environment `loop`, then the
  // repository, then the organization); any read error refuses (fail closed).
  let vars;
  try {
    vars = await gh.effectiveVariables(LOOP_VARIABLES, { environment: 'loop' });
  } catch (err) {
    throw Object.assign(new Error(`refusing --apply: could not read the loop switches (${err?.message ?? err})`), { report });
  }
  const stop = loopStopped(vars, { now: now() });
  if (!stop.stopped) throw Object.assign(new Error(`refusing --apply: ${stop.why}`), { report });
  // The pump and the re-ingest write the state; a snapshot run in CI would
  // race this machine's own snapshot of the live state.
  for (const wf of ACTIVE_BLOCKERS) {
    const active = await gh.activeRuns(wf);
    if (active.length) throw Object.assign(new Error(`refusing --apply: ${wf} has ${active.length} queued or running run(s); wait for them to end`), { report });
  }
  // Keep the live state first, so this restore can be undone. A live asset
  // that cannot be copied (the reason to restore, often) is still kept, renamed.
  let savedLiveAs = null;
  let liveSnapshotError = null;
  try {
    savedLiveAs = (await runSnapshot({ gh, now, log })).snapshot ?? null;
  } catch (err) {
    liveSnapshotError = String(err?.message ?? err);
    log(`restore: could not snapshot the live state first (${liveSnapshotError}); it will be kept on the "${SOURCE_TAG}" release under a new name instead`);
  }
  const live = pickSource((await gh.getRelease(SOURCE_TAG))?.assets);
  if (live && labelSha(live.label) === entry.sha256) return { ...report, applied: false, note: 'the live state already is this snapshot', saved_live_as: savedLiveAs };
  const applied = await applySnapshot({ gh, bytes, sha: entry.sha256, expectedLive: live, now, log });
  return {
    ...report, applied: true, saved_live_as: savedLiveAs, live_snapshot_error: liveSnapshotError,
    replaced_kept_as: applied.replaced_kept_as, live_asset_id: applied.asset_id,
  };
}

function ghToken() {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = { command, name: undefined, identity: undefined, repo: undefined, apply: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--snapshot') o.name = rest[++i];
    else if (a === '--latest') o.name = undefined;
    else if (a === '--identity') o.identity = rest[++i];
    else if (a === '--repo') o.repo = rest[++i];
    else if (a === '--apply') o.apply = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!['list', 'drill'].includes(command)) throw new Error('command must be "list" or "drill"');
  if (o.apply && command !== 'drill') throw new Error('--apply goes with drill');
  return o;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`restore: ${err.message}\nusage: node snapshot/restore.mjs list | drill [--snapshot <name>|--latest] [--identity <file>] [--repo owner/name] [--apply]\n`);
    return 2;
  }
  const token = env.GITHUB_TOKEN || ghToken();
  const scrub = (m) => (token ? String(m).split(token).join('***') : String(m));
  const log = (m) => process.stderr.write(`${scrub(m)}\n`);
  try {
    const gh = createReleaseClient({ repo: o.repo || env.GITHUB_REPOSITORY || DEFAULT_REPO, token, apiUrl: env.GITHUB_API_URL, log });
    if (o.command === 'list') {
      const { manifest, entries, orphans } = await listSnapshots(gh);
      process.stdout.write(`${entries.length} snapshot(s) on release "${SNAPSHOT_TAG}"; live state last confirmed ${manifest?.current_at ?? 'never'}\n`);
      for (const e of entries) {
        process.stdout.write(`${e.name}  ${e.created}  ${String(e.size).padStart(9)} bytes  sha256 ${e.sha256}  source updated ${e.source?.updated_at ?? '?'}\n`);
      }
      for (const e of orphans) {
        process.stdout.write(`${e.name}  ${e.created}  ${String(e.size).padStart(9)} bytes  label sha256 ${e.sha256 ?? 'none'}  NOT IN THE MANIFEST (unverified)\n`);
      }
      return 0;
    }
    const report = await drill({
      gh, name: o.name, identityFile: o.identity || env.AGE_IDENTITY_FILE || DEFAULT_IDENTITY, ageBin: env.AGE_BIN || undefined, apply: o.apply, log,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (err) {
    log(`restore: ${err?.message ?? err}`);
    if (err?.report) process.stdout.write(`${JSON.stringify(err.report, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
