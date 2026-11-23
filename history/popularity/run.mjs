#!/usr/bin/env node
// H3 runner. Usage:
//   node history/popularity/run.mjs --out DIR --state DIR [--seed history/seed.txt]
//        [--mode downloads|stars|all] [--crates-subset PATH/crates-*.ndjson.gz]
// `downloads` = npm, pypistats, crates. `stars` = GitHub. GITHUB_TOKEN is read from the environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createHttp } from '../packages/lib/http.mjs';
import { writeManifest, writeNdjsonGz } from '../packages/lib/manifest.mjs';
import { readSeed } from './seed.mjs';
import { npmPopularity, pypiPopularity, cratesPopularity } from './registries.mjs';
import { githubPopularity } from './github.mjs';

export function readNdjsonGz(path) {
  return gunzipSync(readFileSync(path)).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function runPopularity({ seed, mode = 'all', http, out, stateDir, token, cratesSubset, now = Date.now(), sleep, delayMs }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const startedAt = Date.now();
  const files = []; const errors = []; const missing = []; const warnings = []; const extra = { mode, seed_counts: Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.length])) };
  const emit = (name, rows) => files.push({ name: writeNdjsonGz(out, `${name}-${day}.ndjson.gz`, rows), rows: rows.length });
  const opt = { now, ...(sleep ? { sleep } : {}), ...(delayMs != null ? { delayMs } : {}) };
  if (mode === 'downloads' || mode === 'all') {
    for (const [name, fn] of [['npm', () => npmPopularity(http, seed.npm, opt)], ['pypi', () => pypiPopularity(http, seed.pypi, opt)]]) {
      const r = await fn(); emit(`popularity-${name}`, r.rows); errors.push(...r.errors); missing.push(...(r.missing ?? []));
    }
    let subset = [];
    if (seed.crates.length) {
      if (cratesSubset && existsSync(cratesSubset)) subset = readNdjsonGz(cratesSubset);
      else warnings.push('crates: no --crates-subset file supplied (no history-packages crates file found); crates not counted this run');
    }
    const r = cratesPopularity(subset, seed.crates, { now });
    emit('popularity-crates', r.rows);
    if (seed.crates.length && subset.length) missing.push(...r.missing);
  }
  if (mode === 'stars' || mode === 'all') {
    const sp = join(stateDir, 'github-etags.json');
    const state = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : {};
    const r = await githubPopularity(http, seed.github, { token, state, now });
    emit('popularity-github', r.rows); errors.push(...r.errors); missing.push(...r.missing); warnings.push(...r.warnings); extra.github = r.stats;
    mkdirSync(stateDir, { recursive: true }); writeFileSync(sp, JSON.stringify(r.state)); // ETags are safe to keep even on partial failure
  }
  // `ok` is for broken runs only. Missing packages and rate-limit stops are recorded, not failed.
  extra.missing = missing; extra.warnings = warnings;
  const { manifest } = writeManifest({ dir: out, source: `popularity-${mode}`, files, startedAt, finishedAt: Date.now(), errors, extra });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, state: { type: 'string' }, seed: { type: 'string', default: 'history/seed.txt' }, mode: { type: 'string', default: 'all' }, 'crates-subset': { type: 'string' } } });
  if (!values.out || !values.state || !['downloads', 'stars', 'all'].includes(values.mode)) { console.error('usage: --out DIR --state DIR [--mode downloads|stars|all]'); process.exit(2); }
  mkdirSync(values.out, { recursive: true });
  const m = await runPopularity({ seed: readSeed(values.seed), mode: values.mode, http: createHttp(), out: values.out, stateDir: values.state, token: process.env.GITHUB_TOKEN, cratesSubset: values['crates-subset'] });
  console.log(`${m.source}: ${m.files.map((f) => `${f.name} rows=${f.rows}`).join(', ')}; missing=${m.missing.length}${m.ok ? '' : ' ERRORS ' + m.errors.join('; ')}`);
  for (const w of m.warnings) console.log(`::warning title=history-popularity::${w}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### ${m.source}`, '', ...m.files.map((f) => `- ${f.name}: ${f.rows} rows`), `- missing (gone from their registry): ${m.missing.length}`];
    if (m.github) lines.push(`- github: ${m.github.requests} requests, ${m.github.not_modified} not modified, ${m.github.skipped_rate_limit} skipped at the rate limit`);
    for (const w of m.warnings) lines.push(`- warning: ${w}`);
    for (const e of m.errors) lines.push(`- error: ${e}`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  process.exit(m.ok ? 0 : 1);
}
