// The lane drain's parsing and decisions (scripts/lane-drain.mjs): which workers a lane means,
// when the wait ends, and when the pump's log says nothing is waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { drain, drained, githubApi, lastIngest, parseLanes, summaryText, workersFor } from '../scripts/lane-drain.mjs';

const config = JSON.parse(readFileSync(new URL('../pump/workflows.json', import.meta.url), 'utf8'));
const line = (w, e = 0, j = 0) => `2026-11-28T03:00:00.0000000Z pump: ingest: checked 4, judged ${j}, waiting ${w}, errors ${e}`;

/** A fake GitHub: `open` is a list of per-poll answers for the workers, `pumpLogs` one log per pump run. */
function fake({ open = [[]], pumpLogs = [line(0)], appear = true } = {}) {
  let poll = 0;
  let nextId = 100;
  const runs = [{ id: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }];
  const calls = { dispatched: 0, opened: 0 };
  return {
    calls,
    async openRuns(repo, file) {
      calls.opened += 1;
      const now = open[Math.min(poll, open.length - 1)];
      return now.filter((r) => r.workflow === `${repo}/${file}`).map((r) => ({ id: r.id, url: `u/${r.id}` }));
    },
    async dispatchPump() {
      calls.dispatched += 1;
      if (appear) runs.unshift({ id: nextId += 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch' });
    },
    async pumpRuns() { return runs; },
    async pumpLog() { return pumpLogs[Math.min(calls.dispatched - 1, pumpLogs.length - 1)] ?? ''; },
    advance() { poll += 1; },
  };
}
const quick = { pollMs: 1, pumpWaitMs: 1000, appearMs: 50 };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('R-DRAIN-01: lanes are comma or space separated lane names, without repeats; an unknown lane, or a name that is not one, stops the run before anything is read', () => {
  assert.deepEqual(parseLanes('live-probe, writecheck  live-probe'), ['live-probe', 'writecheck']);
  for (const bad of ['', ' , ', 'Live_Probe', '../x', 'a;b']) assert.throws(() => parseLanes(bad), /empty|not a lane name/);
  assert.throws(() => workersFor(config, ['no-such-lane']), /unknown lane no-such-lane/);
  assert.throws(() => workersFor({ workflows: { x: { repo: 'a b', file: 'f.yml' } } }, ['x']), /no usable repo/);
});

test('R-DRAIN-02: the workers come from pump/workflows.json, not from the script: a lane maps to its repository and file, and lanes sharing a workflow are waited on once', () => {
  const w = workersFor(config, ['live-probe', 'writecheck']);
  assert.deepEqual(w.map((x) => `${x.repo}/${x.file}`), [`${config.workflows['live-probe'].repo}/${config.workflows['live-probe'].file}`, `${config.workflows.writecheck.repo}/${config.workflows.writecheck.file}`]);
  const shared = workersFor({ workflows: { a: { repo: 'o/r', file: 'f.yml' }, b: { repo: 'o/r', file: 'f.yml' } } }, ['a', 'b']);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].lanes, ['a', 'b']);
  assert.doesNotMatch(readFileSync(new URL('../scripts/lane-drain.mjs', import.meta.url), 'utf8'), /mcp-writecheck-action|mcp-check/, 'no repository is named in the script');
});

test('R-DRAIN-03: the ingest line is read from a pump log, the last one wins, and only waiting 0 ends the drain; no line is not drained', () => {
  assert.deepEqual(lastIngest(`x\n${line(3, 0, 1)}\ny`), { checked: 4, judged: 1, waiting: 3, errors: 0 });
  assert.equal(lastIngest(`${line(3)}\n${line(0)}`).waiting, 0, 'the last tick of the run');
  assert.equal(lastIngest(`${line(0)}\n${line(2)}`).waiting, 2);
  assert.equal(lastIngest('pump: ingest: checked 1, judged 1 (accepted 1), waiting 0, errors 0').waiting, 0, 'with the outcomes in brackets');
  assert.equal(lastIngest('nothing here'), null);
  assert.equal(drained(null), false);
  assert.equal(drained({ waiting: 1 }), false);
  assert.equal(drained({ waiting: 0 }), true);
});

test('R-DRAIN-04: the pump is not dispatched while any worker run is queued or in progress; it is dispatched once none is, and the runs waited on are listed', async () => {
  const api = fake({ open: [[{ id: 7, workflow: 'isokron-ai/mcp-check/live-probe.yml' }, { id: 8, workflow: 'isokron-ai/mcp-writecheck-action/corpus.yml' }], [{ id: 8, workflow: 'isokron-ai/mcp-writecheck-action/corpus.yml' }], []] });
  const c = clock();
  const seenDispatch = [];
  const orig = api.dispatchPump;
  api.dispatchPump = async () => { seenDispatch.push(api.calls.opened); return orig(); };
  const sleep = async (ms) => { api.advance(); await c.sleep(ms); };
  const r = await drain({ lanes: ['live-probe', 'writecheck'], config, api, now: c.now, sleep, ...quick });
  assert.equal(r.ok, true);
  assert.deepEqual(r.waited.map((w) => w.id).sort(), [7, 8]);
  assert.equal(api.calls.dispatched, 1);
  assert.equal(seenDispatch[0], 6, 'two workers read on each of three polls before the dispatch');
});

