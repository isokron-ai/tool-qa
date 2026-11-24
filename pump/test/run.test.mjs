import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPump } from '../run.mjs';
import { ApiBudget } from '../budgets.mjs';
import { openState } from '../../state/db.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';
import { IngestSetupError } from '../../ingest/collect.mjs';
import { parseRegistry } from '../../ingest/registry.mjs';
import { readTar } from '../../worker-kit/tar.mjs';
import {
  artifactEntry, defaultRun, fakeDecrypt, fakeEncrypt, makeBundle, REGISTRY_TEXT, RUN_ID, WORKER_REPO, WORKFLOW_SHA,
} from '../../ingest/testkit.mjs';

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

// ingest: null (none) unless a test sets it; undefined means the pump's own collector.
function harness({ slots = '3', subjects = 4, successor, ingest = null } = {}) {
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
      calls.push.push({
        at: c.t,
        dispatches: db.raw.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n,
        results: db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n,
        pending: db.raw.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE status = 'pending'").get().n,
        sent: calls.dispatch.length,
      });
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

test('ingest runs at the start of each tick until two minutes before the end; its errors do not stop the pump', async () => {
  const seen = [];
  const h = harness({
    slots: '2',
    ingest: async ({ db, now, deadline, mintToken }) => {
      seen.push({ at: now(), deadline });
      assert.equal(typeof db.recordResult, 'function');
      assert.equal(typeof mintToken, 'function');
      if (seen.length === 1) throw new Error('ingest exploded');
    },
  });
  const start = h.c.t;
  const out = await runPump(h.opts);
  assert.equal(out.ticks, 5, 'ticks at 0, 2.5, 5, 7.5 and 10 minutes');
  assert.deepEqual(seen.map((s) => (s.at - start) / 1000), [0, 150, 300, 450], 'no new results are taken after minute 9');
  for (const s of seen) assert.equal(s.deadline, start + 9 * 60_000);
  assert.ok(h.lines.some((l) => /ingest/.test(l) && /exploded/.test(l)));
  assert.equal(out.ok, true);
  h.cleanup();
});

test('R-ING-09: a failed push makes the run fail; nothing is sent and the run ends after one housekeeping tick', async () => {
  const h = harness({ slots: '1' });
  let pushes = 0;
  h.opts.push = async () => {
    pushes += 1;
    throw new Error(`release changed under us (token ${TOKEN})`);
  };
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0, 'the save before sending failed, so nothing was sent');
  assert.equal(out.dispatched, 0);
  assert.equal(out.ticks, 2, 'the failing tick, then one housekeeping tick');
  assert.equal(pushes, 3, 'before sending, end of tick 1, and the final save (tick 2 changed nothing)');
  assert.ok(h.lines.some((l) => /nothing more is dispatched this run/.test(l)), h.lines.join('\n'));
  const db = openState(h.stateFile);
  const rows = db.raw.prepare('SELECT status, error FROM dispatches').all();
  assert.ok(rows.length > 0 && rows.every((r) => r.status === 'failed' && /^not sent: the state could not be saved first$/.test(r.error)), JSON.stringify(rows));
  assert.deepEqual(db.openSlots(), [], 'the withdrawn dispatches hold no slot');
  db.close();
  assert.ok(h.lines.every((l) => !l.includes(TOKEN)), 'the token is never logged');
  h.cleanup();
});

// ---- the pump's own collector (ingest/collect.mjs) ----

const PUBKEY = `age1${'q'.repeat(58)}`;

/**
 * live-probe against a worker repo whose run finishes at once and uploads one
 * good result bundle per item (result-<attempt_id>-<index>.tar.age). By default
 * one subject and shard_size 1.
 */
