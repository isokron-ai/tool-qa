#!/usr/bin/env node
// Fail closed on the review gate: the `publish` environment must have a required-reviewers rule.
//
//   gh api repos/<owner>/<repo>/environments/publish | node publish/env-check.mjs
//
// Reads the answer of GitHub's "get an environment" call from stdin (any reader of a public
// repository may make it, so the job's own token is enough). Exits 0 only if the environment's
// protection rules include required_reviewers with at least one reviewer; if the answer lists the
// reviewers and the list is empty, that is a failure too. Anything unreadable fails.
//
// Why this and not a variable: GitHub creates an environment that a workflow names when it does
// not exist, with no protection, and then runs the job without asking anyone. A job that only runs
// after approval cannot tell, from inside, whether anyone approved; this reads the rule itself.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {string[]} problems; none means the environment is protected by required reviewers */
export function checkEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return ['the answer is not an environment'];
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const rule = rules.find((r) => r?.type === 'required_reviewers');
  if (!rule) return [`the environment ${JSON.stringify(env.name ?? null)} has no required-reviewers rule`];
  if (Array.isArray(rule.reviewers) && rule.reviewers.length === 0) return ['the required-reviewers rule has no reviewer'];
  return [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let problems;
  try { problems = checkEnvironment(JSON.parse(readFileSync(0, 'utf8'))); } catch { problems = ['the answer could not be read']; }
  for (const p of problems) process.stderr.write(`::error title=publish-results::The publish environment is not protected: ${p}. Nothing was delivered. See docs/PUBLISHING.md.\n`);
  process.exit(problems.length ? 1 : 0);
}
