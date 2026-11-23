#!/usr/bin/env node
// H2 runner. Usage:
//   node history/packages/run.mjs --out DIR --state DIR [--source npm,pypi,crates,go]
// One source failing does not stop the others; its state is left unchanged and the exit code is 1.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHttp } from './lib/http.mjs';
import { writeManifest, writeNdjsonGz } from './lib/manifest.mjs';
import { runNpm } from './npm.mjs';
import { runPypi } from './pypi.mjs';
import { runCrates } from './crates.mjs';
import { runGo } from './go.mjs';

const RUNNERS = { npm: runNpm, pypi: runPypi, crates: runCrates, go: runGo };

export async function runSource(name, { http, out, stateDir, now = Date.now() }) {
  const statePath = join(stateDir, `${name}.json`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const startedAt = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  let result; const errors = [];
  try { result = await RUNNERS[name]({ http, state, now }); errors.push(...result.errors); }
  catch (e) { errors.push(e.message); result = { rows: [], state }; }
  const files = [];
  if (!result.skipped) files.push({ name: writeNdjsonGz(out, `${name}-${day}.ndjson.gz`, result.rows), rows: result.rows.length });
  const { dump, totals, note, skipped } = result;
  const extra = { since_before: state.since ?? state.serial ?? null, since_after: result.state.since ?? result.state.serial ?? null };
  if (dump) extra.dump = dump;
  if (totals) extra.totals = totals;
  if (note) extra.note = note;
  if (skipped) extra.skipped = true;
  const m = writeManifest({ dir: out, source: name, files, startedAt, finishedAt: Date.now(), errors, extra });
  if (!errors.length) { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(result.state)); }
  return m.manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, state: { type: 'string' }, source: { type: 'string', default: 'npm,pypi,crates,go' } } });
  if (!values.out || !values.state) { console.error('--out and --state are required'); process.exit(2); }
  mkdirSync(values.out, { recursive: true });
  const http = createHttp();
  let failed = 0;
  for (const s of values.source.split(',')) {
    if (!RUNNERS[s]) { console.error(`unknown source ${s}`); process.exit(2); }
    const m = await runSource(s, { http, out: values.out, stateDir: values.state });
    console.log(`${s}: ${m.files.map((f) => `${f.name} rows=${f.rows}`).join(', ') || 'no files'}${m.ok ? '' : ' ERRORS ' + m.errors.join('; ')}`);
    if (!m.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}
