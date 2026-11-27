// The shared fingerprint module (state/fingerprint.mjs): the check-in and the
// leads table read a failure the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemsFromEntries } from '../longitudinal/checkin.mjs';
import { bundleLeads } from '../ingest/ingest.mjs';
import {
  failuresOf, fingerprintOf, itemFromBundle, laneOf, leadFailures, leadKeyOf, nameTokens, toolName, toolTags,
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

test('leadFailures never throws: a broken item makes no lead', () => {
  assert.deepEqual(leadFailures({ subject: 'a/b', results: null, skips: null, tools: [] }), []);
  assert.deepEqual(bundleLeads(Buffer.from('{not json'), new Map(), { subject: 'a/b' }, 'scan-static', { names: new Set() }), []);
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
