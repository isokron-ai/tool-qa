import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_SCHEMA_VERSION, SKIP_REASONS, CONTROL_KINDS, SUPPORTED_KEYWORDS,
  loadSchema, validateAgainstSchema, validateManifest, isBundlePath, sha256Hex,
  workflowFromEnv, collectFiles, buildManifest, artifactName, legacyArtifactName,
} from '../contract.mjs';

const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);

export function validManifest(overrides = {}) {
  return {
    schema_version: 1,
    attempt_id: '01JD0000000000000000000000',
    fence: 7,
    run_key: 'c'.repeat(64),
    subject: { id: 'npm:example-server', repo: 'example/server', sha: SHA40 },
    workflow: { repo: 'isokron-ai/mcp-check', file: '.github/workflows/live-probe.yml', sha: SHA40, run_id: 123456, run_attempt: 1 },
    tools: [{ name: 'mcp-check', version: '1.4.0' }],
    oracles: [{ name: 'inspector', version: '0.9.1' }],
    settings_manifest_digest: SHA64,
    started_at: '2026-11-21T10:00:00Z',
    finished_at: '2026-11-21T10:05:00.123Z',
    files: [
      { path: 'observations/protocol.ndjson', sha256: SHA64, bytes: 10 },
      { path: 'controls/forgery/result.json', sha256: SHA64, bytes: 2 },
    ],
    skips: [{ stage: 'build-probe', reason: 'build_failed_upstream' }],
    controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery/result.json' }],
    ...overrides,
  };
}

function walkKeywords(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((n) => walkKeywords(n, out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      if (k === 'properties' || k === '$defs') Object.values(v).forEach((s) => walkKeywords(s, out));
      else if (k === 'items') walkKeywords(v, out);
    }
  }
  return out;
}

test('the schema file only uses keywords the built-in validator supports', () => {
  const schema = loadSchema();
  const used = walkKeywords(schema);
  for (const k of used) assert.ok(SUPPORTED_KEYWORDS.has(k), `unsupported keyword ${k}`);
  assert.equal(schema.properties.schema_version.const, MANIFEST_SCHEMA_VERSION);
});

test('schema enums match the exported skip reasons and control kinds', () => {
  const schema = loadSchema();
  assert.deepEqual(schema.properties.skips.items.properties.reason.enum, [...SKIP_REASONS]);
  assert.deepEqual(schema.properties.controls.items.properties.kind.enum, [...CONTROL_KINDS]);
  assert.ok(SKIP_REASONS.includes('trace_unavailable'));
  assert.ok(SKIP_REASONS.includes('bridge_required'));
  assert.ok(CONTROL_KINDS.includes('forgery'));
});

