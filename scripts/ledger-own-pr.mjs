#!/usr/bin/env node
// The ledger workflow's own open pull request, from what `gh pr list --head ledger/refresh --json
// number,isCrossRepository,headRepositoryOwner` printed:
//
//   gh pr list ... | node scripts/ledger-own-pr.mjs <owner>
//
// Prints its number, or nothing. `--head` matches a branch of that name in a fork too, so only a pull request
// from this repository (not cross-repository) whose head is owned by <owner> counts (R-LED-02).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {number|null} */
export function ownPr(list, owner) {
  if (!Array.isArray(list) || !owner) return null;
  const mine = list.filter((p) => p && p.isCrossRepository === false
    && String(p.headRepositoryOwner?.login ?? '').toLowerCase() === String(owner).toLowerCase()
    && Number.isSafeInteger(p.number) && p.number > 0);
  return mine.length ? Math.min(...mine.map((p) => p.number)) : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const owner = process.argv[2];
  if (!owner) { process.stderr.write('usage: ledger-own-pr.mjs <owner> < gh-pr-list.json\n'); process.exit(2); }
  let list;
  try { list = JSON.parse(readFileSync(0, 'utf8') || '[]'); } catch { process.stderr.write('ledger-own-pr: stdin is not JSON\n'); process.exit(2); }
  const n = ownPr(list, owner);
  if (n !== null) process.stdout.write(`${n}\n`);
}
