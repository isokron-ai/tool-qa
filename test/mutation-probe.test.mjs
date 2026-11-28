// The mutation probe runner (scripts/mutation-probe.mjs) and the committed probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, collectProbes, loadProbes, normalizeProbe, occurrences, plan, runProbe, safePath, testCommand, verdict } from '../scripts/mutation-probe.mjs';

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

test('R-MUT-01: find/replace and old/new name the same probe; a probe needs an id, a file, a find text and a replace text', () => {
  const a = normalizeProbe({ id: 'a', file: 'x.mjs', find: 'f', replace: 'r' });
  const b = normalizeProbe({ id: 'a', file: 'x.mjs', old: 'f', new: 'r' });
  assert.deepEqual(a, b);
  assert.equal(a.old, 'f');
  assert.equal(normalizeProbe({ id: 'a', file: 'x', find: 'f', replace: '' }).replace, '', 'an empty replace deletes the text');
  for (const bad of [{}, { id: 'a', file: 'x', find: 'f' }, { id: 'a', file: 'x', replace: 'r' }, { id: 'a', find: 'f', replace: 'r' }, { file: 'x', find: 'f', replace: 'r' }, 'text', null]) {
    assert.throws(() => normalizeProbe(bad));
  }
});

test('R-MUT-02: the inputs are checked before any job runs: not JSON, not a list, duplicate ids, more than 20, no test for a probe', () => {
  const m = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, file: 'x', find: 'f', replace: 'r', test: 't.mjs' })));
  assert.equal(collectProbes({ mutations: m(20) }).length, 20);
  assert.throws(() => collectProbes({ mutations: m(21) }), /most one run takes is 20/);
  assert.throws(() => collectProbes({ mutations: '{' }), /not JSON/);
  assert.throws(() => collectProbes({ mutations: '{}' }), /not a JSON list/);
  assert.throws(() => collectProbes({ mutations: JSON.stringify([{ id: 'a', file: 'x', find: 'f', replace: 'r' }, { id: 'a', file: 'y', find: 'f', replace: 'r' }]) }), /duplicate/);
  for (const f of ['/etc/x.json', '../x.json', 'a/../../x.json', 'x.txt']) assert.throws(() => collectProbes({ files: f }), /relative \.json path/);
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    assert.throws(() => collectProbes({ root: dir }), /no probes/);
    const out = join(dir, 'out');
    writeFileSync(out, '');
    assert.throws(() => plan({ MUTATIONS: JSON.stringify([{ id: 'a', file: 'x', find: 'f', replace: 'r' }]), GITHUB_OUTPUT: out }, () => {}), /no test for: a/);
    plan({ MUTATIONS: m(2), GITHUB_OUTPUT: out }, () => {});
    assert.match(readFileSync(out, 'utf8'), /^matrix=\{"include":\[\{"idx":0,"id":"p0"\},\{"idx":1,"id":"p1"\}\]\}\ncount=2\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-MUT-03: a probe edits only files inside the checkout, never .git', () => {
  assert.ok(safePath('/w', 'src/a.mjs'));
  for (const f of ['../a', '/etc/passwd', '.git/config', 'a/../../b', '.', '']) assert.equal(safePath('/w', f), null, f);
  const r = runProbe({ id: 'p', file: '../x', find: 'a', replace: 'b', test: 't.mjs' }, { root: '/w', run: () => assert.fail('not run') });
  assert.equal(r.outcome, 'stale');
});

test('R-MUT-04: a test file runs under node --test (with its pattern), anything else as a shell command; a probe uses its own test before the default', () => {
  assert.deepEqual(testCommand({ id: 'a', test: 'test/x.test.mjs', pattern: 'R-1' }).slice(1), ['--test', '--test-timeout=120000', '--test-name-pattern', 'R-1', 'test/x.test.mjs']);
  assert.deepEqual(testCommand({ id: 'a' }, 'test/y.test.mjs').slice(-1), ['test/y.test.mjs']);
  assert.deepEqual(testCommand({ id: 'a' }, 'npm test -- --grep x'), ['bash', '-ceu', 'npm test -- --grep x']);
  assert.deepEqual(testCommand({ id: 'a', test: 'a.mjs; rm -rf /' }), ['bash', '-ceu', 'a.mjs; rm -rf /'], 'only a plain path is a test file');
  assert.throws(() => testCommand({ id: 'a' }), /no test/);
});

test('R-MUT-05: the baseline runs first and must pass; a test that already fails proves nothing, so the probe is baseline_failed and the file is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    const file = join(dir, 'x.mjs');
    writeFileSync(file, 'export const on = true;\n');
    const p = { id: 'p', file: 'x.mjs', find: 'true', replace: 'false', test: 'unused' };
    const calls = [];
    const seen = [];
    const r = runProbe(p, { root: dir, baseline: true, run: () => { calls.push(readFileSync(file, 'utf8')); return { status: 1, stdout: '' }; } });
    assert.equal(r.outcome, 'baseline_failed');
    assert.deepEqual(calls, ['export const on = true;\n'], 'only the baseline ran, on the unedited file');
    const k = runProbe(p, { root: dir, baseline: true, run: () => { seen.push(readFileSync(file, 'utf8')); return { status: seen.length === 1 ? 0 : 1, stdout: '' }; } });
    assert.equal(k.outcome, 'killed');
    assert.deepEqual(seen, ['export const on = true;\n', 'export const on = false;\n']);
    assert.equal(readFileSync(file, 'utf8'), 'export const on = true;\n');
    const dup = join(dir, 'd.mjs');
    writeFileSync(dup, 'a a');
    assert.equal(runProbe({ ...p, file: 'd.mjs', find: 'a' }, { root: dir, run: () => assert.fail('not run') }).detail, 'the text to mutate occurs 2 times in d.mjs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-MUT-06: the verdict fails on a survivor, a stale probe, a failed baseline or a missing result, and passes only when every planned probe was killed; the JSON and table are written', () => {
  const k = (idx) => ({ idx, id: `k${idx}`, outcome: 'killed', detail: 'd | e' });
  assert.equal(verdict([k(0), k(1)], 2).ok, true);
  assert.equal(verdict([k(0), { ...k(1), outcome: 'survived' }], 2).ok, false);
  assert.equal(verdict([k(0), { ...k(1), outcome: 'stale' }], 2).stale, 1);
  assert.equal(verdict([k(0), { ...k(1), outcome: 'baseline_failed' }], 2).ok, false);
  assert.equal(verdict([k(0)], 2).ok, false, 'a cell that wrote no result');
  assert.equal(verdict([], 0).ok, false);
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    writeFileSync(join(dir, 'result-1.json'), JSON.stringify({ ...k(1), outcome: 'survived' }));
    writeFileSync(join(dir, 'result-0.json'), JSON.stringify(k(0)));
    let out = '';
    assert.equal(collect(dir, { PLANNED: '2' }, (s) => { out += s; }), 1);
    assert.match(out, /\| k0 \| killed \| d \/ e \|\n\| k1 \| survived/);
    const json = JSON.parse(readFileSync(join(dir, 'mutation-probe-results.json'), 'utf8'));
    assert.deepEqual([json.planned, json.survived, json.ok], [2, 1, false]);
    assert.equal(collect(dir, { PLANNED: '3' }, () => {}), 1, 'a third planned probe never reported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
