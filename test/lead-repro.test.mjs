// lead-repro (leads/repro.mjs, leads/repro-run.mjs, leads/repro-gate.mjs, scripts/lead-repro.mjs) and what the lead
// step does with it (leads/step.mjs): an issue shows a synthetic repro only when it was run and reproduced; the caps
// come from bounded variables; writes back off on a rate limit; the reader's construct kind reaches the fingerprint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openState } from '../state/db.mjs';
import { CAP_BOUNDS, capsFrom } from '../state/leads.mjs';
import { CONSTRUCT_KINDS, constructsOf, failuresOf, leadKeyOf } from '../state/fingerprint.mjs';
import { issueFor, planFilings } from '../leads/plan.mjs';
import { controlFiles, DEPS, filesFromBody, NOT_CHECKED, NOT_CONFIRMED, NPM_DEPS, PY_MCP, pinsFor, reproKey, reproSpec, shapeFromBody, syntheticRepro, TEMPLATES, WRITECHECK_START_CAVEAT } from '../leads/repro.mjs';
import { runRepro, verdictOf } from '../leads/repro-run.mjs';
import { FINAL, leadInput, MAX_ARTIFACT_BYTES, MAX_DISPATCHES, MAX_LOOKUPS, REPRO_KV, REPRO_MAX_TRIES, REPRO_RETRY_MS, REPRO_STUCK_RETRY_MS, reproVerdicts, trustedArtifact, trustedRun, verdictFromArtifact } from '../leads/repro-gate.mjs';
import { leadStep } from '../leads/step.mjs';
import { leadsCheck } from '../watchdog/leads.mjs';
import { InputProblem, parseInputs } from '../scripts/lead-repro.mjs';
import { makeZip } from './archive-fixtures.mjs';

