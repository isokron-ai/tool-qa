// The shared fingerprint module (state/fingerprint.mjs): the check-in and the
// leads table read a failure the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemsFromEntries } from '../longitudinal/checkin.mjs';
import { loadCodes, missing, readCheckout } from '../scripts/fingerprint-codes.mjs';
import { bundleLeads } from '../ingest/ingest.mjs';
import {
  CODES, failuresOf, fingerprintOf, itemFromBundle, laneOf, leadFailures, leadKeyOf, nameTokens, toolName, toolTags,
} from '../state/fingerprint.mjs';

const enc = (o) => Buffer.from(JSON.stringify(o));
function bundle({ subject = 'acme/widget-mcp', lane = 'scan-static', repo = 'isokron-ai/mcp-check', tools = [{ name: 'mcp-check', version: '1.3.1' }], skips = [], result = null, at = '2026-11-20T10:00:00Z', attempt = 'att-1', index = 0 } = {}) {
  const manifest = {
    schema_version: 1, attempt_id: attempt, run_key: `rk-${attempt}`, fence: 1, subject: { id: subject, repo: subject, sha: 'a'.repeat(40) },
    workflow: { repo, file: `.github/workflows/${lane}.yml`, sha: '1'.repeat(40), run_id: 77, run_attempt: 1 },
    tools, finished_at: at, started_at: at, skips, files: [], controls: [],
  };
  const files = new Map();
  if (result) files.set(`results/${lane}.json`, enc(result));
  return { manifest, files };
}

test('R-LEAD-01: the lead id is the fingerprint without the tool versions; the check-in and ingest give one bundle the same id', () => {
  const skip = [{ stage: 'static', reason: 'no_tools_found', fault: 'tool' }];
  const a = bundle({ skips: skip, tools: [{ name: 'mcp-check', version: '1.3.1' }] });
  const b = bundle({ skips: skip, tools: [{ name: 'mcp-check', version: '1.4.0' }] });
  const fa = failuresOf(itemFromBundle(a), { faults: ['tool'] })[0];
  const fb = failuresOf(itemFromBundle(b), { faults: ['tool'] })[0];
  assert.notEqual(fingerprintOf(fa).id, fingerprintOf(fb).id, 'the check-in fingerprint moves with the version');
  assert.equal(leadKeyOf(fa).id, leadKeyOf(fb).id, 'the lead does not: one issue across releases');
  assert.equal(leadKeyOf(fa).parts.tool, 'mcp-check');
  assert.deepEqual(leadKeyOf(fa).versions, ['mcp-check@1.3.1']);
  // A probe tool the lane adds later (fuzz) does not split the lead either.
  const c = bundle({ skips: skip, tools: [{ name: '@isokron/mcp-check', version: '1.4.0' }, { name: 'fuzz', version: 'f7ec673' }] });
  const fc = failuresOf(itemFromBundle(c), { faults: ['tool'] })[0];
  assert.equal(leadKeyOf(fc).id, leadKeyOf(fa).id);
  assert.deepEqual(leadKeyOf(fc).versions, ['mcp-check@1.4.0', 'fuzz@f7ec673']);

  // The same bundle through the check-in's archive reader and through ingest.
  const entries = [
    { path: 'accepted/att-1/0/manifest.json', data: enc(a.manifest) },
    { path: 'accepted/att-1/0/ingest.json', data: enc({ ledger: { subject: 'acme/widget-mcp' }, run: { id: 77 } }) },
  ];
  const [item] = itemsFromEntries(entries);
  const fromCheckin = leadFailures(item, { names: nameTokens(['acme/widget-mcp']) });
  const fromIngest = bundleLeads(enc(a.manifest), a.files, { subject: 'acme/widget-mcp' }, 'scan-static', { names: nameTokens(['acme/widget-mcp']) });
  assert.equal(fromIngest.length, 1);
  assert.deepEqual(fromCheckin, fromIngest);
  assert.equal(fromIngest[0].fingerprint, leadKeyOf(fa).id);
});

