// Filing leads as issues on our repositories (leads/plan.mjs, leads/step.mjs,
// leads/repro.mjs): caps, shapes only, crash-safe filing, close and reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../state/db.mjs';
import { CAP_NEW_PER_REPO_PER_DAY, CAP_OPEN_PER_REPO, CLEAN_RECHECKS_TO_CLOSE } from '../state/leads.mjs';
import { assertShapeOnly, issueFor, kindOf, LABEL, planFilings, renderPlan, titleTag } from '../leads/plan.mjs';
import { syntheticRepro, languageOf } from '../leads/repro.mjs';
import { leadStep, LEADS_LAST_KEY } from '../leads/step.mjs';
import { API, fakeApi } from './lib/fake-api.mjs';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tierWeights = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8')).weights;
const lead = (n, over = {}) => ({
  fingerprint: sha(`fp-${n}`).slice(0, 12), tool: 'mcp-check', lane: 'scan-static', component: 'static', oracle: 'scan-static', class: 'no_tools_found',
  idiom: 'none/repo:python', layout: 'server_json:1;via:github', signature: `class=no_tools_found;detail=no_tools;error=-;list_error=-;http=-;fault=tool;retryable=false;n=${n}`,
  partial: false, fault: 'tool', versions: ['mcp-check@1.3.1'], ...over,
});

let seq = 0;
function accept(db, { subject, failures, runId, now, coverage = null }) {
  const key = sha(`run-${++seq}`);
  const att = `att-${seq}`;
  const lease = db.acquireLease(key, att, { ttlMs: DAY, now });
  db.recordRunKey(key, { subject, workflow: 'scan-static', fields: { n: seq }, now });
  db.createDispatch({ attemptId: att, shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: key, subject, fence: lease.fence }], now });
  db.setDispatchRun(att, { runId, runUrl: null, correlatedBy: 'test', now });
  const cov = coverage ?? (failures.length ? 'unassessed_tool' : 'assessed');
  return db.recordResult({ run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: cov === 'assessed' ? null : 'tool', coverage: cov, failures, now: now + 1 });
}
/** A state with `n` reproduced leads on scan-static (so mcp-check), lead i carried by i+1 subjects. */
function reproduced(n, { subjectsPer = (i) => i + 1, over = () => ({}) } = {}) {
  const db = openState(':memory:');
  let run = 1;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < subjectsPer(i); k++) {
      const subject = `acme-org/server-${i}-${k}`;
      db.setSubjectVersion({ id: subject, kind: 'repo', source: 'test', tier: 2, sha: 'a'.repeat(40), now: T0 - DAY });
      accept(db, { subject, failures: [lead(i, over(i))], runId: run++, now: T0 + i * 1000 + k });
      accept(db, { subject, failures: [lead(i, over(i))], runId: run++, now: T0 + HOUR + i * 1000 + k });
    }
  }
  return db;
}
const NOW = new Date(T0 + 2 * HOUR).toISOString();

test('R-LEAD-24: at most 5 new issues per repository per day and 30 open, the leads that unlock most first', () => {
  const db = reproduced(8);
  const plan = planFilings(db, { now: NOW, tierWeights });
  assert.equal(plan.file.length, CAP_NEW_PER_REPO_PER_DAY);
  assert.equal(plan.capped.length, 8 - CAP_NEW_PER_REPO_PER_DAY);
  assert.deepEqual(plan.file.map((e) => e.carriers.current), [8, 7, 6, 5, 4], 'most carried first');
  // Filed today count against the day; the next day there is room again.
  for (const e of plan.file) db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = 1, issue_state = 'open', filed_at = ? WHERE fingerprint = ?").run(NOW, e.lead.fingerprint);
  assert.equal(planFilings(db, { now: NOW, tierWeights }).file.length, 0);
  assert.equal(planFilings(db, { now: new Date(T0 + DAY + 2 * HOUR).toISOString(), tierWeights }).file.length, 3);
  // Open issues cap: with 30 open there is no room, whatever the day.
  const many = reproduced(2);
  for (let i = 0; i < CAP_OPEN_PER_REPO; i++) {
    many.raw.prepare(`INSERT INTO leads (fingerprint, repo, tool, lane, component, oracle, class, idiom, layout, signature, fault, status, first_seen, last_seen, issue_number, issue_state, filed_at, updated_at)
      VALUES (?, 'isokron-ai/mcp-check', 'mcp-check', 'scan-static', 'static', 'scan-static', 'tool_error', 'x', 'y', 'z', 'tool', 'filed', ?, ?, ?, 'open', '2026-01-01T00:00:00Z', ?)`).run(`open${i}`, NOW, NOW, 100 + i, NOW);
  }
  const p2 = planFilings(many, { now: NOW, tierWeights });
  assert.deepEqual([p2.file.length, p2.capped.length], [0, 2]);
  assert.equal(p2.caps['isokron-ai/mcp-check'].open, CAP_OPEN_PER_REPO);
});