test('R-DRAIN-05: a worker run still open at the deadline fails the drain and dispatches nothing', async () => {
  const api = fake({ open: [[{ id: 7, workflow: 'isokron-ai/mcp-check/live-probe.yml' }]] });
  const c = clock();
  const r = await drain({ lanes: ['live-probe'], config, api, now: c.now, sleep: c.sleep, waitMs: 5000, ...quick });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout: 1 worker run\(s\) still open/);
  assert.equal(api.calls.dispatched, 0);
});

test('R-DRAIN-06: the pump is dispatched again until its ingest line says waiting 0, at most max-pumps times; the final waiting count is reported', async () => {
  let c = clock();
  let api = fake({ pumpLogs: [line(5), line(2), line(0)] });
  let r = await drain({ lanes: ['live-probe'], config, api, now: c.now, sleep: c.sleep, ...quick });
  assert.equal(r.ok, true);
  assert.equal(r.pumps.length, 3);
  assert.deepEqual(r.pumps.map((p) => p.ingest.waiting), [5, 2, 0]);
  assert.equal(r.final_waiting, 0);
  c = clock();
  api = fake({ pumpLogs: [line(4)] });
  r = await drain({ lanes: ['live-probe'], config, api, now: c.now, sleep: c.sleep, maxPumps: 2, ...quick });
  assert.equal(r.ok, false);
  assert.equal(api.calls.dispatched, 2);
  assert.equal(r.final_waiting, 4);
  assert.match(r.reason, /after 2 pump run\(s\)/);
  c = clock();
  api = fake({ pumpLogs: ['no ingest line at all'] });
  r = await drain({ lanes: ['live-probe'], config, api, now: c.now, sleep: c.sleep, maxPumps: 1, ...quick });
  assert.equal(r.ok, false, 'a log with no ingest line is not a drain');
  assert.equal(r.final_waiting, null);
});

test('R-DRAIN-07: a pump run that never appears fails the drain; the summary names the runs waited on, each pump run and the final count', async () => {
  const c = clock();
  const gone = await drain({ lanes: ['live-probe'], config, api: fake({ appear: false }), now: c.now, sleep: c.sleep, ...quick });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /never appeared/);
  const c2 = clock();
  const api = fake({ open: [[{ id: 7, workflow: 'isokron-ai/mcp-check/live-probe.yml' }], []], pumpLogs: [line(0, 0, 3)] });
  const sleep = async (ms) => { api.advance(); await c2.sleep(ms); };
  const r = await drain({ lanes: ['live-probe'], config, api, now: c2.now, sleep, ...quick });
  const text = summaryText(r);
  assert.match(text, /## Lane drain: drained/);
  assert.match(text, /Worker runs waited on: 1\*\*\n- isokron-ai\/mcp-check\/live-probe.yml \[7\]\(u\/7\)/);
  assert.match(text, /\*\*Pump runs: 1\*\*/);
  assert.match(text, /\| 3 \| 0 \| 0 \|/);
  assert.match(text, /Final waiting count: 0/);
});

test('R-DRAIN-08: the real API reads worker runs by status, dispatches only pump.yml, and changes no variable; the workflow asks for actions: write and nothing broader', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ method: init.method, path: new URL(url).pathname });
    return { ok: true, status: url.includes('dispatches') ? 204 : 200, json: async () => ({ workflow_runs: [], jobs: [] }), text: async () => '' };
  };
  const api = githubApi({ token: 't', repo: 'isokron-ai/tool-qa', ref: 'main', fetchImpl });
  await api.openRuns('isokron-ai/mcp-check', 'live-probe.yml');
  await api.dispatchPump();
  assert.equal(seen.filter((s) => s.method === 'GET').length, 5, 'queued, in_progress, waiting, requested, pending');
  const writes = seen.filter((s) => s.method !== 'GET');
  assert.deepEqual(writes, [{ method: 'POST', path: '/repos/isokron-ai/tool-qa/actions/workflows/pump.yml/dispatches' }]);
  const src = readFileSync(new URL('../scripts/lane-drain.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/actions\/variables|\/pulls\/|\/merge/, 'no variable or merge call');
  const wf = readFileSync(new URL('../.github/workflows/lane-drain.yml', import.meta.url), 'utf8');
  assert.match(wf, /permissions:\n\s+contents: read\n\s+actions: write/);
  assert.doesNotMatch(wf, /secrets\./);
  assert.doesNotMatch(wf, /run: .*\$\{\{/);
});
