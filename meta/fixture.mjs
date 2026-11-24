#!/usr/bin/env node
// Helpers for the pull-request fixture run (.github/workflows/meta-fixture.yml).
//
//   node meta/fixture.mjs items <lane>
//     Prints shard_id, attempt_id and items (three of our own repositories) as
//     step outputs.
//   node meta/fixture.mjs judge <lane> <bundle-dir> <out-dir>
//     Judges every dry-run bundle (<bundle-dir>/result-<attempt_id>-<i>.tar)
//     with ingest's own checks (ingest/analyze.mjs) against the pinned field
//     registry, as the pump would after decrypting it. Exit 1 unless every
//     item has a bundle and every bundle is accepted.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeBundle } from '../ingest/analyze.mjs';
import { loadRegistry } from '../ingest/registry.mjs';
import { workflowFromEnv } from '../worker-kit/contract.mjs';
import { parseInputs } from './lib/common.mjs';

export const FIXTURE_SUBJECTS = Object.freeze(['isokron-ai/mcp-check', 'isokron-ai/tool-qa', 'isokron-ai/mcp-writecheck-action']);

export function fixtureInputs(lane, env = process.env) {
  const run = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : '0';
  const attempt = /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? env.GITHUB_RUN_ATTEMPT : '1';
  const items = FIXTURE_SUBJECTS.map((subject, i) => ({
    subject,
    run_key: createHash('sha256').update(`${lane}\n${subject}\n${run}`).digest('hex'),
    fence: i + 1,
  }));
  return { shard_id: `fixture-${lane}-${run}`, attempt_id: `fixture-${lane}-${run}-${attempt}`, items: JSON.stringify(items) };
}

export async function judge({ lane, bundleDir, outDir, env = process.env, registry, write = (s) => process.stdout.write(s) }) {
  const input = parseInputs({ shardId: 'judge', attemptId: env.ATTEMPT_ID, items: env.ITEMS });
  const wf = workflowFromEnv(env);
  const reg = registry ?? await loadRegistry();
  let ok = true;
  for (const item of input.items) {
    let tar;
    try {
      tar = readFileSync(join(bundleDir, `result-${input.attemptId}-${item.index}.tar`));
    } catch {
      write(`item ${item.index} ${item.subject}: no bundle\n`);
      ok = false;
      continue;
    }
    const v = analyzeBundle(tar, {
      exp: { attempt_id: input.attemptId, fence: item.fence, run_key: item.run_key, repo: wf.repo, workflow_file: wf.file, workflow_sha: wf.sha, run_id: wf.run_id, run_attempt: wf.run_attempt },
      registry: reg,
    });
    const meta = JSON.parse(readFileSync(join(outDir, String(item.index), 'meta.json'), 'utf8'));
    const obs = readFileSync(join(outDir, String(item.index), 'bundle', 'observations', `${lane}.ndjson`), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const fields = [...new Set(obs.map((r) => r.field))].sort();
    const nulls = obs.filter((r) => r.value === null).map((r) => r.field);
    write(`item ${item.index} ${item.subject}: ${v.outcome}${v.reason ? ` (${v.reason})` : ''}; ${obs.length} records; fields ${fields.join(',')}; null ${nulls.join(',') || 'none'}; skips ${JSON.stringify(meta.skips)}; controls ${meta.controls.map((c) => `${c.kind}=${c.observed}`).join(',')}\n`);
    if (v.outcome !== 'accepted') {
      ok = false;
      write(`  problems: ${JSON.stringify(v.problems.slice(0, 5))}\n`);
    }
  }
  write(ok ? `${lane}: every bundle accepted\n` : `${lane}: not every bundle was accepted\n`);
  return ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === 'items' && argv.length === 2 && /^meta-(github|registry)$/.test(argv[1])) {
    const o = fixtureInputs(argv[1], env);
    process.stdout.write(`shard_id=${o.shard_id}\nattempt_id=${o.attempt_id}\nitems=${o.items}\n`);
    return 0;
  }
  if (argv[0] === 'judge' && argv.length === 4 && /^meta-(github|registry)$/.test(argv[1])) {
    return judge({ lane: argv[1], bundleDir: argv[2], outDir: argv[3], env });
  }
  process.stderr.write('usage: node meta/fixture.mjs items <lane> | judge <lane> <bundle-dir> <out-dir>\n');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