test('R-LEAD-25: an issue holds the shape only: title tag and marker, our tool, counts and a synthetic repro; no subject name, run id or third-party text', () => {
  const db = reproduced(1, { subjectsPer: () => 3 });
  const [e] = planFilings(db, { now: NOW, tierWeights }).file;
  const issue = issueFor(e, { now: NOW });
  assert.ok(issue.title.startsWith(titleTag(e.lead.fingerprint)));
  assert.deepEqual(issue.labels, [LABEL]);
  assert.match(issue.body, new RegExp(`<!-- tool-qa lead ${e.lead.fingerprint} -->`));
  assert.match(issue.body, /3 servers carry it on their latest result; seen/, 'a total only: no tiers under 5 carriers');
  assert.ok(!/T2|Priority|priority/.test(issue.body), 'no tier breakdown and no priority');
  const [big] = planFilings(reproduced(1, { subjectsPer: () => 5 }), { now: NOW, tierWeights }).file;
  assert.match(issueFor(big, { now: NOW }).body, /5 servers carry it on their latest result \(T2: 5\)/);
  assert.match(issue.body, /### Synthetic repro/);
  assert.match(issue.body, /isokron\.ai\/\?utm_source=github/);
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  for (const bad of ['acme', 'server-0', 'run 1', 'run_id']) assert.ok(!text.includes(bad), `${bad} is in the issue`);
  const subjects = db.listSubjects().map((s) => s.id);
  assert.doesNotThrow(() => assertShapeOnly(e.lead, { subjects }));
  // The guard, field by field: a word that is not one of our codes, a field holding a server id, a tool not ours.
  assert.throws(() => assertShapeOnly({ ...e.lead, signature: 'class=tool_error;error=widgetfail' }, { subjects }), /error word is not shape-only/);
  assert.throws(() => assertShapeOnly({ ...e.lead, layout: 'acme-org/server-0-1' }, { subjects }), /not shape-only/);
  assert.throws(() => assertShapeOnly({ ...e.lead, tool: 'acme-scanner' }, { subjects }), /the tool is not shape-only/);
});

test('R-LEAD-25: the synthetic repro is our own template in the lead\'s language and layout, varied by its class; an idiom with no template says so', () => {
  const ok = { verdict: { verdict: 'reproduced', run_id: 1, key: '0'.repeat(16), tool: 'mcp-check@abc' } };
  const r = syntheticRepro(lead(1, { class: 'reader_limit', signature: 'class=reader_limit;partial=unresolved_names', idiom: 'source/derived/repo:ts/js' }), ok);
  assert.match(r, /TOOL_NAME = "echo"/);
  assert.match(r, /registerTool\(TOOL_NAME/);
  assert.match(r, /server\.json/);
  assert.match(r, /npx @isokron\/mcp-check --repo-dir \. --format json/);
  const multi = syntheticRepro(lead(2, { class: 'unsupported_layout', layout: 'server_json:1;multi_server;via:github', idiom: 'none/repo:python' }), ok);
  assert.match(multi, /servers\/a\/server\.py/);
  assert.match(multi, /servers\/b\/server\.py/);
  assert.match(syntheticRepro(lead(3, { idiom: 'none/repo:c#' })), /no fixture template for the idiom `none\/repo:c#` yet/);
  assert.equal(languageOf('source/derived/go'), 'go');
  assert.equal(kindOf(lead(4, { class: 'timeout_start', signature: 'class=timeout_start;detail=start_env_limited' })), 'timeout_start/start_env_limited');
  assert.equal(kindOf(lead(5)), 'no_tools_found', 'scan-static\'s detail word only restates the class');
});

const BOT = 'isokron-tool-qa[bot]';
/** A fake GitHub for our repositories' issues. */
function issuesApi({ refuseLabel = false, existing = [] } = {}) {
  const issues = [...existing];
  const comments = [];
  const api = fakeApi([
    ['GET', /^\/repos\/isokron-ai\/[a-z-]+\/issues$/, (req) => {
      const label = req.query.get('labels');
      return { body: issues.filter((i) => !label || (i.labels ?? []).some((x) => (x.name ?? x) === label)).map((i) => ({ ...i })) };
    }],
    ['POST', /^\/repos\/isokron-ai\/[a-z-]+\/issues$/, (req) => {
      if (refuseLabel && req.json.labels) return { status: 422, body: { message: 'Validation Failed' } };
      const i = { number: issues.length + 1, title: req.json.title, body: req.json.body, state: 'open', labels: req.json.labels ?? [], user: { login: BOT } };
      issues.push(i);
      return { status: 201, body: i };
    }],
    ['GET', /^\/repos\/isokron-ai\/[a-z-]+\/issues\/\d+$/, (req) => {
      const i = issues.find((x) => x.number === Number(req.path.split('/').pop()));
      return i ? { body: { ...i } } : { status: 404, body: { message: 'Not Found' } };
    }],
    ['POST', /^\/repos\/isokron-ai\/[a-z-]+\/issues\/\d+\/comments$/, (req) => { comments.push({ path: req.path, body: req.json.body }); return { status: 201, body: { id: comments.length } }; }],
    ['PATCH', /^\/repos\/isokron-ai\/[a-z-]+\/issues\/\d+$/, (req) => {
      const i = issues.find((x) => x.number === Number(req.path.split('/').pop()));
      i.state = req.json.state;
      return { body: i };
    }],
  ]);
  return { api, issues, comments };
}
const minter = () => {
  const asked = [];
  return { asked, mint: async (args) => { asked.push(args); return { token: `tok-${asked.length}` }; } };
};
const step = (db, over = {}) => leadStep({ db, mode: 'on', tierWeights, now: () => Date.parse(NOW), ...over });

test('R-LEAD-26: dry-run and recheck write the plan to the job summary and touch no issue; off writes nothing but its note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leads-'));
  try {
    for (const mode of ['dry-run', 'recheck']) {
      const db = reproduced(2);
      const m = minter();
      const summary = join(dir, `summary-${mode}`);
      const note = await step(db, { mode, mintToken: m.mint, summaryFile: summary, save: async () => assert.fail('nothing to save') });
      assert.equal(m.asked.length, 0, `${mode}: no token minted`);
      assert.deepEqual([note.filed, note.planned, note.open], [0, 2, 2]);
      const md = readFileSync(summary, 'utf8');
      assert.match(md, /Dry run: no issue is touched/);
      assert.match(md, /file: reproduced/);
      assert.ok(!/acme/.test(md), 'the summary names no server');
      assert.equal(db.listLeads().filter((l) => l.issue_number != null || l.filing_started_at).length, 0);
      assert.equal(db.getKv(LEADS_LAST_KEY).mode, mode);
    }
    // A state from before the leads tables (schema v11): noted as off, nothing read.
    const v11 = openState(':memory:');
    v11.raw.exec('DROP TABLE lead_subjects; DROP TABLE leads; ALTER TABLE results DROP COLUMN skip_codes; PRAGMA user_version = 11');
    assert.equal((await step(v11, { mode: 'on', mintToken: async () => assert.fail('no token') })).mode, 'on');
    assert.equal(v11.getKv(LEADS_LAST_KEY).off, true);
    const off = reproduced(1);
    const note = await step(off, { mode: 'off', summaryFile: join(dir, 'off') });
    assert.equal(note.mode, 'off');
    assert.equal(off.getKv(LEADS_LAST_KEY).off, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-LEAD-27: with the switch true, leads are marked and the state saved before any issue is made; each gets one issue on its repository with an issues-only token', async () => {
  const db = reproduced(2);
  const { api, issues } = issuesApi();
  const m = minter();
  const order = [];
  const save = async () => {
    order.push('save');
    assert.equal(db.listLeads().filter((l) => l.filing_started_at).length, 2, 'both marked before the save');
    assert.equal(issues.length, 0, 'nothing created before the save');
    return true;
  };
  const note = await step(db, { mintToken: m.mint, save, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } });
  assert.deepEqual([note.filed, note.errors], [2, 0]);
  assert.deepEqual(order, ['save']);
  assert.deepEqual(m.asked, [{ repositories: ['mcp-check'], permissions: { issues: 'write' } }]);
  assert.equal(issues.length, 2);
  for (const l of db.listLeads()) {
    assert.deepEqual([l.status, l.issue_state, l.filing_started_at], ['filed', 'open', null]);
    assert.ok(issues.find((i) => i.number === l.issue_number).title.startsWith(titleTag(l.fingerprint)));
  }
  // A second run files nothing again.
  const again = await step(db, { mintToken: m.mint, save, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } });
  assert.equal(again.filed, 0);
  assert.equal(issues.length, 2);
});

