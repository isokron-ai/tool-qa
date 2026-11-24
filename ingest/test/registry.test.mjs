import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  REGISTRY_URL, REGISTRY_SHA256, REGISTRY_COMMIT, REGISTRY_REPO, REGISTRY_PATH, FIELD_TYPES, RegistryError,
  parseRegistry, loadRegistry, checkValueType, validateObservations,
} from '../registry.mjs';

// Same shape as fields/registry.yaml in the results repo (flow mappings, one per line).
const SAMPLE = `# Field registry, version 0.
version: 0
fields:
  - {id: registry_name, layer: identity_discovery, type: string, unit: none, source: discover, class: P, redaction: [R1], status: planned}
  - {id: registry_icons, layer: identity_discovery, type: array, unit: none, source: discover, class: P, redaction: null, status: planned}
  - {id: registry_repository, layer: identity_discovery, type: object, unit: none, source: discover, class: P, redaction: null, status: planned}
  - {id: namespace_type, layer: identity_discovery, type: enum, unit: none, source: discover, class: P, redaction: null, status: planned}
  - {id: namespace_matches_repo_owner, layer: identity_discovery, type: boolean, unit: none, source: discover, class: P, redaction: null, status: active}
  - {id: oci_digest, layer: identity_discovery, type: hash, unit: none, source: discover, class: P, redaction: null, status: planned}
  - {id: tool_count, layer: surface, type: integer, unit: count, source: check, class: P, redaction: null, status: planned}
  - {id: init_latency, layer: runtime, type: number, unit: ms, source: check, class: P, redaction: null, status: planned}
  - {id: first_seen_at, layer: history, type: timestamp, unit: none, source: discover, class: P, redaction: null, status: planned}
  - {id: old_field, layer: history, type: string, unit: none, source: discover, class: P, redaction: null, status: deprecated}
  - {id: env_default, layer: identity_discovery, type: string, unit: none, source: discover, class: X, redaction: [R2, R3], status: planned}
`;

const nd = (...records) => Buffer.from(records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
const files = (obj) => new Map(Object.entries(obj));

test('parseRegistry reads the results-repo format', () => {
  const reg = parseRegistry(SAMPLE);
  assert.equal(reg.version, 0);
  assert.equal(reg.fields.size, 11);
  assert.deepEqual(reg.fields.get('registry_name'), {
    id: 'registry_name', layer: 'identity_discovery', type: 'string', unit: 'none',
    source: 'discover', class: 'P', redaction: ['R1'], status: 'planned',
  });
  assert.equal(reg.fields.get('registry_icons').redaction, null);
  assert.deepEqual(reg.fields.get('env_default').redaction, ['R2', 'R3']);
  assert.equal(reg.sha256, createHash('sha256').update(SAMPLE).digest('hex'));
});

test('parseRegistry rejects malformed registries', () => {
  const entry = (over) => {
    const e = { id: 'a_field', layer: 'x', type: 'string', unit: 'none', source: 's', class: 'P', redaction: 'null', status: 'planned', ...over };
    return `version: 0\nfields:\n  - {${Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ')}}\n`;
  };
  const bad = {
    'no fields': 'version: 0\n',
    'bad version': 'version: zero\nfields:\n  - {id: a, layer: x, type: string, unit: none, source: s, class: P, redaction: null, status: planned}\n',
    'unknown type': entry({ type: 'float' }),
    'unknown status': entry({ status: 'retired' }),
    'bad id': entry({ id: 'Bad-Id' }),
    'missing type': entry({ type: undefined }),
    'bad redaction': entry({ redaction: '[R9]' }),
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.throws(() => parseRegistry(text), RegistryError, name);
  }
  const dup = `${entry({})}  - {id: a_field, layer: x, type: string, unit: none, source: s, class: P, redaction: null, status: planned}\n`;
  assert.throws(() => parseRegistry(dup), /duplicate field id a_field/);
  assert.throws(() => parseRegistry('version: 0\nfields: [\n'), RegistryError);
  // Keys added to the registry later are ignored, not fatal.
  assert.equal(parseRegistry(entry({ description: 'later' })).fields.get('a_field').description, undefined);
});

test('loadRegistry fetches the pinned URL and checks its digest', async () => {
  const body = Buffer.from(SAMPLE);
  const calls = [];
  const fetchOk = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(body, { status: 200 });
  };
  const reg = await loadRegistry({ fetch: fetchOk, expectSha256: createHash('sha256').update(body).digest('hex') });
  assert.equal(reg.fields.size, 11);
  assert.equal(calls[0].url, REGISTRY_URL);
  assert.match(REGISTRY_URL, /^https:\/\/raw\.githubusercontent\.com\/isokron-ai\/mcp-results\/[0-9a-f]{40}\/fields\/registry\.yaml$/);
  assert.match(REGISTRY_SHA256, /^[0-9a-f]{64}$/);

  // Default expectation is the pinned digest, which the sample does not match.
  await assert.rejects(loadRegistry({ fetch: fetchOk }), /sha256 .* does not match the pinned/);
  await assert.rejects(
    loadRegistry({ fetch: async () => new Response('nope', { status: 404 }) }),
    /HTTP 404/,
  );
  await assert.rejects(loadRegistry({ fetch: fetchOk, url: 'http://example.com/r.yaml' }), /https/);
});

