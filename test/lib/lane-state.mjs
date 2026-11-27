// Test helper: lane results, subjects and dispatches written straight into a state database,
// for the watchdog's lane checks (watchdog/lanes.mjs). Raw SQL on purpose: no pump code runs.
import { readFileSync } from 'node:fs';

const CONFIG = JSON.parse(readFileSync(new URL('../../pump/workflows.json', import.meta.url), 'utf8')).workflows;
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param db an opened state database
 * @param {object} o
 * @param {number} o.now ms
 * @param {number} [o.subjects] how many active subjects (tier 3, so max age 30 days)
 * @param {boolean} [o.versioned] subjects have a sha and changed_at (false: both null, as on 27 Nov)
 * @param {Record<string, {ageMin: number, n?: number, assessed?: number, tool?: number}>} [o.lanes] per lane: newest result's age, results written
 *   (n, at most one per subject), how many of them assessed, how many our tool's fault
 * @param {number|null} [o.dispatchAgeMin] age of the newest dispatch (null: none)
 * @param {number} [o.openDispatches] dispatches still open
 */
export function seedLaneState(db, { now, subjects = 5, versioned = true, lanes, dispatchAgeMin = 10, openDispatches = 0 }) {
  const raw = db.raw;
  const t = iso(now);
  raw.exec('BEGIN');
  for (let i = 0; i < subjects; i++) {
    raw.prepare('INSERT INTO subjects (id, kind, source, first_seen, last_seen, name, tier, sha, changed_at) VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?)')
      .run(`o/s${i}`, 'repo', 'seed', t, t, `o/s${i}`, versioned ? 'a'.repeat(40) : null, versioned ? t : null);
  }
  const plan = lanes ?? Object.fromEntries(Object.entries(CONFIG).filter(([, w]) => w.enabled === true).map(([k]) => [k, { ageMin: 10, n: subjects, assessed: subjects }]));
  const ins = raw.prepare('INSERT INTO results (run_key, subject, workflow, attempt_id, fence, outcome, digest, accepted_at, measured_at, skips_streak, fault, coverage, assessed_at) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, 0, ?, ?, ?)');
  for (const [lane, p] of Object.entries(plan)) {
    const n = p.n ?? subjects;
    for (let i = 0; i < n; i++) {
      const at = iso(now - (p.ageMin + (i === 0 ? 0 : 1)) * 60_000);
      const assessed = i < (p.assessed ?? 0);
      const tool = !assessed && i < (p.assessed ?? 0) + (p.tool ?? 0);
      raw.prepare('INSERT INTO run_keys (run_key, subject, workflow, fields, first_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(`${lane}-${i}`, `o/s${i}`, lane, '{}', at);
      ins.run(`${lane}-${i}`, `o/s${i}`, lane, 'att', assessed ? 'ok' : 'skips_only', at, at, tool ? 'tool' : null, assessed ? 'assessed' : tool ? 'unassessed_tool' : 'subject', assessed ? at : null);
    }
  }
  if (dispatchAgeMin !== null) {
    const at = iso(now - dispatchAgeMin * 60_000);
    for (let i = 0; i < Math.max(1, openDispatches); i++) {
      raw.prepare("INSERT INTO dispatches (attempt_id, shard_id, workflow, repo, workflow_file, ref, created, expires, status) VALUES (?, ?, 'live-probe', 'isokron-ai/mcp-check', 'live-probe.yml', 'main', ?, ?, ?)")
        .run(`att-${i}`, `shard-${i}`, at, iso(now + 3_600_000), i < openDispatches ? 'dispatched' : 'done');
    }
  }
  raw.exec('COMMIT');
}

/** kv pump.last_tick as the pump writes it. */
export const tick = (db, now, o = {}) => db.setKv('pump.last_tick', { at: iso(now - 5 * 60_000), due: 0, dispatched: 0, failed: 0, paused: [], stopped: null, blocked: false, ...o }, { now });
