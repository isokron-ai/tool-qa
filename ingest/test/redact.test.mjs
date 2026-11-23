import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES, scanText, maskText, scanValue, redactValue, r2Summary, stripDisplayUnsafe, scanFiles,
} from '../redact.mjs';

// Synthetic, well-formed but fake credentials, assembled at run time so this
// file itself never contains a token-shaped string.
const j = (...p) => p.join('');
const FAKE = {
  'github-token': j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  'github-fine-grained-pat': j('github', '_pat_', '1'.repeat(22), '_', 'a'.repeat(59)),
  'aws-access-key-id': j('AK', 'IA', 'Z7X6C5V4B3N2M1L0'),
  'private-key-block': j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'),
  'age-secret-key': j('AGE-SECRET', '-KEY-1', 'Q'.repeat(58)),
  'slack-token': j('xo', 'xb-', '1234567890-abcdefghij'),
  'stripe-secret-key': j('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0k1L2'),
  'google-api-key': j('AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  'npm-token': j('np', 'm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  'gitlab-pat': j('gl', 'pat-', 'a1B2c3D4e5F6g7H8i9J0'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  'generic-sk-key': j('sk', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  'url-credentials': j('https://deploy', ':', 'hunter2hunter2', '@', 'example.org/x'),
  'generic-secret-assignment': j('api_key', '="', 'Zx9Qw8Er7Ty6Ui5Op4As3', '"'),
  email: j('maintainer', '@', 'some-company.io'),
  canary: j('ISOKRON', '_CANARY_', 'a1b2c3d4e5'),
};

test('every rule has an id, a class in R1..R4 and a test value here', () => {
  for (const r of RULES) {
    assert.match(r.id, /^[a-z0-9-]+$/);
    assert.ok(['R1', 'R2', 'R3', 'R4'].includes(r.class), r.id);
    assert.ok(FAKE[r.id], `no synthetic sample for ${r.id}`);
  }
});

for (const [rule, sample] of Object.entries(FAKE)) {
  test(`rule ${rule} finds its sample inside text and reports only the span`, () => {
    const text = `before ${sample} after`;
    const hits = scanText(text);
    const hit = hits.find((h) => h.rule === rule);
    assert.ok(hit, `${rule} not found in ${JSON.stringify(hits)}`);
    const at = text.indexOf(sample);
    assert.ok(hit.start >= at && hit.end <= at + sample.length && hit.end > hit.start, 'span lies inside the sample');
    assert.equal(hit.length, hit.end - hit.start);
    assert.equal(JSON.stringify(hit).includes(sample), false, 'a hit never carries the matched text');
  });
}

test('ordinary text has no hits', () => {
  const benign = [
    'Lists the files in a directory. Returns JSON.',
    'Set GITHUB_TOKEN in the environment before you start the server.',
    'token: string (required) - the API token to use',
    '"password": "The password for the database user"',
    'git clone git@github.com:example/server.git',
    'Contact: someone@example.com for help',
    'https://user:${TOKEN}@host.example/repo',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'ULID 01JD0000000000000000000000 and uuid 123e4567-e89b-12d3-a456-426614174000',
    'api_key="YOUR_API_KEY_HERE"',
  ];
  for (const t of benign) assert.deepEqual(scanText(t), [], t);
});

test('caller-supplied canary values are found (R4)', () => {
  const hits = scanText('value echoed: dummy-canary-value-1234', { canaries: ['dummy-canary-value-1234'] });
  assert.deepEqual(hits.map((h) => [h.rule, h.class]), [['canary', 'R4']]);
});

test('maskText masks only the matching spans; canaries become [CANARY]', () => {
  const text = `key ${FAKE['github-token']} and ${FAKE.canary} end`;
  const masked = maskText(text, scanText(text));
  assert.equal(masked, 'key [REDACTED:github-token] and [CANARY] end');
});

test('maskText merges overlapping hits', () => {
  assert.equal(maskText('abcdefgh', [{ rule: 'a', class: 'R1', start: 1, end: 4 }, { rule: 'b', class: 'R1', start: 3, end: 6 }]), 'a[REDACTED:a]gh');
});

test('scanValue reports JSON paths for strings and keys', () => {
  const doc = { tools: [{ name: 'x', description: `uses ${FAKE['aws-access-key-id']}` }], [FAKE.email]: 1 };
  const hits = scanValue(doc);
  assert.deepEqual(hits.map((h) => [h.rule, h.json_path]).sort(), [
    ['aws-access-key-id', '$.tools[0].description'],
    ['email', '$'],
  ].sort());
});

test('redactValue returns a masked copy and leaves the input alone', () => {
  const doc = { a: `t=${FAKE['npm-token']}`, n: 5, nested: { b: [FAKE.canary] } };
  const before = structuredClone(doc);
  const { value, hits } = redactValue(doc);
  assert.deepEqual(doc, before);
  assert.deepEqual(value, { a: 't=[REDACTED:npm-token]', n: 5, nested: { b: ['[CANARY]'] } });
  assert.equal(hits.length, 2);
});

test('r2Summary keeps only a hash and a length', () => {
  const s = r2Summary('secret-ish value');
  assert.deepEqual(Object.keys(s).sort(), ['length', 'sha256']);
  assert.equal(s.length, 16);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
});

test('stripDisplayUnsafe removes bidi, zero-width and tag characters', () => {
  const t = `a\u202Eb\u200Bc\u2066d\uFEFFe${String.fromCodePoint(0xE0041)}f`;
  assert.equal(stripDisplayUnsafe(t), 'abcdef');
});

test('scanFiles scans JSON by path, NDJSON per line, and other files as text', () => {
  const files = new Map([
    ['results/a.json', Buffer.from(JSON.stringify({ x: { y: FAKE['github-token'] } }))],
    ['observations/b.ndjson', Buffer.from(`{"field":"f","value":"ok"}\n{"field":"g","value":"${FAKE.email}"}\n`)],
    ['raw/stdout.bin', Buffer.from(`line\n${FAKE['private-key-block']}\n`)],
    ['logs/clean.txt', Buffer.from('nothing here')],
  ]);
  const hits = scanFiles(files);
  assert.deepEqual(hits.map((h) => [h.path, h.rule, h.json_path ?? null, h.line ?? null]).sort(), [
    ['observations/b.ndjson', 'email', '$.value', 2],
    ['raw/stdout.bin', 'private-key-block', null, null],
    ['results/a.json', 'github-token', '$.x.y', null],
  ].sort());
  for (const h of hits) assert.equal(JSON.stringify(h).includes('@some-company'), false);
});

test('scanFiles falls back to text when a .json file does not parse', () => {
  const hits = scanFiles(new Map([['results/bad.json', Buffer.from(`{not json ${FAKE['aws-access-key-id']}`)]]));
  assert.deepEqual(hits.map((h) => h.rule), ['aws-access-key-id']);
});