const T0 = Date.parse('2026-11-28T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(T0 + 2 * HOUR).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tierWeights = JSON.parse(readFileSync(new URL('../pump/tiers.json', import.meta.url), 'utf8')).weights;
const workflows = JSON.parse(readFileSync(new URL('../pump/workflows.json', import.meta.url), 'utf8')).workflows;

const readerLead = (over = {}) => ({
  fingerprint: 'bee256dbce94', tool: 'mcp-check', lane: 'scan-static', component: 'static', oracle: 'scan-static', class: 'reader_limit',
  idiom: 'source/derived/repo:ts/js', layout: 'server_json:1;via:github', signature: 'class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions',
  partial: true, fault: 'tool', versions: ['mcp-check@b4638046c2a91e15d64395822c1cfb26970cabae'], ...over,
});
const startLead = (over = {}) => ({
  fingerprint: 'dc077505461e', tool: 'mcp-writecheck', lane: 'writecheck', component: 'init', oracle: 'writecheck', class: 'timeout_start',
  idiom: 'none/repo:ts/js', layout: 'unknown', signature: 'class=timeout_start;detail=-;error=-;list_error=-;http=-;fault=tool;retryable=false', partial: false, fault: 'tool', versions: [], ...over,
});
const sizeLead = (over = {}) => ({
  fingerprint: '519dd78ae5cb', tool: 'tool-qa-release-diff', lane: 'release-diff', component: 'source', oracle: 'release-diff', class: 'too_large',
  idiom: 'none/repo:python', layout: 'unknown', signature: 'class=too_large;detail=-;error=-;list_error=-;http=-;fault=tool;retryable=false', partial: false, fault: 'tool', versions: [], ...over,
});

// ------------------------------------------------------------------ what an issue shows

test('R-LEAD-54: an issue shows the fixture only with a reproduced verdict; otherwise one plain line and no fixture', () => {
  const l = readerLead();
  const shown = syntheticRepro(l, { verdict: { verdict: 'reproduced', run_id: 7, key: 'k', tool: 'mcp-check@abc' } });
  assert.match(shown, /Confirmed: tool-qa lead-repro run 7/);
  assert.match(shown, /ECHO_DESCRIPTION/);
  assert.match(shown, /```ts/);
  assert.equal(syntheticRepro(l, { verdict: { verdict: 'not_reproduced' } }), NOT_CONFIRMED);
  assert.equal(NOT_CONFIRMED, 'Synthetic repro: not confirmed (our template did not trigger it); evidence is the real-server re-check below.');
  assert.equal(syntheticRepro(l), NOT_CHECKED);
  assert.equal(syntheticRepro(l, { verdict: { verdict: 'error' } }), NOT_CHECKED);
  assert.match(syntheticRepro(readerLead({ lane: 'live-probe', component: 'start', class: 'timeout_start' })), /no template of ours can trigger this class: the live-probe lane installs/);
  for (const text of [syntheticRepro(l, { verdict: { verdict: 'not_reproduced' } }), syntheticRepro(l)]) assert.ok(!/```/.test(text), 'no fixture without a reproduced verdict');
});

test('R-LEAD-54: the issue body has the loop\'s evidence (counts, re-check, 14-day rate, clean re-checks, versions) and round-trips to its shape and fixture', () => {
  const l = { ...readerLead(), repo: 'isokron-ai/mcp-check', status: 'open', sightings: 13, first_seen: '2026-11-28T01:00:00Z', last_seen: '2026-11-28T02:00:00Z', reproduced_at: '2026-11-28T02:00:00Z', clean_rechecks: 1, reopened: 0 };
  const e = { lead: l, carriers: { current: 11, byTier: { T3: 11 }, weight: 1 }, flake: { hits: 13, total: 14, flaky: false }, decision: { file: true, reason: 'reproduced' } };
  const ok = { state: 'ready', key: 'k', verdict: { verdict: 'reproduced', run_id: 1, key: 'k' } };
  const body = issueFor(e, { now: NOW, repro: ok, recheckRunner: 'ubuntu-24.04-arm' }).body;
  assert.match(body, /### Evidence \(real servers\)/);
  assert.match(body, /11 servers carry it on their latest result \(T3: 11\); seen 13 times/);
  assert.match(body, /Reproduced 2026-11-28 by another worker run of the same server and lane, on a `ubuntu-24\.04-arm` runner/);
  assert.match(body, /13 of 14 results of the servers that carried it showed it/);
  assert.match(body, /\*\*Clean re-checks\.\*\* 1 so far; 3 close it/);
  assert.match(body, /\*\*Tool versions seen\.\*\* mcp-check@b4638046/);
  const back = shapeFromBody(body);
  for (const k of ['fingerprint', 'tool', 'lane', 'component', 'oracle', 'class', 'idiom', 'layout', 'signature']) assert.equal(back[k], l[k], k);
  assert.deepEqual(filesFromBody(body), reproSpec(l).files, 'the fixture shown is the template, byte for byte');
  assert.deepEqual(filesFromBody(issueFor(e, { now: NOW, repro: { state: 'ready', key: 'k', verdict: { verdict: 'not_reproduced' } } }).body), []);
  assert.equal(shapeFromBody('no marker'), null);
  assert.deepEqual(filesFromBody('### Synthetic repro\n\n`../x`\n\n```ts\nbad\n```\n'), [], 'no path outside the fixture');
});

// ------------------------------------------------------------------ templates

test('R-LEAD-55: templates are built to trigger the classes the old ones could not: a start-window server with a read/update pair, a release with an over-the-cap entry', () => {
  const s = reproSpec(startLead());
  assert.equal(s.runner, 'writecheck-init');
  const src = new Map(s.files).get('src/index.ts');
  assert.match(src, /START_UP_MS = 60_000/);
  assert.match(src, /registerTool\("get_note"/);
  assert.match(src, /registerTool\("update_note"/);
  assert.ok(src.indexOf('await sleep(START_UP_MS)') < src.indexOf('await import("@modelcontextprotocol/sdk'), 'the delay comes before the SDK is loaded');
  const ctl = new Map(controlFiles(s)).get('src/index.ts');
  assert.ok(!/sleep/.test(ctl) && /update_note/.test(ctl), 'the control is the same server without the delay');
  const r = reproSpec(sizeLead());
  assert.equal(r.runner, 'release-diff');
  assert.deepEqual(r.release.over_cap, { where: 'source', path: 'data/blob.bin', declared_bytes: 5 * 1024 ** 3 });
  assert.ok(r.release.over_cap.declared_bytes > 4 * 1024 ** 3, 'over release-diff\'s 4 GiB source cap');
  assert.equal(reproSpec(readerLead({ lane: 'meta-github' })).synthesizable, false);
  assert.equal(reproSpec(startLead({ component: 'install' })).synthesizable, false);
  assert.equal(reproSpec(sizeLead({ class: 'rate_limited' })).synthesizable, false);
  // The key follows the template, the pins and the lead's class and signature, nothing else.
  const pins = pinsFor('scan-static', workflows);
  assert.equal(reproKey(readerLead(), reproSpec(readerLead()), pins), reproKey(readerLead({ fingerprint: '000000000000', versions: [] }), reproSpec(readerLead()), pins));
  assert.notEqual(reproKey(readerLead(), reproSpec(readerLead()), pins), reproKey(readerLead(), reproSpec(readerLead()), { 'mcp-check': 'other' }));
});

test('R-LEAD-55: release-diff on the release template stops at the source archive as too_large, with the lead\'s exact signature; the plain release does not', async () => {
  const l = sizeLead();
  const s = reproSpec(l);
  const v = await runRepro(l, s.files, s, { releaseDiffPin: pinsFor('release-diff', workflows)['release-diff'] });
  assert.equal(v.verdict, 'reproduced', JSON.stringify(v).slice(0, 500));
  assert.deepEqual(v.detail.skips, [{ stage: 'source', reason: 'too_large', fault: 'tool' }]);
  const plain = await runRepro(l, s.files, { ...s, release: null }, { releaseDiffPin: pinsFor('release-diff', workflows)['release-diff'] });
  assert.equal(plain.verdict, 'not_reproduced');
  assert.equal((await runRepro(l, s.files, s, { releaseDiffPin: '0.0.0' })).verdict, 'error', 'another pin than the code here is an error, never a verdict');
});

test('R-LEAD-55: the writecheck runner counts nothing unless its control (the template without the delay) passes init', async () => {
  // A stand-in for the action's skip rules and for the CLI: the CLI exits as FAKE_INIT says for the control and the fixture.
  const root = mkdtempSync(join(tmpdir(), 'lead-repro-wc-'));
  mkdirSync(join(root, 'loop'));
  writeFileSync(join(root, 'loop', 'skips.mjs'), `export const stagesRan = (steps) => Object.fromEntries(steps.map((s) => [s.step, !s.timed_out && [0, 1].includes(s.exit)]));
export function itemSkips({ stages }) { return { skips: stages.init ? [] : [{ stage: 'init', reason: 'timeout_start', fault: 'tool' }], notes: {} }; }
`);
  const cli = join(root, 'cli.mjs');
  writeFileSync(cli, `import { readFileSync } from 'node:fs';
const src = readFileSync('src/index.ts', 'utf8');
process.exit(/sleep/.test(src) ? Number(process.env.FAKE_FIXTURE_EXIT) : Number(process.env.FAKE_CONTROL_EXIT));
`);
  const l = startLead();
  // no package.json in these copies: nothing to install
  const s = reproSpec(l);
  const files = s.files.filter(([p]) => p !== 'package.json');
  const tools = { cliMain: cli, cliCommit: 'a'.repeat(40), actionDir: root, actionCommit: 'b'.repeat(40) };
  const spec = { ...s, files };
  const withControl = async (control, fixture) => {
    process.env.FAKE_CONTROL_EXIT = String(control);
    process.env.FAKE_FIXTURE_EXIT = String(fixture);
    const { runWritecheckInit } = await import('../leads/repro-run.mjs');
    return runWritecheckInit(l, files, spec, tools, { controlFiles: () => controlFiles(s).filter(([p]) => p !== 'package.json') });
  };
  assert.equal((await withControl(4, 4)).verdict, 'error', 'a control that fails init: the harness says nothing');
  const ok = await withControl(0, 4);
  assert.equal(ok.verdict, 'reproduced');
  assert.equal((await withControl(0, 0)).verdict, 'not_reproduced');
});

test('R-LEAD-55: verdictOf needs the lead\'s class, component and signature together', () => {
  const l = readerLead();
  const f = { fingerprint: 'x', class: l.class, component: l.component, signature: l.signature };
  assert.equal(verdictOf(l, [f]).verdict, 'reproduced');
  assert.equal(verdictOf(l, [{ ...f, signature: `${l.signature};construct=call` }]).verdict, 'not_reproduced');
  assert.equal(verdictOf(l, [{ ...f, component: 'live' }]).verdict, 'not_reproduced');
  assert.equal(verdictOf(l, []).verdict, 'not_reproduced');
});

// ------------------------------------------------------------------ the pump's gate

const RUN_OK = { id: 9, path: '.github/workflows/lead-repro.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'isokron-ai/tool-qa' }, head_repository: { full_name: 'isokron-ai/tool-qa' } };
function gateWorld({ artifacts = [], zips = {}, lengths = {}, failDispatch = false, run = RUN_OK } = {}) {
  const calls = [];
  const client = {
    async request(method, path, o = {}) {
      calls.push({ method, path, o });
      if (method === 'GET' && path.endsWith('/actions/artifacts')) return { status: 200, data: { artifacts: artifacts.filter((a) => a.name === o.query.name) } };
      if (method === 'GET' && /\/actions\/runs\/\d+$/.test(path)) return { status: 200, data: { ...run, id: Number(path.split('/').pop()) } };
      if (method === 'GET' && /\/actions\/artifacts\/\d+\/zip$/.test(path)) return { status: 302, headers: new Headers({ location: `https://blob.test/${path.split('/').at(-2)}` }), data: null };
      if (method === 'POST' && path.endsWith('/dispatches')) { if (failDispatch) throw Object.assign(new Error(`HTTP ${failDispatch}`), { status: failDispatch }); return { status: 204, data: null }; }
      throw new Error(`no route ${method} ${path}`);
    },
  };
  const fetch = async (url) => { const id = String(url).split('/').pop(); return new Response(zips[id] ?? Buffer.alloc(0), { status: 200, headers: lengths[id] ? { 'content-length': String(lengths[id]) } : {} }); };
  return { client, fetch, calls };
}
const artifactOf = (id, key, doc, run = {}) => ({ id, name: `lead-repro-${key}`, size_in_bytes: 100, expired: false, created_at: '2026-11-28T11:00:00Z', workflow_run: { id: 9, repository_id: 1, head_repository_id: 1, head_branch: 'main', ...run } });
const zipOf = (key, verdict, over = {}) => makeZip([{ name: 'lead-repro.json', data: JSON.stringify({ format: 'isokron-lead-repro/1', run_id: 46102904712, results: [{ key, verdict, tool: 'mcp-check@abc', fingerprint: 'bee256dbce94', ...over }] }) }]);

test('R-LEAD-56: the gate reads a verdict back from a main-branch run of tool-qa itself, and never from a pull request or a fork', async () => {
  const l = readerLead();
  const key = reproKey(l, reproSpec(l), pinsFor('scan-static', workflows));
  assert.deepEqual(verdictFromArtifact(zipOf(key, 'reproduced'), key), { verdict: 'reproduced', run_id: 46102904712, tool: 'mcp-check@abc', why: null });
  assert.equal(verdictFromArtifact(zipOf('other', 'reproduced'), key), null, 'a result for another key is not this one\'s');
  assert.equal(verdictFromArtifact(zipOf(key, 'great'), key), null, 'an unknown verdict is nothing');
  assert.equal(trustedArtifact(artifactOf(1, key, null, { head_branch: 'leads/x' })), false);
  assert.equal(trustedArtifact(artifactOf(1, key, null, { head_repository_id: 2 })), false, 'a fork\'s run');
  assert.equal(trustedArtifact({ ...artifactOf(1, key), expired: true }), false);
  // The run itself must be lead-repro.yml, started by workflow_dispatch on main of tool-qa (one GET of the run).
  assert.equal(trustedRun({ ...RUN_OK, id: 8 }, artifactOf(1, key)), false, 'another run id');
  assert.equal(trustedRun(RUN_OK, artifactOf(1, key)), true);
  for (const bad of [{ path: '.github/workflows/test.yml' }, { event: 'pull_request' }, { event: 'push' }, { head_branch: 'x' }, { head_repository: { full_name: 'someone/tool-qa' } }]) {
    assert.equal(trustedRun({ ...RUN_OK, ...bad }, artifactOf(1, key)), false, JSON.stringify(bad));
  }
  for (const [run, want, wrun] of [[{}, 'reproduced'], [{ head_branch: 'leads/x' }, null], [{ head_repository_id: 2 }, null], [{}, null, { ...RUN_OK, path: '.github/workflows/other.yml' }], [{}, null, { ...RUN_OK, event: 'pull_request' }]]) {
    const db = openState(':memory:');
    const w = gateWorld({ artifacts: [artifactOf(5, key, null, run)], zips: { 5: zipOf(key, 'reproduced') }, run: wrun ?? RUN_OK });
    const out = await reproVerdicts({ db, leads: [l], workflows, now: T0, client: w.client, fetch: w.fetch });
    const v = out.get(l.fingerprint);
    if (want) { assert.equal(v.state, 'ready'); assert.equal(v.verdict.verdict, want); assert.equal(db.getKv(REPRO_KV)[key].verdict, want, 'kept in the state'); }
    else { assert.equal(v.state, 'pending', JSON.stringify(run)); assert.ok(w.calls.some((c) => c.method === 'POST'), 'dispatched instead'); assert.ok(!w.calls.some((c) => /\/zip$/.test(c.path)), 'never downloaded'); }
  }
});

test('R-LEAD-61: an artifact over 1 MiB is never downloaded, a download over it is refused, and tool and why reach the issue only as plain short text', async () => {
  const l = readerLead();
  const key = reproKey(l, reproSpec(l), pinsFor('scan-static', workflows));
  const big = { ...artifactOf(5, key), size_in_bytes: MAX_ARTIFACT_BYTES + 1 };
  assert.equal(trustedArtifact(big), false);
  const w = gateWorld({ artifacts: [big], zips: { 5: zipOf(key, 'reproduced') } });
  assert.equal((await reproVerdicts({ db: openState(':memory:'), leads: [l], workflows, now: T0, client: w.client, fetch: w.fetch })).get(l.fingerprint).state, 'pending');
  assert.ok(!w.calls.some((c) => /\/zip$/.test(c.path)));
  // A download larger than the listing said: refused.
  const w2 = gateWorld({ artifacts: [artifactOf(5, key)], zips: { 5: Buffer.concat([zipOf(key, 'reproduced'), Buffer.alloc(MAX_ARTIFACT_BYTES)]) } });
  assert.equal((await reproVerdicts({ db: openState(':memory:'), leads: [l], workflows, now: T0, client: w2.client, fetch: w2.fetch })).get(l.fingerprint).state, 'pending');
  // A download whose length says it is over the cap is refused before its body is read, though the zip itself is good.
  const w3 = gateWorld({ artifacts: [artifactOf(5, key)], zips: { 5: zipOf(key, 'reproduced') }, lengths: { 5: MAX_ARTIFACT_BYTES + 1 } });
  assert.equal((await reproVerdicts({ db: openState(':memory:'), leads: [l], workflows, now: T0, client: w3.client, fetch: w3.fetch })).get(l.fingerprint).state, 'pending');
  for (const bad of ['mcp-check@abc\n## injected', 'mcp-check@abc | x', '[link](http://x)', 'x'.repeat(301)]) {
    assert.equal(verdictFromArtifact(zipOf(key, 'reproduced', { tool: bad }), key).tool, null, JSON.stringify(bad));
    assert.equal(verdictFromArtifact(zipOf(key, 'reproduced', { why: bad }), key).why, null, JSON.stringify(bad));
  }
  assert.equal(verdictFromArtifact(zipOf(key, 'not_reproducible_synthetically', { why: 'the `live-probe` lane installs a registry package' }), key).why, 'the `live-probe` lane installs a registry package');
});

test('R-LEAD-56: with no verdict the gate dispatches lead-repro with the lead\'s shape only, waits, sends again after the retry gap, and ends stuck (never filed) when its tries are spent', async () => {
  const l = { ...readerLead(), repo: 'isokron-ai/mcp-check', recheck_subject: 'acme/secret-server', sightings: 3 };
  const db = openState(':memory:');
  const w = gateWorld();
  const first = await reproVerdicts({ db, leads: [l], workflows, now: T0, client: w.client, fetch: w.fetch });
  assert.equal(first.get(l.fingerprint).state, 'pending');
  const d = w.calls.find((c) => c.method === 'POST');
  assert.equal(d.path, '/repos/isokron-ai/tool-qa/actions/workflows/lead-repro.yml/dispatches');
  assert.equal(d.o.body.ref, 'main');
  assert.deepEqual(Object.keys(d.o.body.inputs), ['lead']);
  assert.deepEqual(Object.keys(JSON.parse(d.o.body.inputs.lead)).sort(), ['class', 'component', 'fingerprint', 'idiom', 'lane', 'layout', 'oracle', 'signature', 'tool']);
  assert.ok(!d.o.body.inputs.lead.includes('acme'), 'no subject in the dispatch');
  assert.equal(leadInput(l), d.o.body.inputs.lead);
  // Inside the retry gap: no second dispatch.
  const w2 = gateWorld();
  await reproVerdicts({ db, leads: [l], workflows, now: T0 + REPRO_RETRY_MS - 1, client: w2.client, fetch: w2.fetch });
  assert.equal(w2.calls.filter((c) => c.method === 'POST').length, 0);
  const w3 = gateWorld();
  await reproVerdicts({ db, leads: [l], workflows, now: T0 + REPRO_RETRY_MS, client: w3.client, fetch: w3.fetch });
  assert.equal(w3.calls.filter((c) => c.method === 'POST').length, 1);
  // Fail closed: tries spent with no verdict is stuck, never filed; it is sent again once every REPRO_STUCK_RETRY_MS.
  const w4 = gateWorld();
  await reproVerdicts({ db, leads: [l], workflows, now: T0 + 2 * REPRO_RETRY_MS, client: w4.client, fetch: w4.fetch });
  assert.equal(db.getKv(REPRO_KV)[reproKey(l, reproSpec(l), pinsFor('scan-static', workflows))].tries, REPRO_MAX_TRIES);
  const spent = await reproVerdicts({ db, leads: [l], workflows, now: T0 + 3 * REPRO_RETRY_MS, client: gateWorld().client, fetch: w4.fetch });
  assert.equal(spent.get(l.fingerprint).state, 'stuck');
  const w5 = gateWorld();
  await reproVerdicts({ db, leads: [l], workflows, now: T0 + 2 * REPRO_RETRY_MS + REPRO_STUCK_RETRY_MS, client: w5.client, fetch: w5.fetch });
  assert.equal(w5.calls.filter((c) => c.method === 'POST').length, 1, 'a stuck key is tried again after the long gap');
  // A class no template triggers needs no run.
  const w6 = gateWorld();
  const n = await reproVerdicts({ db: openState(':memory:'), leads: [readerLead({ lane: 'live-probe', component: 'start', class: 'timeout_start' })], workflows, now: T0, client: w6.client, fetch: w6.fetch });
  assert.equal(n.get('bee256dbce94').verdict.verdict, 'not_reproducible_synthetically');
  assert.equal(w6.calls.length, 0);
  assert.ok(FINAL.has('not_reproduced') && !FINAL.has('error'));
});

test('R-LEAD-56: the gate reads at most MAX_LOOKUPS artifacts and sends at most MAX_DISPATCHES dispatches a run', async () => {
  const leads = Array.from({ length: 20 }, (_, i) => readerLead({ fingerprint: sha(`f${i}`).slice(0, 12), signature: `class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions;n=${i}` }));
  const w = gateWorld();
  await reproVerdicts({ db: openState(':memory:'), leads, workflows, now: T0, client: w.client, fetch: w.fetch });
  assert.equal(w.calls.filter((c) => c.method === 'GET').length, MAX_LOOKUPS);
  assert.equal(w.calls.filter((c) => c.method === 'POST').length, MAX_DISPATCHES);
  // A key only waiting for its turn under these bounds is pending, not stuck: nothing is wrong with it.
  const note = {};
  const out = await reproVerdicts({ db: openState(':memory:'), leads, workflows, now: T0, client: gateWorld().client, fetch: w.fetch, note });
  assert.deepEqual([...new Set([...out.values()].map((v) => v.state))], ['pending']);
  assert.deepEqual([note.repro_stuck, note.repro_pending], [0, 20]);
});

test('R-LEAD-60: fail closed: no token, or a dispatch GitHub refuses (403, 5xx), leaves the lead stuck and counted, a try spent, and the watchdog amber', async () => {
  const l = readerLead();
  const key = reproKey(l, reproSpec(l), pinsFor('scan-static', workflows));
  const noTok = {};
  const a = await reproVerdicts({ db: openState(':memory:'), leads: [l], workflows, now: T0, getClient: async () => { throw new Error('no app'); }, note: noTok });
  assert.equal(a.get(l.fingerprint).state, 'stuck');
  assert.deepEqual([noTok.repro_no_token, noTok.repro_stuck], [1, 1]);
  for (const status of [403, 500, 502]) {
    const db = openState(':memory:');
    const note = {};
    const w = gateWorld({ failDispatch: status });
    const v = await reproVerdicts({ db, leads: [l], workflows, now: T0, client: w.client, fetch: w.fetch, note });
    assert.equal(v.get(l.fingerprint).state, 'stuck', `HTTP ${status}`);
    assert.deepEqual([note.repro_dispatch_errors, note.repro_stuck], [1, 1]);
    const rec = db.getKv(REPRO_KV)[key];
    assert.deepEqual([rec.tries, rec.dispatch_error], [1, `HTTP ${status}`], 'a refused dispatch spends a try, so it cannot stall silently');
    // The next run, inside the retry gap, is still stuck (the error is remembered) and sends nothing.
    const w2 = gateWorld();
    assert.equal((await reproVerdicts({ db, leads: [l], workflows, now: T0 + 1, client: w2.client, fetch: w2.fetch })).get(l.fingerprint).state, 'stuck');
    assert.equal(w2.calls.filter((c) => c.method === 'POST').length, 0);
    // A dispatch GitHub takes clears it.
    const w3 = gateWorld();
    assert.equal((await reproVerdicts({ db, leads: [l], workflows, now: T0 + REPRO_RETRY_MS, client: w3.client, fetch: w3.fetch })).get(l.fingerprint).state, 'pending');
  }
  const last = { at: new Date(T0).toISOString(), mode: 'on', errors: 0, open: 1, filed: 0, closed: 0, reopened: 0, filed_total: 0, closed_total: 0 };
  assert.equal(leadsCheck({ now: T0, mode: 'on', last }).status, 'green');
  for (const extra of [{ repro_no_token: 1 }, { repro_dispatch_errors: 2 }, { repro_stuck: 1 }]) {
    const c = leadsCheck({ now: T0, mode: 'on', last: { ...last, ...extra } });
    assert.equal(c.status, 'amber', JSON.stringify(extra));
    assert.match(c.summary, /lead-repro|stuck/);
  }
});

// ------------------------------------------------------------------ the lead step

let seq = 0;
function accept(db, { subject, failures, runId, now }) {
  const key = sha(`run-${++seq}`);
  const att = `att-${seq}`;
  const lease = db.acquireLease(key, att, { ttlMs: DAY, now });
  db.recordRunKey(key, { subject, workflow: 'scan-static', fields: { n: seq }, now });
  db.createDispatch({ attemptId: att, shardId: 's', workflow: 'scan-static', repo: 'o/r', workflowFile: 'f.yml', ref: 'main', expires: now + DAY, items: [{ run_key: key, subject, fence: lease.fence }], now });
  db.setDispatchRun(att, { runId, runUrl: null, correlatedBy: 'test', now });
  return db.recordResult({ run_key: key, attempt_id: att, fence: lease.fence, verdict: 'accepted', outcome: 'accepted', fault: 'tool', coverage: 'unassessed_tool', failures, now: now + 1 });
}
function reproduced(n) {
  const db = openState(':memory:');
  let run = 1;
  for (let i = 0; i < n; i++) {
    const subject = `acme-org/server-${i}`;
    db.setSubjectVersion({ id: subject, kind: 'repo', source: 'test', tier: 2, sha: 'a'.repeat(40), now: T0 - DAY });
    const f = readerLead({ fingerprint: sha(`fp-${i}`).slice(0, 12), signature: `class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions;n=${i}` });
    accept(db, { subject, failures: [f], runId: run++, now: T0 + i });
    accept(db, { subject, failures: [f], runId: run++, now: T0 + HOUR + i });
  }
  return db;
}
const BOT = 'isokron-tool-qa[bot]';
function issuesApi({ refuse = null } = {}) {
  const issues = [];
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (refuse && method !== 'GET') return json(refuse, { message: refuse === 403 ? 'You have exceeded a secondary rate limit' : 'Too Many Requests' });
    if (method === 'POST' && /\/issues$/.test(url.pathname)) { const body = JSON.parse(init.body); const i = { number: issues.length + 1, title: body.title, body: body.body, state: 'open', user: { login: BOT } }; issues.push(i); return json(201, i); }
    if (method === 'GET' && /\/issues\/\d+$/.test(url.pathname)) { const i = issues.find((x) => x.number === Number(url.pathname.split('/').pop())); return i ? json(200, i) : json(404, { message: 'Not Found' }); }
    if (method === 'PATCH' && /\/issues\/\d+$/.test(url.pathname)) { const i = issues.find((x) => x.number === Number(url.pathname.split('/').pop())); Object.assign(i, JSON.parse(init.body)); return json(200, i); }
    if (method === 'GET' && /\/issues$/.test(url.pathname)) return json(200, issues);
    return json(404, { message: 'no route' });
  };
  return { issues, calls, fetch };
}
const notReproduced = async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state: 'ready', key: 'k', verdict: { verdict: 'not_reproduced', key: 'k' } }]));
const step = (db, over = {}) => leadStep({
  db, mode: 'on', tierWeights, now: () => Date.parse(NOW), env: {}, save: async () => true, mintToken: async () => ({ token: 't' }),
  client: { fetch: over.api.fetch, apiUrl: 'https://api.github.test', sleep: async () => {} }, ...over,
});