function ingestHarness({ ingestOptions = {}, env = {}, subjects = 1, shardSize = 1 } = {}) {
  const h = harness({ slots: '2', subjects });
  h.opts.ingest = undefined; // the pump's own collector
  const pub = join(h.dir, 'ingest.pub');
  writeFileSync(pub, `# test\n${PUBKEY}\n`);
  const outDir = join(h.dir, 'ingest-out');
  const minted = [];
  const sent = () => h.calls.dispatch[0].inputs;
  const blob = (index) => {
    const item = JSON.parse(sent().items)[index];
    const bundle = makeBundle({ identity: { attempt_id: sent().attempt_id, run_key: item.run_key, fence: item.fence } });
    return fakeEncrypt(bundle.tar);
  };
  const artifacts = () => JSON.parse(sent().items).map((_, i) => artifactEntry({ id: 901 + i, name: `result-${sent().attempt_id}-${i}.tar.age` }));
  const api = fakeApi([
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`, () => ({ body: defaultRun() })],
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}/artifacts`, () => ({ body: { total_count: artifacts().length, artifacts: artifacts() } })],
    ['GET', /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/zip$/, (req) => ({ status: 302, headers: { location: `https://blob.example.test/a/${req.path.split('/').at(-2)}` } })],
    ['GET', /^\/a\/\d+$/, (req) => ({ body: blob(Number(req.path.split('/').at(-1)) - 901) })],
  ]);
  const budget = new ApiBudget({ now: h.c.now, sleep: h.c.sleep });
  Object.assign(h.opts, {
    env: { ...h.opts.env, GITHUB_API_URL: API, ...env },
    config: { tiers, workflows: { 'live-probe': { ...wf, repo: WORKER_REPO, file: 'qa-worker.yml', shard_size: shardSize, slots_max: 1 } } },
    fetch: api.fetch,
    budget,
    mintToken: async (args) => {
      minted.push(args);
      return { token: `ghs_synthetic_${minted.length}`, expiresAt: h.c.t + 60 * 60_000 };
    },
    dispatcher: {
      async dispatch(req) {
        h.calls.dispatch.push(req);
        return { runId: RUN_ID, runUrl: null, workflowSha: WORKFLOW_SHA, correlatedBy: 'response' };
      },
    },
    ingestOptions: {
      sealTo: pub,
      outDir,
      identity: 'test-identity',
      registry: { ...parseRegistry(REGISTRY_TEXT), source: 'test' },
      crypto: { decrypt: fakeDecrypt, encrypt: (plaintext) => fakeEncrypt(plaintext), publicKey: () => PUBKEY },
      ...ingestOptions,
    },
  });
  return { ...h, api, budget, minted, outDir };
}

test('a finished worker run is ingested in the next tick and recorded before that tick pushes', async () => {
  const h = ingestHarness();
  const start = h.c.t;
  const out = await runPump(h.opts);
  assert.equal(out.ok, true);
  assert.equal(out.dispatched, 1, 'the accepted subject is not due again');

  const db = openState(h.stateFile);
  const [d] = db.raw.prepare('SELECT * FROM dispatches').all();
  assert.equal(d.status, 'done');
  assert.equal(d.close_reason, 'results_in');
  const [result] = db.listResults();
  assert.equal(result.attempt_id, d.attempt_id);
  assert.equal(result.outcome, 'accepted');
  assert.equal(db.getKv('pump.last_run').dispatched, 1);
  db.close();

  const first = h.calls.push.findIndex((p) => p.results === 1);
  assert.ok(first >= 0 && first < h.calls.push.length - 1, 'pushed by the tick that judged it, not only at the end');
  assert.equal(h.calls.push[first].at, start + 150_000, 'the second tick');

  assert.deepEqual(h.minted, [{ repositories: ['mcp-check'], permissions: { actions: 'read' } }]);
  const used = h.budget.snapshot().used;
  assert.ok(used.actions >= 1 && used.artifacts >= 2, `ingest calls go through the API budget: ${JSON.stringify(used)}`);
  const files = readTar(fakeDecrypt(readFileSync(join(h.outDir, `ingest-${d.attempt_id}-0.tar.age`)))).map((e) => e.path);
  assert.ok(files.includes(`accepted/${d.attempt_id}/0/ingest.json`));
  assert.ok(h.lines.some((l) => /^ingest: live-probe shard .* item 0: accepted, recorded, outputs sealed$/.test(l)), h.lines.join('\n'));
  assert.ok(h.lines.every((l) => !l.includes('ghs_synthetic_')), 'tokens are never logged');
  h.cleanup();
});

