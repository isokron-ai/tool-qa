#!/usr/bin/env node
// The publish switch: the first step of the publish-results workflow.
//
//   node publish/gate.mjs
//
// Publishing is OFF unless RESULTS_PUBLISH_ENABLED is exactly "true" AND the loop
// is on (LOOP_ENABLED "true", LOOP_PAUSE_UNTIL passed, LANE_PUBLISH_RESULTS_ENABLED
// not "false"; the same rules as scripts/guard.mjs). Anything else, an unset
// variable included, is off. Writes proceed=true|false to $GITHUB_OUTPUT and always
// exits 0 when it has decided.

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateGuard } from '../scripts/guard.mjs';

export const JOB = 'publish-results';

export function evaluateGate(env, now = Date.now()) {
  if (env.RESULTS_PUBLISH_ENABLED !== 'true') return { proceed: false, reason: 'publish_off', notice: `${JOB}: publishing is off (RESULTS_PUBLISH_ENABLED is not "true"); skipping.` };
  const g = evaluateGuard(env, { job: JOB, noSlots: true, now });
  return { proceed: g.proceed, reason: g.reason, notice: g.notice };
}

export function main(env = process.env, write = (s) => process.stdout.write(s)) {
  const r = evaluateGate(env);
  write(`${env.GITHUB_ACTIONS === 'true' ? `::notice title=Publish gate::${r.notice.replace(/[\r\n%]/g, ' ')}` : r.notice}\n`);
  const out = `proceed=${r.proceed}\nreason=${r.reason}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out);
  else write(out);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main();
