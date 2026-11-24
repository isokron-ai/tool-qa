// The subject loader: where the pump's subjects come from.
//
// The due list (pump/due.mjs) reads the subjects table. This module fills it
// from the seed list, history/seed-v1.json (997 GitHub repositories; how it was
// drawn is in history/seed/README.md). The pump calls syncSeedSubjects() once
// at the start of every run, inside its single-writer state, before the first
// tick.
//
// Cheap and idempotent: the seed file's sha256, together with MAPPING_VERSION
// (bumped whenever the tier mapping below changes), is kept in kv under
// SEED_KV_KEY. When both match, nothing is written. Otherwise every seed subject
// is upserted with setSubjectVersion() in one transaction.
//
//   id       the subject key: owner/name as the seed spelled it when the
//            subject was first seen. It never changes (state schema v8):
//            run_keys name it. A seed row is matched to its subject by the
//            subject's current name first, then by key, then by a name it had
//            before (case aside), so a rename, a transfer or a rebuilt seed
//            never makes a second subject for one repository
//            (resolveSeedSubjects). The repository's numeric id and current
//            name are looked up separately (pump/identity.mjs).
//   name     for a new subject, the seed's owner/name; afterwards only the
//            identity lookup moves it
//   kind     github
//   source   seed-v<version> (the seed file's version field); only set when
//            the subject is first seen
//   tier     from the seed's own population label, see tierFor()
//   sha      left null: the scan-static worker reads the default branch head
//            itself. A subject with no sha or artifact digest is refreshed on
//            its tier's cadence (tiers.json max_age_days, or
//            unversioned_max_age_days where a cell has no age limit). A sha or
//            digest another writer has set is kept, never reset to null.
//
// Subjects that leave the seed are not deleted: their results and history stay.
// They are marked retired (subjects.retired_at) and the due list skips them, so
// they are no longer refreshed; their last results simply age from then on. A
// subject that comes back in a later seed is active again.
//
// A seed that would retire more than MAX_RETIRE_SHARE (10%) of the active seed
// subjects is refused (R-SUB-03): a truncated or wrong file must not retire
// nearly everything. To retire more on purpose, set the one-shot override in
// kv, ALLOW_RETIRE_KV_KEY = true (docs/OPERATIONS.md); the load that uses it
// clears it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_FILE = new URL('../history/seed-v1.json', import.meta.url);
export const SEED_KV_KEY = 'subjects.seed';
/** Bump when tierFor() or what is written per subject changes, so the next run re-applies the seed. */
export const MAPPING_VERSION = 1;
/** One-shot override: true lets the next load retire more than MAX_RETIRE_SHARE. */
export const ALLOW_RETIRE_KV_KEY = 'subjects.seed.allow_retire';
/** The share of active seed subjects one load may retire without the override. */
export const MAX_RETIRE_SHARE = 0.1;
const SOURCE_PREFIX = 'seed-v';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The seed path as recorded in kv: relative to the repository when inside it. */
export function seedPath(file) {
  const abs = resolve(file instanceof URL ? fileURLToPath(file) : String(file));
  const rel = relative(REPO_ROOT, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : abs;
}

const ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The seed's population label -> pump tier (0..4).
 *   T0         our own five repositories: T0 (every push and tool release;
 *              daily while their sha is unknown)
 *   gold14     the 14 Go and Rust servers we calibrate against: T1
 *   reference  modelcontextprotocol/servers: T1
 *   sample     the stratified history sample: T2 when the seed recorded
 *              100 or more stars (popular community), else T3 (long tail)
 * Anything else is an error: the whole seed is refused, nothing is written.
 */
export function tierFor(subject) {
  switch (subject?.tier) {
    case 'T0': return 0;
    case 'gold14':
    case 'reference': return 1;
    case 'sample': return subject.star_bucket === '100-999' || subject.star_bucket === '1000+' ? 2 : 3;
    default: throw new Error(`seed subject ${JSON.stringify(subject?.id)}: unknown population tier ${JSON.stringify(subject?.tier)}`);
  }
}

/** Parse and check a seed file's bytes. Returns {source, sha256, subjects: [{id, tier}]}; throws on any bad row. */
export function parseSeed(bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const seed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  if (!Number.isInteger(seed?.version) || seed.version < 1) throw new Error('seed: version must be a positive integer');
  if (!Array.isArray(seed.subjects) || seed.subjects.length === 0) throw new Error('seed: subjects must be a non-empty list');
  if (!Number.isInteger(seed.size)) throw new Error('seed: size (the number of subjects) is required');
  if (seed.size !== seed.subjects.length) {
    throw new Error(`seed: size says ${seed.size} but there are ${seed.subjects.length} subjects`);
  }
  const seen = new Set();
  const subjects = seed.subjects.map((s) => {
    if (typeof s?.id !== 'string' || !ID_RE.test(s.id)) throw new Error(`seed: subject id ${JSON.stringify(s?.id)} is not owner/name`);
    const key = s.id.toLowerCase();
    if (seen.has(key)) throw new Error(`seed: ${s.id} is listed twice`);
    seen.add(key);
    return { id: s.id, tier: tierFor(s) };
  });
  return { source: `seed-v${seed.version}`, sha256, subjects };
}

/**
 * Which subject each seed row is: Map(seed id -> {key, isNew}). In order of
 * preference, case aside: the active subject whose current name is the seed
 * id; the subject whose key is the seed id; the subject that had the seed id
 * as an earlier name (subject_events). A subject merged into another (alias_of)
 * stands for that other one. Each subject takes at most one seed row; a row
 * left over is a new subject, keyed by its seed id, or `<id>#2`, `#3` ... when
 * that key is taken (the old name of a renamed repository reused by a new
 * one).
 */
export function resolveSeedSubjects(db, seedIds) {
  const subjects = db.listSubjects();
  const byExactKey = new Map(subjects.map((s) => [s.id, s]));
  const canon = (s) => {
    let cur = s;
    for (let i = 0; i < 8 && cur?.alias_of; i++) cur = byExactKey.get(cur.alias_of) ?? cur;
    return cur?.alias_of ? undefined : cur;
  };
  const lower = (x) => String(x).toLowerCase();
  const byName = new Map();
  for (const s of subjects) {
    if (s.alias_of || typeof s.name !== 'string') continue;
    const k = lower(s.name);
    const prev = byName.get(k);
    // Prefer an active subject, then one bound to an id.
    const rank = (x) => (x.retired_at === null ? 2 : 0) + (x.repo_id !== null ? 1 : 0);
    if (!prev || rank(s) > rank(prev)) byName.set(k, s);
  }
  const byKey = new Map();
  for (const s of subjects) if (!byKey.has(lower(s.id))) byKey.set(lower(s.id), s);
  const byOld = new Map();
  if (typeof db.listSubjectEvents === 'function') {
    for (const e of db.listSubjectEvents()) {
      if ((e.kind === 'renamed' || e.kind === 'transferred') && e.old_name) byOld.set(lower(e.old_name), byExactKey.get(e.subject));
    }
  }
  const out = new Map();
  const claimed = new Set();
  const take = (id, s) => {
    const c = canon(s);
    if (!c || claimed.has(c.id)) return false;
    claimed.add(c.id);
    out.set(id, { key: c.id, isNew: false });
    return true;
  };
  for (const id of seedIds) {
    const s = byName.get(lower(id));
    if (s) take(id, s);
  }
  for (const id of seedIds) {
    if (out.has(id)) continue;
    const s = byKey.get(lower(id));
    if (s && take(id, s)) continue;
    const o = byOld.get(lower(id));
    if (o) take(id, o);
  }
  const taken = new Set(subjects.map((s) => lower(s.id)));
  for (const id of seedIds) {
    if (out.has(id)) continue;
    let key = id;
    for (let n = 2; taken.has(lower(key)); n++) key = `${id}#${n}`;
    taken.add(lower(key));
    out.set(id, { key, isNew: true });
  }
  return out;
}

/**
 * Load the seed into the state store unless this exact file and mapping are
 * already loaded. Never throws: a bad or missing seed file, a load that would
 * retire too many subjects, or a state error is returned as {error}; nothing is
 * written then, and the subjects already in the state are left as they are.
 *
 * @returns {{ loaded: boolean, error?: string, source?: string, sha256?: string,
 *   subjects?: number, tiers?: Record<string, number>, retired?: number, summary: string }}
 */
export function syncSeedSubjects(db, { now = Date.now(), file = SEED_FILE, read = readFileSync } = {}) {
  const fail = (err) => {
    const error = String(err?.message ?? err).slice(0, 300);
    return { loaded: false, error, summary: `seed not loaded, subjects left as they were: ${error}` };
  };
  let seed;
  try {
    seed = parseSeed(read(file));
  } catch (err) {
    return fail(err);
  }
  const path = seedPath(file);
  try {
    const prev = db.getKv(SEED_KV_KEY);
    if (prev?.sha256 === seed.sha256 && prev?.mapping === MAPPING_VERSION) {
      return { loaded: false, source: seed.source, sha256: seed.sha256, subjects: prev.subjects, summary: `${seed.source} already loaded (${prev.subjects} subjects)` };
    }
    // Each seed row's subject key (schema v8): renamed subjects keep theirs.
    const resolved = resolveSeedSubjects(db, seed.subjects.map((s) => s.id));
    // How many active seed subjects this load would retire (R-SUB-03).
    const keep = new Set([...resolved.values()].map((r) => r.key));
    const active = db.listSubjects().filter((s) => s.retired_at == null && String(s.source).startsWith(SOURCE_PREFIX));
    const leaving = active.filter((s) => !keep.has(s.id)).length;
    const override = db.getKv(ALLOW_RETIRE_KV_KEY) === true;
    if (leaving > active.length * MAX_RETIRE_SHARE && !override) {
      return fail(new Error(`${path} would retire ${leaving} of ${active.length} active seed subjects (over ${MAX_RETIRE_SHARE * 100}%); set kv ${ALLOW_RETIRE_KV_KEY} to true to allow it once`));
    }
    const tiers = {};
    let retired = 0;
    db.tx(() => {
      for (const s of seed.subjects) {
        const { key } = resolved.get(s.id);
        const cur = db.getSubject(key);
        // A sha or digest set by another writer is kept: resetting it would read as a new version.
        db.setSubjectVersion({
          id: key, kind: 'github', source: seed.source, tier: s.tier, name: s.id,
          sha: cur?.sha ?? null, artifactDigest: cur?.artifact_digest ?? null, now,
        });
        tiers[`T${s.tier}`] = (tiers[`T${s.tier}`] ?? 0) + 1;
      }
      retired = db.retireSubjects({ sourcePrefix: SOURCE_PREFIX, keep: [...keep], now });
      if (override) db.deleteKv(ALLOW_RETIRE_KV_KEY);
      db.setKv(SEED_KV_KEY, {
        file: path, source: seed.source, sha256: seed.sha256, mapping: MAPPING_VERSION,
        subjects: seed.subjects.length, tiers, retired, loaded_at: new Date(now).toISOString(),
      }, { now });
    });
    const split = Object.keys(tiers).sort().map((k) => `${k} ${tiers[k]}`).join(', ');
    return {
      loaded: true, source: seed.source, sha256: seed.sha256, subjects: seed.subjects.length, tiers, retired,
      summary: `loaded ${seed.subjects.length} subjects from ${seed.source} (${split}); ${retired} retired${override ? ' (retire override used and cleared)' : ''}`,
    };
  } catch (err) {
    // A state error (the transaction rolled back): reported, never thrown (R-SUB-05).
    return fail(err);
  }
}
