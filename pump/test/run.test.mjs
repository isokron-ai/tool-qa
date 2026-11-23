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

// ---- the pump's own collector (ingest/collect.mjs) ----

const PUBKEY = `age1${'q'.repeat(58)}`;

/** One subject, live-probe with shard_size 1, a worker repo whose run finishes at once and uploads a good result. */
function ingestHarness({ ingestOptions = {}, env = {} } = {}) {
  const h = harness({ slots: '2', subjects: 1 });
  h.opts.ingest = undefined; // the pump's own collector
  const pub = join(h.dir, 'ingest.pub');
  writeFileSync(pub, `# test\n${PUBKEY}\n`);
  const outDir = join(h.dir, 'ingest-out');
  const minted = [];
  const blob = () => {
    const sent = h.calls.dispatch[0];
    const [item] = JSON.parse(sent.inputs.items);
    const bundle = makeBundle({ identity: { attempt_id: sent.inputs.attempt_id, run_key: item.run_key, fence: item.fence } });
    return fakeEncrypt(bundle.tar);
  };
  const api = fakeApi([
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}`, () => ({ body: defaultRun() })],
    ['GET', `/repos/${WORKER_REPO}/actions/runs/${RUN_ID}/artifacts`, () => ({ body: { total_count: 1, artifacts: [artifactEntry()] } })],
    ['GET', `/repos/${WORKER_REPO}/actions/artifacts/901/zip`, () => ({ status: 302, headers: { location: 'https://blob.example.test/a/901' } })],
    ['GET', '/a/901', () => ({ body: blob() })],
  ]);
  const budget = new ApiBudget({ now: h.c.now, sleep: h.c.sleep });
  Object.assign(h.opts, {
    env: { ...h.opts.env, GITHUB_API_URL: API, ...env },
    config: { tiers, workflows: { 'live-probe': { ...wf, repo: WORKER_REPO, file: 'qa-worker.yml', shard_size: 1, slots_max: 1 } } },
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
  const files = readTar(fakeDecrypt(readFileSync(join(h.outDir, `ingest-${d.attempt_id}.tar.age`)))).map((e) => e.path);
  assert.ok(files.includes(`accepted/${d.attempt_id}/ingest.json`));
  assert.ok(h.lines.some((l) => /^ingest: live-probe shard .*: accepted, recorded, outputs sealed$/.test(l)), h.lines.join('\n'));
  assert.ok(h.lines.every((l) => !l.includes('ghs_synthetic_')), 'tokens are never logged');
  h.cleanup();
});

test('with ingest.pub still the placeholder the pump dispatches nothing and fails the run', async () => {
  const h = ingestHarness({ ingestOptions: { sealTo: undefined } });
  delete h.opts.ingestOptions.sealTo;
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(out.ticks, 1, 'one housekeeping tick');
  assert.equal(h.calls.push.length, 1, 'the state is still saved');
  assert.ok(h.lines.some((l) => /ingest\.pub has no age public key yet/.test(l) && /nothing is dispatched/.test(l)), h.lines.join('\n'));
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

test('an enabled workflow with shard_size above 1 blocks dispatch until ingest can judge it', async () => {
  const h = harness({ slots: '2', ingest: { check: async ({ workflows }) => {
    assert.ok(workflows['live-probe']);
    throw new IngestSetupError('workflow "live-probe" has shard_size 2');
  }, collect: async () => assert.fail('collect is not called once setup failed') } });
  const out = await runPump(h.opts);
  assert.equal(out.ok, false);
  assert.equal(h.calls.dispatch.length, 0);
  assert.ok(h.lines.some((l) => /shard_size 2/.test(l)));
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
