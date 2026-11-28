#!/usr/bin/env node
// A dry run of the meta-backend classifier over the loop's frame, on GitHub
// Actions (.github/workflows/meta-backend-dryrun.yml). Nothing is sealed,
// uploaded to ingest or written to the state: it prints counts and a sample a
// person can check by hand, and keeps the rows as a short-lived artifact.
//
//   node meta/dryrun-backend.mjs subjects --seed <seed-v1.json> [--candidates <candidates.json.gz>] [--extra N]
//       Prints the frame, one owner/name per line: every seed subject, then the
//       first N discover candidates (pump/discover.mjs walks them in this order:
//       class, then hash) that are not seed subjects. N defaults to 200.
//   node meta/dryrun-backend.mjs classify --subjects <file> --shard i/n --out <file.ndjson> [--concurrency 6]
//       Classifies every n-th subject from the i-th, as the lane would (meta/backend.mjs collectSubject).
//   node meta/dryrun-backend.mjs summarize --out <summary.md> <rows.ndjson> ...
//       Class, reason, backend and confidence counts, and a sample of 20 servers with their evidence.
//
// The archives are read exactly as the lane reads them: from codeload.github.com
// and raw.githubusercontent.com, as text, in memory. Nothing from a subject runs.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { collectSubject } from './backend.mjs';
import { createCache, createHttp, mapLimit } from './lib/http.mjs';
import { SUBJECT_RE } from './lib/common.mjs';

const arg = (argv, name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };

/** The frame: seed subjects, then the first `extra` discover candidates in walk order that are not in the seed. */
export function frameSubjects(seed, candidates = [], extra = 200) {
  const ids = seed.subjects.map((s) => s.id).filter((id) => SUBJECT_RE.test(id));
  const have = new Set(ids.map((x) => x.toLowerCase()));
  const walk = [...candidates].filter((c) => typeof c?.name === 'string' && SUBJECT_RE.test(c.name))
    .sort((a, b) => (a.class - b.class) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const added = [];
  for (const c of walk) {
    if (added.length >= extra) break;
    const k = c.name.toLowerCase();
    if (have.has(k)) continue;
    have.add(k);
    added.push(c.name);
  }
  return [...ids, ...added];
}

/** One output row per subject: what an owner needs to spot-check the class. */
export function row(subject, c) {
  const v = c.value;
  return {
    subject,
    class: v?.class ?? null,
    reason: v?.reason ?? (v ? null : c.why ?? null),
    backend: v?.backend?.id ?? null,
    kind: v?.backend?.kind ?? null,
    stand_in: v?.stand_in?.id ?? null,
    spec_url: v?.spec_url ?? null,
    confidence: v?.confidence ?? null,
    secondary: (v?.backends ?? []).filter((b) => b.role === 'secondary').map((b) => b.id),
    base_url_env: (v?.base_url_env ?? []).slice(0, 6),
    env_names: (v?.env_names ?? []).slice(0, 10),
    write_tools: v?.write_tools ?? null,
    evidence: (v?.evidence ?? []).slice(0, 8).map((e) => `${e.signal}${e.backend ? `:${e.backend}` : ''} ${e.detail}${e.path ? ` (${e.path})` : ''}`),
    basis: v ? { source: v.basis.source, commit: v.basis.commit, files: v.basis.files_read, code: v.basis.code_files_read, truncated: v.basis.truncated } : null,
    stages: c.stages,
    skips: c.skips,
  };
}

const h = (s) => createHash('sha256').update(s).digest('hex');

/** Counts and a stratified, stable sample of 20 (8 local_full, 6 mock_min, 6 none; filled from the rest when short). */
export function summarize(rows) {
  const count = (f) => { const m = {}; for (const r of rows) { const k = f(r) ?? 'unread'; m[k] = (m[k] ?? 0) + 1; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1])); };
  const by = { class: count((r) => r.class), reason: count((r) => (r.class === 'none' ? r.reason : r.class === null ? 'unread' : undefined) ?? '-'), confidence: count((r) => r.confidence) };
  delete by.reason['-'];
  const backends = {};
  for (const r of rows) if (r.backend) backends[`${r.backend} (${r.class})`] = (backends[`${r.backend} (${r.class})`] ?? 0) + 1;
  const top = Object.entries(backends).sort((a, b) => b[1] - a[1]).slice(0, 25);
  const stable = [...rows].filter((r) => r.class).sort((a, b) => (h(a.subject) < h(b.subject) ? -1 : 1));
  const want = { local_full: 8, mock_min: 6, none: 6 };
  const sample = [];
  for (const [cls, n] of Object.entries(want)) sample.push(...stable.filter((r) => r.class === cls).slice(0, n));
  for (const r of stable) { if (sample.length >= 20) break; if (!sample.includes(r)) sample.push(r); }
  const skipped = rows.filter((r) => r.skips?.length).length;
  return { total: rows.length, read: rows.filter((r) => r.class).length, skipped, by, top_backends: top, sample: sample.slice(0, 20) };
}

