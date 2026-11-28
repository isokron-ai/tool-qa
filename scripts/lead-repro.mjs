#!/usr/bin/env node
// lead-repro: does a lead's synthetic repro reproduce? Runs on GitHub Actions (.github/workflows/lead-repro.yml).
//
//   node scripts/lead-repro.mjs plan <dir>   what to run: the leads, their fixtures, the tools and pins they need
//   node scripts/lead-repro.mjs run <dir>    run them (tools fetched by the workflow in between); writes
//                                            <dir>/lead-repro.json and the job summary
//
// Inputs (environment only, checked whole): LEAD_ISSUE `owner/repo#number` of a lead issue on our repositories;
// LEAD_FINGERPRINT, a lead's 12-hex fingerprint (its issue is looked up by title tag); LEAD_SHAPE, a lead's shape
// as JSON (the columns of state/leads.mjs SHAPE_COLUMNS a fingerprint is made of), for a lead with no issue yet.
// EVENT_NAME pull_request runs the cases of leads/repro-cases.json instead. GITHUB_TOKEN (the job's own, read
// only) reads the public issues; it is used only in `plan`.
//
// For each lead: the fixture its issue shows (if any) and the fixture our templates make now are each run by the
// lane's own code at the lane's pinned version (leads/repro-run.mjs), and each gets a verdict: reproduced (the
// same class, component and signature as the lead), not_reproduced, not_reproducible_synthetically (no template
// of ours can trigger the class), or error (our harness failed). The template's verdict is the one that counts:
// the pump reads it back by its repro key (leads/repro-gate.mjs) before an issue shows a fixture.
// Shapes only: no server names (a lead has none), our tools, our fixtures.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertShapeOnly, kindOf, titleTag } from '../leads/plan.mjs';
import { filesFromBody, pinsFor, reproKey, reproSpec, shapeFromBody, TEMPLATE_VERSION } from '../leads/repro.mjs';
import { runRepro } from '../leads/repro-run.mjs';
import { loadRouting } from '../state/leads.mjs';

export const FORMAT = 'isokron-lead-repro/1';
export const ARTIFACT_PREFIX = 'lead-repro-';
export const BOT_LOGIN = 'isokron-tool-qa[bot]';
export const MAX_CASES = 20;
/** Where each pinned tool of a runner comes from. */
export const TOOL_REPOS = Object.freeze({ 'mcp-check': 'isokron-ai/mcp-check', 'mcp-writecheck-action': 'isokron-ai/mcp-writecheck-action', 'mcp-writecheck': 'isokron-ai/mcp-write-safety' });
const RUNNER_TOOLS = { 'scan-static': ['mcp-check'], 'writecheck-init': ['mcp-writecheck', 'mcp-writecheck-action'], 'release-diff': [] };

export class InputProblem extends Error {}

const ISSUE_RE = /^(isokron-ai\/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,8})$/;
const FP_RE = /^[0-9a-f]{12}$/;
const SHAPE_KEYS = ['fingerprint', 'tool', 'lane', 'component', 'oracle', 'class', 'idiom', 'layout', 'signature'];

