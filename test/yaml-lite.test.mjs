import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, lineOf, YamlError } from '../scripts/lib/yaml-lite.mjs';

test('block mappings, sequences and scalars', () => {
  const doc = parseYaml([
    '# comment',
    'name: demo  # trailing comment',
    'on:',
    '  push:',
    '    branches: [main, "release/*"]',
    'list:',
    '- a',
    '- b',
    'nested:',
    '  - x: 1',
    '    y: two',
    '  - plain value',
    'empty:',
    "quoted: 'it''s'",
    'dq: "a\\tb #not comment"',
    'hash: a#b',
  ].join('\n'));
  assert.equal(doc.name, 'demo');
  assert.deepEqual(doc.on, { push: { branches: ['main', 'release/*'] } });
  assert.deepEqual(doc.list, ['a', 'b']);
  assert.deepEqual(doc.nested, [{ x: '1', y: 'two' }, 'plain value']);
  assert.equal(doc.empty, null);
  assert.equal(doc.quoted, "it's");
  assert.equal(doc.dq, 'a\tb #not comment');
  assert.equal(doc.hash, 'a#b');
});

test('flow collections', () => {
  const doc = parseYaml('a: {}\nb: []\nc: { x: 1, y: [p, "q, r"], z: {} }\nd: {uses: "o/r@x", with: {k: "${{ v }}"}}\n');
  assert.deepEqual(doc.a, {});
  assert.deepEqual(doc.b, []);
  assert.deepEqual(doc.c, { x: '1', y: ['p', 'q, r'], z: {} });
  assert.deepEqual(doc.d, { uses: 'o/r@x', with: { k: '${{ v }}' } });
});

test('block scalars keep their content', () => {
  const doc = parseYaml([
    'run: |',
    '  echo one',
    '    indented # not a comment',
    '',
    '  echo "${{ github.sha }}"',
    'strip: |-',
    '  x',
    'folded: >-',
    '  a',
    '  b',
    'next: done',
  ].join('\n'));
  assert.equal(doc.run, 'echo one\n  indented # not a comment\n\necho "${{ github.sha }}"\n');
  assert.equal(doc.strip, 'x');
  assert.equal(doc.folded, 'a b');
  assert.equal(doc.next, 'done');
});

test('multi-line plain scalars fold into one line', () => {
  const doc = parseYaml("if: a == 'b' &&\n  c == 'd'\nx: y\n");
  assert.equal(doc.if, "a == 'b' && c == 'd'");
  assert.equal(doc.x, 'y');
});

test('line numbers are recorded for keys and items', () => {
  const doc = parseYaml('a: 1\nsteps:\n  - run: x\n  - uses: y\n');
  assert.equal(lineOf(doc, 'a'), 1);
  assert.equal(lineOf(doc, 'steps'), 2);
  assert.equal(lineOf(doc.steps, 1), 4);
  assert.equal(lineOf(doc.steps[1], 'uses'), 4);
});

test('quoted keys', () => {
  const doc = parseYaml("'on': push\n\"x y\": z\n");
  assert.equal(doc.on, 'push');
  assert.equal(doc['x y'], 'z');
});

test('unsupported constructs fail closed', () => {
  for (const src of [
    'a: &x 1\nb: *x\n',
    'a: !!str 1\n',
    '? complex\n: key\n',
    'a: 1\n---\nb: 2\n',
    'a: [1,\n  2]\n',
    'a: "open\n  close"\n',
    'a:\n\tb: 1\n',
    'a: 1\na: 2\n',
    '<<: {a: 1}\n',
  ]) {
    assert.throws(() => parseYaml(src), YamlError, JSON.stringify(src));
  }
});

test('a leading document marker is allowed', () => {
  assert.deepEqual(parseYaml('---\na: 1\n'), { a: '1' });
});
