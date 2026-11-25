#!/usr/bin/env node
// The checker that runs on the output is code from another repository (mcp-results'
// scripts/verify.mjs). It runs in a job with no secret, and only if the files that make it up
// are exactly the ones a person reviewed: publish/verify-pin.json holds their sha256.
//
//   node publish/pin-check.mjs <mcp-results checkout> [publish/verify-pin.json]
//
// A change to the checker in mcp-results does not take effect here until its digests are
// updated in this repository, in a pull request.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {string[]} problems */
export function checkPin(dir, pin) {
  const files = pin?.files;
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) return ['the pin lists no files'];
  const problems = [];
  for (const [rel, want] of Object.entries(files)) {
    if (!/^[0-9a-f]{64}$/.test(String(want))) { problems.push(`${rel}: the pin has no sha256 for it`); continue; }
    let got;
    try { got = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex'); } catch { problems.push(`${rel}: missing`); continue; }
    if (got !== want) problems.push(`${rel}: is not the reviewed version (sha256 ${got.slice(0, 12)}, pinned ${want.slice(0, 12)})`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const dir = process.argv[2];
  const pinFile = process.argv[3] ?? new URL('./verify-pin.json', import.meta.url).pathname;
  if (!dir) { process.stderr.write('usage: pin-check.mjs <mcp-results checkout> [pin file]\n'); process.exit(2); }
  const problems = checkPin(dir, JSON.parse(readFileSync(pinFile, 'utf8')));
  for (const p of problems) process.stderr.write(`pin: ${p}\n`);
  process.exit(problems.length ? 1 : 0);
}