test('a valid manifest passes', () => {
  const r = validateManifest(validManifest());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('nullable subject repo and sha are allowed', () => {
  const r = validateManifest(validManifest({ subject: { id: 'pypi:x', repo: null, sha: null } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

const bad = [
  ['missing field', (m) => { delete m.run_key; }, /run_key/],
  ['extra top-level field', (m) => { m.verdict = 'pass'; }, /verdict/],
  ['wrong schema version', (m) => { m.schema_version = 2; }, /schema_version/],
  ['fence zero', (m) => { m.fence = 0; }, /fence/],
  ['fence as string', (m) => { m.fence = '7'; }, /fence/],
  ['fence not whole', (m) => { m.fence = 7.5; }, /fence/],
  ['run_key not hex', (m) => { m.run_key = 'z'.repeat(64); }, /run_key/],
  ['attempt id with slash', (m) => { m.attempt_id = 'a/b'; }, /attempt_id/],
  ['bad start time', (m) => { m.started_at = '2026-11-21 10:00'; }, /started_at/],
  ['impossible date', (m) => { m.started_at = '2026-02-30T10:00:00Z'; }, /started_at/],
  ['finished before started', (m) => { m.finished_at = '2026-11-21T09:00:00Z'; }, /finished_at/],
  ['path traversal', (m) => { m.files[0].path = 'results/../../etc/passwd'; }, /path/],
  ['dot segment', (m) => { m.files[0].path = 'results/./x'; }, /path/],
  ['absolute path', (m) => { m.files[0].path = '/results/x'; }, /path/],
  ['unknown top-level dir', (m) => { m.files[0].path = 'secrets/x'; }, /path/],
  ['manifest listed as a file', (m) => { m.files[0].path = 'manifest.json'; }, /path/],
  ['backslash in path', (m) => { m.files[0].path = 'results\\x'; }, /path/],
  ['duplicate path', (m) => { m.files[1].path = m.files[0].path; }, /duplicate/],
  ['unknown skip reason', (m) => { m.skips[0].reason = 'felt_like_it'; }, /reason/],
  ['skip without reason', (m) => { delete m.skips[0].reason; }, /reason/],
  ['unknown control kind', (m) => { m.controls[0].kind = 'other'; }, /kind/],
  ['control output not listed', (m) => { m.controls[0].output = 'controls/missing.json'; }, /not listed/],
  ['forgery control without output', (m) => { delete m.controls[0].output; }, /output/],
  ['skip evidence not listed', (m) => { m.skips[0].evidence = 'logs/missing.txt'; }, /not listed/],
  ['no tools', (m) => { m.tools = []; }, /tools/],
  ['workflow outside .github/workflows', (m) => { m.workflow.file = 'ci.yml'; }, /file/],
  ['workflow sha short', (m) => { m.workflow.sha = 'abc'; }, /sha/],
  ['not an object', () => 'nope', /object/],
];

for (const [name, mutate, re] of bad) {
  test(`invalid manifest is rejected: ${name}`, () => {
    let m = validManifest();
    m = mutate(m) ?? m;
    if (typeof m === 'object') m = structuredClone(m);
    const r = validateManifest(m);
    assert.equal(r.ok, false);
    assert.match(r.errors.map((e) => `${e.path} ${e.message}`).join('\n'), re);
  });
}

test('validateAgainstSchema handles $ref, type arrays, const and enum', () => {
  const schema = {
    $defs: { n: { type: 'integer', minimum: 2 } },
    type: 'object',
    properties: { a: { $ref: '#/$defs/n' }, b: { type: ['string', 'null'], pattern: '^x' }, c: { enum: ['p', 'q'] } },
    additionalProperties: false,
  };
  assert.deepEqual(validateAgainstSchema(schema, { a: 3, b: null, c: 'p' }), []);
  assert.equal(validateAgainstSchema(schema, { a: 1 }).length, 1);
  assert.equal(validateAgainstSchema(schema, { b: 'y' }).length, 1);
  assert.equal(validateAgainstSchema(schema, { c: 'r' }).length, 1);
  assert.throws(() => validateAgainstSchema({ $ref: 'http://elsewhere/x' }, 1), /\$ref/);
  assert.throws(() => validateAgainstSchema({ oneOf: [] }, 1), /unsupported/);
});

test('isBundlePath', () => {
  assert.equal(isBundlePath('raw/stdout.bin'), true);
  assert.equal(isBundlePath('observations/a/b/c.ndjson'), true);
  assert.equal(isBundlePath('raw'), false);
  assert.equal(isBundlePath('raw/'), false);
  assert.equal(isBundlePath('raw//x'), false);
  assert.equal(isBundlePath('raw/..'), false);
  assert.equal(isBundlePath('raw/..x'), true);
  assert.equal(isBundlePath(`raw/${'a'.repeat(101)}`), false);
});

test('workflowFromEnv reads the runner variables', () => {
  const wf = workflowFromEnv({
    GITHUB_REPOSITORY: 'isokron-ai/mcp-check',
    GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-check/.github/workflows/live-probe.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: SHA40,
    GITHUB_RUN_ID: '987',
    GITHUB_RUN_ATTEMPT: '2',
  });
  assert.deepEqual(wf, { repo: 'isokron-ai/mcp-check', file: '.github/workflows/live-probe.yml', sha: SHA40, run_id: 987, run_attempt: 2 });
  assert.throws(() => workflowFromEnv({ GITHUB_REPOSITORY: 'a/b', GITHUB_WORKFLOW_REF: 'c/d/.github/workflows/x.yml@main', GITHUB_WORKFLOW_SHA: SHA40, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' }), /another repository/);
  assert.throws(() => workflowFromEnv({}), /GITHUB_REPOSITORY/);
});

function tempBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'wk-contract-'));
  mkdirSync(join(dir, 'observations'), { recursive: true });
  mkdirSync(join(dir, 'raw', 'sub'), { recursive: true });
  mkdirSync(join(dir, 'logs', 'empty'), { recursive: true });
  writeFileSync(join(dir, 'observations', 'protocol.ndjson'), '{"field":"protocol_negotiated","value":"2025-06-18"}\n');
  writeFileSync(join(dir, 'raw', 'sub', 'stdout.bin'), Buffer.from([0, 1, 2, 255]));
  return dir;
}

test('collectFiles walks the bundle directory in sorted order with digests', () => {
  const dir = tempBundle();
  try {
    const files = collectFiles(dir);
    assert.deepEqual(files.map((f) => f.path), ['observations/protocol.ndjson', 'raw/sub/stdout.bin']);
    assert.equal(files[1].data.length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collectFiles refuses symlinks, a manifest.json of its own and files outside the layout', () => {
  for (const [name, setup, re] of [
    ['symlink', (d) => symlinkSync('/etc/hosts', join(d, 'raw', 'link')), /symlink/],
    ['manifest', (d) => writeFileSync(join(d, 'manifest.json'), '{}'), /manifest\.json/],
    ['outside layout', (d) => writeFileSync(join(d, 'notes.txt'), 'x'), /notes\.txt/],
    ['bad name', (d) => writeFileSync(join(d, 'raw', 'sp ace'), 'x'), /sp ace/],
  ]) {
    const dir = tempBundle();
    try {
      setup(dir);
      assert.throws(() => collectFiles(dir), re, name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('buildManifest fills identity, workflow and file digests and validates', () => {
  const files = [
    { path: 'raw/b.txt', data: Buffer.from('bb') },
    { path: 'observations/a.ndjson', data: Buffer.from('{}\n') },
  ];
  const m = buildManifest({
    identity: { attempt_id: 'att-1', fence: 3, run_key: 'd'.repeat(64) },
    workflow: { repo: 'isokron-ai/mcp-check', file: '.github/workflows/x.yml', sha: SHA40, run_id: 5, run_attempt: 1 },
    meta: {
      subject: { id: 's1', repo: null, sha: null },
      tools: [{ name: 'mcp-check', version: '1.0.0' }],
      oracles: [],
      settings_manifest_digest: SHA64,
      started_at: '2026-11-21T10:00:00Z',
      skips: [],
      controls: [{ kind: 'known_good', expected: 'pass', observed: 'pass' }],
    },
    files,
    now: () => new Date('2026-11-21T10:01:00Z'),
  });
  assert.equal(m.schema_version, 1);
  assert.equal(m.finished_at, '2026-11-21T10:01:00.000Z');
  assert.deepEqual(m.files, [
    { path: 'observations/a.ndjson', sha256: sha256Hex(Buffer.from('{}\n')), bytes: 3 },
    { path: 'raw/b.txt', sha256: sha256Hex(Buffer.from('bb')), bytes: 2 },
  ]);
  assert.equal(validateManifest(m).ok, true);
});

test('buildManifest refuses meta that tries to set identity or file fields', () => {
  const base = {
    identity: { attempt_id: 'att-1', fence: 3, run_key: 'd'.repeat(64) },
    workflow: { repo: 'a/b', file: '.github/workflows/x.yml', sha: SHA40, run_id: 5, run_attempt: 1 },
    files: [],
  };
  const meta = { subject: { id: 's', repo: null, sha: null }, tools: [{ name: 't', version: '1' }], oracles: [], settings_manifest_digest: SHA64, started_at: '2026-11-21T10:00:00Z', skips: [], controls: [] };
  assert.throws(() => buildManifest({ ...base, meta: { ...meta, fence: 99 } }), /fence/);
  assert.throws(() => buildManifest({ ...base, meta: { ...meta, files: [] } }), /files/);
  assert.throws(() => buildManifest({ ...base, meta: { ...meta, tools: [] } }), /tools/);
});

test('artifactName names one bundle per item: result-<attempt_id>-<index>.tar.age', () => {
  assert.equal(artifactName('01JD', 0), 'result-01JD-0.tar.age');
  assert.equal(artifactName('att-1', 24), 'result-att-1-24.tar.age');
  assert.throws(() => artifactName('../x', 0), /attempt/);
  for (const bad of [undefined, -1, 1.5, '0', NaN, 10_000]) {
    assert.throws(() => artifactName('att-1', bad), /item index/, String(bad));
  }
});

test('legacyArtifactName is the one-item name ingest still accepts', () => {
  assert.equal(legacyArtifactName('01JD'), 'result-01JD.tar.age');
  assert.throws(() => legacyArtifactName('../x'), /attempt/);
});
