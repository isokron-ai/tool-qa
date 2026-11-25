// Synthetic accepted results for the publisher's tests. Nothing here is real data:
// the subjects are made up, the secrets are obvious test strings, and the keys are
// generated per run.

import { createHash } from 'node:crypto';

import { buildManifest } from '../../worker-kit/contract.mjs';
import { parseRegistry } from '../../ingest/registry.mjs';

export const sha = (d) => createHash('sha256').update(d).digest('hex');

export const REGISTRY_TEXT = `version: 0
fields:
  - {id: registry_name, layer: identity_discovery, type: string, unit: none, source: discover, class: P, redaction: [R1], status: active}
  - {id: tool_count, layer: protocol, type: integer, unit: count, source: scan-live, class: P, redaction: null, status: active}
  - {id: server_info, layer: protocol, type: object, unit: none, source: scan-live, class: P, redaction: [R1], status: active}
  - {id: registration_provenance, layer: source_build, type: object, unit: none, source: scan-static, class: P-s, redaction: null, status: active}
  - {id: stderr_counts, layer: runtime, type: object, unit: none, source: scan-live, class: P, redaction: [R2], status: active}
  - {id: startup_ms, layer: runtime, type: integer, unit: ms, source: scan-live, class: P, redaction: null, status: active}
  - {id: not_yet_collected, layer: protocol, type: integer, unit: count, source: scan-live, class: P, redaction: null, status: planned}
  - {id: injection_like_text_patterns, layer: derived_semantics, type: array, unit: none, source: ingest-compact, class: P-h, redaction: null, status: active}
  - {id: tool_descriptions_text, layer: derived_semantics, type: array, unit: none, source: scan-live, class: P-t, redaction: [R1], status: active}
  - {id: write_tool_confirmed, layer: write_tests, type: boolean, unit: none, source: writecheck, class: B, redaction: null, status: active}
  - {id: static_vs_live_agreement, layer: derived_semantics, type: object, unit: none, source: ingest-compact, class: PA, redaction: null, status: active}
  - {id: raw_transcript, layer: runtime, type: string, unit: none, source: scan-live, class: X, redaction: [R2], status: active}
  - {id: ci_exploitable_trigger, layer: source_build, type: object, unit: none, source: scan-static, class: S, redaction: null, status: planned}
  - {id: injection_like_text_confirmed, layer: derived_semantics, type: object, unit: none, source: scan-static, class: M, redaction: null, status: active}
`;
export const registry = () => parseRegistry(REGISTRY_TEXT);

export const RUN_KEY = (n) => sha(`run-key-${n}`);

const SUBJECTS = {
  demo: { id: 'io.example/demo', repo: 'example/demo', sha: 'c'.repeat(40) },
  other: { id: 'io.example/other', repo: 'example/other', sha: 'd'.repeat(40) },
  third: { id: 'io.example/third', repo: 'example/third', sha: null },
};

/**
 * Entries (path, data) of one item laid out as accepted/<attempt>/<index>/..., as the
 * pump's keep-forever file holds them: manifest.json, ingest.json, observations/, and
 * also results/ and raw/ files, which the publisher must never read.
 */
export function item({
  attempt = 'att-1', index = 0, n = 1, subject = 'demo', lane = 'live-probe', finishedAt = '2026-11-24T10:05:00Z',
  observations = [{ field: 'tool_count', value: 3 }, { field: 'registry_name', value: 'demo' }],
  skips = [], outcome = 'accepted', dir = 'accepted', mutateManifest, mutateIngest, extraFiles = {},
} = {}) {
  const obsText = observations.map((o) => `${JSON.stringify(o)}\n`).join('');
  const files = {
    'observations/main.ndjson': obsText,
    'results/report.json': JSON.stringify({ findings: ['TEST-ONLY-FINDING-TEXT'], note: 'results files are never published' }),
    'raw/subject/repo.json': JSON.stringify({ readme: 'TEST-ONLY-RAW-TEXT' }),
    ...extraFiles,
  };
  const list = Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) }));
  const manifest = buildManifest({
    identity: { attempt_id: attempt, fence: 7, run_key: RUN_KEY(n) },
    workflow: { repo: 'isokron-ai/mcp-check', file: `.github/workflows/${lane}.yml`, sha: '1'.repeat(40), run_id: 4242, run_attempt: 1 },
    meta: {
      subject: { ...SUBJECTS[subject] }, tools: [{ name: 'mcp-check', version: '0.1.0' }], oracles: [], settings_manifest_digest: 'e'.repeat(64),
      started_at: '2026-11-24T10:00:00Z', finished_at: finishedAt, skips,
      controls: [{ kind: 'known_good', expected: 'ok', observed: 'ok' }],
    },
    files: list,
  });
  if (mutateManifest) mutateManifest(manifest);
  const rf = skips.length ? null : 'assessed';
  const ingest = {
    outcome: 'accepted', reason: null, item_index: index,
    ledger: { run_key: RUN_KEY(n), fence: 7, current_fence: 7 },
    bundle: rf ? { coverage: rf } : {},
  };
  if (mutateIngest) mutateIngest(ingest);
  const base = `${dir}/${attempt}/${index}`;
  return [
    { path: `${base}/manifest.json`, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: `${base}/ingest.json`, data: Buffer.from(`${JSON.stringify(ingest, null, 2)}\n`) },
    ...list.map((f) => ({ path: `${base}/${f.path}`, data: f.data })),
  ];
}

export const flat = (...items) => items.flat();