test('R-LEAD-60: a lead whose repro check is running, stuck, unanswered or failed is not filed and takes no mark; it is filed once the verdict is in', async () => {
  const db = reproduced(2);
  const api = issuesApi();
  const pending = async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state: 'pending', key: 'k', verdict: null }]));
  const n1 = await step(db, { api, reproGate: pending });
  assert.deepEqual([n1.filed, n1.repro_waiting], [0, 2]);
  assert.ok(db.listLeads().every((l) => l.filing_started_at == null && l.issue_number == null), 'nothing marked');
  // Fail closed: stuck, no answer for a lead, or a gate that throws files nothing either.
  const stuck = async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state: 'stuck', key: 'k', verdict: null }]));
  for (const gate of [stuck, async () => new Map(), async () => { throw new Error('boom'); }]) {
    const n = await step(db, { api, reproGate: gate });
    assert.equal(n.filed, 0);
    assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0);
  }
  const thrown = await step(db, { api, reproGate: async () => { throw new Error('boom'); } });
  assert.ok(thrown.repro_stuck >= 1, 'a gate that throws is counted, so the watchdog shows it');
  const ready = (verdict) => async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state: 'ready', key: 'k', verdict: { verdict, run_id: 3, key: 'k' } }]));
  const n2 = await step(db, { api, reproGate: ready('not_reproduced') });
  assert.equal(n2.filed, 2);
  for (const i of api.issues) { assert.ok(i.body.includes(NOT_CONFIRMED)); assert.ok(!i.body.includes('```ts')); }
});

