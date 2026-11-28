#!/usr/bin/env node
// Dry run of the discover pass (pump/discover.mjs) against a local copy of the state.
//
//   GITHUB_TOKEN=<read-only token> node scripts/discover-dry-run.mjs --state <decrypted state.sqlite> --candidates <candidates.json.gz>
//
// Copies the state, applies one discover pass to the copy with the real
// GraphQL API (public repositories only) and a local candidates file (what
// discover/run.mjs writes), and prints the pass, the frame and the due list
// count before and after. The given state is never written; nothing is
// pushed; the token is never printed.

import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { openState } from '../state/db.mjs';
import { ApiBudget } from '../pump/budgets.mjs';
import { dueFromState, loadConfig } from '../pump/due.mjs';
import { createClient, scrub } from '../pump/github.mjs';
import { applyDiscovery, FRAME_KV_KEY } from '../pump/discover.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  let state = null;
  let cands = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') state = argv[++i];
    else if (argv[i] === '--candidates') cands = argv[++i];
    else { process.stderr.write(`unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!state || !cands || !env.GITHUB_TOKEN) { process.stderr.write('usage: GITHUB_TOKEN=... node scripts/discover-dry-run.mjs --state <file> --candidates <file>\n'); return 2; }
  const say = (l) => process.stdout.write(`${scrub(l, [env.GITHUB_TOKEN])}\n`);
  const dir = mkdtempSync(join(tmpdir(), 'discover-dry-'));
  try {
    const copy = join(dir, 'state.sqlite');
    copyFileSync(state, copy);
    const db = openState(copy);
    const { tiers, workflows } = loadConfig();
    const doc = JSON.parse(gunzipSync(readFileSync(cands)).toString('utf8'));
    say(`state copy (schema ${db.schemaVersion()}); candidates ${doc.candidates.length} generated ${doc.generated_at}`);
    say(`before: subjects ${db.listSubjects().length}; due ${dueFromState(db, { now: Date.now(), tiers, workflows }).length}`);
    const client = createClient({ token: env.GITHUB_TOKEN, fetch: globalThis.fetch, apiUrl: env.GITHUB_API_URL || 'https://api.github.com', budget: new ApiBudget(), log: say });
    const out = await applyDiscovery(db, { client, getCandidates: async () => ({ artifact_id: 'local', doc }), now: Date.now, log: say });
    say(`pass: ${out.summary}`);
    for (const s of db.listSubjects().filter((x) => x.source === 'discover-v1').slice(0, 5)) {
      const keys = db.listDiscoveryKeys(s.id);
      say(`  e.g. ${s.id} T${s.tier} repo_id ${s.repo_id} id_status ${s.id_status}; keys ${keys.map((k) => `${k.subfolder || '.'}|${k.purl || '-'}|${k.feeds}`).join(', ')}`);
    }
    say(`frame: ${JSON.stringify(db.getKv(FRAME_KV_KEY))}`);
    const due = dueFromState(db, { now: Date.now(), tiers, workflows });
    say(`after: subjects ${db.listSubjects().length}; due ${due.length} (${due.filter((d) => d.reasons.includes('first_sight')).length} first_sight)`);
    db.close();
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
