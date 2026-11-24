import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOG_PATH, FULL_RAW_DAYS, HOLD_DAYS, controlFailed, keepSet, sha256 } from '../retention.mjs';

const buf = (s) => Buffer.from(s);
const manifest = (controls) => buf(JSON.stringify({ controls }));
const item = (dir, controls, extra = {}) => new Map([
  [`${dir}/ingest.json`, buf('{"outcome":"accepted"}')],
  [`${dir}/manifest.json`, manifest(controls)],
  [`${dir}/results/scan-static.json`, buf('{"grade":"B"}')],
  [`${dir}/observations/static.ndjson`, buf('{"field":"tool_count","value":3}\n')],
  [`${dir}/raw/subject/repo.json`, buf('{}')],
  [`${dir}/raw/subject/tools.json`, buf('[{"name":"a"}]')],
  [`${dir}/controls/known-answer.json`, buf('{}')],
  [`${dir}/controls/forgery.json`, buf('{}')],
  [`${dir}/raw/control-forgery/tools.json`, buf('[]')],
  [`${dir}/report.json`, buf('{"big":true}')],
  [`${dir}/scan.json`, buf('{}')],
  [`${dir}/logs/run.log`, buf('x')],
  ...Object.entries(extra).map(([k, v]) => [`${dir}/${k}`, buf(v)]),
]);

test('R-RET-02: the keep-forever set is results, manifest, ingest.json, observations and repo.json; controls, report, scan and logs stay in the full bundle only', () => {
  const dir = 'accepted/att-1/0';
  const { keep, catalogs, dropped } = keepSet(item(dir, [{ kind: 'forgery', expected: 'contained', observed: 'contained' }]));
  assert.deepEqual([...keep.keys()].sort(), [`${dir}/ingest.json`, `${dir}/manifest.json`, `${dir}/observations/static.ndjson`, `${dir}/raw/subject/repo.json`, `${dir}/results/scan-static.json`]);
  assert.deepEqual([...dropped].sort(), [`${dir}/controls/forgery.json`, `${dir}/controls/known-answer.json`, `${dir}/logs/run.log`, `${dir}/raw/control-forgery/tools.json`, `${dir}/report.json`, `${dir}/scan.json`]);
  assert.deepEqual([...catalogs.keys()], [sha256(buf('[{"name":"a"}]'))], 'the tool list goes to the content-addressed catalog, not the keep file');
});

test('R-RET-02: the control files of an item whose control failed are kept; so are those of a manifest that cannot be read', () => {
  const dir = 'accepted/att-1/1';
  const failed = keepSet(item(dir, [{ kind: 'known_good', expected: 'pass', observed: 'fail' }]));
  assert.ok(failed.keep.has(`${dir}/controls/known-answer.json`) && failed.keep.has(`${dir}/controls/forgery.json`) && failed.keep.has(`${dir}/raw/control-forgery/tools.json`));
  assert.ok(!failed.keep.has(`${dir}/report.json`), 'only the controls are added');
  assert.equal(controlFailed(buf('not json')), true);
  assert.equal(controlFailed(manifest([])), false);
  // The decision is per item: item 1 failed, item 2 did not.
  const both = new Map([...item('accepted/a/1', [{ expected: 'x', observed: 'y' }]), ...item('accepted/a/2', [{ expected: 'x', observed: 'x' }])]);
  const k = keepSet(both).keep;
  assert.ok(k.has('accepted/a/1/controls/known-answer.json'));
  assert.ok(!k.has('accepted/a/2/controls/known-answer.json'));
});

test('R-RET-02: one catalog per distinct tool list, whatever the number of items; a rejected item keeps only its report; an attempt-level report is kept', () => {
  const same = new Map([...item('accepted/a/0', []), ...item('accepted/a/1', [])]);
  assert.equal(keepSet(same).catalogs.size, 1);
  const other = new Map([...item('accepted/a/0', []), ...item('accepted/a/1', [], { 'raw/subject/tools.json': '[{"name":"b"}]' })]);
  assert.equal(keepSet(other).catalogs.size, 2);
  const rejected = keepSet(new Map([['rejected/a/0/ingest.json', buf('{}')], ['rejected/a/0/result.tar.age', buf('x')], ['rejected/a/ingest.json', buf('{}')]]));
  assert.deepEqual([...rejected.keep.keys()].sort(), ['rejected/a/0/ingest.json', 'rejected/a/ingest.json']);
  assert.deepEqual(rejected.dropped, ['rejected/a/0/result.tar.age']);
  assert.equal(CATALOG_PATH, 'raw/subject/tools.json');
});

test('the windows are the owner-approved ones', () => {
  assert.equal(FULL_RAW_DAYS, 30);
  assert.deepEqual({ ...HOLD_DAYS }, { dispute: 90, disclosure: 90, raw: 548 });
});
