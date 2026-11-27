#!/usr/bin/env node
// Feed ground truth into a local copy of the state: which assessed results were
// judged correct or incorrect (kv coverage.truth, state/coverage.mjs).
//
//   node scripts/coverage-truth.mjs --state state.sqlite --judgments judgments.json [--apply]
//   node scripts/coverage-truth.mjs --state state.sqlite --qa-csv per-repo-results.csv [--lane scan-static] [--apply]
//
// judgments.json: [{ "subject": "<key>" | "run_key": "<key>", "workflow": "scan-static",
//                    "state": "correct" | "incorrect", "source": "qa_gate" | "resolved_disagreement" | "hand_review" }]
// --qa-csv reads the real-repo QA gate's per-repo table: a row with a truth list
// and no error is correct when it missed no tool and added no phantom, else
// incorrect; the row's repo is matched to a subject by name, and the judgment is
// for that subject's newest result in --lane (default scan-static).
//
// Without --apply nothing is written; the counts say what would be. It works on
// a pulled copy of the state asset (scripts/state-asset.mjs pull); pushing the
// copy back is the operator's step (docs/OPERATIONS.md, one writer at a time).
// Prints counts only.

import { readFileSync } from 'node:fs';
import { openState } from '../state/db.mjs';
import { recordTruth } from '../state/coverage.mjs';

/** Parse CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) into rows of objects keyed by the header. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Judgments from the QA gate's per-repo rows. Rows without truth or with an error make none. */
export function judgmentsFromQa(rows, subjectsByName, workflow = 'scan-static') {
  const out = [];
  let unmatched = 0;
  for (const r of rows) {
    const truth = Number(r.truth_count);
    if (!(truth > 0) || String(r.error ?? '').trim() !== '') continue;
    const subject = subjectsByName.get(String(r.repo ?? '').toLowerCase());
    if (!subject) { unmatched++; continue; }
    const clean = Number(r.missed) === 0 && Number(r.phantom) === 0;
    out.push({ subject, workflow, state: clean ? 'correct' : 'incorrect', source: 'qa_gate' });
  }
  return { judgments: out, unmatched };
}

function args(argv) {
  const o = { apply: false, lane: 'scan-static' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (['--state', '--judgments', '--qa-csv', '--lane'].includes(a)) o[a === '--qa-csv' ? 'qaCsv' : a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.state) throw new Error('--state is required');
  if (!o.judgments && !o.qaCsv) throw new Error('--judgments or --qa-csv is required');
  return o;
}

export function main(argv = process.argv.slice(2), out = (l) => process.stdout.write(`${l}\n`)) {
  let o;
  try { o = args(argv); } catch (err) { process.stderr.write(`coverage-truth: ${err.message}\n`); return 2; }
  const db = openState(o.state);
  try {
    let list;
    let unmatched = 0;
    if (o.judgments) list = JSON.parse(readFileSync(o.judgments, 'utf8'));
    else {
      const byName = new Map(db.listSubjects().filter((s) => s.retired_at == null && s.alias_of == null && s.name).map((s) => [String(s.name).toLowerCase(), s.id]));
      ({ judgments: list, unmatched } = judgmentsFromQa(parseCsv(readFileSync(o.qaCsv, 'utf8')), byName, o.lane));
    }
    if (!Array.isArray(list)) throw new Error('the judgments must be a JSON array');
    // Dry run on the same code path: record into a throwaway copy of the table state by rolling back.
    db.raw.exec('BEGIN');
    const res = recordTruth(db, list, { now: Date.now() });
    if (o.apply) db.raw.exec('COMMIT'); else db.raw.exec('ROLLBACK');
    out(`${o.apply ? 'recorded' : 'would record'} ${res.recorded} judgment(s); ${res.rejected.length} rejected; ${unmatched} QA row(s) matched no subject`);
    for (const [reason, n] of Object.entries(res.rejected.reduce((a, r) => ((a[r.reason] = (a[r.reason] ?? 0) + 1), a), {}))) out(`  rejected: ${reason}: ${n}`);
    return 0;
  } catch (err) {
    process.stderr.write(`coverage-truth: ${err.message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = main();