test('R-LEAD-56: an open issue of ours is edited once when its repro verdict changes, and not again while it stays the same', async () => {
  const db = reproduced(1);
  const api = issuesApi();
  const gate = (verdict) => async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state: 'ready', key: 'k1', verdict: { verdict, run_id: 3, key: 'k1' } }]));
  await step(db, { api, reproGate: gate('not_reproduced') });
  assert.equal(api.issues.length, 1);
  const n2 = await step(db, { api, reproGate: gate('not_reproduced') });
  assert.equal(n2.refreshed, 0, 'same verdict: no edit');
  const n3 = await step(db, { api, reproGate: gate('reproduced') });
  assert.equal(n3.refreshed, 1);
  assert.match(api.issues[0].body, /Confirmed: tool-qa lead-repro run 3/);
  assert.equal(api.calls.filter((c) => c.method === 'PATCH').length, 1);
  const reads = () => api.calls.filter((c) => c.method === 'GET' && /\/issues\/\d+$/.test(c.path)).length;
  const before = reads();
  // Even with the counts changed (another sighting), an unchanged verdict means no read and no edit.
  db.raw.prepare('UPDATE leads SET sightings = sightings + 1').run();
  const n4 = await step(db, { api, reproGate: gate('reproduced') });
  assert.equal(n4.refreshed, 0);
  assert.equal(reads(), before, 'not even read');
  // While its verdict is pending or stuck, an issue is never read or edited.
  const r0 = reads();
  for (const state of ['pending', 'stuck']) {
    const n = await step(db, { api, reproGate: async ({ leads }) => new Map(leads.map((l) => [l.fingerprint, { state, key: 'k2', verdict: null }])) });
    assert.equal(n.refreshed, 0, state);
  }
  assert.equal(reads(), r0);
  // An issue of ours without this lead's marker is not edited.
  const marker = api.issues[0].body.match(/<!-- tool-qa lead [0-9a-f]{12} -->/)[0];
  api.issues[0].body = api.issues[0].body.replace(marker, '');
  const n6 = await step(db, { api, reproGate: gate('not_reproduced') });
  assert.equal(n6.refreshed, 0, 'no marker: left alone');
  // An issue that is not ours is never edited.
  api.issues[0].body = `${marker}\n${api.issues[0].body}`;
  api.issues[0].user.login = 'someone';
  const n5 = await step(db, { api, reproGate: gate('reproduced') });
  assert.equal(n5.refreshed, 0);
});

