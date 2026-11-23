import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyHealth, LABEL, mergeChecks, parseBody, renderBody, TITLE } from '../health.mjs';
import { createClient } from '../../pump/github.mjs';
import { API, fakeApi, fakeClock } from '../../test/lib/fake-api.mjs';

const REPO = 'isokron-ai/tool-qa';
const NOW = Date.parse('2026-03-02T12:00:00Z');

/** A fake issues API with one in-memory issue list. */
function issuesApi(initial = []) {
  const issues = initial.map((i) => ({ state: 'open', labels: [{ name: LABEL }], ...i }));
  const comments = [];
  const graphql = [];
  let next = 100;
  const api = fakeApi([
    ['GET', `/repos/${REPO}/issues`, (req) => ({
      body: issues.filter((i) => i.state === req.query.get('state') && i.labels.some((l) => l.name === req.query.get('labels'))),
    })],
    ['POST', `/repos/${REPO}/issues`, (req) => {
      const issue = { number: ++next, node_id: `I_${next}`, title: req.json.title, body: req.json.body, state: 'open', labels: req.json.labels.map((name) => ({ name })) };
      issues.push(issue);
      return { status: 201, body: issue };
    }],
    ['PATCH', /\/issues\/\d+$/, (req) => {
      const issue = issues.find((i) => i.number === Number(req.path.split('/').pop()));
      Object.assign(issue, req.json);
      return { body: issue };
    }],
    ['POST', /\/issues\/\d+\/comments$/, (req) => {
      comments.push({ number: Number(req.path.split('/')[5]), body: req.json.body });
      return { status: 201, body: { id: comments.length } };
    }],
    ['POST', '/graphql', (req) => {
      graphql.push(req.json);
      return { status: 403, body: { message: 'Resource not accessible by integration' } };
    }],
  ]);
  const c = fakeClock(NOW);
  const client = createClient({ token: 'ghs_synthetic', fetch: api.fetch, apiUrl: API, now: c.now, sleep: c.sleep });
  return { api, issues, comments, graphql, client };
}

const green = [{ id: 'pump', status: 'green', summary: 'last pump run started 3 minutes ago' }];
const red = [{ id: 'pump', status: 'red', summary: 'no pump run started for 50 minutes; dispatching one' }];

test('the body carries a hidden machine-readable state and a table', () => {
  const body = renderBody({ checks: [{ id: 'a', status: 'amber', summary: 'x | y --> z' }], now: NOW });
  assert.match(body, /^<!-- loop-health:v1 /);
  assert.match(body, /\| a \| amber \| x \\\| y --> z \|/);
  const parsed = parseBody(body);
  assert.equal(parsed.overall, 'amber');
  assert.deepEqual(parsed.checks, [{ id: 'a', status: 'amber', summary: 'x | y --> z' }]);
  assert.equal(parseBody('hello'), null);
  assert.equal(parseBody(null), null);
});

test('the first run creates the issue with its label and tries to pin it', async () => {
  const h = issuesApi();
  const out = await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW });
  assert.equal(out.created, true);
  assert.equal(h.issues.length, 1);
  assert.equal(h.issues[0].title, TITLE);
  assert.deepEqual(h.issues[0].labels, [{ name: LABEL }]);
  assert.equal(parseBody(h.issues[0].body).overall, 'green');
  assert.equal(h.graphql.length, 1, 'pin attempted');
  assert.match(h.graphql[0].query, /pinIssue/);
  assert.equal(out.pinned, false, 'a refused pin is not fatal');
});

test('an unchanged state is not written again', async () => {
  const h = issuesApi();
  await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW });
  const out = await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW + 900_000 });
  assert.equal(out.updated, false);
  assert.equal(h.api.calls.filter((r) => r.method === 'PATCH').length, 0);
});

test('a change is written in place; only turning red or recovering adds a comment', async () => {
  const h = issuesApi();
  await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW });
  let out = await applyHealth({ client: h.client, repo: REPO, checks: [{ ...green[0], summary: 'last pump run started 9 minutes ago' }], now: NOW });
  assert.equal(out.updated, true);
  assert.equal(h.comments.length, 0);
  out = await applyHealth({ client: h.client, repo: REPO, checks: red, now: NOW });
  assert.equal(out.commented, true);
  assert.match(h.comments[0].body, /red/);
  assert.match(h.comments[0].body, /pump/);
  out = await applyHealth({ client: h.client, repo: REPO, checks: [{ id: 'pump', status: 'red', summary: 'still bad' }], now: NOW });
  assert.equal(out.commented, false, 'still red: no new comment');
  out = await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW });
  assert.equal(out.commented, true);
  assert.match(h.comments[1].body, /recovered/i);
  assert.equal(h.issues.length, 1, 'always the same issue');
});

test('issues with another title or pull requests are not taken for the health issue', async () => {
  const h = issuesApi([
    { number: 5, title: 'Something else', body: '' },
    { number: 6, title: TITLE, body: '', pull_request: {} },
  ]);
  const out = await applyHealth({ client: h.client, repo: REPO, checks: green, now: NOW });
  assert.equal(out.created, true);
  assert.equal(out.number, 101);
});

test('merge mode adds or updates one item and keeps the rest', async () => {
  const h = issuesApi();
  await applyHealth({ client: h.client, repo: REPO, checks: [...green, { id: 'slots', status: 'green', summary: 'ok' }], now: NOW });
  await applyHealth({
    client: h.client, repo: REPO, mode: 'merge', now: NOW,
    checks: [{ id: 'pump-successor', status: 'red', summary: 'could not dispatch', at: new Date(NOW).toISOString(), keep: true }],
  });
  const state = parseBody(h.issues[0].body);
  assert.deepEqual(state.checks.map((c) => c.id), ['pump', 'slots', 'pump-successor']);
  assert.equal(state.overall, 'red');
  assert.equal(h.comments.length, 1);
});

test('replace keeps an item raised by another job until a newer reading of the same id arrives', () => {
  const at = (m) => new Date(NOW + m * 60_000).toISOString();
  const prev = [
    { id: 'pump', status: 'green', summary: 'ok' },
    { id: 'pump-successor', status: 'red', summary: 'failed', at: at(0), keep: true },
  ];
  let merged = mergeChecks(prev, [{ id: 'pump', status: 'amber', summary: 'late' }], 'replace');
  assert.deepEqual(merged.map((c) => [c.id, c.status]), [['pump', 'amber'], ['pump-successor', 'red']]);
  merged = mergeChecks(prev, [{ id: 'pump-successor', status: 'green', summary: 'fine', at: at(-5) }], 'replace');
  assert.equal(merged.find((c) => c.id === 'pump-successor').status, 'red', 'an older reading does not clear it');
  merged = mergeChecks(prev, [{ id: 'pump-successor', status: 'green', summary: 'fine', at: at(5) }], 'replace');
  assert.equal(merged.find((c) => c.id === 'pump-successor').status, 'green');
  assert.equal(merged.find((c) => c.id === 'pump'), undefined, 'replace drops plain items not reported again');
});
