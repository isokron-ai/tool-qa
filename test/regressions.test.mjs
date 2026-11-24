// REGRESSIONS.md is the ledger of every problem found and the tests that pin
// it. This test keeps the ledger and the suite in step: every test a row names
// must exist (in that file, under that exact name), and every test named
// after a row (R-ING-NN: ...) must be listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Rows of the ledger table: {id, tests: [{file, name}], fix}. */
export function parseLedger(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\| R-[A-Z]+-\d+ \|/.test(line)) continue;
    const cells = line.split(' | ');
    const id = cells[0].slice(2).trim();
    const pinned = cells[2] ?? '';
    const tests = [...pinned.matchAll(/`([^`]+\.test\.mjs)` › `([^`]+)`/g)].map((m) => ({ file: m[1], name: m[2] }));
    rows.push({ id, tests, fix: (cells[3] ?? '').replace(/\|\s*$/, '').trim() });
  }
  return rows;
}

/** Titles of the top-level test('...') calls in a test file's source. */
export function testNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\btest\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) names.add(m[2].replace(/\\(.)/g, '$1'));
  return names;
}

function testFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (e.name.endsWith('.test.mjs')) out.push(relative(ROOT, p));
  }
  return out;
}

test('every test the ledger names exists, under that name, in that file', () => {
  const rows = parseLedger(readFileSync(join(ROOT, 'REGRESSIONS.md'), 'utf8'));
  assert.ok(rows.length > 0, 'the ledger has rows');
  const seen = new Set();
  const cache = new Map();
  for (const row of rows) {
    assert.ok(!seen.has(row.id), `${row.id} is listed twice`);
    seen.add(row.id);
    assert.ok(row.tests.length > 0, `${row.id} names no test`);
    assert.match(row.fix, /\b[0-9a-f]{7,40}\b/, `${row.id} names no fix commit`);
    for (const t of row.tests) {
      if (!cache.has(t.file)) {
        let src = null;
        try { src = readFileSync(join(ROOT, t.file), 'utf8'); } catch { /* reported below */ }
        cache.set(t.file, src === null ? null : testNames(src));
      }
      const names = cache.get(t.file);
      assert.ok(names, `${row.id}: ${t.file} does not exist`);
      assert.ok(names.has(t.name), `${row.id}: ${t.file} has no test named "${t.name}"`);
    }
  }
});

test('every test named after a ledger row is listed in that row', () => {
  const rows = parseLedger(readFileSync(join(ROOT, 'REGRESSIONS.md'), 'utf8'));
  const listed = new Set(rows.flatMap((r) => r.tests.map((t) => `${t.file}\u0000${t.name}`)));
  const ids = new Set(rows.map((r) => r.id));
  for (const file of testFiles()) {
    for (const name of testNames(readFileSync(join(ROOT, file), 'utf8'))) {
      const m = /^(R-[A-Z]+-\d+):/.exec(name);
      if (!m) continue;
      assert.ok(ids.has(m[1]), `${file}: "${name}" names ${m[1]}, which has no row in REGRESSIONS.md`);
      assert.ok(listed.has(`${file}\u0000${name}`), `${file}: "${name}" is not listed in REGRESSIONS.md`);
    }
  }
});

test('the ledger check itself catches a missing test', () => {
  const rows = parseLedger('| R-ING-99 | x | `test/regressions.test.mjs` › `R-ING-99: no such test` | abcdef1 |\n');
  assert.deepEqual(rows, [{ id: 'R-ING-99', tests: [{ file: 'test/regressions.test.mjs', name: 'R-ING-99: no such test' }], fix: 'abcdef1' }]);
  const names = testNames(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  assert.equal(names.has('R-ING-99: no such test'), false);
  assert.ok(names.has('the ledger check itself catches a missing test'));
  assert.ok(testNames("test('it\\'s escaped', () => {})").has("it's escaped"));
});
