#!/usr/bin/env node
// Policy check for GitHub Actions workflow files.
//
//   node scripts/check-workflows.mjs [file-or-dir ...]   (default: .github/workflows)
//
// Rules (each violation is reported as file:line: rule: message):
//   top-permissions        top-level `permissions: {}` is present and empty
//   job-permissions        every job declares `permissions`
//   pinned-uses            every `uses:` is pinned to a full 40-hex commit SHA
//                          (same-repository ./ and $/ paths are exempt;
//                          docker:// needs @sha256:<digest>)
//   job-timeout            every job sets `timeout-minutes` (jobs that call a
//                          reusable workflow are exempt: GitHub doesn't allow it there)
//   no-pull-request-target the workflow is not triggered by pull_request_target
//   no-event-in-run        no `${{ ... github.event ... }}` expression inside `run:`
//   schedule-concurrency   scheduled workflows set `concurrency` (top level or every job)
//   yaml                   the file can't be read by the strict reader
//
// Exit codes: 0 no violations, 1 violations found, 2 usage error.
// Needs only Node's standard library.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml, lineOf, YamlError } from './lib/yaml-lite.mjs';

const SHA_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_USES = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const EXPR = /\$\{\{([\s\S]*?)\}\}/g;
const EVENT_REF = /\bgithub\s*(?:\.\s*event\b|\[\s*['"]event['"]\s*\])/;

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => isMap(obj) && Object.prototype.hasOwnProperty.call(obj, key);

function triggers(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((t) => typeof t === 'string');
  if (isMap(on)) return Object.keys(on);
  return [];
}

function exprLine(text, index, startLine, isBlock) {
  // For block scalars, point at the line inside the block that holds the match.
  if (!isBlock) return startLine;
  return startLine + 1 + (text.slice(0, index).match(/\n/g) || []).length;
}

/**
 * Check one workflow file's text.
 * @returns {{ file: string, line: number, rule: string, message: string }[]}
 */
export function checkWorkflowText(text, file = '<workflow>') {
  const out = [];
  const add = (line, rule, message) => out.push({ file, line: line ?? 1, rule, message });

  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) {
      add(err.line, 'yaml', `${err.message.replace(/^line \d+: /, '')} (the policy check reads a strict YAML subset)`);
      return out;
    }
    throw err;
  }
  if (!isMap(doc)) {
    add(1, 'yaml', 'workflow file is not a mapping');
    return out;
  }

  // top-permissions
  if (!has(doc, 'permissions')) {
    add(1, 'top-permissions', 'top-level `permissions: {}` is missing');
  } else if (!isMap(doc.permissions) || Object.keys(doc.permissions).length !== 0) {
    add(lineOf(doc, 'permissions'), 'top-permissions', 'top-level permissions must be exactly `{}`; grant scopes per job');
  }

  // no-pull-request-target
  const on = doc.on;
  if (triggers(on).includes('pull_request_target')) {
    add(lineOf(doc, 'on'), 'no-pull-request-target', 'pull_request_target is not allowed');
  }

  const jobs = isMap(doc.jobs) ? doc.jobs : {};
  if (!isMap(doc.jobs)) add(1, 'yaml', '`jobs` is missing or not a mapping');

  // schedule-concurrency
  if (isMap(on) && has(on, 'schedule')) {
    const jobIds = Object.keys(jobs);
    const allJobs = jobIds.length > 0 && jobIds.every((id) => has(jobs[id], 'concurrency'));
    if (!has(doc, 'concurrency') && !allJobs) {
      add(lineOf(on, 'schedule'), 'schedule-concurrency', 'scheduled workflow needs `concurrency` (top level or on every job)');
    }
  }

  const checkUses = (value, line) => {
    if (typeof value !== 'string') {
      add(line, 'pinned-uses', '`uses` must be a string');
      return;
    }
    const uses = value.trim();
    if (uses.startsWith('./') || uses.startsWith('$/')) return;
    if (uses.startsWith('docker://')) {
      if (!DOCKER_USES.test(uses)) add(line, 'pinned-uses', `"${uses}" must be pinned by digest (docker://image@sha256:<64 hex>)`);
      return;
    }
    if (!SHA_USES.test(uses)) add(line, 'pinned-uses', `"${uses}" must be pinned to a full 40-character commit SHA`);
  };

  for (const [id, job] of Object.entries(jobs)) {
    const jobLine = lineOf(jobs, id);
    if (!isMap(job)) {
      add(jobLine, 'yaml', `job "${id}" is not a mapping`);
      continue;
    }
    if (!has(job, 'permissions')) add(jobLine, 'job-permissions', `job "${id}" has no explicit \`permissions\``);
    const callsWorkflow = has(job, 'uses');
    if (callsWorkflow) checkUses(job.uses, lineOf(job, 'uses'));
    else if (!has(job, 'timeout-minutes')) add(jobLine, 'job-timeout', `job "${id}" has no \`timeout-minutes\``);

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!isMap(step)) return;
      if (has(step, 'uses')) checkUses(step.uses, lineOf(step, 'uses') ?? lineOf(steps, i));
      if (has(step, 'run') && typeof step.run === 'string') {
        const runLine = lineOf(step, 'run');
        const isBlock = step.run.includes('\n');
        for (const m of step.run.matchAll(EXPR)) {
          if (EVENT_REF.test(m[1])) {
            add(exprLine(step.run, m.index, runLine, isBlock), 'no-event-in-run',
              `step ${i + 1} of job "${id}" interpolates github.event into \`run\`; pass it through \`env\``);
          }
        }
      }
    });
  }
  return out;
}

function collect(paths) {
  const files = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (/\.ya?ml$/.test(f) && statSync(join(p, f)).isFile()) files.push(join(p, f));
      }
    } else files.push(p);
  }
  return files;
}

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const paths = argv.length ? argv : ['.github/workflows'];
  let files;
  try {
    files = collect(paths);
  } catch (err) {
    process.stderr.write(`check-workflows: ${err.message}\n`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write(`check-workflows: no workflow files found in ${paths.join(', ')}\n`);
    return 2;
  }
  const violations = [];
  for (const f of files) {
    const shown = relative(process.cwd(), f) || f;
    violations.push(...checkWorkflowText(readFileSync(f, 'utf8'), shown));
  }
  for (const v of violations) {
    if (env.GITHUB_ACTIONS === 'true') {
      process.stdout.write(`::error file=${escapeProp(v.file)},line=${v.line},title=${escapeProp(v.rule)}::${escapeData(v.message)}\n`);
    } else {
      process.stdout.write(`${v.file}:${v.line}: ${v.rule}: ${v.message}\n`);
    }
  }
  const n = violations.length;
  process.stdout.write(`${files.length} workflow file${files.length === 1 ? '' : 's'} checked, ${n} violation${n === 1 ? '' : 's'}\n`);
  return n === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