test('a shard of three subjects: one bundle per item, each judged and recorded, the dispatch closed once', async () => {
  const h = ingestHarness({ subjects: 3, shardSize: 3 });
  const out = await runPump(h.opts);
  assert.equal(out.ok, true, h.lines.join('\n'));
  assert.equal(out.dispatched, 1, 'one dispatch carries all three subjects');
  assert.equal(JSON.parse(h.calls.dispatch[0].inputs.items).length, 3);

  const db = openState(h.stateFile);
  const [d] = db.raw.prepare('SELECT * FROM dispatches').all();
  assert.equal(d.status, 'done');
  assert.equal(d.close_reason, 'results_in');
  const results = db.listResults();
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.attempt_id === d.attempt_id && r.outcome === 'accepted'));
  assert.deepEqual(db.getAttempt(d.attempt_id).items.map((i) => [i.index, i.outcome]), [[0, 'accepted'], [1, 'accepted'], [2, 'accepted']]);
  db.close();

  for (const i of [0, 1, 2]) {
    const files = readTar(fakeDecrypt(readFileSync(join(h.outDir, `ingest-${d.attempt_id}-${i}.tar.age`)))).map((e) => e.path);
    assert.ok(files.includes(`accepted/${d.attempt_id}/${i}/ingest.json`), `item ${i}: ${files.join(', ')}`);
    assert.ok(h.lines.some((l) => l.endsWith(`item ${i}: accepted, recorded, outputs sealed`)), h.lines.join('\n'));
  }
  const listings = h.api.calls.filter((c) => c.path.endsWith(`/runs/${RUN_ID}/artifacts`));
  assert.equal(listings.length, 1, 'the artifacts are listed once for the whole shard');
  h.cleanup();
});

test('with ingest.pub holding only the placeholder comments the pump dispatches nothing and fails the run', async () => {
  const h = ingestHarness();
  const placeholder = join(h.dir, 'placeholder.pub');
  writeFileSync(placeholder, '# The ingest public key goes here.\n# Nothing else yet.\n');
  h.opts.ingestOptions.sealTo = placeholder;
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(out.ticks, 1, 'one housekeeping tick');
  assert.equal(h.calls.push.length, 1, 'the state is still saved');
  assert.ok(h.lines.some((l) => /placeholder\.pub has no age public key yet/.test(l) && /nothing is dispatched/.test(l)), h.lines.join('\n'));
  assert.equal(h.api.calls.length, 0);
  h.cleanup();
});

test('without AGE_IDENTITY the pump dispatches nothing', async () => {
  const h = ingestHarness();
  delete h.opts.ingestOptions.identity;
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0);
  assert.ok(h.lines.some((l) => /AGE_IDENTITY is not set/.test(l)), h.lines.join('\n'));
  h.cleanup();
});

test('a failed ingest setup check blocks dispatch and is reported', async () => {
  const h = harness({ slots: '2', ingest: { check: async () => {
    throw new IngestSetupError('the keys do not match');
  }, collect: async () => assert.fail('collect is not called once setup failed') } });
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0);
  assert.ok(h.lines.some((l) => /the keys do not match/.test(l) && /nothing is dispatched/.test(l)), h.lines.join('\n'));
  h.cleanup();
});

test('an enabled workflow with shard_size above 1 is not a setup problem', async () => {
  const h = ingestHarness();
  h.opts.config.workflows['live-probe'].shard_size = 4;
  const out = await runPump(h.opts);
  assert.equal(out.ok, true, h.lines.join('\n'));
  assert.equal(h.calls.dispatch.length, 1);
  assert.ok(h.lines.every((l) => !/not ready/.test(l)), h.lines.join('\n'));
  h.cleanup();
});

test('AGE_IDENTITY never reaches the log', async () => {
  const secret = `AGE-SECRET-KEY-1${'Q'.repeat(58)}`;
  const h = harness({ slots: '1', ingest: async () => {
    throw new Error(`could not use ${secret}`);
  } });
  h.opts.env.AGE_IDENTITY = secret;
  await runPump(h.opts);
  assert.ok(h.lines.some((l) => /ingest failed/.test(l)));
  assert.ok(h.lines.every((l) => !l.includes(secret)));
  h.cleanup();
});

