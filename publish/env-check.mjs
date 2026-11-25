#!/usr/bin/env node
// Fail closed on the review gate: the `publish` environment must have a required-reviewers rule.
//
//   gh api repos/<owner>/<repo>/environments/publish | node publish/env-check.mjs
//
// Reads the answer of GitHub's "get an environment" call from stdin (any reader of a public
// repository may make it, so the job's own token is enough). Exits 0 only if the environment's
// protection rules include required_reviewers that lists at least one reviewer (a missing list fails),
// and its deployment_branch_policy is set (protected branches or custom branches; null means any
// branch). Anything unreadable fails.
//
// Why this and not a variable: GitHub creates an environment that a workflow names when it does
// not exist, with no protection, and then runs the job without asking anyone. A job that only runs
// after approval cannot tell, from inside, whether anyone approved; this reads the rule itself.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {string[]} problems; none means the environment is protected by required reviewers and limited branches */
export function checkEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return ['the answer is not an environment'];
  const problems = [];
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const rule = rules.find((r) => r?.type === 'required_reviewers');
  if (!rule) problems.push(`the environment ${JSON.stringify(env.name ?? null)} has no required-reviewers rule`);
  else if (!Array.isArray(rule.reviewers) || rule.reviewers.length === 0) problems.push('the required-reviewers rule does not list a reviewer');
  // null means any branch may run the job: a dispatch from any branch would reach the approval.
  const policy = env.deployment_branch_policy;
  if (!policy || typeof policy !== 'object') problems.push('deployment branches are not restricted (protected branches only, or main only, is required)');
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let problems;
  try { problems = checkEnvironment(JSON.parse(readFileSync(0, 'utf8'))); } catch { problems = ['the answer could not be read']; }
  for (const p of problems) process.stderr.write(`::error title=publish-results::The publish environment is not protected: ${p}. Nothing was delivered. See docs/PUBLISHING.md.\n`);
  process.exit(problems.length ? 1 : 0);
}
