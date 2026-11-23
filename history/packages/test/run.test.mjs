import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch, noSleep } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import { runSource } from '../run.mjs';

test('runSource writes data, manifest and state; failure keeps state', async () => {
  const out = mkdtempSync(join(tmpdir(), 'o-')); const stateDir = mkdtempSync(join(tmpdir(), 's-'));
  const ok = mockFetch(() => ({ body: JSON.stringify({ Path: 'x/mcp', Version: 'v1', Timestamp: '2026-01-01T00:00:00Z' }) }));
  const m = await runSource('go', { http: createHttp({ fetch: ok, sleep: noSleep }), out, stateDir, now: Date.parse('2026-02-01T00:00:00Z') });
  assert.equal(m.ok, true);
  assert.equal(m.files[0].name, 'go-2026-02-01.ndjson.gz');
  assert.equal(m.files[0].rows, 1);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'go.json'))).since, '2026-01-01T00:00:00Z');

  const before = readFileSync(join(stateDir, 'go.json'), 'utf8');
  const bad = mockFetch(() => ({ status: 404, body: '' }));
  const m2 = await runSource('go', { http: createHttp({ fetch: bad, sleep: noSleep }), out, stateDir });
  assert.equal(m2.ok, false);
  assert.equal(readFileSync(join(stateDir, 'go.json'), 'utf8'), before);
  assert.ok(existsSync(join(out, 'manifest-go.json')));
});

test('manifest records whether feed state was restored and flags a possible gap', async () => {
  const out = mkdtempSync(join(tmpdir(), 'o-')); const stateDir = mkdtempSync(join(tmpdir(), 's-'));
  const ok = mockFetch(() => ({ body: JSON.stringify({ Path: 'x/mcp', Version: 'v1', Timestamp: '2026-01-01T00:00:00Z' }) }));
  const http = createHttp({ fetch: ok, sleep: noSleep });
  const now = Date.parse('2026-02-01T00:00:00Z');
  const first = await runSource('go', { http, out, stateDir, now });
  assert.equal(first.state_restored, false);
  assert.equal(first.gap_possible, true);
  const second = await runSource('go', { http, out, stateDir, now });
  assert.equal(second.state_restored, true);
  assert.equal(second.gap_possible, false);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest-go.json'))).state_restored, true);
});

test('CLI prints a warning annotation when feed state is missing', () => {
  const out = mkdtempSync(join(tmpdir(), 'o-')); const stateDir = mkdtempSync(join(tmpdir(), 's-'));
  const preload = join(mkdtempSync(join(tmpdir(), 'p-')), 'fetch.mjs');
  writeFileSync(preload, "globalThis.fetch = async () => new Response(JSON.stringify({ Path: 'x/mcp', Version: 'v1', Timestamp: '2026-01-01T00:00:00Z' }));\n");
  const run = fileURLToPath(new URL('../run.mjs', import.meta.url));
  const r = spawnSync(process.execPath, ['--import', preload, run, '--out', out, '--state', stateDir, '--source', 'go'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning title=history-packages go::/);
  const again = spawnSync(process.execPath, ['--import', preload, run, '--out', out, '--state', stateDir, '--source', 'go'], { encoding: 'utf8' });
  assert.doesNotMatch(again.stdout, /::warning/);
});
