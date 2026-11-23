import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPump } from '../run.mjs';
import { openState } from '../../state/db.mjs';
import { fakeClock } from '../../test/lib/fake-api.mjs';

const tiers = JSON.parse(readFileSync(new URL('../tiers.json', import.meta.url), 'utf8'));
const TOKEN = 'ghs_synthetic_state_token';

const wf = {
  enabled: true, repo: 'isokron-ai/mcp-check', file: 'live-probe.yml', ref: 'main',
  shard_size: 2, setup_minutes: 4, minutes_per_subject: 2, slots_max: 12,
  versions: { tool: {}, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default',
};

function seed(file, n, now) {
  const db = openState(file);
  for (let i = 0; i < n; i++) db.setSubjectVersion({ id: `npm:p${i}`, kind: 'package', source: 'npm', tier: 1, sha: String(i).repeat(40).slice(0, 40), now });
  db.close();
}

function harness({ slots = '3', subjects = 4, successor, ingest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-run-'));
  const stateFile = join(dir, 'state.sqlite');
  const c = fakeClock();
  seed(stateFile, subjects, c.t);
  const calls = { pull: 0, push: [], dispatch: [] };
  const lines = [];
  let id = 0;
  const opts = {
    env: { GITHUB_REPOSITORY: 'isokron-ai/tool-qa', GITHUB_TOKEN: TOKEN, LOOP_SLOTS: slots },
    now: c.now,
    sleep: c.sleep,
    log: (l) => lines.push(l),
    stateFile,
    config: { tiers, workflows: { 'live-probe': wf } },
    pull: async (args) => {
      calls.pull += 1;
      assert.equal(args.token, TOKEN);
      return { status: 'pulled' };
    },
    push: async (args) => {
      const db = openState(args.file);
      calls.push.push({ at: c.t, dispatches: db.raw.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n });
      db.close();
      return { status: 'pushed' };
    },
    dispatcher: {
      async dispatch(req) {
        calls.dispatch.push(req);
        return { runId: 10 + calls.dispatch.length, runUrl: null, workflowSha: null, correlatedBy: 'response' };
      },
    },
    newId: () => `att-${++id}`,
    successorFile: successor ? join(dir, 'successor.json') : undefined,
    ingest,
  };
  if (successor) writeFileSync(opts.successorFile, JSON.stringify(successor));
  return { dir, stateFile, c, calls, lines, opts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('LOOP_SLOTS=0: one housekeeping tick, no dispatches, state still saved', async () => {
  const h = harness({ slots: '0' });
  const out = await runPump(h.opts);
  assert.equal(out.ticks, 1);
  assert.equal(out.workerSlots, 0);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.pull, 1);
  assert.equal(h.calls.push.length, 1);
  const db = openState(h.stateFile);
  assert.equal(db.getKv('pump.last_tick').dispatched, 0);
  assert.equal(db.getKv('pump.last_run').ticks, 1);
  db.close();
  h.cleanup();
});

test('ticks repeat every 150 s for about 11 minutes and state is pushed after dispatching', async () => {
  const h = harness({ slots: '3', subjects: 4 });
  const out = await runPump(h.opts);
  assert.equal(out.ticks, 5, 'ticks at 0, 2.5, 5, 7.5 and 10 minutes');
  assert.equal(out.dispatched, 2);
  assert.equal(h.calls.dispatch.length, 2);
  assert.ok(h.calls.push.length >= 2, 'pushed after the dispatching tick and at the end');
  assert.equal(h.calls.push[0].dispatches, 2, 'the first push already holds the dispatches');
  assert.ok(h.c.t - Date.parse('2026-03-02T10:00:00Z') <= 11 * 60_000);
  h.cleanup();
});

test('the successor result is recorded for the watchdog', async () => {
  const h = harness({ slots: '0', successor: { ok: false, error: 'HTTP 502', at: '2026-03-02T10:00:00.000Z' } });
  await runPump(h.opts);
  const db = openState(h.stateFile);
  assert.deepEqual(db.getKv('pump.successor'), { ok: false, error: 'HTTP 502', at: '2026-03-02T10:00:00.000Z' });
  db.close();
  h.cleanup();
});

test('an ingest hook runs every tick with the open state; its errors do not stop the pump', async () => {
  const seen = [];
  const h = harness({
    slots: '2',
    ingest: async ({ db, now }) => {
      seen.push(now());
      assert.equal(typeof db.recordResult, 'function');
      if (seen.length === 1) throw new Error('ingest exploded');
    },
  });
  const out = await runPump(h.opts);
  assert.equal(seen.length, out.ticks);
  assert.ok(h.lines.some((l) => /ingest/.test(l) && /exploded/.test(l)));
  h.cleanup();
});

test('a failed push makes the run fail, after the remaining ticks', async () => {
  const h = harness({ slots: '1' });
  h.opts.push = async () => {
    throw new Error(`release changed under us (token ${TOKEN})`);
  };
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.ok(h.lines.every((l) => !l.includes(TOKEN)), 'the token is never logged');
  h.cleanup();
});
