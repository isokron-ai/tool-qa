// docs/MEASUREMENTS.md says measurements stay separate and are never combined into one score. This test holds
// the parts that can be checked: the pinned field registry has no combined-score field, every registry layer
// belongs to one named lane (or is marked as not a measurement), and loop code emits no combined-score field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRegistry } from '../ingest/registry.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// A field id is split on "_" and none of its words may be one of these. "scorecard" is a third party's own
// named result and is a different word.
const COMBINING = new Set(['score', 'scores', 'grade', 'grades', 'rating', 'ratings', 'rank', 'ranking', 'overall', 'composite', 'combined']);
const combining = (id) => id.split('_').filter((w) => COMBINING.has(w));

// Each registry layer sits in exactly one lane, or is not a measurement of the server. Adding a layer to the
// registry fails the test below until it is placed here and in docs/MEASUREMENTS.md.
export const LANES = ['protocol and conformance', 'catalog and tool-definition quality', 'behaviour', 'write safety', 'supply chain and release provenance', 'hardening'];
const LANE_OF_LAYER = {
  protocol: 'protocol and conformance',
  derived_semantics: 'catalog and tool-definition quality',
  runtime: 'behaviour',
  write_tests: 'write safety',
  source_build: 'supply chain and release provenance',
  repo_ecosystem: 'supply chain and release provenance',
  identity_discovery: null, // who the server is; not a measurement
  tool_telemetry: null, // coverage state, fault side, our own timings
  longitudinal: null, // history of the others, kept per lane
};

const registry = () => parseRegistry(readFileSync(join(ROOT, 'meta/test/fixtures/registry-pinned.yaml'), 'utf8'));

test('the pinned field registry has no field that combines measurements into one score', () => {
  const { fields } = registry();
  assert.ok(fields.size > 100, 'the registry was read');
  const bad = [...fields.keys()].filter((id) => combining(id).length);
  assert.deepEqual(bad, [], `registry fields named like a combined measure: ${bad.join(', ')}`);
  // The check would catch what it is for.
  assert.deepEqual(combining('overall_score'), ['overall', 'score']);
  assert.deepEqual(combining('scorecard_result'), []);
});

test('every registry layer belongs to one lane or is marked as not a measurement, and the doc names every lane', () => {
  const layers = new Set([...registry().fields.values()].map((f) => f.layer));
  for (const layer of layers) assert.ok(layer in LANE_OF_LAYER, `registry layer "${layer}" has no lane: place it in test/measurements.test.mjs and docs/MEASUREMENTS.md`);
  for (const lane of Object.values(LANE_OF_LAYER)) assert.ok(lane === null || LANES.includes(lane));
  const doc = readFileSync(join(ROOT, 'docs/MEASUREMENTS.md'), 'utf8').toLowerCase().replace(/\s+/g, ' ');
  for (const lane of LANES) assert.ok(doc.includes(lane), `docs/MEASUREMENTS.md does not name the lane "${lane}"`);
});

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'test' || e.name === 'fixtures' || e.name === 'history') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

test('loop code emits no observation field named like a combined measure', () => {
  let seen = 0;
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bfield:\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) {
      seen++;
      assert.deepEqual(combining(m[1]), [], `${relative(ROOT, file)} emits field "${m[1]}", which reads as a combined measure`);
    }
  }
  assert.ok(seen > 0, 'the scan found field names to check');
});
