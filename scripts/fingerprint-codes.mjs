#!/usr/bin/env node
// The codes a fingerprint signature may carry (state/fingerprint-codes.json),
// read from an mcp-check checkout, so the allow-lists follow our workers.
//
//   node scripts/fingerprint-codes.mjs --mcp-check <dir>            print what the checkout has
//   node scripts/fingerprint-codes.mjs --mcp-check <dir> --check    exit 1 when the committed file misses any
//
// Read from the source text (no import: the checkout is not installed):
//   details      corpus/live-probe.mjs DETAILS keys and corpus/scan-static.mjs SKIPS keys
//                (result.detail codes)
//   list_errors  every `new InputError('<code>'` in src/, corpus/ and action/ (result.list_error)
//   error_names  every `class <Name> extends ...Error` there (result.error_name is an error's name)
// The committed file also holds the JavaScript built-in error names, which no
// checkout declares. Only our own code is read; nothing is fetched.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODES_FILE = new URL('../state/fingerprint-codes.json', import.meta.url);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The keys of `export const <name> = Object.freeze({ ... });` in a source text. */
function frozenKeys(text, name) {
  const start = text.indexOf(`export const ${name} = Object.freeze({`);
  if (start < 0) return [];
  const end = text.indexOf('\n});', start);
  return [...text.slice(start, end).matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
}

/** What an mcp-check checkout declares. */
export function readCheckout(dir) {
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  const files = ['src', 'corpus', 'action'].filter((d) => { try { return statSync(join(dir, d)).isDirectory(); } catch { return false; } }).flatMap((d) => walk(join(dir, d)));
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const sorted = (xs) => [...new Set(xs)].sort();
  return {
    details: sorted([...frozenKeys(read('corpus/live-probe.mjs'), 'DETAILS'), ...frozenKeys(read('corpus/scan-static.mjs'), 'SKIPS')]),
    list_errors: sorted([...text.matchAll(/new InputError\('([a-z_]+)'/g)].map((m) => m[1])),
    error_names: sorted([...text.matchAll(/class ([A-Za-z][A-Za-z0-9]*) extends [A-Za-z]*Error\b/g)].map((m) => m[1])),
  };
}

export const loadCodes = () => JSON.parse(readFileSync(CODES_FILE, 'utf8'));

/** Codes the checkout has and the committed file does not. */
export function missing(found, codes = loadCodes()) {
  const out = {};
  for (const k of ['details', 'list_errors', 'error_names']) {
    const gap = found[k].filter((c) => !codes[k].includes(c));
    if (gap.length) out[k] = gap;
  }
  return out;
}

export function main(argv = process.argv.slice(2), write = (s) => process.stdout.write(s)) {
  const i = argv.indexOf('--mcp-check');
  if (i < 0 || !argv[i + 1]) {
    write('usage: node scripts/fingerprint-codes.mjs --mcp-check <dir> [--check]\n');
    return 2;
  }
  const found = readCheckout(argv[i + 1]);
  if (!argv.includes('--check')) {
    write(`${JSON.stringify(found, null, 2)}\n`);
    return 0;
  }
  const gap = missing(found);
  if (Object.keys(gap).length) {
    write(`state/fingerprint-codes.json misses codes the checkout has: ${JSON.stringify(gap)}\n`);
    return 1;
  }
  write('state/fingerprint-codes.json holds every code the checkout has\n');
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
