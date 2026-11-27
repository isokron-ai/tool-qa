#!/usr/bin/env node
// Dry run of the head poll (pump/heads.mjs) against a local copy of the state.
//
//   GITHUB_TOKEN=<read-only token> node scripts/heads-dry-run.mjs --state <decrypted state.sqlite> [--max-queries 3]
//
// Copies the state file to a temporary folder, prints the due list's counts
// (by lane and reason), runs one head pass on the copy with the real GraphQL
// API (public repositories only), and prints the pass and the due list after.
// The given file is never written and nothing is pushed. The token is never
// printed.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openState } from '../state/db.mjs';
import { ApiBudget } from '../pump/budgets.mjs';
import { dueFromState, loadConfig } from '../pump/due.mjs';
import { createClient, scrub } from '../pump/github.mjs';
import { MAX_QUERIES, refreshHeads } from '../pump/heads.mjs';

/** Due counts by lane and reason, as lines. */
export function dueSummary(due) {
  const by = new Map();
  for (const d of due) {
    const k = `${d.workflow} ${d.reasons.join('+')}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [`due ${due.length}`, ...[...by.entries()].sort().map(([k, n]) => `  ${k}: ${n}`)];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let state = null;
  let maxQueries = MAX_QUERIES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') state = argv[++i];
    else if (argv[i] === '--max-queries') maxQueries = Number(argv[++i]);
    else { process.stderr.write(`unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!state || !env.GITHUB_TOKEN) {
    process.stderr.write('usage: GITHUB_TOKEN=... node scripts/heads-dry-run.mjs --state <file> [--max-queries n]\n');
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'heads-dry-'));
  const say = (l) => process.stdout.write(`${scrub(l, [env.GITHUB_TOKEN])}\n`);
  try {
    const copy = join(dir, 'state.sqlite');
    copyFileSync(state, copy);
    const db = openState(copy);
    const cfg = loadConfig();
    const now = Date.now();
    say(`state copy at ${new Date(now).toISOString()}`);
    const before = db.listSubjects().filter((s) => s.retired_at == null && s.alias_of == null);
    say(`active subjects ${before.length}; with sha ${before.filter((s) => s.sha).length}; with changed_at ${before.filter((s) => s.changed_at).length}`);
    for (const l of dueSummary(dueFromState(db, { now, tiers: cfg.tiers, workflows: cfg.workflows }))) say(`before: ${l}`);
    const client = createClient({ token: env.GITHUB_TOKEN, fetch: globalThis.fetch, apiUrl: env.GITHUB_API_URL || 'https://api.github.com', budget: new ApiBudget(), log: say });
    const out = await refreshHeads(db, { client, tiers: cfg.tiers, now: Date.now, log: say, maxQueries });
    say(`pass: ${out.summary}`);
    const after = db.listSubjects().filter((s) => s.retired_at == null && s.alias_of == null);
    for (const s of after.filter((x) => x.changed_at).slice(0, 5)) say(`  e.g. ${s.id} T${s.tier} sha ${s.sha?.slice(0, 7)} changed_at ${s.changed_at} (${s.change_reason})`);
    for (const l of dueSummary(dueFromState(db, { now: Date.now(), tiers: cfg.tiers, workflows: cfg.workflows }))) say(`after: ${l}`);
    say(`cursors: ${JSON.stringify(out.tiers)}`);
    db.close();
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