test('loadRegistry reads a local file without a digest pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  try {
    const p = join(dir, 'registry.yaml');
    writeFileSync(p, SAMPLE);
    const reg = await loadRegistry({ path: p });
    assert.equal(reg.fields.size, 11);
    assert.equal(reg.source, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkValueType covers every registry type', () => {
  const ok = {
    string: ['', 'x'], integer: [0, -3, 2 ** 53 - 1], number: [0, 1.5, -2], boolean: [true, false],
    enum: ['stdio'], array: [[], [1, 'a']], object: [{}, { a: 1 }],
    timestamp: ['2026-01-02T03:04:05Z', '2026-01-02T03:04:05.123+02:00'],
    hash: ['a'.repeat(64)],
  };
  const bad = {
    string: [1, null, {}], integer: [1.5, '1', 2 ** 53, NaN], number: ['1', Infinity, NaN], boolean: ['true', 0],
    enum: ['', 3, 'has space'], array: [{}, 'a'], object: [[], null, 'a'],
    timestamp: ['2026-01-02', '2026-13-02T03:04:05Z', 5], hash: ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)],
  };
  assert.deepEqual(Object.keys(ok).sort(), [...FIELD_TYPES].sort());
  for (const [type, values] of Object.entries(ok)) {
    for (const v of values) assert.equal(checkValueType(type, v), true, `${type} ${JSON.stringify(v)}`);
  }
  for (const [type, values] of Object.entries(bad)) {
    for (const v of values) assert.equal(checkValueType(type, v), false, `${type} ${String(v)}`);
  }
  assert.throws(() => checkValueType('float', 1), /unknown field type/);
});

test('validateObservations accepts declared fields with the right types', () => {
  const reg = parseRegistry(SAMPLE);
  const r = validateObservations(files({
    'observations/discover.ndjson': nd(
      { field: 'registry_name', value: 'demo' },
      { field: 'tool_count', value: 3, stage: 'list_tools' },
      { field: 'namespace_matches_repo_owner', value: true },
      { field: 'oci_digest', value: null, why: 'no image published' },
      { field: 'first_seen_at', value: '2026-01-02T03:04:05Z' },
    ),
    'results/report.json': Buffer.from('{"not": "checked here"}'),
    'raw/x.ndjson': Buffer.from('not json at all'),
  }), reg);
  assert.deepEqual(r, { ok: true, errors: [], records: 5, measured: 4 }, 'the null value is a record, not a measurement');
});

