#!/usr/bin/env node
// Replay accepted results through the lead pipeline, locally, and print what
// it would do: the leads, and for each whether it would be filed now and why.
//
//   node leads/dry-run.mjs --archive <dir> [--identity <file>] [--out-json <file>] [--now <iso>]
//   node leads/dry-run.mjs --plain <dir> [--out-json <file>] [--now <iso>]
//
// The archive is read the way the check-in reads it (longitudinal/checkin.mjs
// readArchive: sealed bundles decrypted in memory with the ingest identity,
// default ~/.isokron/loop-age-identity.key, never printed; nothing decrypted
// is written to disk). Each accepted item, oldest first, goes through the same
// fingerprinting (state/fingerprint.mjs leadFailures) and the same fold
// (StateDb.noteLeads, on a state database in memory) as ingest in the pump.
// The worker run id of each item stands in for the runner: a lead is
// reproduced when a later item of the same subject and lane from another
// worker run carries it again.
//
// stdout holds shapes only (state/leads.mjs SHAPE_COLUMNS, counts, decisions):
// no subject name, no run id, no payload, so it may be pasted into a public
// pull request. --out-json adds where each lead was seen (subject names), so
// it is written 0600 and never inside the folder being read.
//
// Exit codes: 0 done; 2 usage (or an output inside the input); 3 the input could not be read.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readArchive, readPlain, byTime } from '../longitudinal/checkin.mjs';
import { DEFAULT_IDENTITY, outUnsafe, writeOut } from '../longitudinal/derive.mjs';
import { openState } from '../state/db.mjs';
import { leadFailures, seedLanguageOf } from '../state/fingerprint.mjs';
import { filingDecision, flakeStats, shapeOf } from '../state/leads.mjs';
import { resultFault } from '../worker-kit/contract.mjs';
import { recheckPairs, RECHECK_MAX_DUE } from './recheck.mjs';

export const SOURCE = 'tool-qa leads/dry-run.mjs';

/**
 * Fold items (checkin.mjs items) into a fresh in-memory state, oldest first.
 * @returns {{db: import('../state/db.mjs').StateDb, folded: number, refused: number}}
 */
