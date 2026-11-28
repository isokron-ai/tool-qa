#!/usr/bin/env node
// Mutation probes: switch one protection off, run the tests that pin it, and
// check that they fail (the probe is "killed"). Runs on GitHub Actions
// (.github/workflows/mutation-probe.yml), never needing a local machine.
//
//   node scripts/mutation-probe.mjs <probes.json> [...more.json]
//
// A probes file is a JSON list of {id, file, old, new, test, pattern?}: `old`
// must occur exactly once in `file`; it is replaced by `new`, `node --test`
// runs `test` (only the tests whose names match `pattern`, when given), and the
// file is put back. A probe survives when the tests still pass; a probe whose
// `old` text is gone (or not unique) is reported as stale. Exit 1 when any
// probe survived or is stale, so the job goes red.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How often `needle` occurs in `text`. */
export const occurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/** Read and check a probes file: a list of probes with the fields every probe needs. */
export function loadProbes(file) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${file}: not a non-empty list`);
  for (const p of list) {
    for (const k of ['id', 'file', 'old', 'test']) if (typeof p?.[k] !== 'string' || !p[k]) throw new Error(`${file}: a probe has no ${k}`);
    if (typeof p.new !== 'string') throw new Error(`${file}: probe ${p.id} has no new text`);
  }
  return list;
}

/** Run one probe; the mutated file is always put back. */
export function runProbe(p, { run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600_000 }) } = {}) {
  const original = readFileSync(p.file, 'utf8');
  if (occurrences(original, p.old) !== 1) return { id: p.id, outcome: 'stale', detail: `the text to mutate occurs ${occurrences(original, p.old)} times in ${p.file}` };
  writeFileSync(p.file, original.replace(p.old, p.new));
  try {
    const res = run(['--test', '--test-timeout=120000', ...(p.pattern ? ['--test-name-pattern', p.pattern] : []), p.test]);
    const failed = (res.stdout ?? '').split('\n').filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.replace(/ \([0-9.]+ms\)$/, '').slice(2, 120));
    return res.status === 0 ? { id: p.id, outcome: 'survived', detail: 'every test still passed' } : { id: p.id, outcome: 'killed', detail: [...new Set(failed)].slice(0, 3).join('; ') || `exit ${res.status}` };
  } finally {
    writeFileSync(p.file, original);
  }
}

export function main(argv = process.argv.slice(2), env = process.env, write = (s) => process.stdout.write(s)) {
  if (argv.length === 0) {
    write('usage: node scripts/mutation-probe.mjs <probes.json> [...]\n');
    return 2;
  }
  const results = argv.flatMap((f) => loadProbes(f).map((p) => runProbe(p)));
  const lines = ['| probe | outcome | detail |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.outcome} | ${r.detail.replace(/\|/g, '/')} |`)];
  write(`${lines.join('\n')}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Mutation probes\n\n${lines.join('\n')}\n`);
  return results.every((r) => r.outcome === 'killed') ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
