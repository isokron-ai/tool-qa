// docs/OPERATIONS.md says which switch stops which workflow (R-DOC-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const doc = readFileSync(new URL('docs/OPERATIONS.md', root), 'utf8');
const workflows = readdirSync(new URL('.github/workflows/', root)).filter((f) => f.endsWith('.yml'));

test('R-DOC-01: every workflow file and every LANE_*_ENABLED switch used in .github/workflows is named in docs/OPERATIONS.md', () => {
  assert.ok(workflows.length > 10);
  const missingFiles = workflows.filter((f) => !doc.includes(f));
  assert.deepEqual(missingFiles, [], 'workflow files the runbook never mentions');
  const switches = new Set();
  for (const f of workflows) for (const m of readFileSync(new URL(`.github/workflows/${f}`, root), 'utf8').matchAll(/\bLANE_[A-Z_]+_ENABLED\b/g)) switches.add(m[0]);
  const missing = [...switches].filter((v) => !doc.includes(v)).sort();
  assert.deepEqual(missing, [], 'lane switches the runbook never mentions');
});

test('R-DOC-01: the runbook no longer promises "Workers (later)": the worker lanes and their own repositories\' switches are named', () => {
  assert.doesNotMatch(doc, /Workers \(later\)/);
  for (const v of ['LANE_SCAN_STATIC_ENABLED', 'LANE_LIVE_PROBE_ENABLED', 'LANE_WRITECHECK_ENABLED']) assert.ok(doc.includes(v), v);
});
