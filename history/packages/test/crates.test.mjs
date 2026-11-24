import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mockFetch, makeTarGz, noSleep } from './helpers.mjs';
import { createHttp } from '../lib/http.mjs';
import { CsvParser, processDump, runCrates } from '../crates.mjs';

test('CsvParser handles quotes, embedded commas, newlines, CRLF', () => {
  const rows = []; const p = new CsvParser((r) => rows.push(r));
  p.push('a,b,c\r\n1,"x, ""y""\nz",\n"q",,');
  p.end();
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, "y"\nz', ''], ['q', '', '']]);
});

const files = {
  '2026-11-23-020000/metadata.json': JSON.stringify({ timestamp: '2026-11-23T02:00:00Z', crates_io_commit: 'abc' }),
  '2026-11-23-020000/data/crates.csv': 'created_at,description,id,name,repository,updated_at\n' +
    '2020,"A server, for MCP",1,mcp-thing,https://example.test/a,2026-11-01\n' +
    '2020,"web\nframework",2,serde,,2026-11-02\n' +
    '2020,plain,3,tagged,,2026-11-03\n',
  '2026-11-23-020000/data/keywords.csv': 'crates_cnt,id,keyword\n1,10,mcp\n1,11,web\n',
  '2026-11-23-020000/data/crates_keywords.csv': 'crate_id,keyword_id\n3,10\n2,11\n',
  '2026-11-23-020000/data/crate_downloads.csv': 'crate_id,downloads\n1,500\n2,999999\n3,12\n',
  '2026-11-23-020000/data/versions.csv': 'crate_id,created_at,num,yanked\n1,2026-10-01,0.1.0,f\n1,2026-11-01,0.2.0,f\n3,2026-09-01,1.0.0,f\n2,2026-01-01,1.0.0,f\n',
  '2026-11-23-020000/data/other.csv': 'x\n1\n',
};

test('processDump computes the MCP subset, hash and metadata from a tar.gz', async () => {
  const gz = makeTarGz(files);
  // feed in awkward 7-byte chunks to exercise buffering
  const chunks = []; for (let i = 0; i < gz.length; i += 7) chunks.push(gz.subarray(i, i + 7));
  const r = await processDump(Readable.from(chunks));
  assert.equal(r.dump.sha256, createHash('sha256').update(gz).digest('hex'));
  assert.equal(r.dump.bytes, gz.length);
  assert.equal(r.dump.timestamp, '2026-11-23T02:00:00Z');
  assert.equal(r.dump.commit, 'abc');
  assert.equal(r.totals.crates, 3);
  assert.deepEqual(r.rows.map((x) => [x.id, x.match, x.downloads_total, x.versions, x.latest_version_at]), [
    ['mcp-thing', ['name', 'description'], 500, 2, '2026-11-01'],
    ['tagged', ['keyword'], 12, 1, '2026-09-01'],
  ]);
  assert.equal(r.rows[0].description_len, 'A server, for MCP'.length);
  assert.ok(!('description' in r.rows[0]));
});

test('R-HIST-01: processDump keeps seeded crates the matcher misses, with reason seed', async () => {
  const r = await processDump(Readable.from([makeTarGz(files)]), { seedNames: new Set(['serde', 'tagged', 'not-in-dump']) });
  assert.deepEqual(r.rows.map((x) => [x.id, x.match, x.downloads_total]), [
    ['mcp-thing', ['name', 'description'], 500],
    ['serde', ['seed'], 999999],
    ['tagged', ['keyword', 'seed'], 12],
  ]);
});

test('runCrates skips when ETag unchanged', async () => {
  const f = mockFetch(() => ({ headers: { etag: '"e1"' }, body: '' }));
  const r = await runCrates({ http: createHttp({ fetch: f, sleep: noSleep }), state: { etag: '"e1"' } });
  assert.equal(r.skipped, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, 'HEAD');
});

test('R-HIST-01: runCrates re-reads an unchanged dump when the seeded crates change', async () => {
  const gz = makeTarGz(files);
  const f = mockFetch((u, init) => ({ headers: { etag: '"e1"' }, body: '', stream: init.method === 'HEAD' ? null : Readable.from([gz]) }));
  const http = createHttp({ fetch: f, sleep: noSleep });
  const r = await runCrates({ http, state: { etag: '"e1"' }, seedNames: new Set(['serde']) });
  assert.ok(!r.skipped);
  assert.ok(r.rows.some((x) => x.id === 'serde'));
  const again = await runCrates({ http, state: r.state, seedNames: new Set(['serde']) });
  assert.equal(again.skipped, true);
});

test('runCrates downloads when ETag changed', async () => {
  const gz = makeTarGz(files);
  const f = mockFetch((u, init) => ({ headers: { etag: '"e2"' }, body: '', stream: init.method === 'HEAD' ? null : Readable.from([gz]) }));
  const r = await runCrates({ http: createHttp({ fetch: f, sleep: noSleep }), state: { etag: '"e1"' } });
  assert.equal(r.rows.length, 2);
  assert.equal(r.state.etag, '"e2"');
});