export function markdown(s) {
  const lines = [
    `## meta-backend dry run: ${s.total} subjects, ${s.read} classified, ${s.skipped} with a skip`,
    '',
    '| Class | Subjects |', '|---|---|',
    ...Object.entries(s.by.class).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| none: reason | Subjects |', '|---|---|',
    ...Object.entries(s.by.reason).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| Confidence | Subjects |', '|---|---|',
    ...Object.entries(s.by.confidence).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| Primary backend (class) | Subjects |', '|---|---|',
    ...s.top_backends.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '### Sample of 20 for a hand check',
    '',
    '| Server | Class | Backend | Stand-in or spec | Confidence | Write tools | Evidence |', '|---|---|---|---|---|---|---|',
    ...s.sample.map((r) => `| ${r.subject} | ${r.class}${r.reason ? ` (${r.reason})` : ''} | ${r.backend ?? '-'} | ${r.stand_in ?? r.spec_url ?? '-'} | ${r.confidence} | ${r.write_tools ? `${r.write_tools.write_like}/${r.write_tools.names_seen}` : '-'} | ${r.evidence.slice(0, 4).join('; ').replace(/\|/g, '/')} |`),
    '',
  ];
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  if (cmd === 'subjects') {
    const seed = JSON.parse(readFileSync(arg(argv, '--seed'), 'utf8'));
    const cpath = arg(argv, '--candidates');
    let candidates = [];
    if (cpath) {
      try { candidates = JSON.parse(gunzipSync(readFileSync(cpath)).toString('utf8')).candidates ?? []; } catch (err) { process.stderr.write(`candidates not read (${err.message}); seed only\n`); }
    }
    const extra = Number(arg(argv, '--extra', '200'));
    const list = frameSubjects(seed, candidates, Number.isInteger(extra) && extra >= 0 ? extra : 200);
    process.stdout.write(`${list.join('\n')}\n`);
    process.stderr.write(`frame: ${seed.subjects.length} seed subjects, ${list.length - seed.subjects.length} discovered, ${list.length} in all (${candidates.length} candidates read)\n`);
    return 0;
  }
  if (cmd === 'classify') {
    const subjects = readFileSync(arg(argv, '--subjects'), 'utf8').split('\n').map((x) => x.trim()).filter((x) => SUBJECT_RE.test(x));
    const [i, n] = String(arg(argv, '--shard', '0/1')).split('/').map(Number);
    const mine = subjects.filter((_, k) => k % n === i);
    const out = arg(argv, '--out');
    writeFileSync(out, '');
    const http = createHttp({ cache: createCache() });
    const t0 = Date.now();
    let done = 0;
    await mapLimit(mine, Number(arg(argv, '--concurrency', '6')), async (s) => {
      let c;
      try { c = await collectSubject(http, s); } catch (err) { c = { value: null, why: `lane error: ${err?.name ?? 'Error'}`, stages: { collect: 'subject_error' }, skips: [{ stage: 'collect', reason: 'tool_error', fault: 'tool' }] }; }
      appendFileSync(out, `${JSON.stringify(row(s, c))}\n`);
      done++;
      if (done % 50 === 0) process.stdout.write(`${done}/${mine.length} in ${Math.round((Date.now() - t0) / 1000)} s\n`);
    });
    process.stdout.write(`shard ${i}/${n}: ${mine.length} subjects in ${Math.round((Date.now() - t0) / 1000)} s; ${http.stats.requests} requests\n`);
    return 0;
  }
  if (cmd === 'summarize') {
    const files = argv.slice(1).filter((x, k, a) => x !== '--out' && a[k - 1] !== '--out');
    const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const s = summarize(rows);
    const md = markdown(s);
    const out = arg(argv, '--out');
    if (out) writeFileSync(out, md);
    writeFileSync(`${out ?? 'summary.md'}.json`, `${JSON.stringify(s, null, 2)}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
    process.stdout.write(md);
    return 0;
  }
  process.stderr.write('usage: node meta/dryrun-backend.mjs subjects | classify | summarize (see the header)\n');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