test('R-CHECKIN-15: tool names are ours, never name-redacted: @isokron/mcp-check is mcp-check even when a subject is called mcp-check-helper; an unknown tool is <other>', () => {
  assert.equal(toolName('@isokron/mcp-check'), 'mcp-check');
  assert.equal(toolName('isokron-ai/mcp-surface-corpus'), 'mcp-surface-corpus');
  assert.equal(toolName('acme-scanner'), '<other>');
  assert.deepEqual(toolTags([{ name: '@isokron/mcp-check', version: '1.3.1' }, { name: 'gvisor', version: '20261116.0' }, { name: 'x', version: 'v 1; rm' }]),
    ['mcp-check@1.3.1', 'gvisor@20261116.0', '<other>@<other>']);
  const b = bundle({ subject: 'mcp-org/mcp-check-helper', skips: [{ stage: 'static', reason: 'unsupported_layout', fault: 'tool' }], tools: [{ name: '@isokron/mcp-check', version: '1.3.1' }] });
  const names = nameTokens(['mcp-org/mcp-check-helper']);
  const [f] = failuresOf(itemFromBundle(b), { faults: ['tool'] }, { names });
  assert.equal(f.tool, 'mcp-check@1.3.1', 'our tool name shares words with the subject and is still shown');
});

test('R-CHECKIN-16: the lane is our workflow name (writecheck runs corpus.yml), and our workers\' own stage codes (resolve, install, start) are kept', () => {
  assert.equal(laneOf({ repo: 'isokron-ai/mcp-writecheck-action', file: '.github/workflows/corpus.yml' }), 'writecheck');
  assert.equal(laneOf({ repo: 'isokron-ai/mcp-check', file: '.github/workflows/live-probe.yml' }), 'live-probe');
  assert.equal(laneOf({ repo: 'someone/else', file: '.github/workflows/corpus.yml' }), 'corpus', 'another repository keeps the file name');
  const b = bundle({ lane: 'live-probe', skips: [{ stage: 'resolve', reason: 'no_runnable_artifact', fault: 'tool' }, { stage: 'acme-widget', reason: 'timeout_start', fault: 'tool' }] });
  const fl = failuresOf(itemFromBundle(b), { faults: ['tool'] }, { names: nameTokens(['acme/widget-mcp']) });
  assert.deepEqual(fl.map((f) => f.stage), ['resolve', '<other>']);
});

test('R-LEAD-07: a lead holds the bug shape only: no subject name reaches any part of it, and infra faults are leads while subject and policy ones are not', () => {
  const subject = 'acme/widget-mcp';
  const b = bundle({
    subject,
    skips: [
      { stage: 'static', reason: 'no_tools_found', fault: 'tool' },
      { stage: 'resolve', reason: 'upstream_unavailable', fault: 'infra' },
      { stage: 'start', reason: 'start_requires_credentials', fault: 'subject' },
      { stage: 'full', reason: 'policy_excluded', fault: 'policy' },
    ],
    result: { status: 'error', error_name: 'WidgetMcpError', list_error: { code: 'AcmeFail' }, http_status: 503 },
  });
  const leads = leadFailures(itemFromBundle(b), { names: nameTokens([subject]) });
  assert.deepEqual(leads.map((l) => l.fault).sort(), ['infra', 'tool', 'tool'], JSON.stringify(leads));
  const text = JSON.stringify(leads).toLowerCase();
  for (const bad of ['acme', 'widget']) assert.ok(!text.includes(bad), `${bad} reached a lead`);
  assert.ok(leads.every((l) => /^[0-9a-f]{12}$/.test(l.fingerprint)));
});

