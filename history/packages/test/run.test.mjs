import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
