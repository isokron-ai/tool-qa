#!/usr/bin/env node
// Build the files to publish from what ingest accepted. Writes nothing to the
// results checkout and sends nothing anywhere: the would-be files go to --out,
// and deliver.mjs (a later workflow step) is the only thing that can publish them.
//
//   node publish/run.mjs --results <mcp-results checkout> --out <dir> \
//        (--source-dir <dir> | --plain-dir <dir> | --source-artifacts [--since-days N]) \
//        [--registry <file>] [--identity-file <file>]
//
// Sources (see read.mjs):
//   --source-dir        a folder of sealed keep-*.tar.age files (the archive pull's
//                       layout, or the keep-forever release parts); needs the age identity
//   --plain-dir         a folder laid out as accepted/<attempt>/<index>/... (tests, fixtures)
//   --source-artifacts  the Actions artifacts ingest-keep-* of GITHUB_REPOSITORY made in the
//                       last N days (default 7), checked to come from our own pump on main
//
// The age identity is read from AGE_IDENTITY (or --identity-file) into memory and
// removed from the environment at start. Decrypted data is never written to disk.
//
// Output in --out (this is all that is ever public):
//   data/...      the files that would change in mcp-results/data (day files, manifest)
//   report.json   what is published: records added, records already published, files changed,
//                 the registry used. Nothing about what was held or left out.
//
// Everything about what was held or left out (held by reason, fields left out by class, items
// that failed a check, sealed files that could not be read, conflicts skipped) goes to
// --private-out only: report.json there, age-sealed to --seal-to's recipients as report.json.age
// when --seal-to is given (the workflow does). Without --private-out it is not written at all.
// Counts of held results are never printed, put in the step summary or in a pull request: next
// to the public counts of accepted results they would show how many were held as security class.
//
// Exit codes: 0 done (with or without changes), 1 error, 2 usage, 3 stopped without writing: a
// published record outside the re-read window would change (conflict), or something already
// published is no longer publishable under the registry (audit). 4 done, but not clean: a sealed
// file could not be read, a result was held for a coverage mismatch, or a re-read record differed
// from its published one. The output is written, and the workflow ends red after delivering it.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ageEncrypt, readSealRecipients } from '../ingest/age.mjs';
import { parseRegistry } from '../ingest/registry.mjs';
import { ApiBudget } from '../pump/budgets.mjs';
import { createClient, scrub } from '../pump/github.mjs';
import { MAX_LIST_PAGES, download, listArtifacts, prefetchRuns, provenanceProblem } from '../scripts/archive-pull.mjs';
import { readZipLenient } from '../scripts/lib/unzip.mjs';
import { buildRecord } from './record.mjs';
import { checkItem, entriesFromPlain, entriesFromSealed, itemsFromEntries, KEEP_FILE_RE, sealedFilesIn } from './read.mjs';
import { auditStore, filesToWrite, loadStore, merge } from './store.mjs';
import { sha256 } from './canonical.mjs';

const USER_AGENT = 'isokron-tool-qa-publish-results';
const KEEP_ARTIFACT = /^ingest-keep-\d+-\d+$/;

/**
 * Turn entries of accepted results into records and merge them. Pure apart from `store`.
 * @returns the counts of the run (no secret-class count) and the new records
 */
export function publishEntries(entryLists, { registry, store, windowStartMs = null }) {
  const stats = { items_not_accepted: 0, held_other: {}, withheld_fields: {}, records_built: 0 };
  const built = [];
  for (const entries of entryLists) {
    for (const group of itemsFromEntries(entries)) {
      const checked = checkItem(group);
      if (!checked.ok) { stats.items_not_accepted += 1; continue; }
      const r = buildRecord(checked.item, registry);
      if (r.held) {
        // A security-class hold is silent: nothing is counted, logged or reported.
        if (r.reason !== 'security_class') stats.held_other[r.reason] = (stats.held_other[r.reason] ?? 0) + 1;
        continue;
      }
      for (const [k, n] of Object.entries(r.withheld)) stats.withheld_fields[k] = (stats.withheld_fields[k] ?? 0) + n;
      built.push(r.record);
    }
  }
  stats.records_built = built.length;
  const merged = merge(store, built, { windowStartMs });
  return { stats, merged };
}

