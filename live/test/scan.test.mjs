// live/vendor-names.mjs and live/scan.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { hasVendorName, scanVendorNames, VENDOR_WORDS } from '../vendor-names.mjs';
import { scanPublic } from '../scan.mjs';

const w = (...p) => p.join('');
const FAKE_GH = w('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
const FAKE_AWS = w('AK', 'IA', 'ABCDEFGHIJKLMNOP');

test('the vendor list covers at least the R-PUB-08 words, and is not spelled out in any live/ file', () => {
  const rpub08 = [['cl', 'aude'], ['anthr', 'opic'], ['open', 'ai'], ['gp', 't-'], ['gem', 'ini'], ['op', 'us '], ['son', 'net'], ['ha', 'iku'], ['cha', 'tg', 'pt'], ['gr', 'ok']].map((p) => p.join(''));
  for (const word of rpub08) assert.ok(hasVendorName(`x ${word} y`) && hasVendorName(word.toUpperCase()), word.trim());
  const root = new URL('../', import.meta.url);
  const files = [...readdirSync(root).filter((f) => /\.(mjs|md)$/.test(f)), ...readdirSync(new URL('test/', root)).filter((f) => f.endsWith('.mjs')).map((f) => `test/${f}`)];
  for (const f of files) assert.ok(!hasVendorName(readFileSync(new URL(f, root), 'utf8')), `${f} names a vendor`);
  assert.ok(VENDOR_WORDS.length >= 15);
});

test('vendor names are found inside repository names; plain words like coherent or cursor are not', () => {
  assert.ok(hasVendorName(w('someone/mcp-', 'open', 'ai', '-bridge')));
  assert.ok(hasVendorName(w('Gem', 'ini', 'Tools')));
  assert.equal(hasVendorName('a coherent, discarded record'), false);
  assert.equal(hasVendorName('acme-labs/mcp-server-weather'), false);
  const hits = scanVendorNames(w('x ', 'son', 'net', ' y'));
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['end', 'length', 'rule', 'start']);
});

test('scanPublic finds secrets, emails and vendor names in values and keys, and reports only rule and path', () => {
  const value = {
    ok: 'fine',
    list: ['fine', `token ${FAKE_GH}`],
    nested: { mail: 'person@realmail.org', pin: FAKE_AWS, tool: w('cl', 'aude', '-thing') },
    [w('open', 'ai')]: 1,
    [`k ${FAKE_GH}`]: 2,
  };
  const { ok, hits } = scanPublic(value);
  assert.equal(ok, false);
  const got = hits.map((h) => `${h.rule} ${h.path}`).sort();
  assert.deepEqual(got, [
    'aws-access-key-id $.nested.pin',
    'email $.nested.mail',
    'github-token $.list[1]',
    'github-token $[?]',
    'vendor-name $.nested.tool',
    'vendor-name $[?]',
  ]);
  const text = JSON.stringify(hits);
  for (const secret of [FAKE_GH, FAKE_AWS, 'person@realmail.org', w('open', 'ai'), w('cl', 'aude')]) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), 'a hit never carries the text');
  for (const h of hits) assert.deepEqual(Object.keys(h).sort(), ['path', 'rule']);
});

test('scanPublic passes clean values, reserved example emails, and flags non-finite numbers and deep nesting', () => {
  assert.deepEqual(scanPublic({ a: 'x@example.com', b: [1, 2, { c: 'acme-labs/files-mcp' }] }), { ok: true, hits: [] });
  assert.equal(scanPublic({ n: Number.NaN }).ok, false);
  let deep = 'x';
  for (let i = 0; i < 40; i++) deep = [deep];
  assert.deepEqual(scanPublic(deep).hits.map((h) => h.rule), ['too-deep']);
});