/** A lead shape from LEAD_SHAPE: the fingerprint's columns, each a short string of the shape alphabet. */
export function parseShape(text, { lanes }) {
  let v;
  try { v = JSON.parse(text); } catch { throw new InputProblem('LEAD_SHAPE is not JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InputProblem('LEAD_SHAPE is not an object');
  const shape = {};
  for (const k of SHAPE_KEYS) {
    if (typeof v[k] !== 'string' || v[k].length === 0 || v[k].length > 400) throw new InputProblem(`LEAD_SHAPE.${k} is missing or too long`);
    shape[k] = v[k];
  }
  if (!FP_RE.test(shape.fingerprint)) throw new InputProblem('LEAD_SHAPE.fingerprint is not 12 hex');
  if (!lanes.includes(shape.lane)) throw new InputProblem('LEAD_SHAPE.lane is not one of our lanes');
  if (!/^[a-z_]{1,40}$/.test(shape.class) || !/^[a-z_]{1,40}$/.test(shape.component)) throw new InputProblem('LEAD_SHAPE.class or component is malformed');
  if (!/^[a-z0-9_=;:<>.,/-]{1,400}$/i.test(shape.signature)) throw new InputProblem('LEAD_SHAPE.signature is malformed');
  try { assertShapeOnly({ ...shape, versions: [] }); } catch (err) { throw new InputProblem(`LEAD_SHAPE: ${err.message}`); }
  return { ...shape, versions: [] };
}

/** The inputs, checked whole: one of issue, fingerprint or shape (or the committed cases on a pull request). */
export function parseInputs(env, { lanes, root }) {
  const issue = String(env.LEAD_ISSUE ?? '').trim();
  const fp = String(env.LEAD_FINGERPRINT ?? '').trim();
  const shape = String(env.LEAD_SHAPE ?? '').trim();
  if (env.EVENT_NAME === 'pull_request') {
    const list = JSON.parse(readFileSync(join(root, 'leads', 'repro-cases.json'), 'utf8')).cases;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CASES) throw new InputProblem('leads/repro-cases.json: cases must be a list of 1 to 20');
    return list.map((c) => { const m = ISSUE_RE.exec(String(c)); if (!m) throw new InputProblem(`leads/repro-cases.json: ${c} is not owner/repo#number`); return { issue: { repo: m[1], number: Number(m[2]) } }; });
  }
  const given = [issue, fp, shape].filter(Boolean).length;
  if (given !== 1) throw new InputProblem('give exactly one of issue, fingerprint and lead');
  if (issue) {
    const m = ISSUE_RE.exec(issue);
    if (!m) throw new InputProblem('issue must be isokron-ai/<repo>#<number>');
    return [{ issue: { repo: m[1], number: Number(m[2]) } }];
  }
  if (fp) {
    if (!FP_RE.test(fp)) throw new InputProblem('fingerprint must be 12 lower-case hex');
    return [{ fingerprint: fp }];
  }
  if (shape.length > 4000 || /[\u0000-\u001f]/.test(shape)) throw new InputProblem('lead must be one line of JSON, at most 4000 characters');
  return [{ shape: parseShape(shape, { lanes }) }];
}

/** GET a GitHub API path: with the job's token, then without one on 401/403 (public issues need none). */
async function ghGet(fetchImpl, path, token) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'isokron-tool-qa-lead-repro' };
  let res = await fetchImpl(`https://api.github.com${path}`, { headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers });
  if (token && (res.status === 401 || res.status === 403)) res = await fetchImpl(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

/** A lead issue of ours: opened by our App, with the lead marker; its shape and the fixture it shows. */
async function readIssue(fetchImpl, { repo, number }, { token, routing }) {
  if (!routing.repos.includes(repo)) throw new InputProblem(`${repo} is not one of the repositories leads are filed on`);
  const i = await ghGet(fetchImpl, `/repos/${repo}/issues/${number}`, token);
  if (i?.user?.login !== BOT_LOGIN) throw new InputProblem(`${repo}#${number} was not opened by our App`);
  const shape = shapeFromBody(i.body);
  if (!shape) throw new InputProblem(`${repo}#${number} is not a lead issue (no marker or field table)`);
  return { shape, files: filesFromBody(i.body), state: i.state };
}

async function findIssue(fetchImpl, fp, { token, routing }) {
  for (const repo of routing.repos) {
    for (let page = 1; page <= 3; page++) {
      const list = await ghGet(fetchImpl, `/repos/${repo}/issues?state=all&labels=loop-lead&per_page=100&page=${page}`, token);
      const hit = (Array.isArray(list) ? list : []).find((i) => !i.pull_request && i.user?.login === BOT_LOGIN && String(i.title).startsWith(titleTag(fp)));
      if (hit) return { repo, number: hit.number };
      if (!Array.isArray(list) || list.length < 100) break;
    }
  }
  return null;
}

/** Full commit of a short pin, from the tool's public repository. */
async function fullSha(fetchImpl, repo, pin, token) {
  if (/^[0-9a-f]{40}$/.test(pin)) return pin;
  if (!/^[0-9a-f]{7,39}$/.test(pin)) throw new Error(`${repo}: the pin ${pin} is not a commit`);
  const c = await ghGet(fetchImpl, `/repos/${repo}/commits/${pin}`, token);
  if (!/^[0-9a-f]{40}$/.test(c?.sha ?? '') || !c.sha.startsWith(pin)) throw new Error(`${repo}: ${pin} does not resolve to one commit`);
  return c.sha;
}

export async function plan({ env = process.env, root = fileURLToPath(new URL('..', import.meta.url)), fetch: fetchImpl = globalThis.fetch } = {}) {
  const workflows = JSON.parse(readFileSync(join(root, 'pump', 'workflows.json'), 'utf8')).workflows;
  const routing = loadRouting();
  const token = env.GITHUB_TOKEN || null;
  const inputs = parseInputs(env, { lanes: Object.keys(workflows), root });
  const cases = [];
  for (const inp of inputs) {
    let issue = inp.issue ?? null;
    let shape = inp.shape ?? null;
    let issueFiles = null;
    if (inp.fingerprint) {
      issue = await findIssue(fetchImpl, inp.fingerprint, { token, routing });
      if (!issue) throw new InputProblem(`no lead issue of ours has the fingerprint ${inp.fingerprint}; give the lead's shape instead`);
    }
    if (issue) {
      const r = await readIssue(fetchImpl, issue, { token, routing });
      shape = r.shape;
      issueFiles = r.files;
    }
    const spec = reproSpec(shape);
    const pins = pinsFor(shape.lane, workflows);
    cases.push({ issue, lead: shape, pins, key: reproKey(shape, spec, pins), runner: spec.runner, issue_files: issueFiles, template_files: spec.files });
  }
  // The tools the runners need, each at the full commit of its pin (one pin per tool across the cases).
  const tools = {};
  for (const c of cases) {
    for (const t of RUNNER_TOOLS[c.runner] ?? []) {
      const pin = c.pins[t];
      if (!pin) throw new Error(`the ${c.lead.lane} lane pins no ${t}`);
      if (tools[t] && tools[t].pin !== pin) throw new Error(`two pins of ${t} in one run (${tools[t].pin}, ${pin})`);
      tools[t] = { pin, repo: TOOL_REPOS[t] };
    }
  }
  for (const t of Object.values(tools)) t.sha = await fullSha(fetchImpl, t.repo, t.pin, token);
  const artifact = env.EVENT_NAME === 'pull_request' ? `${ARTIFACT_PREFIX}pr` : cases.length === 1 ? `${ARTIFACT_PREFIX}${cases[0].key}` : `${ARTIFACT_PREFIX}batch`;
  return { format: FORMAT, template_version: TEMPLATE_VERSION, event: env.EVENT_NAME ?? null, cases, tools, artifact };
}

const sameFiles = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function run(p, { env = process.env } = {}) {
  const tools = {
    mcpCheckDir: env.MCP_CHECK_DIR || null, mcpCheckCommit: p.tools['mcp-check']?.sha ?? null,
    cliMain: env.WRITECHECK_CLI_MAIN || null, cliCommit: p.tools['mcp-writecheck']?.sha ?? null,
    actionDir: env.WRITECHECK_ACTION_DIR || null, actionCommit: p.tools['mcp-writecheck-action']?.sha ?? null,
  };
  const out = [];
  for (const c of p.cases) {
    const spec = reproSpec(c.lead);
    const t = { ...tools, releaseDiffPin: c.pins['release-diff'] ?? null };
    const runs = [];
    const template = await runRepro(c.lead, c.template_files, spec, t);
    runs.push({ source: 'template', ...template });
    if (c.issue_files && c.issue_files.length && !sameFiles(c.issue_files, c.template_files)) runs.push({ source: 'issue', ...(await runRepro(c.lead, c.issue_files, { ...spec, release: null, synthesizable: spec.synthesizable || !!spec.runner }, t)) });
    else if (c.issue) runs.push({ source: 'issue', ...(c.issue_files?.length ? { verdict: template.verdict, same_as: 'template' } : { verdict: 'no_fixture', observed: [] }) });
    const tool = (RUNNER_TOOLS[c.runner] ?? []).map((k) => `${k}@${p.tools[k]?.sha ?? c.pins[k]}`).join(', ') || Object.entries(c.pins).map(([k, v]) => `${k}@${v}`).join(', ');
    out.push({ issue: c.issue ? `${c.issue.repo}#${c.issue.number}` : null, fingerprint: c.lead.fingerprint, lead: c.lead, kind: kindOf(c.lead), key: c.key, runner: c.runner, tool, why: spec.why, verdict: template.verdict, runs });
  }
  return { format: FORMAT, template_version: p.template_version, run_id: Number(env.GITHUB_RUN_ID) || null, at: new Date().toISOString(), artifact: p.artifact, results: out };
}

export function renderSummary(doc) {
  const L = ['## Lead repro', '', `Template version ${doc.template_version}; run ${doc.run_id ?? '-'}; artifact \`${doc.artifact}\`.`, ''];
  L.push('| issue | fingerprint | class | runner | tool | issue\'s fixture | our template now | repro key |', '|---|---|---|---|---|---|---|---|');
  for (const r of doc.results) {
    const issueRun = r.runs.find((x) => x.source === 'issue');
    L.push(`| ${r.issue ?? '-'} | \`${r.fingerprint}\` | \`${r.kind}\` | ${r.runner ?? '-'} | ${r.tool || '-'} | ${issueRun ? issueRun.verdict : '-'} | ${r.verdict} | \`${r.key}\` |`);
  }
  L.push('');
  for (const r of doc.results) {
    for (const x of r.runs) {
      const seen = (x.observed ?? []).map((f) => `\`${f.class}\` at \`${f.component}\` (\`${f.signature}\`)`).join('; ') || 'nothing';
      L.push(`- \`${r.fingerprint}\` ${x.source}: ${x.verdict}${x.error ? ` (${String(x.error).split('\n')[0].slice(0, 200)})` : ''}${x.why ? ` (${x.why})` : ''}; the loop's code saw: ${seen}`);
    }
  }
  return `${L.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), env = process.env, write = (s) => process.stdout.write(s)) {
  const [cmd, dir] = argv;
  if (!['plan', 'run'].includes(cmd) || !dir) { write('usage: node scripts/lead-repro.mjs plan|run <dir>\n'); return 2; }
  mkdirSync(dir, { recursive: true });
  try {
    if (cmd === 'plan') {
      const p = await plan({ env });
      writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(p, null, 2)}\n`);
      const o = [`artifact=${p.artifact}`];
      for (const [k, t] of Object.entries(p.tools)) o.push(`${k.replace(/-/g, '_')}_sha=${t.sha}`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${o.join('\n')}\n`);
      write(`lead-repro: ${p.cases.length} lead(s); tools: ${Object.entries(p.tools).map(([k, t]) => `${k}@${t.sha}`).join(', ') || 'none to fetch'}\n`);
      return 0;
    }
    const p = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    const doc = await run(p, { env });
    writeFileSync(join(dir, 'lead-repro.json'), `${JSON.stringify(doc, null, 2)}\n`);
    const md = renderSummary(doc);
    write(md);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
    return 0;
  } catch (err) {
    write(`::error title=lead-repro::${err instanceof InputProblem ? '' : 'harness error: '}${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 500)}\n`);
    return err instanceof InputProblem ? 2 : 3;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
