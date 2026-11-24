#!/usr/bin/env node
// Helpers for the pull-request fixture run (.github/workflows/meta-fixture.yml).
//
//   node meta/fixture.mjs items <lane> [check|upload]
//     Prints shard_id, attempt_id and items (three of our own repositories; for
//     release-diff, those that publish packages) as step outputs.
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
/** release-diff: our repositories that publish npm or PyPI packages (and two whose npm metadata names another repository). */
export const RELEASE_DIFF_SUBJECTS = Object.freeze([
  'isokron-ai/mcp-check', 'isokron-ai/mcp-write-safety-kits', 'isokron-ai/mcp-write-safety', 'isokron-ai/kronicle-lite',
  'isokron-ai/strapi-plugin-writesafe', 'isokron-ai/sea-lite', 'isokron-ai/mcp-catalog-snap', 'isokron-ai/tool-qa',
]);
const LANE_RE = /^(?:meta-github|meta-registry|release-diff)$/;

export function fixtureInputs(lane, env = process.env, mode = 'check') {
  const run = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : '0';
  const attempt = /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? env.GITHUB_RUN_ATTEMPT : '1';
  const items = (lane === 'release-diff' ? RELEASE_DIFF_SUBJECTS : FIXTURE_SUBJECTS).map((subject, i) => ({
    subject,
    run_key: createHash('sha256').update(`${lane}\n${subject}\n${run}`).digest('hex'),
    fence: i + 1,
  }));
  return { shard_id: `fixture-${lane}-${mode}-${run}`, attempt_id: `fixture-${lane}-${mode}-${run}-${attempt}`, items: JSON.stringify(items) };
}

export async function judge({ lane, bundleDir, outDir, env = process.env, registry, write = (s) => process.stdout.write(s) }) {
  const input = parseInputs({ shardId: 'judge', attemptId: env.ATTEMPT_ID, items: env.ITEMS });
  const wf = workflowFromEnv(env);
  const reg = registry ?? await loadRegistry();
  let ok = true;
  let lastApi = null;
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
    const report = JSON.parse(readFileSync(join(outDir, String(item.index), 'bundle', 'results', `${lane}.json`), 'utf8'));
    lastApi = report.shard_api;
    const nulls = obs.filter((r) => r.value === null).map((r) => r.field);
    write(`item ${item.index} ${item.subject}: ${v.outcome}${v.reason ? ` (${v.reason})` : ''}; ${obs.length} records; fields ${fields.join(',')}; null ${nulls.join(',') || 'none'}; stages ${JSON.stringify(report.stages)}; skips ${JSON.stringify(meta.skips)}; controls ${meta.controls.map((c) => `${c.kind}=${c.observed}`).join(',')}\n`);
    if (lane === 'release-diff') {
      // What our own packages look like: each artifact's outcome and the public findings. release_diff_held is
      // security-class: nothing about it is printed here, not even a count (this log is public).
      const val = (f) => obs.find((r) => r.field === f)?.value ?? [];
      for (const a of val('release_artifacts')) write(`  artifact ${a.ecosystem}:${a.package}@${a.version} ${a.artifact}: ${a.outcome}; linked_by ${a.linked_by}; provenance ${a.provenance?.verified ? 'verified' : a.provenance?.why}; tag ${a.tag ? `${a.tag.name} (${a.tag.match})` : 'none'}; basis ${a.basis?.kind ?? 'none'}\n`);
      for (const x of val('release_diff_summary')) write(`  summary ${x.package}@${x.version} ${x.artifact}: ${x.files} files, ${x.identical} identical, explained ${JSON.stringify(x.explained)}, unexplained ${x.unexplained_absent} absent / ${x.unexplained_differs} differing\n`);
      for (const f of val('release_diff_findings')) write(`  finding ${f.package}@${f.version} ${f.artifact ?? ''} ${f.kind} (${f.level})${f.path ? ` ${f.path}` : ''}\n`);
    }
    if (v.outcome !== 'accepted') {
      ok = false;
      write(`  problems: ${JSON.stringify(v.problems.slice(0, 5))}\n`);
    }
  }
  write(`${lane}: API use ${JSON.stringify(lastApi)}\n`);
  write(ok ? `${lane}: every bundle accepted\n` : `${lane}: not every bundle was accepted\n`);
  return ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === 'items' && (argv.length === 2 || (argv.length === 3 && /^(check|upload)$/.test(argv[2]))) && LANE_RE.test(argv[1])) {
    const o = fixtureInputs(argv[1], env, argv[2] ?? 'check');
    process.stdout.write(`shard_id=${o.shard_id}\nattempt_id=${o.attempt_id}\nitems=${o.items}\n`);
    return 0;
  }
  if (argv[0] === 'judge' && argv.length === 4 && LANE_RE.test(argv[1])) {
    return judge({ lane: argv[1], bundleDir: argv[2], outDir: argv[3], env });
  }
  process.stderr.write('usage: node meta/fixture.mjs items <lane> | judge <lane> <bundle-dir> <out-dir>\n');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
