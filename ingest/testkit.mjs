// Test helpers only (not used at run time): synthetic result bundles and a
// fake GitHub API, so ingest can be tested without a network or a worker.

import { buildManifest, MANIFEST_NAME } from '../worker-kit/contract.mjs';
import { writeTar } from '../worker-kit/tar.mjs';
import { AgeError } from './age.mjs';

export const RUN_KEY = 'a'.repeat(64);
export const WORKFLOW_SHA = '1'.repeat(40);
export const WORKER_REPO = 'isokron-ai/mcp-check';
export const WORKFLOW_FILE = '.github/workflows/qa-worker.yml';
export const RUN_ID = 4242;
export const MARKER = 'FORGERY_MARKER_0123456789abcdef';

/** What the ledger says was dispatched (the trusted side). */
export function expected(over = {}) {
  return {
    attempt_id: 'att-1',
    fence: 7,
    run_key: RUN_KEY,
    repo: WORKER_REPO,
    workflow_file: WORKFLOW_FILE,
    workflow_sha: WORKFLOW_SHA,
    run_id: RUN_ID,
    run_attempt: 1,
    ...over,
  };
}

/** A clean bundle's files: one observation file, a report, a passing forgery control. */
export function defaultFiles() {
  return {
    'observations/check.ndjson': `${JSON.stringify({ field: 'tool_count', value: 3 })}\n${JSON.stringify({ field: 'registry_name', value: 'demo' })}\n`,
    'results/report.json': JSON.stringify({ tool: 'check', ok: true, findings: [] }),
    'controls/forgery.json': JSON.stringify({ target: 'forgery', verdict: 'contained' }),
    'raw/forgery-target.ndjson': `${JSON.stringify({ attempt_id: 'att-999', fence: 99, run_key: 'b'.repeat(64), note: MARKER })}\n`,
    'logs/run.log': 'started\nfinished\n',
  };
}

export function defaultMeta(over = {}) {
  return {
    subject: { id: 'io.example/demo', repo: 'example/demo', sha: 'c'.repeat(40) },
    tools: [{ name: 'mcp-check', version: '0.1.0' }],
    oracles: [],
    settings_manifest_digest: 'd'.repeat(64),
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:05:00Z',
    skips: [],
    controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json', marker: MARKER }],
    ...over,
  };
}

/**
 * Build a bundle. Options let a test forge parts of it.
 * @returns {{manifest: object, files: Map<string, Buffer>, tar: Buffer}}
 */
export function makeBundle({
  identity = {}, workflow = {}, meta = {}, files = defaultFiles(), mutateManifest, extraTarEntries = [], dropFromTar = [],
} = {}) {
  const e = expected();
  const fileList = Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) }));
  const manifest = buildManifest({
    identity: { attempt_id: e.attempt_id, fence: e.fence, run_key: e.run_key, ...identity },
    workflow: { repo: e.repo, file: e.workflow_file, sha: e.workflow_sha, run_id: e.run_id, run_attempt: 1, ...workflow },
    meta: defaultMeta(meta),
    files: fileList,
  });
  if (mutateManifest) mutateManifest(manifest);
  const entries = [
    { path: MANIFEST_NAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...fileList.filter((f) => !dropFromTar.includes(f.path)),
    ...extraTarEntries.map(([path, data]) => ({ path, data: Buffer.from(data) })),
  ];
  return {
    manifest,
    files: new Map(fileList.filter((f) => !dropFromTar.includes(f.path)).concat(
      extraTarEntries.map(([path, data]) => ({ path, data: Buffer.from(data) })),
    ).map((f) => [f.path, f.data])),
    tar: writeTar(entries),
  };
}

/** Minimal field registry text in the results-repo format. */
export const REGISTRY_TEXT = `version: 0
fields:
  - {id: registry_name, layer: identity_discovery, type: string, unit: none, source: discover, class: P, redaction: [R1], status: planned}
  - {id: tool_count, layer: surface, type: integer, unit: count, source: check, class: P, redaction: null, status: planned}
  - {id: old_field, layer: surface, type: string, unit: none, source: check, class: P, redaction: null, status: deprecated}
`;

// ---- fake crypto, GitHub API and ledger ----

/** Stand-in for age in tests that are not about crypto: a fixed header in front of the tar. */
export const FAKE_AGE_HEADER = Buffer.from('age-encryption.org/v1\n-> fake-recipient\n---\n');

export function fakeEncrypt(plaintext) {
  return Buffer.concat([FAKE_AGE_HEADER, plaintext]);
}

export function fakeDecrypt(ciphertext) {
  if (!ciphertext.subarray(0, FAKE_AGE_HEADER.length).equals(FAKE_AGE_HEADER)) {
    throw new AgeError('age could not decrypt the bundle: no identity matched any of the recipients', 'failed');
  }
  return ciphertext.subarray(FAKE_AGE_HEADER.length);
}

export function defaultRun(over = {}) {
  return {
    id: RUN_ID,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: WORKFLOW_FILE,
    head_sha: WORKFLOW_SHA,
    run_attempt: 1,
    repository: { full_name: WORKER_REPO },
    ...over,
  };
}

export function artifactEntry(over = {}) {
  return {
    id: 901,
    name: 'result-att-1-0.tar.age',
    size_in_bytes: 1000,
    expired: false,
    workflow_run: { id: RUN_ID },
    ...over,
  };
}

/**
 * A fake of ingest/github.mjs. `blob` is what downloadArtifact returns (or an
 * Error to throw), or a function of the artifact id that returns one. Calls
 * are kept in `.calls`.
 */
export function fakeGithub({ run = defaultRun(), artifacts = [artifactEntry()], blob } = {}) {
  const calls = [];
  return {
    calls,
    async getRun(repo, runId) {
      calls.push(['getRun', repo, runId]);
      return run;
    },
    async listRunArtifacts(repo, runId) {
      calls.push(['listRunArtifacts', repo, runId]);
      return artifacts;
    },
    async downloadArtifact(repo, id) {
      calls.push(['downloadArtifact', repo, id]);
      const b = typeof blob === 'function' ? blob(id) : blob;
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

/** A normalised attempts-ledger row for the default attempt. */
export function expectedRow(over = {}) {
  const e = expected();
  return {
    attempt_id: e.attempt_id,
    run_key: e.run_key,
    fence: e.fence,
    repo: e.repo,
    run_id: e.run_id,
    workflow_file: e.workflow_file,
    workflow_sha: null,
    current_fence: null,
    outcome: null,
    canaries: [],
    ...over,
  };
}

/**
 * A ledger row for a shard of several items: item i has run_keys[i] and fence
 * firstFence + i.
 */
export function multiItemRow(runKeys, { firstFence = 7, ...over } = {}) {
  const { run_key: _k, fence: _f, current_fence: _c, outcome: _o, ...shared } = expectedRow();
  return {
    ...shared,
    items: runKeys.map((k, index) => ({ index, run_key: k, fence: firstFence + index, current_fence: null, outcome: null })),
    ...over,
  };
}

/** In-memory attempts ledger with the interface of ingest/ledger.mjs. */
export function fakeLedger(rows = [expectedRow()], { answer } = {}) {
  const records = [];
  return {
    kind: 'fake',
    records,
    getAttempt: (id) => rows.find((r) => r.attempt_id === id) ?? null,
    recordResult: (r) => {
      records.push(r);
      return answer ? answer(r) : { accepted: r.accepted, reason: r.reason };
    },
    close() {},
  };
}
