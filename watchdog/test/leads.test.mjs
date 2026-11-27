// The watchdog's leads item (watchdog/leads.mjs) and the queue history the
// lead step keeps for it (leads/step.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openState } from '../../state/db.mjs';
import { leadStep, LEADS_LAST_KEY, HISTORY_EVERY_MS } from '../../leads/step.mjs';
import { evaluate } from '../checks.mjs';
import { leadsCheck, LEADS_THRESHOLDS as T } from '../leads.mjs';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const last = (over = {}) => ({ at: iso(T0), mode: 'dry-run', open: 10, filed_total: 2, closed_total: 1, filed: 0, closed: 0, reopened: 0, errors: 0, history: [], ...over });

test('R-LEAD-31: the leads check is off with the switch off, amber when the lead step stops writing or had errors, green otherwise; never red', () => {
  assert.equal(leadsCheck({ now: T0, mode: 'off', last: last() }).status, 'off');
  assert.match(leadsCheck({ now: T0, mode: 'dry-run', last: null }).summary, /written nothing yet/);
  assert.equal(leadsCheck({ now: T0, mode: 'dry-run', last: null }).status, 'amber');
  const off = leadsCheck({ now: T0, mode: 'on', last: { off: true, at: iso(T0) } });
  assert.deepEqual([off.status, /pump's lead step ran as off/.test(off.summary)], ['amber', true], 'on here, but the pump ran it as off');
  assert.equal(leadsCheck({ now: T0 + 10 * 60_000, mode: 'dry-run', last: last() }).status, 'green');
  const stale = leadsCheck({ now: T0 + T.staleMs + 60_000, mode: 'on', last: last() });
  assert.deepEqual([stale.status, /stopped producing output/.test(stale.summary)], ['amber', true]);
  const err = leadsCheck({ now: T0, mode: 'on', last: last({ errors: 2 }) });
  assert.deepEqual([err.status, /2 errors/.test(err.summary)], ['amber', true]);
  for (const s of ['off', 'dry-run', 'recheck', 'on']) for (const l of [null, last(), last({ errors: 9, open: 1e6 })]) assert.notEqual(leadsCheck({ now: T0 + 99 * HOUR, mode: s, last: l }).status, 'red');
});

test('R-LEAD-32: the leads check is amber when the queue grows without bound: too many open, steady growth over a day, a re-check backlog, re-checks given up', () => {
  assert.equal(leadsCheck({ now: T0, mode: 'on', last: last({ open: T.queueAmber + 1 }) }).status, 'amber');
  const rising = Array.from({ length: 6 }, (_, i) => [iso(T0 - (5 - i) * 4 * HOUR), 100 + i * 30]);
  const grow = leadsCheck({ now: T0, mode: 'on', last: last({ open: 250, history: rising }) });
  assert.deepEqual([grow.status, /rose on every sample/.test(grow.summary)], ['amber', true]);
  const flat = rising.map(([t], i) => [t, i === 3 ? 90 : 100 + i * 30]);
  assert.equal(leadsCheck({ now: T0, mode: 'on', last: last({ open: 250, history: flat }) }).status, 'green', 'a dip is no unbounded growth');
  assert.equal(leadsCheck({ now: T0, mode: 'on', last: last(), recheck: { due: 20, waiting: T.recheckAmber + 1, given_up: 0 } }).status, 'amber');
  assert.equal(leadsCheck({ now: T0, mode: 'on', last: last(), recheck: { due: 0, waiting: 0, given_up: T.givenUpAmber + 1 } }).status, 'amber');
  assert.match(leadsCheck({ now: T0, mode: 'recheck', last: last(), recheck: { due: 3, waiting: 4, given_up: 0 } }).summary, /re-checks due 3, waiting 4/);
});

test('R-LEAD-33: the lead step keeps an hourly sample of the open queue in kv leads.last (the last 30), and the watchdog reads it from the state', async () => {
  const db = openState(':memory:');
  let t = T0;
  for (let i = 0; i < 40; i++) {
    await leadStep({ db, mode: 'dry-run', tierWeights: {}, now: () => t });
    t += HISTORY_EVERY_MS / 2;
  }
  const kv = db.getKv(LEADS_LAST_KEY);
  assert.equal(kv.history.length, 20, 'one sample per hour of the 20 hours');
  assert.ok(kv.history.every((h, i) => i === 0 || Date.parse(h[0]) - Date.parse(kv.history[i - 1][0]) >= HISTORY_EVERY_MS));
  const state = { openSlots: [], openDispatches: [], kv: { 'leads.last': kv, 'leads.recheck': null } };
  const item = evaluate({ now: t, slots: 3, leadsMode: 'dry-run', state }).checks.find((c) => c.id === 'leads');
  assert.equal(item.status, 'green');
  assert.equal(evaluate({ now: t, slots: 3, state }).checks.find((c) => c.id === 'leads').status, 'off', 'off unless the watchdog is told the switch is on');
});

test('R-LEAD-35: pump.yml gives the pump step LANE_LEADS_ENABLED and watchdog.yml gives it to the watchdog, from the repository variable', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), 'utf8');
  for (const f of ['pump.yml', 'watchdog.yml']) assert.match(read(f), /\n\s+LANE_LEADS_ENABLED: \$\{\{ vars\.LANE_LEADS_ENABLED \}\}\n/, f);
});
