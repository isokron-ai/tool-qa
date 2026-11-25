#!/usr/bin/env node
// A dry run on synthetic input: writes what the publisher would publish for a few
// made-up results into a local folder. No real data, no key, no network.
//
//   node publish/sample.mjs --results <mcp-results checkout> --out <folder>
//
// The input has a normal result, a result that is our own limit (a skip with fault tool),
// a server-side skip, a result with a secret in the author's text (masked), a result with
// a security-class field (held: it does not appear), and a rejected one (not read).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { main } from './run.mjs';
import { item } from './test/fixtures.mjs';

const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const results = arg('--results');
const out = arg('--out');
if (!results || !out) { process.stderr.write('usage: sample.mjs --results <checkout> --out <folder>\n'); process.exit(2); }

const j = (...p) => p.join('');
const entries = [
  item({ attempt: 'demo-1', n: 1, subject: 'demo', lane: 'live-probe', observations: [{ field: 'tool_count', value: 3 }, { field: 'registry_name', value: 'io.example/demo' }, { field: 'startup_ms', value: 812 }] }),
  item({ attempt: 'demo-2', n: 2, subject: 'other', lane: 'scan-static', observations: [], extraFiles: { 'logs/read.log': 'x' }, skips: [{ stage: 'read', reason: 'unsupported_language', fault: 'tool', evidence: 'logs/read.log' }], finishedAt: '2026-11-24T11:00:00Z' }),
  item({ attempt: 'demo-3', n: 3, subject: 'third', lane: 'live-probe', observations: [], skips: [{ stage: 'start', reason: 'start_requires_credentials', fault: 'subject' }], finishedAt: '2026-11-24T12:00:00Z' }),
  item({ attempt: 'demo-4', n: 4, subject: 'demo', lane: 'live-probe', observations: [{ field: 'registry_name', value: `io.example/demo ${j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')}` }], finishedAt: '2026-11-25T09:00:00Z' }),
  item({ attempt: 'demo-5', n: 5, subject: 'other', lane: 'scan-static', observations: [{ field: 'commit_sha', value: 'c'.repeat(40) }, { field: 'ci_exploitable_trigger', value: { held: 'never shown' } }] }),
  item({ attempt: 'demo-6', n: 6, subject: 'third', dir: 'rejected' }),
].flat();

const dir = mkdtempSync(join(tmpdir(), 'publish-sample-'));
try {
  for (const e of entries) { const f = join(dir, e.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, e.data); }
  process.exitCode = await main(['--results', results, '--out', out, '--plain-dir', dir], {});
} finally {
  rmSync(dir, { recursive: true, force: true });
}