export function replay(items, { langOf = seedLanguageOf() } = {}) {
  const db = openState(':memory:');
  const seen = new Set();
  const sorted = items.filter((it) => { const k = `${it.attempt_id}/${it.item_index}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => byTime(a.observed_at, b.observed_at) || `${a.attempt_id}/${a.item_index}`.localeCompare(`${b.attempt_id}/${b.item_index}`));
  let folded = 0;
  let refused = 0;
  for (const it of sorted) {
    if (!Number.isFinite(Date.parse(it.observed_at))) continue;
    const failures = leadFailures(it, { langOf });
    if (failures === null) continue; // unreadable: not folded, as in ingest
    // As ingest: a result whose every skip is retryable (skips_only) is no clean re-check.
    const skipsOnly = it.skips.length > 0 && it.skips.every((s) => s?.retryable === true);
    const coverage = skipsOnly ? null : resultFault(it.skips).coverage;
    const r = db.noteLeads(it.subject, it.lane, it.key ?? `${it.attempt_id}/${it.item_index}`, failures, { now: it.observed_at, observedAt: it.observed_at, runId: it.run_id, coverage });
    if (r.refused) refused += 1;
    else folded += 1;
  }
  return { db, folded, refused };
}

/** Every lead with its decision, newest state first by how many subjects carry it now. */
export function report(db, { now }) {
  const rows = [];
  for (const l of db.listLeads()) {
    const pairs = db.leadSubjects(l.fingerprint);
    const current = pairs.filter((p) => p.current === 1).length;
    const decision = filingDecision(l, { pairs, now }) ?? { file: false, reason: l.status };
    const flake = flakeStats(pairs, now);
    rows.push({ shape: shapeOf(l), current, pairs: pairs.length, decision, flake_rate: Math.round(flake.rate * 1000) / 1000, flaky: flake.flaky, seen_on: pairs });
  }
  rows.sort((a, b) => b.current - a.current || b.shape.sightings - a.shape.sightings || a.shape.fingerprint.localeCompare(b.shape.fingerprint));
  return rows;
}

/** The shapes-only text (safe to publish). */
export function renderText(rows, { read, now }) {
  const L = [];
  const by = (f) => rows.reduce((m, r) => m.set(f(r), (m.get(f(r)) ?? 0) + 1), new Map());
  L.push(`lead dry run at ${now}: ${read.items} items folded (${read.refused} late), ${rows.length} leads`);
  L.push(`  by status: ${[...by((r) => r.shape.status)].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  L.push(`  by decision: ${[...by((r) => (r.decision.file ? `file (${r.decision.reason})` : r.decision.reason))].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  L.push(`  by repo: ${[...by((r) => r.shape.repo)].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  L.push('');
  L.push('| fingerprint | repo | lane | component | class | fault | idiom | layout | status | now on | sightings | reproduced | flake rate | decision |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const s = r.shape;
    const kind = s.class + (/;partial=([a-z_]+)/.exec(s.signature)?.[1] ? `:${/;partial=([a-z_]+)/.exec(s.signature)[1]}` : '');
    L.push(`| \`${s.fingerprint}\` | ${s.repo.replace('isokron-ai/', '')} | ${s.lane} | ${s.component} | ${kind} | ${s.fault} | ${s.idiom} | ${s.layout} | ${s.status} | ${r.current} | ${s.sightings} | ${s.reproduced_at ? 'yes' : 'no'} | ${r.flake_rate} | ${r.decision.file ? `file: ${r.decision.reason}` : r.decision.reason} |`);
  }
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = {};
  const valued = ['--archive', '--plain', '--identity', '--out-json', '--now'];
  for (let i = 0; i < argv.length; i++) {
    if (!valued.includes(argv[i]) || i + 1 >= argv.length) return null;
    o[argv[i].slice(2)] = argv[++i];
  }
  if (!o.archive === !o.plain) return null;
  if (o.now !== undefined && !Number.isFinite(Date.parse(o.now))) return null;
  return o;
}

export async function main(argv = process.argv.slice(2), { write = (s) => process.stdout.write(s), now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (!o) {
    write('usage: node leads/dry-run.mjs (--archive <dir> [--identity <file>] | --plain <dir>) [--out-json <file>] [--now <iso>]\n');
    return 2;
  }
  const input = o.archive ?? o.plain;
  if (o['out-json'] && outUnsafe(o['out-json'], input)) {
    write('--out-json must not be inside the folder being read, nor a link or a second name for a file in it\n');
    return 2;
  }
  let read;
  try {
    if (o.archive) read = readArchive(o.archive, { identity: readFileSync(o.identity ?? DEFAULT_IDENTITY, 'utf8') });
    else {
      if (!statSync(o.plain).isDirectory()) throw new Error('not a folder');
      read = readPlain(o.plain);
    }
  } catch (err) {
    write(`could not read the input (${err?.code ?? err?.name ?? 'error'})\n`);
    return 3;
  }
  const at = o.now ?? now().toISOString();
  const { db, folded, refused } = replay(read.items);
  try {
    const rows = report(db, { now: at });
    write(renderText(rows, { read: { items: folded, refused }, now: at }));
    // What the pump would re-dispatch now with LANE_LEADS_ENABLED=recheck (leads/recheck.mjs); counts only, the pairs name subjects.
    const rc = recheckPairs(db);
    write(`\nre-checks the pump would send now: ${rc.pairs.size} (at most ${RECHECK_MAX_DUE} at once), leads waiting for one: ${rc.waiting}\n`);
    if (o['out-json']) {
      try {
        writeOut(o['out-json'], `${JSON.stringify({ source: SOURCE, generated_at: at, read: read.stats, folded, refused, leads: rows }, null, 2)}\n`);
      } catch (err) {
        write(`could not write the output (${err?.code ?? err?.name ?? 'error'})\n`);
        return 3;
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
