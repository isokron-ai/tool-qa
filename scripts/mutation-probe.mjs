#!/usr/bin/env node
// Mutation probes: switch one protection off, run the tests that pin it, and
// check that they fail (the probe is "killed"). Runs on GitHub Actions
// (.github/workflows/mutation-probe.yml), never needing a local machine.
//
//   node scripts/mutation-probe.mjs <probes.json> [...more.json]   all probes in this checkout, one after the other
//   node scripts/mutation-probe.mjs plan                           the workflow's plan step (reads env)
//   node scripts/mutation-probe.mjs cell                           one probe, baseline then mutant (reads env)
//   node scripts/mutation-probe.mjs collect <results-dir>          the workflow's summary step
//
// A probe is {id, file, find, replace, test?, pattern?}; `old` and `new` are the
// same as `find` and `replace` (the first probe files used them). `find` must
// occur exactly once in `file`; it is replaced by `replace`, the test runs, and
// the file is put back. `test` is a test file (run as `node --test <file>`, only
// the tests whose names match `pattern` when given) or, when it is anything
// else, a shell command; a probe without `test` uses the workflow's `test`.
// Outcomes: killed (the test failed), survived (it still passed), stale (`find`
// is gone or not unique, or `file` is outside the checkout) and baseline_failed
// (the test failed before the edit, so a failure would prove nothing). Exit 1
// when any probe is not killed, so the job goes red.
//
// The workflow passes every input in environment variables; nothing here
// reads a command line built from them.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PROBES = 20;
export const OUTCOMES = ['killed', 'survived', 'stale', 'baseline_failed'];
const TEST_FILE = /^[\w@./-]+\.(?:m?js|cjs)$/;

/** How often `needle` occurs in `text`. */
export const occurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/** One probe, checked and with find/replace and old/new both set. */
export function normalizeProbe(p, where = 'probe') {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${where}: not an object`);
  const find = p.find ?? p.old;
  const replace = p.replace ?? p.new;
  for (const [k, v] of [['id', p.id], ['file', p.file], ['find', find]]) if (typeof v !== 'string' || !v) throw new Error(`${where}: a probe has no ${k}`);
  if (typeof replace !== 'string') throw new Error(`${where}: probe ${p.id} has no replace text`);
  if (p.test !== undefined && (typeof p.test !== 'string' || !p.test)) throw new Error(`${where}: probe ${p.id} has a test that is not text`);
  if (p.pattern !== undefined && typeof p.pattern !== 'string') throw new Error(`${where}: probe ${p.id} has a pattern that is not text`);
  return { id: p.id, file: p.file, find, replace, old: find, new: replace, ...(p.test ? { test: p.test } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) };
}

/** Read and check a probes file: a non-empty list of probes. */
export function loadProbes(file) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${file}: not a non-empty list`);
  return list.map((p) => normalizeProbe(p, file));
}

/** The probes a run asks for: inline JSON first, then each probes file. Ids must be unique. */
export function collectProbes({ mutations = '', files = '', root = process.cwd() } = {}) {
  const out = [];
  // Nothing asked for: every committed probes file under test/mutations/ (a pull request run).
  if (!mutations.trim() && !files.trim()) {
    try { files = readdirSync(join(root, 'test/mutations')).filter((f) => f.endsWith('.json')).sort().map((f) => `test/mutations/${f}`).join(' '); } catch { /* no directory */ }
  }
  if (mutations.trim()) {
    let list;
    try { list = JSON.parse(mutations); } catch (err) { throw new Error(`mutations is not JSON: ${err.message}`); }
    if (!Array.isArray(list)) throw new Error('mutations is not a JSON list');
    list.forEach((p, i) => out.push(normalizeProbe(p, `mutations[${i}]`)));
  }
  for (const f of files.split(/\s+/).filter(Boolean)) {
    if (isAbsolute(f) || f.split('/').includes('..') || !f.endsWith('.json')) throw new Error(`probes file must be a relative .json path inside the repository: ${f}`);
    out.push(...loadProbes(f));
  }
  if (out.length === 0) throw new Error('no probes: give mutations or a probes file');
  const seen = new Set();
  for (const p of out) {
    if (seen.has(p.id)) throw new Error(`duplicate probe id: ${p.id}`);
    seen.add(p.id);
  }
  if (out.length > MAX_PROBES) throw new Error(`${out.length} probes; the most one run takes is ${MAX_PROBES}`);
  return out;
}

/** The command that runs a probe's test: a test file under node --test, anything else in bash. */
export function testCommand(p, defaultTest = '') {
  const t = p.test || defaultTest;
  if (!t) throw new Error(`probe ${p.id} has no test and the run gave none`);
  if (TEST_FILE.test(t)) return [process.execPath, '--test', '--test-timeout=120000', ...(p.pattern ? ['--test-name-pattern', p.pattern] : []), t];
  return ['bash', '-ceu', t];
}

/** The file a probe names, inside `root`, never in .git; null when it is not. */
export function safePath(root, file) {
  if (isAbsolute(file)) return null;
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git') return null;
  return abs;
}

const spawnRun = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });

/**
 * Run one probe; the mutated file is always put back. `run(argv)` returns {status, stdout}.
 * With baseline true the unmodified test runs first and must pass.
 */