function parseArgs(argv) {
  const o = { sinceDays: 7 };
  const need = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') o.results = need(i++);
    else if (a === '--out') o.out = need(i++);
    else if (a === '--source-dir') o.sourceDir = need(i++);
    else if (a === '--plain-dir') o.plainDir = need(i++);
    else if (a === '--source-artifacts') o.artifacts = true;
    else if (a === '--since-days') o.sinceDays = Number(need(i++));
    else if (a === '--registry') o.registry = need(i++);
    else if (a === '--identity-file') o.identityFile = need(i++);
    else if (a === '--private-out') o.privateOut = need(i++);
    else if (a === '--seal-to') o.sealTo = need(i++);
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.results || !o.out) throw new Error('--results and --out are required');
  if ([o.sourceDir, o.plainDir, o.artifacts].filter(Boolean).length !== 1) throw new Error('give exactly one of --source-dir, --plain-dir, --source-artifacts');
  if (!Number.isFinite(o.sinceDays) || o.sinceDays <= 0 || o.sinceDays > 90) throw new Error('--since-days must be 1 to 90');
  return o;
}

async function artifactSealedFiles({ env, sinceDays, say }) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('--source-artifacts needs GITHUB_REPOSITORY and GITHUB_TOKEN');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const budget = new ApiBudget({ sleep, families: { artifacts: { perHour: 600, perMinute: 60 }, actions: { perHour: 200, perMinute: 30 } }, totalPerHour: 800, maxWaitMs: 120_000 });
  const client = createClient({ token, budget, sleep, userAgent: USER_AGENT, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
  const since = Date.now() - sinceDays * 86_400_000;
  const listing = await listArtifacts(client, repo, since, MAX_LIST_PAGES);
  if (!listing.complete) throw new Error('the artifact list did not end within its page limit');
  const list = listing.items.filter((a) => !a.expired && KEEP_ARTIFACT.test(a.name) && Date.parse(a.created_at) >= since)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const runs = new Map();
  await prefetchRuns(client, repo, list, runs);
  const files = [];
  let foreign = 0;
  for (const a of list) {
    const origin = await provenanceProblem(client, repo, a, runs);
    if (origin) { foreign += 1; say(`publish: ${a.name}: not from our own pump on main, left alone`); continue; }
    const data = await download(client, globalThis.fetch, repo, a, sleep);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''))?.[1] ?? null;
    if (digest && digest !== sha256(data)) throw new Error(`${a.name}: the download does not match the artifact digest`);
    for (const e of readZipLenient(data).entries) {
      if (KEEP_FILE_RE.test(e.name)) files.push({ name: `${a.name}/${e.name}`, data: e.data });
    }
  }
  return { files, artifacts: list.length, foreign };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  let o;
  try { o = parseArgs(argv); } catch (err) {
    process.stderr.write(`publish: ${err.message}\n`);
    return 2;
  }
  let identity = env.AGE_IDENTITY;
  delete process.env.AGE_IDENTITY;
  const secrets = () => [identity, env.GITHUB_TOKEN];
  const say = (line) => process.stderr.write(`${scrub(line, secrets())}\n`);
  try {
    const results = resolve(o.results);
    const registry = parseRegistry(readFileSync(o.registry ?? join(results, 'fields/registry.yaml'), 'utf8'));
    const dataDir = join(results, 'data');
    const store = loadStore(dataDir);
    const problems = auditStore(store, registry);
    if (problems.length) {
      for (const p of problems.slice(0, 50)) say(`publish: audit: ${p}`);
      say(`publish: ${problems.length} problem(s) with what is already published; nothing written`);
      return 3;
    }

    const report = { version: 1, mode: o.plainDir ? 'plain' : o.sourceDir ? 'dir' : 'artifacts', registry: { version: registry.version, sha256: registry.sha256 }, sealed_files: 0, unreadable_sealed_files: 0 };
    const lists = [];
    if (o.plainDir) {
      lists.push(entriesFromPlain(resolve(o.plainDir)));
    } else {
      if (!identity && o.identityFile) identity = readFileSync(o.identityFile, 'utf8');
      if (!identity) throw new Error('the age identity is needed to read sealed results (AGE_IDENTITY or --identity-file)');
      let sealed;
      if (o.sourceDir) sealed = { files: sealedFilesIn(resolve(o.sourceDir)) };
      else {
        sealed = await artifactSealedFiles({ env, sinceDays: o.sinceDays, say });
        report.artifacts = { listed: sealed.artifacts, not_ours: sealed.foreign };
      }
      report.sealed_files = sealed.files.length;
      for (const f of sealed.files) {
        try { lists.push((deps.entriesFromSealed ?? entriesFromSealed)(f.data, { identity, ageBin: env.AGE_BIN || 'age' })); } catch (err) {
          report.unreadable_sealed_files += 1;
          say(`publish: ${f.name}: cannot be read (${String(err?.message ?? err).slice(0, 120)})`);
        }
      }
    }

    // Results read again from artifacts (the last N days) may differ from what was published if the
    // registry or the redaction rules changed since: those are skipped and counted privately.
    const windowStartMs = o.artifacts ? (deps.now?.() ?? Date.now()) - (o.sinceDays + 2) * 86_400_000 : null;
    const { stats, merged } = publishEntries(lists, { registry, store, windowStartMs });
    if (merged.conflicts.length) {
      for (const c of merged.conflicts.slice(0, 20)) say(`publish: conflict: record ${c.record_id} is published in ${c.path} with other content; published records are never changed. Nothing written`);
      return 3;
    }
    const files = filesToWrite(store, merged, { registry, dataDir });
    // The result must itself pass the audit, so a bug here stops the run instead of publishing.
    const after = auditStore(store, registry);
    if (after.length) {
      for (const p of after.slice(0, 50)) say(`publish: output audit: ${p}`);
      return 3;
    }

    rmSync(join(o.out, 'data'), { recursive: true, force: true });
    for (const [p, bytes] of files) {
      const f = join(o.out, 'data', p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, bytes);
    }
    const priv = { ...report, ...stats, records_added: merged.added.length, records_unchanged: merged.unchanged, records_skipped_by_correction: merged.removed, conflicts_skipped: merged.skipped_conflicts };
    const clean = priv.unreadable_sealed_files === 0 && !(priv.held_other.coverage_mismatch > 0) && priv.conflicts_skipped === 0;
    const pub = {
      version: 1, registry: report.registry,
      records_added: merged.added.length, records_unchanged: merged.unchanged,
      files_changed: [...files.keys()].sort(),
    };
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, 'report.json'), `${JSON.stringify(pub, null, 2)}\n`);
    if (o.privateOut) {
      mkdirSync(o.privateOut, { recursive: true });
      const text = `${JSON.stringify({ ...priv, clean }, null, 2)}\n`;
      if (o.sealTo) {
        const box = ageEncrypt({ plaintext: Buffer.from(text), recipients: readSealRecipients(resolve(o.sealTo)), ageBin: env.AGE_BIN || 'age' });
        writeFileSync(join(o.privateOut, 'report.json.age'), box, { mode: 0o600 });
      } else writeFileSync(join(o.privateOut, 'report.json'), text, { mode: 0o600 });
    }
    say(`publish: ${pub.records_added} new record(s), ${pub.records_unchanged} already published, ${files.size} file(s) change${clean ? '' : '; not clean: see the private report'}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Publish results\n\n- new records: ${pub.records_added}\n- already published: ${pub.records_unchanged}\n- files that change: ${files.size}\n`);
    if (!clean) return 4;
    return 0;
  } catch (err) {
    say(`publish: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
