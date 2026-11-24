#!/usr/bin/env node
// Compare one result (perf/run.mjs) with the baseline of the SAME server's
// previous release, and say ok / amber / red / new.
//
//   node perf/compare.mjs --result <file> [--baselines perf/baselines] [--against <version>]
//                         [--summary <markdown file to append to>] [--verdict <json file>]
//
// The previous release is the newest version below the result's own that has a
// baseline file perf/baselines/<server>/<version>.json. A server is never
// compared with another server (judgeResult refuses). Exit codes: 0 ok, amber
// or new; 1 red; 2 usage error. Amber prints a GitHub warning annotation.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { RESULT_SCHEMA, judgeResult, parseVersion, previousVersion } from './lib.mjs';
import { SAFE_ID } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Versions that have a baseline for a server. */
export function baselineVersions(baselinesDir, server) {
  const dir = join(baselinesDir, server);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((v) => parseVersion(v));
}

export function loadBaseline(baselinesDir, server, version) {
  if (!SAFE_ID.test(server) || !parseVersion(version)) throw new Error('bad server or version for a baseline path');
  const b = JSON.parse(readFileSync(join(baselinesDir, server, `${version}.json`), 'utf8'));
  if (b.schema !== RESULT_SCHEMA) throw new Error(`baseline ${server} ${version} has schema ${b.schema}, expected ${RESULT_SCHEMA}`);
  return b;
}

const icon = { ok: 'OK', amber: 'AMBER', red: 'RED', new: 'NEW (first baseline)' };

export function markdown(result, verdict) {
  const lines = [`### ${result.server} ${result.version}: ${icon[verdict.status]}`, ''];
  lines.push(verdict.baseline_version
    ? `Compared with ${result.server} ${verdict.baseline_version} (its own previous release).`
    : 'No earlier release of this server has a baseline.');
  lines.push('', `Inspector ${result.inspector.version} \`--load\`; runner calibration ${result.runner.calibration_ms} ms (smaller is faster).`, '');
  lines.push('| profile | p50 ms | p95 ms | p99 ms | errors | ok calls/s | p95 spread | vs previous |', '|---|---|---|---|---|---|---|---|');
  for (const [name, p] of Object.entries(result.profiles)) {
    const s = p.summary;
    if (!s) { lines.push(`| ${name} | | | | | | | did not complete: ${p.error ?? 'no summary'} |`); continue; }
    const j = verdict.profiles[name];
    lines.push(`| ${name} | ${s.p50_ms} | ${s.p95_ms} | ${s.p99_ms} | ${s.error_rate} | ${s.ok_per_s} | ${s.p95_spread}x | ${j ? j.status : verdict.status === 'new' ? 'new' : '-'} |`);
  }
  for (const [name, j] of Object.entries(verdict.profiles)) {
    if (j.notes.length) lines.push('', `${name}:`, ...j.notes.map((n) => `- ${n}`));
  }
  if (verdict.notes.length) lines.push('', ...verdict.notes.map((n) => `- ${n}`));
  const churn = Object.entries(result.profiles).filter(([, p]) => p.summary?.churn);
  if (churn.length) {
    lines.push('', 'Session churn (each worker connects, makes 3 calls, disconnects, repeats):', '', '| profile | sessions opened | connect failed | connect p50 ms | connect p95 ms | sessions/s |', '|---|---|---|---|---|---|');
    for (const [name, p] of churn) {
      const c = p.summary.churn;
      lines.push(`| ${name} | ${c.sessions_opened} | ${c.connect_failed} | ${c.connect_p50_ms} | ${c.connect_p95_ms} | ${Math.round(c.sessions_per_s)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const { values } = parseArgs({
    options: {
      result: { type: 'string' },
      baselines: { type: 'string', default: join(HERE, 'baselines') },
      against: { type: 'string' },
      summary: { type: 'string' },
      verdict: { type: 'string' },
    },
  });
  if (!values.result) throw new Error('--result is required');
  const result = JSON.parse(readFileSync(values.result, 'utf8'));
  if (result.schema !== RESULT_SCHEMA) throw new Error(`result has schema ${result.schema}, expected ${RESULT_SCHEMA}`);
  if (!SAFE_ID.test(result.server) || !parseVersion(result.version)) throw new Error('result has a bad server id or version');
  const dir = resolve(values.baselines);
  const prev = values.against ?? previousVersion(result.version, baselineVersions(dir, result.server));
  const baseline = prev ? loadBaseline(dir, result.server, prev) : null;
  const verdict = judgeResult(result, baseline);
  const md = markdown(result, verdict);
  process.stdout.write(md);
  if (values.summary) appendFileSync(values.summary, `${md}\n`);
  if (values.verdict) writeFileSync(values.verdict, `${JSON.stringify({ server: result.server, version: result.version, ...verdict }, null, 2)}\n`);
  if (verdict.status === 'amber') {
    const first = Object.values(verdict.profiles).flatMap((p) => p.notes).find((n) => n.startsWith('amber')) ?? 'slower than the previous release';
    console.log(`::warning title=perf ${result.server} ${result.version}::${first.replace(/[\r\n%]/g, ' ')}`);
  }
  if (verdict.status === 'red') {
    const first = [...Object.values(verdict.profiles).flatMap((p) => p.notes), ...verdict.notes].find((n) => n.startsWith('red') || n.includes('did not complete') || n.includes('too high')) ?? 'regression';
    console.log(`::error title=perf ${result.server} ${result.version}::${first.replace(/[\r\n%]/g, ' ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`perf compare: ${e.message}`); process.exit(2); }
}