export function runProbe(p, { run = spawnRun, root = process.cwd(), defaultTest = '', baseline = false } = {}) {
  const base = { id: p.id, file: p.file };
  const path = safePath(root, p.file);
  if (!path) return { ...base, outcome: 'stale', detail: `${p.file} is outside the checkout` };
  let original;
  try { original = readFileSync(path, 'utf8'); } catch { return { ...base, outcome: 'stale', detail: `${p.file} cannot be read` }; }
  const find = p.find ?? p.old;
  const replace = p.replace ?? p.new;
  const n = occurrences(original, find);
  if (n !== 1) return { ...base, outcome: 'stale', detail: `the text to mutate occurs ${n} times in ${p.file}` };
  const argv = testCommand(p, defaultTest);
  if (baseline) {
    const b = run(argv);
    if (b.status !== 0) return { ...base, outcome: 'baseline_failed', detail: `the test fails before the edit (exit ${b.status})` };
  }
  writeFileSync(path, original.replace(find, () => replace));
  try {
    const res = run(argv);
    const failed = (res.stdout ?? '').split('\n').filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.replace(/ \([0-9.]+ms\)$/, '').slice(2, 120));
    return res.status === 0
      ? { ...base, outcome: 'survived', detail: 'every test still passed' }
      : { ...base, outcome: 'killed', detail: [...new Set(failed)].slice(0, 3).join('; ') || `exit ${res.status}` };
  } finally {
    writeFileSync(path, original);
  }
}

const cell = (s) => String(s).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');

/** The summary table for a list of results. */
export function table(results) {
  return ['| probe | outcome | detail |', '|---|---|---|', ...results.map((r) => `| ${cell(r.id)} | ${r.outcome} | ${cell(r.detail)} |`)].join('\n');
}

/** Whether a set of results passes: exactly the planned probes, every one killed. */
export function verdict(results, expected = results.length) {
  const bad = results.filter((r) => r.outcome !== 'killed');
  const missing = expected - results.length;
  return { ok: bad.length === 0 && missing === 0 && results.length > 0, survived: results.filter((r) => r.outcome === 'survived').length, stale: results.filter((r) => r.outcome === 'stale').length, baseline_failed: results.filter((r) => r.outcome === 'baseline_failed').length, missing };
}

const summary = (env, text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };

/** The plan step: validate the inputs, write the matrix to GITHUB_OUTPUT. */
export function plan(env, write) {
  const probes = collectProbes({ mutations: env.MUTATIONS ?? '', files: env.PROBE_FILES ?? '' });
  const missingTest = probes.filter((p) => !p.test && !(env.DEFAULT_TEST ?? '').trim());
  if (missingTest.length) throw new Error(`no test for: ${missingTest.map((p) => p.id).join(', ')}`);
  const matrix = { include: probes.map((p, i) => ({ idx: i, id: p.id.slice(0, 60) })) };
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\ncount=${probes.length}\n`);
  write(`${probes.length} probes planned\n`);
  return 0;
}

/** The cell step: one probe, result written to RESULT_DIR/result-<idx>.json. Always exits 0 on a verdict. */
export function cellStep(env, write, run = spawnRun) {
  const probes = collectProbes({ mutations: env.MUTATIONS ?? '', files: env.PROBE_FILES ?? '' });
  const idx = Number(env.PROBE_INDEX);
  if (!Number.isInteger(idx) || !probes[idx]) throw new Error(`no probe at index ${env.PROBE_INDEX}`);
  const r = runProbe(probes[idx], { run, defaultTest: env.DEFAULT_TEST ?? '', baseline: true });
  const dir = env.RESULT_DIR || 'mutation-result';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `result-${idx}.json`), `${JSON.stringify({ idx, ...r })}\n`);
  write(`${r.id}: ${r.outcome} (${r.detail})\n`);
  return 0;
}

/** The collect step: the table, the JSON file, exit 1 unless every planned probe was killed. */
export function collect(dir, env, write) {
  const results = readdirSync(dir).filter((f) => /^result-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort((a, b) => a.idx - b.idx);
  const expected = Number(env.PLANNED ?? results.length);
  const v = verdict(results, expected);
  const out = { ref: env.PROBE_REF ?? null, planned: expected, ...v, results };
  writeFileSync(join(dir, 'mutation-probe-results.json'), `${JSON.stringify(out, null, 2)}\n`);
  const text = `${table(results)}\n\n${results.length} of ${expected} ran: ${results.length - v.survived - v.stale - v.baseline_failed} killed, ${v.survived} survived, ${v.stale} stale, ${v.baseline_failed} baseline failed${v.missing ? `, ${v.missing} missing` : ''}.`;
  write(`${text}\n`);
  summary(env, `## Mutation probes\n\n${text}`);
  return v.ok ? 0 : 1;
}

export function main(argv = process.argv.slice(2), env = process.env, write = (s) => process.stdout.write(s)) {
  if (argv.length === 0) {
    write('usage: node scripts/mutation-probe.mjs <probes.json> [...] | plan | cell | collect <dir>\n');
    return 2;
  }
  if (argv[0] === 'plan') return plan(env, write);
  if (argv[0] === 'cell') return cellStep(env, write);
  if (argv[0] === 'collect') return argv[1] ? collect(argv[1], env, write) : 2;
  const results = argv.flatMap((f) => loadProbes(f).map((p) => runProbe(p, { defaultTest: env.DEFAULT_TEST ?? '' })));
  write(`${table(results)}\n`);
  summary(env, `## Mutation probes\n\n${table(results)}`);
  return results.every((r) => r.outcome === 'killed') ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`::error::${String(err.message).replace(/[\r\n]+/g, ' ')}\n`);
    process.exitCode = 2;
  }
}