test('R-LEAD-27: a failed save files nothing; a filing started but not confirmed is adopted from GitHub by its title tag, never filed twice', async () => {
  const db = reproduced(1);
  const { api, issues } = issuesApi();
  const m = minter();
  const client = { fetch: api.fetch, apiUrl: API, sleep: async () => {} };
  const first = await step(db, { mintToken: m.mint, save: async () => false, client });
  assert.equal(first.filed, 0);
  assert.equal(issues.length, 0);
  // The pump died after creating the issue and before saving its number.
  const [l] = db.listLeads();
  issues.push({ number: 41, title: `${titleTag(l.fingerprint)} no_tools_found in scan-static static`, body: '', state: 'open', labels: [{ name: LABEL }] });
  issues[0].body = `<!-- tool-qa lead ${l.fingerprint} -->`;
  issues[0].user = { login: BOT };
  db.raw.prepare('UPDATE leads SET filing_started_at = ? WHERE fingerprint = ?').run(NOW, l.fingerprint);
  const second = await step(db, { mintToken: m.mint, save: async () => true, client });
  assert.deepEqual([second.adopted, second.filed], [1, 0]);
  assert.equal(issues.length, 1);
  assert.equal(db.listLeads()[0].issue_number, 41);
  // Marked, but GitHub has no such issue: filed (once) after all.
  const db2 = reproduced(1);
  db2.raw.prepare('UPDATE leads SET filing_started_at = ?').run(NOW);
  const gh2 = issuesApi();
  const third = await step(db2, { mintToken: m.mint, save: async () => true, client: { ...client, fetch: gh2.api.fetch } });
  assert.deepEqual([third.refiled, third.filed, gh2.issues.length], [1, 1, 1]);
});

