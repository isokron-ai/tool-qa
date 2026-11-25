import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const stepOf = (yml, name) => {
  const i = yml.indexOf(`- name: ${name}`);
  assert.ok(i >= 0, name);
  const next = yml.indexOf('\n      - name:', i + 5);
  return yml.slice(i, next < 0 ? undefined : next);
};

test('pump.yml: the live R2 settings are on the Pump step only; the watchdog reads the switch', () => {
  const yml = read('.github/workflows/pump.yml');
  const pump = stepOf(yml, 'Pump');
  assert.match(pump, /LIVE_R2_ACCESS_KEY_ID: \$\{\{ secrets\.LIVE_R2_ACCESS_KEY_ID \}\}/);
  assert.match(pump, /LIVE_R2_SECRET_ACCESS_KEY: \$\{\{ secrets\.LIVE_R2_SECRET_ACCESS_KEY \}\}/);
  assert.match(pump, /R2_ACCOUNT_ID: \$\{\{ secrets\.R2_ACCOUNT_ID \}\}/);
  assert.match(pump, /LANE_LIVE_SNAPSHOT_ENABLED: \$\{\{ vars\.LANE_LIVE_SNAPSHOT_ENABLED \}\}/);
  assert.match(pump, /LIVE_R2_BUCKET: isokron-loop-live/);
  assert.equal((yml.match(/secrets\.LIVE_R2_SECRET_ACCESS_KEY/g) ?? []).length, 1, 'the secret appears in one step only');
  assert.match(read('.github/workflows/watchdog.yml'), /LANE_LIVE_SNAPSHOT_ENABLED: \$\{\{ vars\.LANE_LIVE_SNAPSHOT_ENABLED \}\}/);
});
