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
//   id       owner/name, as the seed and the scan-static worker spell it
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SEED_FILE = new URL('../history/seed-v1.json', import.meta.url);
export const SEED_KV_KEY = 'subjects.seed';
/** Bump when tierFor() or what is written per subject changes, so the next run re-applies the seed. */
export const MAPPING_VERSION = 1;

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
  if (Number.isInteger(seed.size) && seed.size !== seed.subjects.length) {
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
 * Load the seed into the state store unless this exact file and mapping are
 * already loaded. Never throws: a bad or missing seed file is returned as
 * {error}, nothing is written, and the subjects already in the state are left
 * as they are.
 *
 * @returns {{ loaded: boolean, error?: string, source?: string, sha256?: string,
 *   subjects?: number, tiers?: Record<string, number>, retired?: number, summary: string }}
 */
export function syncSeedSubjects(db, { now = Date.now(), file = SEED_FILE, read = readFileSync } = {}) {
  let seed;
  try {
    seed = parseSeed(read(file));
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 300);
    return { loaded: false, error, summary: `seed not loaded, subjects left as they were: ${error}` };
  }
  const prev = db.getKv(SEED_KV_KEY);
  if (prev?.sha256 === seed.sha256 && prev?.mapping === MAPPING_VERSION) {
    return { loaded: false, source: seed.source, sha256: seed.sha256, subjects: prev.subjects, summary: `${seed.source} already loaded (${prev.subjects} subjects)` };
  }
  const tiers = {};
  let retired = 0;
  db.tx(() => {
    for (const s of seed.subjects) {
      const cur = db.getSubject(s.id);
      // A sha or digest set by another writer is kept: resetting it would read as a new version.
      db.setSubjectVersion({
        id: s.id, kind: 'github', source: seed.source, tier: s.tier,
        sha: cur?.sha ?? null, artifactDigest: cur?.artifact_digest ?? null, now,
      });
      tiers[`T${s.tier}`] = (tiers[`T${s.tier}`] ?? 0) + 1;
    }
    retired = db.retireSubjects({ sourcePrefix: 'seed-v', keep: seed.subjects.map((s) => s.id), now });
    db.setKv(SEED_KV_KEY, {
      file: 'history/seed-v1.json', source: seed.source, sha256: seed.sha256, mapping: MAPPING_VERSION,
      subjects: seed.subjects.length, tiers, retired, loaded_at: new Date(now).toISOString(),
    }, { now });
  });
  const split = Object.keys(tiers).sort().map((k) => `${k} ${tiers[k]}`).join(', ');
  return {
    loaded: true, source: seed.source, sha256: seed.sha256, subjects: seed.subjects.length, tiers, retired,
    summary: `loaded ${seed.subjects.length} subjects from ${seed.source} (${split}); ${retired} retired`,
  };
}
