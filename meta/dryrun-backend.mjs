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
import { loadMaps } from './lib/backend-maps.mjs';
import { usableStandIn } from './lib/backend-scan.mjs';
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
    routable: v?.routable ?? false,
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

/** One markdown table cell: repository text can hold a newline or a pipe, which would break the table. */
const cell = (x) => String(x ?? '-').replace(/[\r\n\u2028\u2029|]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 400);

export const GOLD_FILE = new URL('./test/fixtures/backend-gold.json', import.meta.url);
/** The precision a class must reach on the gold set before writecheck's modes are switched on (owner rule, 28 Nov). */
export const ROUTING_PRECISION = 0.9;
const SQL_KIND = new Set(['postgres', 'mysql', 'sqlite', 'mssql', 'oracle', 'duckdb', 'clickhouse', 'sql']);

/**
 * The class a gold row should get with these maps: none without write tools or with a backend no map names; else the
 * map's routing (a usable stand-in: local_full; a spec: mock_min; otherwise none).
 */
export function backendGoldClass(g, maps) {
  if (g.has_write_tools !== true) return 'none';
  const b = maps.table.get(g.backend);
  if (!b || b.not_a_store) return 'none';
  if (usableStandIn(b)) return 'local_full';
  if (b.spec) return 'mock_min';
  return 'none';
}

/**
 * Precision per class against the gold set: of the rows the classifier put in a class, how many are right (the class,
 * and for local_full and mock_min the backend too; a generic `sql` matches any SQL engine). `routed` counts only what
 * the modes would take (routable). Rows not in the gold set are not counted.
 */
export function goldPrecision(rows, gold, maps) {
  const by = new Map(gold.rows.map((g) => [g.subject.toLowerCase(), g]));
  const out = {};
  const wrong = [];
  for (const cls of ['local_full', 'mock_min', 'none']) out[cls] = { predicted: 0, correct: 0, routed: 0, routed_correct: 0 };
  for (const r of rows) {
    const g = by.get(String(r.subject).toLowerCase());
    if (!g || !r.class || g.has_write_tools === 'unknown') continue;
    const want = backendGoldClass(g, maps);
    const backendOk = r.class === 'none' || r.backend === g.backend || (r.backend === 'sql' && SQL_KIND.has(g.backend)) || (r.backend === 'repo-openapi' && want === 'mock_min');
    const ok = r.class === want && backendOk;
    const o = out[r.class];
    o.predicted++; if (ok) o.correct++;
    if (r.routable) { o.routed++; if (ok) o.routed_correct++; }
    if (!ok) wrong.push({ subject: r.subject, predicted: `${r.class}${r.backend ? `:${r.backend}` : ''}${r.routable ? '' : ' (not routed)'}`, gold: `${want}:${g.backend}` });
  }
  for (const o of Object.values(out)) {
    o.precision = o.predicted ? Math.round((o.correct / o.predicted) * 1000) / 1000 : null;
    o.routed_precision = o.routed ? Math.round((o.routed_correct / o.routed) * 1000) / 1000 : null;
  }
  const gate = ['local_full', 'mock_min'].every((c) => out[c].routed_precision === null || out[c].routed_precision >= ROUTING_PRECISION);
  return { classes: out, wrong, gate, threshold: ROUTING_PRECISION, gold_rows: gold.rows.length };
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
    ...s.sample.map((r) => `| ${cell(r.subject)} | ${cell(`${r.class}${r.reason ? ` (${r.reason})` : ''}`)} | ${cell(r.backend)} | ${cell(r.stand_in ?? r.spec_url)} | ${cell(`${r.confidence}${r.routable ? '' : ', not routed'}`)} | ${r.write_tools ? `${r.write_tools.write_like}/${r.write_tools.names_seen}` : '-'} | ${cell(r.evidence.slice(0, 4).join('; '))} |`),
    '',
  ];
  if (s.gold) {
    const g = s.gold;
    lines.push(`### Precision against the gold set (${g.gold_rows} hand-labelled servers; routing needs ${Math.round(g.threshold * 100)}% on local_full and mock_min)`, '',
      '| Class | Predicted | Correct | Precision | Routed | Routed correct | Routed precision |', '|---|---|---|---|---|---|---|',
      ...Object.entries(g.classes).map(([c, o]) => `| ${c} | ${o.predicted} | ${o.correct} | ${o.precision ?? '-'} | ${o.routed} | ${o.routed_correct} | ${o.routed_precision ?? '-'} |`),
      '', `Gate: **${g.gate ? 'met' : 'not met'}**.`, '',
      '| Server | Predicted | Gold |', '|---|---|---|', ...g.wrong.map((w) => `| ${cell(w.subject)} | ${cell(w.predicted)} | ${cell(w.gold)} |`), '');
  }
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
    const files = argv.slice(1).filter((x, k, a) => !['--out', '--gold'].includes(x) && !['--out', '--gold'].includes(a[k - 1]));
    const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const s = summarize(rows);
    try {
      s.gold = goldPrecision(rows, JSON.parse(readFileSync(arg(argv, '--gold') ?? GOLD_FILE, 'utf8')), loadMaps());
    } catch (err) {
      process.stderr.write(`gold set not read (${err.message})\n`);
    }
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