test('R-LEAD-28: a lead that closes after clean re-checks closes its issue with a comment; one that comes back reopens it; a repository that refuses the label still gets the issue', async () => {
  const db = reproduced(1);
  const { api, issues, comments } = issuesApi({ refuseLabel: true });
  const m = minter();
  const client = { fetch: api.fetch, apiUrl: API, sleep: async () => {} };
  assert.equal((await step(db, { mintToken: m.mint, save: async () => true, client })).filed, 1);
  assert.deepEqual(issues[0].labels, [], 'filed without the label after a 422');
  // The fix: three clean re-checks of the one server that carried it.
  let t = T0 + 3 * HOUR;
  for (let r = 100; r < 100 + CLEAN_RECHECKS_TO_CLOSE; r++) accept(db, { subject: 'acme-org/server-0-0', failures: [], runId: r, now: (t += HOUR) });
  assert.deepEqual([db.listLeads()[0].status, db.listLeads()[0].needs_sync], ['closed', 1]);
  const closed = await step(db, { mintToken: m.mint, save: async () => true, client, now: () => t + HOUR });
  assert.equal(closed.closed, 1);
  assert.equal(issues[0].state, 'closed');
  assert.match(comments[0].body, /re-checked this 3 times without seeing it/);
  assert.equal(db.listLeads()[0].needs_sync, 0);
  // It comes back.
  accept(db, { subject: 'acme-org/server-0-0', failures: [lead(0)], runId: 200, now: (t += HOUR) });
  assert.equal(db.listLeads()[0].status, 'filed');
  const reopened = await step(db, { mintToken: m.mint, save: async () => true, client, now: () => t + HOUR });
  assert.equal(reopened.reopened, 1);
  assert.equal(issues[0].state, 'open');
  assert.equal(issues.length, 1, 'the same issue, never a second one');
});

