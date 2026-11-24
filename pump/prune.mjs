// State pruning inside the pump (loop upgrade #14), and the state size metric.
//
// state/prune.mjs decides which rows may leave the live state. This file moves
// them out safely, in two steps across two pump runs, so a row is only ever
// deleted once a copy of it is stored where the archive pull and the off-site
// backup pick it up:
//
//   1. stage (at the end of a run)  select the rows (a dry run, nothing is
//      deleted), write them as one sealed archive
//      `state-archive-<run id>-<run attempt>.tar.age` (a tar of the rows as
//      gzipped NDJSON and a small header, age-encrypted to state/state.pub)
//      into --state-archive-out, and note it in the state (kv
//      `state.prune.staged`). pump.yml uploads that folder as the artifact
//      `ingest-state-archive-<run id>-<run attempt>` (90 days); its name starts
//      with `ingest-`, so scripts/archive-pull.mjs and offsite/backup.mjs copy
//      it like the pump's other sealed outputs, unchanged.
//   2. complete (at the end of a later run)  find that artifact on the run that
//      staged it, download it, check its sha256 against the staged note,
//      decrypt it with the loop identity and read every row back. Only then
//      delete: each archived row that is still exactly as archived and still
//      meets its rule (state/prune.mjs deleteArchived), in one transaction.
//      Then VACUUM if enough pages are free.
//
// An archive that does not show up within ABANDON_MS, or does not read back,
// is given up: nothing is deleted, the note is dropped, and a later run stages
// the rows again. One stage and at most one delete per run, each within a row
// and time budget. Nothing is pruned while LANE_STATE_PRUNE_ENABLED is set to
// anything but "true", or when the run could not push its state.
//
// Every run also records the state's size (kv `state.size`): the database
// bytes, free pages, rows per table, the asset it was pulled from and the last
// prune result, for the watchdog's `state-size` check.

import { mkdirSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { isAgeCiphertext, unwrapArtifact } from '../ingest/container.mjs';
import { laneVariable } from '../scripts/guard.mjs';
import { createClient } from './github.mjs';
import {
  PRUNE_MAX_MS, PRUNE_MAX_ROWS, PRUNE_MIN_AGE_MS, buildArchive, deleteArchived, maybeVacuum, pruneFloorMs, readArchive, selectPrunable, stateSize,
} from '../state/prune.mjs';

const HOUR = 3_600_000;
export const STAGED_KEY = 'state.prune.staged';
export const LAST_KEY = 'state.prune.last';
export const SIZE_KEY = 'state.size';
export const PRUNE_LANE = 'state-prune';
export const ARTIFACT_PREFIX = 'ingest-state-archive-';
/** How long a staged archive may take to show up before it is given up. */
export const ABANDON_MS = 6 * HOUR;
/** Most bytes an archive download may have. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/** The artifact and file names of the archive a run stages. */
export function archiveNames({ runId, runAttempt = 1 }) {
  const id = String(runId);
  const attempt = String(runAttempt || 1);
  if (!/^\d{1,20}$/.test(id) || !/^\d{1,6}$/.test(attempt)) throw new TypeError(`archiveNames: bad run id ${id} / attempt ${attempt}`);
  return { artifact: `${ARTIFACT_PREFIX}${id}-${attempt}`, file: `state-archive-${id}-${attempt}.tar.age` };
}

/** Is pruning switched on? Unset, empty or "true" is on, like every lane switch. */
export function pruneEnabled(env = {}) {
  const raw = env[laneVariable(PRUNE_LANE)];
  return raw === undefined || raw === '' || raw === 'true';
}

function writeDurable(file, data) {
  const temp = `${file}.partial`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/**
 * Find the staged archive's artifact on the run that made it and download
 * it. Returns the bytes, or null when the run has no such artifact (yet).
 * Uses an installation token for this repository with actions: read.
 */
export function artifactFetcher({ repo, mintToken, fetch, apiUrl, budget, now, sleep }) {
  return async (staged) => {
    const { token } = await mintToken({ repositories: [String(repo).split('/')[1]], permissions: { actions: 'read' } });
    const client = createClient({ token, fetch, apiUrl, budget, now, sleep });
    const res = await client.request('GET', `/repos/${repo}/actions/runs/${staged.run_id}/artifacts`, { query: { name: staged.artifact, per_page: 100 } });
    const a = (res.data?.artifacts ?? []).find((x) => x.name === staged.artifact && !x.expired && Number(x.workflow_run?.id) === Number(staged.run_id));
    if (!a) return null;
    if (Number(a.size_in_bytes) > MAX_ARCHIVE_BYTES) throw new Error(`the archive artifact is ${a.size_in_bytes} bytes, more than ${MAX_ARCHIVE_BYTES}`);
    const r = await client.request('GET', `/repos/${repo}/actions/artifacts/${a.id}/zip`, { redirect: 'manual' });
    const location = r.headers?.get?.('location');
    if (r.status < 300 || r.status >= 400 || !location) throw new Error(`expected a redirect to the archive, got HTTP ${r.status}`);
    // The signed storage link gets no token.
    const blob = await fetch(location, { headers: { 'user-agent': 'isokron-tool-qa' }, redirect: 'follow' });
    if (!blob.ok) throw new Error(`the archive download returned HTTP ${blob.status}`);
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length > MAX_ARCHIVE_BYTES) throw new Error('the archive download is too large');
    return buf;
  };
}

/**
 * Step 2: delete what the staged archive holds, once it reads back.
 * @returns {Promise<object>} the result (status: waiting, abandoned, pruned)
 */
export async function completeStaged({ db, staged, now, fetchArchive, crypto, log = () => {} }) {
  const age = now - Date.parse(staged.created);
  const giveUp = (why) => {
    db.deleteKv(STAGED_KEY);
    log(`prune: gave up the staged archive ${staged.artifact} (${why}); nothing was deleted, the rows are staged again later`);
    return { status: 'abandoned', archive: staged.artifact, why };
  };
  const found = await fetchArchive(staged);
  if (!found) {
    if (!(age <= ABANDON_MS)) return giveUp(`no artifact ${staged.artifact} on run ${staged.run_id} after ${Math.round(age / 60_000)} minutes`);
    log(`prune: the staged archive ${staged.artifact} is not on its run yet; deleting nothing until it is`);
    return { status: 'waiting', archive: staged.artifact };
  }
  let ciphertext;
  try {
    ciphertext = unwrapArtifact(found, staged.file).ciphertext;
  } catch (err) {
    return giveUp(`the artifact does not hold ${staged.file}: ${err?.message ?? err}`);
  }
  if (ciphertext.length !== staged.bytes || sha256(ciphertext) !== staged.sha256) return giveUp('the archive is not the one staged (size or sha256 differs)');
  let archive;
  try {
    archive = readArchive(Buffer.from(await crypto.decrypt(ciphertext)));
  } catch (err) {
    return giveUp(`the archive does not read back: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (archive.meta.staged_id !== staged.id) return giveUp('the archive belongs to another staging');
  const out = deleteArchived(db, { rows: archive.rows, cutoff: staged.cutoff });
  db.deleteKv(STAGED_KEY);
  log(`prune: deleted ${out.total} rows held by ${staged.artifact} (${Object.entries(out.deleted).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'})`);
  return { status: 'pruned', archive: staged.artifact, cutoff: staged.cutoff, deleted: out.deleted, kept: out.kept, total: out.total };
}

/**
 * Step 1: select rows and stage them as a sealed archive in `archiveDir`.
 * @returns {Promise<object>} the result (status: nothing, staged)
 */
export async function stage({ db, now, minAgeMs, maxRows, deadline, clock, crypto, archiveDir, runId, runAttempt, repo, log = () => {} }) {
  const cutoff = now - minAgeMs;
  const sel = selectPrunable(db, { cutoff, maxRows, deadline, clock });
  if (sel.total === 0) return { status: 'nothing', cutoff: sel.cutoff };
  const names = archiveNames({ runId, runAttempt });
  const id = randomUUID();
  const { tar, meta } = buildArchive({
    rows: sel.rows,
    meta: { staged_id: id, created: iso(now), cutoff: sel.cutoff, schema_version: db.schemaVersion(), source: { repo, run_id: Number(runId), run_attempt: Number(runAttempt || 1) } },
  });
  const ciphertext = Buffer.from(await crypto.encrypt(tar));
  if (!isAgeCiphertext(ciphertext)) throw new Error('the sealed archive is not age ciphertext; staging nothing');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const file = join(archiveDir, names.file);
  writeDurable(file, ciphertext);
  const staged = {
    id, created: iso(now), cutoff: sel.cutoff, artifact: names.artifact, file: names.file, run_id: Number(runId), run_attempt: Number(runAttempt || 1),
    sha256: sha256(ciphertext), bytes: ciphertext.length, counts: meta.counts, rows: meta.rows,
  };
  try {
    db.setKv(STAGED_KEY, staged, { now });
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  log(`prune: staged ${sel.total} rows older than ${sel.cutoff} as ${names.file} (${ciphertext.length} bytes sealed${sel.stopped ? `; stopped at the ${sel.stopped} budget` : ''}); they are deleted once the artifact reads back`);
  return { status: 'staged', archive: names.artifact, cutoff: sel.cutoff, counts: meta.counts, rows: sel.total, bytes: ciphertext.length, stopped: sel.stopped };
}

/**
 * One prune pass at the end of a pump run: complete the staged archive if
 * there is one, then stage the next if none is waiting. Never throws; the
 * result is kept as kv `state.prune.last` and returned.
 */
export async function pruneStep({
  db, now = Date.now, env = {}, repo, fetchArchive, crypto, archiveDir, lateMs,
  minAgeMs = PRUNE_MIN_AGE_MS, maxRows = PRUNE_MAX_ROWS, maxMs = PRUNE_MAX_MS, clock = () => performance.now(), log = () => {},
}) {
  const t = now();
  const result = { at: iso(t), complete: null, stage: null, vacuum: null, error: null };
  if (!pruneEnabled(env)) {
    result.status = 'off';
    db.setKv(LAST_KEY, result, { now: t });
    return result;
  }
  const floor = pruneFloorMs(lateMs);
  const age = Math.max(floor, Number(minAgeMs) || 0);
  const deadline = clock() + maxMs;
  try {
    const staged = db.getKv(STAGED_KEY);
    if (staged) {
      if (!fetchArchive || !crypto) result.complete = { status: 'waiting', archive: staged.artifact, why: 'no way to read the archive in this run' };
      else result.complete = await completeStaged({ db, staged, now: t, fetchArchive, crypto, log });
    }
    if (result.complete?.status === 'pruned') result.vacuum = maybeVacuum(db);
    const runId = env.GITHUB_RUN_ID;
    if (!db.getKv(STAGED_KEY) && archiveDir && runId && crypto) {
      result.stage = await stage({ db, now: t, minAgeMs: age, maxRows, deadline, clock, crypto, archiveDir, runId, runAttempt: env.GITHUB_RUN_ATTEMPT, repo, log });
    }
  } catch (err) {
    result.error = String(err?.message ?? err).slice(0, 300);
    log(`prune: ${result.error}; nothing more is pruned this run`);
  }
  result.status = result.error ? 'error' : result.complete?.status === 'pruned' ? 'pruned' : result.stage?.status === 'staged' ? 'staged' : result.complete?.status ?? result.stage?.status ?? 'idle';
  db.setKv(LAST_KEY, result, { now: t });
  return result;
}

/** Record the state's size for the watchdog (kv `state.size`). */
export function recordStateSize(db, { now, assetBytes = null, prune = null } = {}) {
  const s = stateSize(db);
  const value = {
    at: iso(now), bytes: s.bytes, page_size: s.page_size, pages: s.pages, free_pages: s.free_pages, rows: s.rows,
    asset_bytes: Number.isSafeInteger(assetBytes) ? assetBytes : null,
    prune: prune ? { status: prune.status, at: prune.at, error: prune.error ?? null, deleted: prune.complete?.total ?? 0, staged: prune.stage?.rows ?? 0 } : null,
  };
  db.setKv(SIZE_KEY, value, { now });
  return value;
}