test('R-LEAD-56: a secondary rate limit (403) or 429 stops every write of the run; the issues budget is spaced well inside GitHub\'s content limits', async () => {
  for (const status of [403, 429]) {
    const db = reproduced(5);
    const api = issuesApi({ refuse: status });
    const note = await step(db, { api, reproGate: notReproduced, client: { fetch: api.fetch, apiUrl: 'https://api.github.test', sleep: async () => {}, maxAttempts: 1, retryTotalMs: 0 } });
    assert.equal(note.backed_off, true, `HTTP ${status}`);
    assert.equal(api.calls.filter((c) => c.method === 'POST').length <= 2, true, `HTTP ${status}: writes stop at the first refusal (with its one retry at most)`);
  }
  const { DEFAULT_FAMILIES } = await import('../pump/budgets.mjs');
  const fam = DEFAULT_FAMILIES.issues;
  assert.ok(fam.minIntervalMs >= 1000 && fam.perMinute <= 80 && fam.perHour <= 500, 'inside GitHub\'s documented limits for content creation');
  assert.ok(fam.perHour >= capsFrom({}).maxWrites, 'one run\'s writes fit the hourly budget');
});

// ------------------------------------------------------------------ caps

test('R-LEAD-61: the issue writes of a run stop at the step\'s time budget', async () => {
  const db = reproduced(3);
  const api = issuesApi();
  let t = Date.parse(NOW);
  // Each GitHub call takes a minute of the clock: with a 2-minute budget the step stops after the first writes.
  const slow = { fetch: async (u, i) => { t += 60_000; return api.fetch(u, i); }, apiUrl: 'https://api.github.test', sleep: async () => {} };
  const note = await step(db, { api, reproGate: notReproduced, now: () => t, stepBudgetMs: 2 * 60_000, client: slow });
  assert.ok(note.filed >= 1 && note.filed < 3, `filed ${note.filed}`);
  const all = await step(reproduced(3), { api: issuesApi(), reproGate: notReproduced });
  assert.equal(all.filed, 3, 'the default budget is not reached');
});

