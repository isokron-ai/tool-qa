// The sandbox self-test item (watchdog/selftest.mjs, R-WD-17): the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imageFromLog, nightlyImage, selftestCheck, selftestLanes } from '../selftest.mjs';

test('R-WD-17: the image version comes from the Runner Image group, not the provisioner', () => {
  const log = '2026-11-26T02:55:09Z ##[group]Runner Image Provisioner\n2026-11-26T02:55:09Z Version: 20261111.635\n2026-11-26T02:55:09Z ##[endgroup]\n2026-11-26T02:55:09Z ##[group]Runner Image\n2026-11-26T02:55:09Z Image: ubuntu-24.04\n2026-11-26T02:55:09Z Version: 20261116.376.1\n';
  assert.equal(imageFromLog(log), '20261116.376.1');
  assert.equal(imageFromLog('no header here'), null);
  assert.equal(imageFromLog('##[group]Runner Image\nVersion: bad value;rm\n'), 'bad');
});

test('R-WD-17: the nightly image is the version after the slash', () => {
  assert.equal(nightlyImage({ runner_image: 'ubuntu24/20261122.23.1' }), '20261122.23.1');
  assert.equal(nightlyImage({}), null);
});

test('R-WD-17: only enabled lanes that run third-party code are read, once per workflow file', () => {
  const lanes = selftestLanes({
    a: { enabled: true, runs_untrusted: true, repo: 'o/r', file: 'a.yml' },
    b: { enabled: true, runs_untrusted: true, repo: 'o/r', file: 'a.yml' },
    c: { enabled: false, runs_untrusted: true, repo: 'o/r', file: 'c.yml' },
    d: { enabled: true, runs_untrusted: false, repo: 'o/r', file: 'd.yml' },
    e: { enabled: true, repo: 'o/r', file: '../e.yml' },
  });
  assert.deepEqual(lanes.map((l) => l.name), ['a']);
});

test('R-WD-17: the item is never red', () => {
  const f = Array.from({ length: 30 }, (_, i) => ({ lane: 'live-probe', at: '2026-11-26T00:00:00Z', image: `v${i}`, url: 'https://github.com/o/r/actions/runs/1', job_id: i }));
  assert.equal(selftestCheck({ read: { on: true, failures: f, errors: [], more: true }, passedImage: null }).status, 'amber');
});
