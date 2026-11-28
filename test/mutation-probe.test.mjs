// The mutation probe runner (scripts/mutation-probe.mjs) and the committed probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProbes, occurrences, runProbe } from '../scripts/mutation-probe.mjs';

test('every committed probe names text that occurs exactly once in its file, so no probe is stale', () => {
  const dir = new URL('./mutations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    for (const p of loadProbes(join(dir.pathname, f))) {
      assert.equal(occurrences(readFileSync(p.file, 'utf8'), p.old), 1, `${f}: ${p.id}`);
      assert.ok(readFileSync(p.test, 'utf8').length > 0, `${f}: ${p.id} names a test file`);
    }
  }
});

test('a probe is killed when the tests fail, survives when they pass, is stale when its text is gone; the file is always put back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    const file = join(dir, 'x.mjs');
    writeFileSync(file, 'export const on = true;\n');
    const p = { id: 'p', file, old: 'true', new: 'false', test: 'unused' };
    assert.equal(runProbe(p, { run: () => ({ status: 1, stdout: '✖ R-X-01: it failed (1ms)\n' }) }).outcome, 'killed');
    assert.equal(runProbe(p, { run: () => ({ status: 0, stdout: '' }) }).outcome, 'survived');
    assert.equal(readFileSync(file, 'utf8'), 'export const on = true;\n', 'put back');
    assert.equal(runProbe({ ...p, old: 'nowhere' }, { run: () => assert.fail('not run') }).outcome, 'stale');
    let seen = null;
    runProbe(p, { run: () => { seen = readFileSync(file, 'utf8'); return { status: 1, stdout: '' }; } });
    assert.equal(seen, 'export const on = false;\n', 'the tests ran against the mutated file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