test('R-LEAD-28: at most MAX_WRITES issue writes per run; the rest wait for the next run; a GitHub failure is counted, never thrown', async () => {
  const db = reproduced(4);
  const { api, issues } = issuesApi();
  const m = minter();
  const note = await step(db, { mintToken: m.mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} }, maxWrites: 2 });
  assert.equal(note.filed, 2);
  assert.equal(issues.length, 2);
  const broken = fakeApi([['*', /.*/, () => ({ status: 500, body: { message: 'boom' } })]]);
  const db2 = reproduced(1);
  const n2 = await step(db2, { mintToken: m.mint, save: async () => true, client: { fetch: broken.fetch, apiUrl: API, sleep: async () => {}, maxAttempts: 1 } });
  assert.deepEqual([n2.filed, n2.errors > 0], [0, true]);
  assert.ok(db2.listLeads()[0].filing_started_at, 'left marked: the next run looks it up first');
});

test('R-LEAD-25: the step files nothing the shape guard holds, and a held lead takes no filing slot', async () => {
  const db = reproduced(1, { over: () => ({ signature: 'class=tool_error;detail=-;error=widgetfail;list_error=-;http=-;fault=tool;retryable=false' }) });
  db.setSubjectVersion({ id: 'widgetfail/server', kind: 'repo', source: 'test', tier: 2, sha: 'a'.repeat(40), now: T0 });
  const { api, issues } = issuesApi();
  const m = minter();
  const note = await step(db, { mintToken: m.mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } });
  assert.deepEqual([note.filed, issues.length, note.planned], [0, 0, 0]);
  assert.ok(note.held >= 1);
});

test('R-LEAD-30: an issue filed without its label (the repository refused it) is still adopted by its title tag, never filed twice; a pull request with the tag is not an issue; a failed comment does not repeat the close', async () => {
  const db = reproduced(1);
  const [l] = db.listLeads();
  const { api, issues, comments } = issuesApi({
    existing: [
      { number: 1, title: `${titleTag(l.fingerprint)} a pull request`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: 'open', labels: [], pull_request: { url: 'x' }, user: { login: BOT } },
      { number: 2, title: `${titleTag(l.fingerprint)} no_tools_found in scan-static static`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: 'open', labels: [], user: { login: BOT } },
    ],
  });
  db.raw.prepare('UPDATE leads SET filing_started_at = ? WHERE fingerprint = ?').run(NOW, l.fingerprint);
  const m = minter();
  const client = { fetch: api.fetch, apiUrl: API, sleep: async () => {} };
  const note = await step(db, { mintToken: m.mint, save: async () => true, client });
  assert.deepEqual([note.adopted, note.filed, issues.length], [1, 0, 2]);
  assert.equal(db.listLeads()[0].issue_number, 2);

  // Close: the state is set first; a comment that fails is logged and not tried again.
  db.raw.prepare("UPDATE leads SET status = 'closed', needs_sync = 1, clean_rechecks = 3, issue_state = 'open' WHERE fingerprint = ?").run(l.fingerprint);
  const failingComments = fakeApi([
    ['POST', /\/comments$/, () => ({ status: 500, body: { message: 'boom' } })],
    ...api.routes,
  ]);
  const lines = [];
  const c1 = await step(db, { mintToken: m.mint, save: async () => true, client: { ...client, fetch: failingComments.fetch, maxAttempts: 1 }, log: (x) => lines.push(x) });
  assert.equal(c1.closed, 1);
  assert.equal(issues[1].state, 'closed');
  assert.ok(lines.some((x) => /its comment failed/.test(x)));
  const c2 = await step(db, { mintToken: m.mint, save: async () => true, client });
  assert.equal(c2.closed, 0, 'not closed (or commented) again');
  assert.equal(comments.length, 0);
});

