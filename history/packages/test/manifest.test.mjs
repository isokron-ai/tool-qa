import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeNdjsonGz, writeManifest, sha256 } from '../lib/manifest.mjs';

test('ndjson.gz and manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  const name = writeNdjsonGz(dir, 'a.ndjson.gz', [{ a: 1 }, { a: 2 }]);
  assert.equal(gunzipSync(readFileSync(join(dir, name))).toString(), '{"a":1}\n{"a":2}\n');
  const { manifest } = writeManifest({ dir, source: 't', files: [{ name, rows: 2 }], startedAt: 0, finishedAt: 1000, errors: [new Error('x')] });
  assert.equal(manifest.files[0].sha256, sha256(readFileSync(join(dir, name))));
  assert.equal(manifest.files[0].rows, 2);
  assert.equal(manifest.ok, false);
  assert.deepEqual(manifest.errors, ['Error: x']);
  assert.equal(manifest.started_at, '1970-01-01T00:00:00.000Z');
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest-t.json'))).source, 't');
  // reproducible
  writeNdjsonGz(dir, 'b.ndjson.gz', [{ a: 1 }, { a: 2 }]);
  assert.equal(sha256(readFileSync(join(dir, 'a.ndjson.gz'))), sha256(readFileSync(join(dir, 'b.ndjson.gz'))));
});