test('R-LEAD-14: an item that cannot be read gives null (not folded), never [] (which would count as a clean re-check of every lead)', () => {
  assert.equal(leadFailures({ subject: 'a/b', results: null, skips: null, tools: [] }), null);
  assert.equal(bundleLeads(Buffer.from('{not json'), new Map(), { subject: 'a/b' }, 'scan-static', { names: new Set() }), null);
  assert.deepEqual(leadFailures(itemFromBundle(bundle())), [], 'a readable item with no failure is []');
});

test('R-LEAD-15: a lead names only our own tools: a third-party tool a worker runs (gvisor, an SDK) is in neither its id nor its versions', () => {
  const skips = [{ stage: 'install', reason: 'no_runnable_artifact', fault: 'tool' }];
  const tools = [{ name: 'mcp-writecheck', version: '3af41c6' }, { name: 'mcp-writecheck-action', version: 'db0d614' }, { name: 'gvisor', version: '20261116.0' }, { name: 'sdk-python', version: '2.3.0' }];
  const [l] = leadFailures(itemFromBundle(bundle({ lane: 'corpus', repo: 'isokron-ai/mcp-writecheck-action', skips, tools })));
  assert.equal(l.tool, 'mcp-writecheck');
  assert.deepEqual(l.versions, ['mcp-writecheck@3af41c6', 'mcp-writecheck-action@db0d614']);
  const [m] = leadFailures(itemFromBundle(bundle({ lane: 'corpus', repo: 'isokron-ai/mcp-writecheck-action', skips, tools: [...tools, { name: 'gvisor', version: '20270101.0' }] })));
  assert.equal(m.fingerprint, l.fingerprint, 'a third-party upgrade does not split the lead');
  const [n] = leadFailures(itemFromBundle(bundle({ skips, tools: [{ name: 'gvisor', version: '1' }] })));
  assert.equal(n.tool, '<other>');
});

test('R-CHECKIN-17: a worker that reports one reason again at every later stage (install, init, plan, catalog) has one failure, at its first stage', () => {
  const stages = ['install', 'init', 'plan', 'catalog'];
  const b = bundle({ lane: 'corpus', repo: 'isokron-ai/mcp-writecheck-action', skips: [
    ...stages.map((stage) => ({ stage, reason: 'no_runnable_artifact', fault: 'tool' })),
    { stage: 'full', reason: 'timeout_start', fault: 'tool' },
  ] });
  const fl = failuresOf(itemFromBundle(b), { faults: ['tool'] });
  assert.deepEqual(fl.map((f) => `${f.stage}:${f.cls}`), ['install:no_runnable_artifact', 'full:timeout_start']);
  assert.equal(leadFailures(itemFromBundle(b)).length, 2);
});

test('R-CHECKIN-18: the signature carries live-probe\'s fine cause (an allow-listed code of ours): two timeout_start items with different causes are two fingerprints; free text is never one', () => {
  const skips = [{ stage: 'start', reason: 'timeout_start', fault: 'tool' }];
  const item = (detail) => itemFromBundle(bundle({ lane: 'live-probe', skips, result: { status: 'skipped', detail } }));
  const [drift] = failuresOf(item('start_dependency_drift'), { faults: ['tool'] });
  const [env] = failuresOf(item('start_env_limited'), { faults: ['tool'] });
  assert.match(drift.signature, /;detail=start_dependency_drift;/);
  assert.match(env.signature, /;detail=start_env_limited;/);
  assert.notEqual(fingerprintOf(drift).id, fingerprintOf(env).id, 'the check-in fingerprint tells them apart');
  assert.notEqual(leadKeyOf(drift).id, leadKeyOf(env).id, 'and so does the lead');
  // The check-in reads the same: its archive items go through the same module.
  const enc2 = (o) => Buffer.from(JSON.stringify(o));
  const b = bundle({ lane: 'live-probe', skips, result: { status: 'skipped', detail: 'start_dependency_drift' } });
  const [ci] = itemsFromEntries([
    { path: 'accepted/att-1/0/manifest.json', data: enc2(b.manifest) },
    { path: 'accepted/att-1/0/results/live-probe.json', data: b.files.get('results/live-probe.json') },
  ]);
  assert.equal(fingerprintOf(failuresOf(ci, { faults: ['tool'] })[0]).id, fingerprintOf(drift).id);
  // A detail that is not one of our codes (a graded result's free text, a subject word) is <other>.
  for (const free of ['acme-widget failed to start', 'start_acme_widget', 'Start_Env_Limited']) {
    const [f] = failuresOf(item(free), { faults: ['tool'] }, { names: nameTokens(['acme/widget-mcp']) });
    assert.match(f.signature, /;detail=<other>;/, free);
  }
});