test('R-LEAD-40: no issue or job summary can single out a server: a tier breakdown only with 5 or more carriers, and never the priority', async () => {
  const small = planFilings(reproduced(1, { subjectsPer: () => 1 }), { now: NOW, tierWeights }).file[0];
  const body = issueFor(small, { now: NOW }).body;
  assert.match(body, /1 server carries it on its latest result; seen/);
  assert.ok(!/\bT[0-4]\b/.test(body) && !/priority/i.test(body));
  const md = renderPlan(planFilings(reproduced(2), { now: NOW, tierWeights }), { now: NOW, mode: 'dry-run' });
  assert.ok(!/priority/i.test(md), 'the job summary has no priority column');
  assert.ok(!/\bT[0-4]\b/.test(md));
});

test('R-LEAD-41: adoption takes only our App\'s issue with the lead\'s marker: an issue anyone else opened with the same title tag is never adopted', async () => {
  const db = reproduced(1);
  const [l] = db.listLeads();
  const { api, issues } = issuesApi({
    existing: [
      { number: 1, title: `${titleTag(l.fingerprint)} copied by someone`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: 'open', labels: [], user: { login: 'someone' } },
      { number: 2, title: `${titleTag(l.fingerprint)} by our App, no marker`, body: 'text', state: 'open', labels: [], user: { login: BOT } },
    ],
  });
  db.raw.prepare('UPDATE leads SET filing_started_at = ? WHERE fingerprint = ?').run(NOW, l.fingerprint);
  const note = await step(db, { mintToken: minter().mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } });
  assert.deepEqual([note.adopted, note.refiled, note.filed], [0, 1, 1]);
  assert.equal(db.listLeads()[0].issue_number, 3, 'filed as a new issue of ours');
  assert.equal(issues[2].user.login, BOT);
});

test('R-LEAD-42: the shape guard runs before the daily room is handed out, field by field: a held lead takes no slot, and a subject named like a public SDK repository holds no lead', () => {
  const db = reproduced(7, { over: (i) => (i === 6 ? { signature: 'class=tool_error;detail=-;error=widgetfail;list_error=-;http=-;fault=tool;retryable=false' } : {}) });
  db.setSubjectVersion({ id: 'modelcontextprotocol/go-sdk', kind: 'repo', source: 'test', tier: 1, sha: 'a'.repeat(40), now: T0 });
  const plan = planFilings(db, { now: NOW, tierWeights });
  assert.equal(plan.file.length, CAP_NEW_PER_REPO_PER_DAY, 'the held lead (the most carried) did not take a slot');
  assert.ok(plan.held.some((e) => e.decision.reason === 'not_shape_only' && e.carriers.current === 7));
  const go = { ...plan.file[0], lead: { ...plan.file[0].lead, idiom: 'source/derived/go' } };
  assert.match(issueFor(go, { now: NOW }).body, /modelcontextprotocol\/go-sdk/, 'the Go template names the SDK');
  assert.doesNotThrow(() => assertShapeOnly(go.lead, { subjects: ['modelcontextprotocol/go-sdk'] }), 'template text is ours: not checked');
});