test('R-LEAD-57: the caps come from the repository variables, default 30 new a day, 150 open, 60 writes, and are bounded so a typo cannot flood', () => {
  assert.deepEqual(capsFrom({}), { capNew: 30, capOpen: 150, maxWrites: 60, notes: [] });
  assert.deepEqual(capsFrom({ LEADS_CAP_NEW_PER_REPO_DAY: '12', LEADS_CAP_OPEN_PER_REPO: '40', LEADS_MAX_WRITES: '0' }), { capNew: 12, capOpen: 40, maxWrites: 0, notes: [] });
  const typo = capsFrom({ LEADS_CAP_NEW_PER_REPO_DAY: '300', LEADS_CAP_OPEN_PER_REPO: '3000', LEADS_MAX_WRITES: '999' });
  assert.deepEqual([typo.capNew, typo.capOpen, typo.maxWrites], [CAP_BOUNDS.new_per_day, CAP_BOUNDS.open, CAP_BOUNDS.writes]);
  assert.deepEqual(CAP_BOUNDS, { new_per_day: 50, open: 300, writes: 100 });
  assert.equal(typo.notes.length, 3);
  for (const bad of ['-1', '3.5', 'thirty', '1e3', ' 7 x']) assert.equal(capsFrom({ LEADS_CAP_NEW_PER_REPO_DAY: bad }).capNew, 30, bad);
});

