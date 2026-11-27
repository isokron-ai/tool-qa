#!/usr/bin/env node
// Dry run of the backfill filler (pump/backfill.mjs) against a local copy of the state.
//
//   node scripts/backfill-dry-run.mjs --state <decrypted state.sqlite> [--slots 5]
//
// Read-only: opens a copy, prints the tick's due list, the free slots and
// what the filler would add, by lane and tier, with the oldest picks. Makes
// no network call and writes nothing.

import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openState } from '../state/db.mjs';
import { computeDue, isEnabled, loadConfig, loadDueInputs } from '../pump/due.mjs';
import { backfillCandidates, backfillFor, reserveSlots } from '../pump/backfill.mjs';
import { occupancy } from '../pump/slots.mjs';

const count = (list, key) => {
  const m = new Map();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
};

export function main(argv = process.argv.slice(2)) {
  let state = null;
  let slots = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') state = argv[++i];
    else if (argv[i] === '--slots') slots = Number(argv[++i]);
    else { process.stderr.write(`unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!state) { process.stderr.write('usage: node scripts/backfill-dry-run.mjs --state <file> [--slots n]\n'); return 2; }
  const dir = mkdtempSync(join(tmpdir(), 'backfill-dry-'));
  const say = (l) => process.stdout.write(`${l}\n`);
  try {
    const copy = join(dir, 'state.sqlite');
    copyFileSync(state, copy);
    const db = openState(copy);
    const { tiers, workflows } = loadConfig();
    const now = Date.now();
    const paused = new Set(db.pausedWorkflows({ now }).map((p) => p.workflow));
    const lanes = Object.fromEntries(Object.entries(workflows).filter(([n, w]) => isEnabled(w) && !paused.has(n)));
    const inputs = loadDueInputs(db, { now, tiers, workflows: lanes });
    const due = computeDue(inputs);
    const occ = occupancy(db, { now });
    const openBy = new Map();
    for (const d of occ.dispatches) openBy.set(d.workflow, (openBy.get(d.workflow) ?? 0) + 1);
    const candidates = backfillCandidates(inputs, { exclude: new Set(due.map((d) => `${d.subject}\u0000${d.workflow}`)), since: db.attemptsSinceResult() });
    const fill = backfillFor({ candidates, due, workflows: lanes, freeSlots: slots - occ.slots, openByWorkflow: openBy, reserve: reserveSlots(tiers) });
    say(`state copy at ${new Date(now).toISOString()}; enabled lanes ${Object.keys(lanes).join(', ')}${paused.size ? `; paused ${[...paused].join(', ')}` : ''}`);
    say(`due ${due.length} (${count(due, (d) => d.workflow)})`);
    say(`worker slots ${slots}, open ${occ.slots}, free ${Math.max(0, slots - occ.slots)}`);
    say(`backfill candidates ${candidates.length} (${count(candidates, (d) => `${d.workflow}/T${d.tier}`)})`);
    say(`backfill this tick ${fill.length} (${count(fill, (d) => d.workflow)})`);
    for (const f of fill.slice(0, 8)) {
      const last = inputs.lastResults.get(`${f.subject}\u0000${f.workflow}`);
      say(`  ${f.priority.toFixed(1).padStart(8)}  T${f.tier}  ${f.workflow.padEnd(14)} ${f.subject}  last result ${last.accepted_at}`);
    }
    db.close();
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