test('R-LEAD-43: before closing or reopening, the issue is read: one a person closed or reopened, or one our App did not open, is left as it is', async () => {
  for (const [humanState, author, want] of [['closed', BOT, 'closed'], ['open', 'someone', 'open']]) {
    const db = reproduced(1);
    const [l] = db.listLeads();
    const { api, issues, comments } = issuesApi({ existing: [{ number: 1, title: `${titleTag(l.fingerprint)} x`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: humanState, labels: [], user: { login: author } }] });
    // The lead closed by itself while we recorded the issue as open; a person may have closed it already, or it is not ours.
    db.raw.prepare("UPDATE leads SET status = 'closed', issue_number = 1, issue_state = 'open', needs_sync = 1 WHERE fingerprint = ?").run(l.fingerprint);
    if (author === BOT) {
      // A person closed it, then the lead came back: we must not reopen what they closed.
      db.raw.prepare("UPDATE leads SET status = 'filed', issue_state = 'open', needs_sync = 1 WHERE fingerprint = ?").run(l.fingerprint);
    }
    const lines = [];
    const note = await step(db, { mintToken: minter().mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} }, log: (x) => lines.push(x) });
    assert.deepEqual([note.closed, note.reopened, comments.length], [0, 0, 0], `${humanState}/${author}`);
    assert.equal(issues[0].state, want, 'left as it is');
    assert.equal(db.listLeads()[0].needs_sync, 0);
    assert.ok(lines.some((x) => /left as it is/.test(x)));
  }
});

test('R-LEAD-44: each write guard alone holds the cap: only the leads that fit are marked, and a label retry is a write of its own', async () => {
  // The selection guard: with room for 2 writes, only 2 of 4 leads are marked; the others are not left in doubt.
  const db = reproduced(4);
  const a = issuesApi();
  const n1 = await step(db, { mintToken: minter().mint, save: async () => true, client: { fetch: a.api.fetch, apiUrl: API, sleep: async () => {} }, maxWrites: 2 });
  assert.equal(n1.filed, 2);
  assert.equal(db.listLeads().filter((l) => l.filing_started_at).length, 0, 'none left marked');
  // The write guard: each create costs two writes when the label is refused; with 3 writes the second create stops.
  const db2 = reproduced(2);
  const b = issuesApi({ refuseLabel: true });
  const n2 = await step(db2, { mintToken: minter().mint, save: async () => true, client: { fetch: b.api.fetch, apiUrl: API, sleep: async () => {} }, maxWrites: 3 });
  const posts = b.api.calls.filter((c) => c.method === 'POST' && /\/issues$/.test(c.path)).length;
  assert.ok(posts <= 3, `at most 3 issue writes, made ${posts}`);
  assert.equal(n2.filed, 1);
  assert.ok(n2.writes <= 3);
});

test('R-LEAD-40: a tier is named only with 5 or more carriers in it; smaller tiers fold into "other tiers", so one T0 server inside a 5-carrier lead is never shown', () => {
  const db = reproduced(1, { subjectsPer: () => 5 });
  db.raw.prepare("UPDATE subjects SET tier = 0 WHERE id = 'acme-org/server-0-0'").run();
  db.raw.prepare("UPDATE subjects SET tier = 4 WHERE id LIKE 'acme-org/server-0-%' AND id != 'acme-org/server-0-0'").run();
  const [e] = planFilings(db, { now: NOW, tierWeights }).file;
  const body = issueFor(e, { now: NOW }).body;
  assert.match(body, /5 servers carry it on their latest result; seen/, 'no tier has 5: no breakdown at all');
  assert.ok(!/\bT[0-4]\b/.test(body), body.match(/\*\*Counts\.\*\*.*/)?.[0]);
  const big = reproduced(1, { subjectsPer: () => 6 });
  big.raw.prepare("UPDATE subjects SET tier = 0 WHERE id = 'acme-org/server-0-0'").run();
  const [e2] = planFilings(big, { now: NOW, tierWeights }).file;
  assert.match(issueFor(e2, { now: NOW }).body, /6 servers carry it on their latest result \(T2: 5, other tiers: 1\)/);
});