test('R-LEAD-57: the lead step files within the caps the variables set', async () => {
  const db = reproduced(6);
  const api = issuesApi();
  const note = await step(db, { api, env: { LEADS_CAP_NEW_PER_REPO_DAY: '4' }, reproGate: notReproduced });
  assert.equal(note.filed, 4);
  assert.deepEqual(note.caps, { new_per_day: 4, open: 150, writes: 60 });
  const db2 = reproduced(6);
  const n2 = await step(db2, { api: issuesApi(), env: { LEADS_MAX_WRITES: '2' }, reproGate: notReproduced });
  assert.equal(n2.filed, 2);
  assert.equal(planFilings(reproduced(6), { now: NOW, tierWeights }).file.length, 6, 'the default room is 30 a day');
});

// ------------------------------------------------------------------ the reader's construct kind

test('R-LEAD-58: the construct kinds the reader names reach the fingerprint, one lead per kind; a result without them keeps its fingerprint', () => {
  const item = (list) => ({ subject: 'x/y', lane: 'scan-static', tools: ['mcp-check@abc'], skips: [], results: new Map([['scan-static', { status: 'graded', list, listing: { via: 'github' } }]]), scan: null });
  const base = { from: 'source', fidelity: 'derived', language: null, unresolved_names: 0, registration_not_seen: 0, tools_left_out: 0, unreadable: { input_schemas: 0, descriptions: 2, annotations: 0 } };
  const old = failuresOf(item(base), { faults: ['tool'] });
  assert.deepEqual(old.map((f) => f.signature), ['class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions']);
  const withKinds = failuresOf(item({ ...base, unreadable_kinds: { descriptions: { member: 1, call: 1 }, input_schemas: {}, annotations: {}, names: {} } }), { faults: ['tool'] });
  assert.deepEqual(withKinds.map((f) => f.signature), [
    'class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions;construct=call',
    'class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions;construct=member',
  ]);
  assert.equal(leadKeyOf(failuresOf(item({ ...base, unreadable_kinds: {} }), { faults: ['tool'] })[0]).id, leadKeyOf(old[0]).id, 'empty kinds: the same lead as before');
  assert.deepEqual(constructsOf({ call: 1, 'drop table': 2, member: 0 }), ['<other>', 'call']);
  assert.deepEqual(constructsOf(null), []);
  assert.equal(CONSTRUCT_KINDS.length, 12);
});

