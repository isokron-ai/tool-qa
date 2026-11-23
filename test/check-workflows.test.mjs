import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { checkWorkflowText } from '../scripts/check-workflows.mjs';

const FIX = fileURLToPath(new URL('./fixtures/workflows/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/check-workflows.mjs');

function check(name) {
  const file = join(FIX, name);
  return checkWorkflowText(readFileSync(file, 'utf8'), name);
}
const rules = (vs) => vs.map((v) => v.rule);

test('good fixtures have no violations', () => {
  for (const f of readdirSync(join(FIX, 'good'))) {
    assert.deepEqual(check(`good/${f}`), [], f);
  }
});

test('missing top-level permissions', () => {
  const v = check('bad/no-top-permissions.yml');
  assert.deepEqual(rules(v), ['top-permissions']);
  assert.equal(v[0].line, 1);
});

test('top-level permissions must be exactly {}', () => {
  const v = check('bad/top-permissions-not-empty.yml');
  assert.deepEqual(rules(v), ['top-permissions']);
  assert.equal(v[0].line, 2);
  for (const value of ['read-all', 'write-all', '""', '{ contents: read }']) {
    const src = `on: push\npermissions: ${value}\njobs: {}\n`;
    assert.deepEqual(rules(checkWorkflowText(src, 'x.yml')), ['top-permissions'], value);
  }
});

test('every job needs explicit permissions', () => {
  const v = check('bad/job-no-permissions.yml');
  assert.deepEqual(rules(v), ['job-permissions']);
  assert.match(v[0].message, /"missing"/);
  assert.equal(v[0].line, 10);
});

test('every uses must be pinned to a full commit SHA', () => {
  const v = check('bad/unpinned-uses.yml');
  assert.deepEqual(rules(v), Array(7).fill('pinned-uses'));
  assert.deepEqual(v.map((x) => x.line), [9, 10, 11, 12, 13, 14, 18]);
});

test('same-repository uses forms are exempt', () => {
  const src = [
    'on: push', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x', '    timeout-minutes: 1',
    '    permissions: {}', '    steps:', '      - uses: ./.github/actions/x', '      - uses: $/.github/actions/y',
    '  b:', '    permissions: {}', '    uses: $/.github/workflows/z.yml',
  ].join('\n');
  assert.deepEqual(checkWorkflowText(src, 'x.yml'), []);
});

test('uses with an expression is not pinned', () => {
  const src = [
    'on: push', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x', '    timeout-minutes: 1',
    '    permissions: {}', '    steps:', '      - uses: actions/checkout@${{ env.REF }}',
  ].join('\n');
  assert.deepEqual(rules(checkWorkflowText(src, 'x.yml')), ['pinned-uses']);
});

test('every job needs timeout-minutes, except reusable workflow calls', () => {
  const v = check('bad/no-timeout.yml');
  assert.deepEqual(rules(v), ['job-timeout']);
  assert.equal(v[0].line, 4);
});

test('pull_request_target is forbidden in every form', () => {
  assert.deepEqual(rules(check('bad/pull-request-target.yml')), ['no-pull-request-target']);
  const base = 'permissions: {}\njobs: {}\n';
  for (const on of ['on: pull_request_target', 'on: [push, pull_request_target]', 'on:\n  - pull_request_target']) {
    assert.deepEqual(rules(checkWorkflowText(`${on}\n${base}`, 'x.yml')), ['no-pull-request-target'], on);
  }
});

test('github.event must not be interpolated into run', () => {
  const v = check('bad/event-in-run.yml');
  assert.deepEqual(rules(v), ['no-event-in-run', 'no-event-in-run', 'no-event-in-run']);
  assert.deepEqual(v.map((x) => x.line), [10, 14, 16]);
});

test('github.event in env or if is allowed; event_name in run is allowed', () => {
  const src = [
    'on: push', 'permissions: {}', 'jobs:', '  a:', '    runs-on: x', '    timeout-minutes: 1',
    '    permissions: {}', '    if: github.event.pull_request.draft == false', '    steps:',
    '      - env:', '          T: ${{ github.event.head_commit.message }}',
    '        run: echo "$T ${{ github.event_name }} ${{ github.eventual }}"',
  ].join('\n');
  assert.deepEqual(checkWorkflowText(src, 'x.yml'), []);
});

test('scheduled workflows need concurrency', () => {
  assert.deepEqual(rules(check('bad/schedule-no-concurrency.yml')), ['schedule-concurrency']);
  // Concurrency on every job also counts.
  const src = [
    'on:', '  schedule:', "    - cron: '0 * * * *'", 'permissions: {}', 'jobs:', '  a:', '    runs-on: x',
    '    timeout-minutes: 1', '    permissions: {}', '    concurrency: a', '    steps:', '      - run: echo',
  ].join('\n');
  assert.deepEqual(checkWorkflowText(src, 'x.yml'), []);
});

test('YAML the checker cannot read is a violation, not a pass', () => {
  const v = check('bad/yaml-anchor.yml');
  assert.deepEqual(rules(v), ['yaml']);
  assert.equal(v[0].line, 4);
  assert.deepEqual(rules(checkWorkflowText('- just\n- a list\n', 'x.yml')), ['yaml']);
});

test('CLI: exits 1 and prints file:line for violations', () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(FIX, 'bad')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no-timeout\.yml:4: job-timeout: /);
  assert.match(r.stdout, /violation/);
});

test('CLI: emits GitHub annotations under Actions', () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(FIX, 'bad/no-timeout.yml')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error file=.*no-timeout\.yml,line=4,title=job-timeout::/m);
});

test('CLI: exits 0 on good fixtures', () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(FIX, 'good')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('CLI: a missing path is a usage error', () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(FIX, 'nope')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
});

test("this repository's own workflows pass", () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(ROOT, '.github/workflows')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