test('R-LEAD-37: error and list-error words come from fixed lists of our codes, so a fingerprint never changes as subjects are added (SyntaxError stays syntaxerror next to a server called axe)', () => {
  const b = bundle({ subject: 'tools/axe', result: { status: 'error', error_name: 'SyntaxError', list_error: 'too_many_tools' } });
  const alone = failuresOf(itemFromBundle(b), { faults: ['tool'] });
  const crowded = failuresOf(itemFromBundle(b), { faults: ['tool'] }, { names: nameTokens(['tools/axe', 'syntax-org/error-server', 'too/many-tools']) });
  assert.match(alone[0].signature, /error=syntaxerror;list_error=too_many_tools;/);
  assert.deepEqual(crowded.map((f) => leadKeyOf(f).id), alone.map((f) => leadKeyOf(f).id), 'the same lead whatever names exist');
  // Our own classes and the built-ins are kept; anything else is <other>.
  for (const n of ['McpFetchError', 'BundleTooLarge', 'TypeError', 'AbortError']) assert.ok(CODES.error_names.includes(n), n);
  const other = failuresOf(itemFromBundle(bundle({ result: { status: 'error', error_name: 'AcmeWidgetCrash', list_error: 'acme_code' } })), { faults: ['tool'] });
  assert.match(other[0].signature, /error=<other>;list_error=<other>;/);
});

test('R-LEAD-38: the committed codes hold every detail, list error and error class mcp-check declares (checked against a checkout when MCP_CHECK_DIR is set)', { skip: process.env.MCP_CHECK_DIR ? false : 'set MCP_CHECK_DIR to an mcp-check checkout' }, () => {
  assert.deepEqual(missing(readCheckout(process.env.MCP_CHECK_DIR)), {});
});

test('R-LEAD-38: the committed codes include the live-probe causes the review found missing, and the module reads that file', () => {
  const codes = loadCodes();
  for (const d of ['registry_query_refused', 'image_access_denied', 'resolver_error', 'no_tools_capability', 'start_dependency_drift', 'repo_unavailable', 'reader_error']) assert.ok(codes.details.includes(d), d);
  assert.deepEqual(CODES, codes);
  const [f] = failuresOf(itemFromBundle(bundle({ lane: 'live-probe', skips: [{ stage: 'resolve', reason: 'no_runnable_artifact', fault: 'tool' }], result: { status: 'skipped', detail: 'resolver_error' } })), { faults: ['tool'] });
  assert.match(f.signature, /;detail=resolver_error;/);
});

test('R-LEAD-48: the code list cannot fall behind silently: a daily workflow checks it against mcp-check main, and it holds commit_moved', async () => {
  const { readFileSync } = await import('node:fs');
  const wf = readFileSync(new URL('../.github/workflows/fingerprint-codes.yml', import.meta.url), 'utf8');
  assert.match(wf, /\n {2}schedule:\n {4}- cron: '[^']+'\n/);
  assert.match(wf, /repository: isokron-ai\/mcp-check\n\s+ref: main\n/);
  assert.match(wf, /run: node scripts\/fingerprint-codes\.mjs --mcp-check mcp-check --check\n/);
  assert.ok(loadCodes().details.includes('commit_moved'));
});