test('R-ING-06: expired dispatches are reaped before ingest looks at them', async () => {
  const seen = [];
  const h = harness({ slots: '0', ingest: async ({ db, now }) => {
    seen.push(db.dispatchesAwaitingResults({ now: now(), lateMs: 0 }).map((d) => [d.attempt_id, d.status]));
    seen.push(db.getDispatch('att-old').status);
  } });
  const db = openState(h.stateFile);
  const t = h.c.t - 60 * 60_000;
  db.acquireSlot('att-old', { budget: 5, ttlMs: 30 * 60_000, now: t });
  const l = db.acquireLease('k'.repeat(64), 'att-old', { ttlMs: 30 * 60_000, now: t });
  db.createDispatch({
    attemptId: 'att-old', shardId: 's-old', workflow: 'live-probe', repo: 'isokron-ai/mcp-check', workflowFile: 'live-probe.yml', ref: 'main',
    expires: t + 30 * 60_000, items: [{ run_key: 'k'.repeat(64), subject: 'npm:p0', fence: l.fence }], now: t,
  });
  db.markDispatched('att-old', { runId: 99 });
  db.close();
  const out = await runPump(h.opts);
  assert.deepEqual(seen, [[], 'expired'], 'ingest never sees it as an open dispatch');
  assert.ok(h.lines.some((l2) => /lease expired: closed live-probe shard s-old/.test(l2)), h.lines.join('\n'));
  const after = openState(h.stateFile);
  assert.equal(after.getKv('pump.last_tick').reaped, 1);
  after.close();
  assert.equal(out.ok, true);
  h.cleanup();
});

test('R-ING-09: a push that fails after dispatching stops dispatching for the rest of the run', async () => {
  const h = harness({ slots: '3', subjects: 6 });
  const push = h.opts.push;
  let n = 0;
  h.opts.push = async (args) => {
    n += 1;
    if (n === 2) throw new Error('HTTP 502'); // the save at the end of tick 1
    return push(args);
  };
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 3, 'tick 1 sent its shards (saved before sending)');
  assert.equal(out.ticks, 2, 'then one housekeeping tick, and the run ends');
  assert.ok(h.lines.some((l) => /state push \(tick 1\) failed: HTTP 502; nothing more is dispatched this run/.test(l)), h.lines.join('\n'));
  const db = openState(h.stateFile);
  assert.equal(db.getKv('pump.last_tick').workerSlots, 0, 'the last tick dispatched nothing');
  db.close();
  h.cleanup();
});

test('R-ING-10: dispatches are in the saved state before they are sent', async () => {
  const h = harness({ slots: '3', subjects: 4 });
  const out = await runPump(h.opts);
  assert.equal(out.dispatched, 2);
  const before = h.calls.push[0];
  assert.equal(before.sent, 0, 'the first push happens before anything is sent');
  assert.equal(before.pending, 2, 'and holds both dispatches as pending');
  const after = h.calls.push[1];
  assert.equal(after.sent, 2);
  assert.equal(after.pending, 0, 'the next push has them as dispatched');
  h.cleanup();
});

test('R-ING-11: the API budget is saved with the state and seeds the next run', async () => {
  const h = harness({ slots: '0' });
  const first = new ApiBudget({ now: h.c.now, sleep: h.c.sleep });
  for (let i = 0; i < 7; i++) await first.take('contents');
  await runPump({ ...h.opts, budget: first });
  const db = openState(h.stateFile);
  const saved = db.getKv('pump.api_budget');
  db.close();
  assert.equal(saved.used.contents, 7);
  assert.equal(saved.calls.families.contents.length, 7);

  h.c.t += 10 * 60_000;
  const second = new ApiBudget({ now: h.c.now, sleep: h.c.sleep });
  await runPump({ ...h.opts, budget: second });
  assert.equal(second.snapshot().used.contents, 7, 'the second run counts the first run\'s calls');
  h.cleanup();
});