test('R-LEAD-44: a close or reopen needs room for both its writes: with one write left it waits for the next run', async () => {
  const db = reproduced(1);
  const [l] = db.listLeads();
  const { api, issues, comments } = issuesApi({ existing: [{ number: 1, title: `${titleTag(l.fingerprint)} x`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: 'open', labels: [], user: { login: BOT } }] });
  db.raw.prepare("UPDATE leads SET status = 'closed', issue_number = 1, issue_state = 'open', needs_sync = 1 WHERE fingerprint = ?").run(l.fingerprint);
  const client = { fetch: api.fetch, apiUrl: API, sleep: async () => {} };
  const n1 = await step(db, { mintToken: minter().mint, save: async () => true, client, maxWrites: 1 });
  assert.deepEqual([n1.closed, issues[0].state, comments.length, db.listLeads()[0].needs_sync], [0, 'open', 0, 1]);
  const n2 = await step(db, { mintToken: minter().mint, save: async () => true, client, maxWrites: 2 });
  assert.deepEqual([n2.closed, issues[0].state, comments.length, n2.writes], [1, 'closed', 1, 2]);
});

test('R-LEAD-46: a person\'s "not planned" close stands: a lead that comes back does not reopen it', async () => {
  const db = reproduced(1);
  const [l] = db.listLeads();
  const { api, issues, comments } = issuesApi({ existing: [{ number: 1, title: `${titleTag(l.fingerprint)} x`, body: `<!-- tool-qa lead ${l.fingerprint} -->`, state: 'closed', state_reason: 'not_planned', labels: [], user: { login: BOT } }] });
  // We closed it (completed); a person then marked it not planned; the lead came back.
  db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = 1, issue_state = 'closed', needs_sync = 1 WHERE fingerprint = ?").run(l.fingerprint);
  const lines = [];
  const note = await step(db, { mintToken: minter().mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} }, log: (x) => lines.push(x) });
  assert.deepEqual([note.reopened, issues[0].state, comments.length, db.listLeads()[0].needs_sync], [0, 'closed', 0, 0]);
  assert.ok(lines.some((x) => /not planned/.test(x)));
  // Closed as completed (by us), the same comeback reopens it.
  issues[0].state_reason = 'completed';
  db.raw.prepare('UPDATE leads SET needs_sync = 1 WHERE fingerprint = ?').run(l.fingerprint);
  assert.equal((await step(db, { mintToken: minter().mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } })).reopened, 1);
});

test('R-LEAD-49: every run with the pipeline on logs one status line (counts and our reason codes only), even with nothing to file; off logs nothing', async () => {
  for (const mode of ['dry-run', 'recheck', 'on']) {
    const db = reproduced(2);
    // One lead still waits for its re-check.
    db.raw.prepare('UPDATE leads SET reproduced_at = NULL WHERE fingerprint = (SELECT MIN(fingerprint) FROM leads)').run();
    db.setKv('leads.recheck', { at: NOW, mode, due: 1, waiting: 1, given_up: 0 }, { now: NOW });
    const lines = [];
    const { api } = issuesApi();
    await step(db, { mode, log: (l) => lines.push(l), mintToken: minter().mint, save: async () => true, client: { fetch: api.fetch, apiUrl: API, sleep: async () => {} } });
    const status = lines.filter((l) => l.startsWith(`leads: ${mode}: `));
    assert.equal(status.length, 1, `${mode}: ${lines.join(' | ')}`);
    assert.match(status[0], /2 open|1 open/);
    assert.match(status[0], /held \(recheck_pending 1\)/);
    assert.match(status[0], /re-checks due 1, waiting 1, given up 0/);
    assert.ok(!/acme|server-/.test(status[0]), 'no subject name');
  }
  const off = reproduced(1);
  const lines = [];
  await step(off, { mode: 'off', log: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});
