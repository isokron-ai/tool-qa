import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareFacts, forgeryControl, knownAnswerControl, loadKnownAnswer, newMarker } from '../controls.mjs';
import { laneOf } from '../lanes.mjs';
import { createHttp } from '../lib/http.mjs';
import { createBudget } from '../github.mjs';
import { checkControls } from '../../ingest/forgery.mjs';
import { ghNode, githubFetch, registryFetch } from './helpers.mjs';

for (const name of ['meta-github', 'meta-registry']) {
  test(`forgery control (${name}): the planted answers are read and nothing of them escapes raw/`, async () => {
    const marker = newMarker();
    const r = await forgeryControl(laneOf(name), { marker });
    assert.equal(r.control.observed, 'contained');
    assert.ok(r.files['raw/control-forgery/answers.json'].includes(marker));
    assert.ok(!r.files['controls/forgery.json'].includes(marker));
    const files = new Map(Object.entries(r.files).map(([k, v]) => [k, Buffer.from(v)]));
    assert.deepEqual(checkControls({ controls: [r.control] }, files), [], 'ingest finds nothing wrong with it');
  });
}

test('forgery control: a lane that copies upstream text is caught as leaked', async () => {
  const real = laneOf('meta-registry');
  const leaky = {
    ...real,
    async collect(args) {
      const out = await real.collect(args);
      for (const o of out.values()) o.records.push({ field: 'depsdev_facts', value: { note: 'FORGERYMARK0123456789' } });
      return out;
    },
  };
  const r = await forgeryControl(leaky, { marker: 'FORGERYMARK0123456789' });
  assert.equal(r.control.observed, 'leaked');
});

test('forgery control: a lane that copies an upstream key is caught as leaked', async () => {
  const real = laneOf('meta-github');
  const leaky = {
    ...real,
    async collect(args) {
      const out = await real.collect(args);
      for (const o of out.values()) o.records.push({ field: 'repo_core', value: { attempt_id: 'att-999' } });
      return out;
    },
  };
  assert.equal((await forgeryControl(leaky)).control.observed, 'leaked');
});

test('compareFacts: exact, at_least and contains', () => {
  const spec = { exact: { a: 1 }, at_least: { n: 3 }, contains: { list: [{ x: 1 }] } };
  assert.deepEqual(compareFacts(spec, { a: 1, n: 4, list: [{ x: 1 }, { x: 2 }] }), []);
  assert.deepEqual(compareFacts(spec, { a: 2, n: 2, list: [] }).map((m) => m.fact), ['a', 'n', 'list']);
});

test('known-answer control (meta-github): matches our repository, and a changed fact is a mismatch', async () => {
  const lane = laneOf('meta-github');
  const http = createHttp({ fetch: githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode() } }), sleep: async () => {} });
  const ok = await knownAnswerControl(lane, { http, token: 't', budget: createBudget() });
  assert.equal(ok.control.observed, 'match');
  const http2 = createHttp({ fetch: githubFetch({ repos: { 'isokron-ai/mcp-check': ghNode({ createdAt: '2020-01-01T00:00:00Z' }) } }), sleep: async () => {} });
  const bad = await knownAnswerControl(lane, { http: http2, token: 't', budget: createBudget() });
  assert.equal(bad.control.observed, 'mismatch');
  assert.match(bad.files['controls/known-answer.json'], /"created_at"/);
});

test('known-answer control (meta-registry): matches; an unreachable registry is unavailable, never a pass', async () => {
  const lane = laneOf('meta-registry');
  const ok = await knownAnswerControl(lane, { http: createHttp({ fetch: registryFetch(), sleep: async () => {} }) });
  assert.equal(ok.control.observed, 'match');
  const down = createHttp({ fetch: async () => new Response('', { status: 503 }), sleep: async () => {}, retries: 0 });
  const r = await knownAnswerControl(lane, { http: down });
  assert.equal(r.unavailable, 'upstream_unavailable');
  assert.equal(r.control, null);
});

test('the known answers name our own repository', () => {
  const spec = loadKnownAnswer();
  assert.equal(spec.subject, 'isokron-ai/mcp-check');
  assert.ok(spec['meta-github'].exact.github_id > 0);
  assert.ok(spec['meta-registry'].contains.npm.length > 0);
});