test('validateObservations reports each kind of problem with a reason', () => {
  const reg = parseRegistry(SAMPLE);
  const r = validateObservations(files({
    'observations/a.ndjson': nd(
      { field: 'made_up_field', value: 1 },
      { field: 'old_field', value: 'x' },
      { field: 'tool_count', value: 'three' },
      { field: 'oci_digest', value: null },
      { field: 'registry_name', value: 'x', extra: 1 },
      { value: 1 },
      { field: 'registry_name' },
      'not json',
      '[1,2]',
      { field: 'registry_name', value: 'x', stage: 'Bad Stage' },
    ),
    'observations/b.json': Buffer.from('{}'),
    'observations/c.ndjson': Buffer.from([0xff, 0xfe, 0x0a]),
  }), reg);
  assert.equal(r.ok, false);
  const got = r.errors.map((e) => [e.path, e.line ?? null, e.reason]);
  assert.deepEqual(got, [
    ['observations/a.ndjson', 1, 'undeclared_field'],
    ['observations/a.ndjson', 2, 'deprecated_field'],
    ['observations/a.ndjson', 3, 'field_type'],
    ['observations/a.ndjson', 4, 'observation_format'],
    ['observations/a.ndjson', 5, 'observation_format'],
    ['observations/a.ndjson', 6, 'observation_format'],
    ['observations/a.ndjson', 7, 'observation_format'],
    ['observations/a.ndjson', 8, 'observation_format'],
    ['observations/a.ndjson', 9, 'observation_format'],
    ['observations/a.ndjson', 10, 'observation_format'],
    ['observations/b.json', null, 'observation_format'],
    ['observations/c.ndjson', null, 'observation_format'],
  ]);
  assert.equal(r.errors[0].field, 'made_up_field');
  // Messages describe the problem but never copy observed values.
  assert.ok(r.errors.every((e) => !e.message.includes('three')));
});

test('validateObservations caps the error list', () => {
  const reg = parseRegistry(SAMPLE);
  const many = Array.from({ length: 200 }, (_, i) => ({ field: `nope_${i}`, value: 1 }));
  const r = validateObservations(files({ 'observations/a.ndjson': nd(...many) }), reg, { maxErrors: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 10);
  assert.equal(r.truncated, true);
});

test('R-COV-04: the pinned registry declares fault_side and coverage_state, and active fields are accepted like planned ones', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../meta/test/fixtures/registry-pinned.yaml', import.meta.url), 'utf8');
  const reg = parseRegistry(text);
  assert.equal(reg.sha256, REGISTRY_SHA256, 'the test copy is the file ingest pins');
  for (const id of ['fault_side', 'coverage_state']) {
    const f = reg.fields.get(id);
    assert.ok(f, id);
    assert.deepEqual([f.type, f.status], ['enum', 'active'], id);
  }
  // The fields scan-static writes today are active, and still accepted as observations.
  for (const id of ['commit_sha', 'commit_date', 'registration_provenance']) assert.equal(reg.fields.get(id).status, 'active', id);
  const obs = new Map([['observations/static.ndjson', Buffer.from(`${JSON.stringify({ field: 'commit_sha', value: 'a'.repeat(40), stage: 'static' })}\n`)]]);
  assert.equal(validateObservations(obs, { ...reg, source: 'test' }).ok, true);
});

test('R-COV-08: the pin and its test copy agree: commit, path and sha256 move together', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = readFileSync(new URL('../../meta/test/fixtures/registry-pinned.yaml', import.meta.url));
  const source = JSON.parse(readFileSync(new URL('../../meta/test/fixtures/registry-pinned.source.json', import.meta.url), 'utf8'));
  const sha = createHash('sha256').update(fixture).digest('hex');
  assert.equal(sha, REGISTRY_SHA256, 'the test copy is the file REGISTRY_SHA256 names');
  assert.equal(source.sha256, REGISTRY_SHA256, 'the recorded source names the pinned digest');
  assert.equal(source.commit, REGISTRY_COMMIT, 'the test copy came from the pinned commit');
  assert.equal(source.repo, REGISTRY_REPO);
  assert.equal(source.path, REGISTRY_PATH);
  assert.equal(REGISTRY_URL, `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${source.path}`);
});