test('R-LEAD-58: a lead that names its construct gets a fixture written as that construct; one we have no template for says so', () => {
  const at = (sig, idiom = 'source/derived/repo:ts/js') => reproSpec(readerLead({ signature: `class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=${sig}`, idiom }));
  const src = (s, f = 'src/index.ts') => new Map(s.files).get(f) ?? '';
  assert.match(src(at('unreadable_descriptions;construct=call')), /description: pick\("Echo the text back\."\)/);
  assert.match(src(at('unreadable_descriptions;construct=member')), /description: VALUES\.value/);
  assert.match(src(at('unreadable_descriptions;construct=template_expr')), /description: `\$\{PREFIX\}Echo the text back\.`/);
  assert.match(src(at('unreadable_descriptions;construct=function')), /get description\(\) \{/);
  const imp = at('unreadable_descriptions;construct=imported');
  assert.match(src(imp), /import \{ VALUE \} from "@fixture\/values";/);
  assert.match(src(imp, 'src/values.ts'), /export const VALUE = "Echo the text back\.";/);
  assert.match(src(at('unresolved_names;construct=call')), /registerTool\(pick\("echo"\)/);
  assert.match(src(at('unreadable_annotations;construct=conditional')), /readOnlyHint: process\.env\.LEAD_FIXTURE_FLAG \? true : true/);
  assert.match(src(at('unreadable_input_schemas;construct=spread')), /inputSchema: \{ \.\.\.pick\(\{ text: z\.string\(\) \}\) \}/);
  const py = at('unreadable_descriptions;construct=call', 'source/derived/repo:python');
  assert.match(src(py, 'server.py'), /description=pick\("Echo the text back\."\)/);
  assert.match(src(at('unreadable_annotations;construct=imported', 'source/derived/repo:python'), 'server.py'), /from lead_fixture_values import VALUE/);
  const none = at('unreadable_descriptions;construct=nested');
  assert.match(src(none), /const ECHO_DESCRIPTION = "Echo the text back\.";/, 'no template for nested: the constant stands in');
  assert.match(syntheticRepro(readerLead({ signature: 'class=reader_limit;detail=-;error=-;list_error=-;http=-;partial=unreadable_descriptions;construct=nested' }), { verdict: { verdict: 'reproduced' } }), /which no template of ours writes yet/);
  for (const s of [at('unreadable_descriptions;construct=call'), py]) for (const [, text] of s.files) assert.ok(!/acme|secret/.test(text));
});

// ------------------------------------------------------------------ the script's inputs

test('R-LEAD-59: lead-repro takes exactly one of issue, fingerprint and shape, each checked whole; a pull request runs the committed cases', () => {
  const o = { lanes: Object.keys(workflows), root: new URL('..', import.meta.url).pathname };
  assert.deepEqual(parseInputs({ LEAD_ISSUE: 'isokron-ai/mcp-check#78' }, o), [{ issue: { repo: 'isokron-ai/mcp-check', number: 78 } }]);
  assert.deepEqual(parseInputs({ LEAD_FINGERPRINT: 'bee256dbce94' }, o), [{ fingerprint: 'bee256dbce94' }]);
  const s = parseInputs({ LEAD_SHAPE: leadInput(readerLead()) }, o)[0].shape;
  assert.equal(s.signature, readerLead().signature);
  for (const env of [{}, { LEAD_ISSUE: 'isokron-ai/mcp-check#78', LEAD_FINGERPRINT: 'bee256dbce94' }, { LEAD_ISSUE: 'someone/else#1' }, { LEAD_ISSUE: 'isokron-ai/mcp-check#78\nx' },
    { LEAD_FINGERPRINT: 'BEE256' }, { LEAD_SHAPE: '{"fingerprint":"x"}' }, { LEAD_SHAPE: leadInput(readerLead({ lane: 'not-a-lane' })) }, { LEAD_SHAPE: leadInput(readerLead({ tool: 'acme-scanner' })) },
    { LEAD_SHAPE: leadInput(readerLead({ signature: 'class=x;$(rm -rf /)' })) }]) {
    assert.throws(() => parseInputs(env, o), InputProblem, JSON.stringify(env));
  }
  const pr = parseInputs({ EVENT_NAME: 'pull_request' }, o);
  assert.equal(pr.length, 7);
  assert.ok(pr.every((c) => c.issue && /^isokron-ai\//.test(c.issue.repo)));
});

test('R-LEAD-59: the lead-repro workflow reads only, uses no secret, and passes every input through env', () => {
  const y = readFileSync(new URL('../.github/workflows/lead-repro.yml', import.meta.url), 'utf8');
  assert.match(y, /^permissions: \{\}$/m);
  assert.match(y, /permissions:\n {6}contents: read\n {6}issues: read\n/);
  assert.ok(!/\$\{\{\s*secrets\./.test(y), 'no secret');
  for (const block of y.split(/\n\s+- /).filter((b) => /\brun: /.test(b))) {
    const run = block.slice(block.indexOf('run:'));
    assert.ok(!/\$\{\{/.test(run), `no expression in run: ${run.slice(0, 80)}`);
  }
  for (const m of y.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/);
  assert.match(y, /uses: actions\/checkout@[0-9a-f]{40} # [^\n]*\n {8}with:\n {10}persist-credentials: false\n/, 'the checkout keeps no token');
});

test('R-LEAD-60: the fixtures\' dependencies are pinned (exact npm versions with our lockfile, an exact mcp) and part of the repro key', () => {
  const pkg = JSON.parse(TEMPLATES.ts.pkg['package.json']);
  assert.deepEqual(pkg.dependencies, NPM_DEPS);
  const lock = JSON.parse(readFileSync(new URL('../leads/fixtures/npm/package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, NPM_DEPS);
  for (const [name, v] of Object.entries(NPM_DEPS)) assert.equal(lock.packages[`node_modules/${name}`].version, v);
  for (const [k, e] of Object.entries(lock.packages)) if (k) assert.match(e.integrity ?? '', /^sha512-/, `${k} has an integrity`);
  assert.match(PY_MCP, /^mcp==\d+\.\d+\.\d+$/);
  assert.match(TEMPLATES.python.pkg['pyproject.toml'], new RegExp(`"${PY_MCP.replace(/\./g, '\\.')}"`));
  assert.match(DEPS.npm_lock, /^[0-9a-f]{16}$/);
  const l = startLead();
  const s = reproSpec(l);
  const pins = pinsFor('writecheck', workflows);
  assert.notEqual(reproKey(l, s, pins), reproKey(l, s, pins, { ...DEPS, npm_lock: '0'.repeat(16) }), 'another lockfile: another key');
  assert.notEqual(reproKey(l, s, pins), reproKey(l, s, pins, { ...DEPS, pip: 'mcp==0.0.1' }));
});

test('R-LEAD-60: a confirmed writecheck start fixture says it is confirmed for slow starts only, while writecheck cannot tell one from a server with no read/update pair', () => {
  const text = syntheticRepro(startLead(), { verdict: { verdict: 'reproduced', run_id: 1, key: 'k' } });
  assert.ok(text.includes(WRITECHECK_START_CAVEAT));
  assert.match(WRITECHECK_START_CAVEAT, /misclassified "no read\/update pair"/);
  assert.ok(!syntheticRepro(readerLead(), { verdict: { verdict: 'reproduced' } }).includes(WRITECHECK_START_CAVEAT));
  assert.ok(!syntheticRepro(startLead(), { verdict: { verdict: 'not_reproduced' } }).includes('```'));
});
