import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ageDecrypt, ageEncrypt, agePublicKey, parseRecipientFile, parseIdentity, readSealRecipients, AgeError,
} from '../age.mjs';

const AGE = process.env.AGE_BIN || 'age';
const KEYGEN = process.env.AGE_KEYGEN_BIN || 'age-keygen';
const haveAge = spawnSync(AGE, ['--version']).status === 0 && spawnSync(KEYGEN, ['--version']).status === 0;
const skip = haveAge ? false : 'age and age-keygen are not on PATH (set AGE_BIN / AGE_KEYGEN_BIN to run this test)';

function keypair() {
  const identity = spawnSync(KEYGEN, [], { encoding: 'utf8' }).stdout;
  const recipient = spawnSync(KEYGEN, ['-y'], { input: identity, encoding: 'utf8' }).stdout.trim();
  return { identity, recipient };
}

// Built at run time so the file holds no key-shaped literal.
const fakeKey = (ch) => `AGE-SECRET-KEY-1${ch.repeat(58)}`;
const fakeRecipient = (ch) => `age1${ch.repeat(58)}`;

test('parseRecipientFile: comments and blank lines are ignored, anything else must be a key', () => {
  assert.deepEqual(parseRecipientFile('# placeholder\n\n   # still nothing\n'), []);
  assert.deepEqual(parseRecipientFile(`# key\n${fakeRecipient('q')}\n${fakeRecipient('p')}\n`), [fakeRecipient('q'), fakeRecipient('p')]);
  assert.throws(() => parseRecipientFile('ssh-ed25519 AAAA\n'), /line 1 is not an age X25519 public key/);
  assert.throws(() => parseRecipientFile(`${fakeRecipient('q')} trailing\n`), AgeError);
});

test('parseIdentity: needs exactly one X25519 identity and never echoes input', () => {
  const k = fakeKey('Q');
  assert.equal(parseIdentity(`# created: 2026-01-01\n# public key: ${fakeRecipient('q')}\n${k}\n`), k);
  assert.equal(parseIdentity(`  ${k}  \r\n`), k);
  for (const bad of ['', 'nonsense', `${k}\n${fakeKey('P')}\n`, `${k}x`, `AGE-PLUGIN-YUBIKEY-1QQQ\n`]) {
    try {
      parseIdentity(bad);
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof AgeError);
      assert.ok(!err.message.includes('AGE-SECRET-KEY-1Q'), 'message must not carry the key');
    }
  }
});

test('encrypt and decrypt round trip with a real key; temp files are removed', { skip }, () => {
  const { identity, recipient } = keypair();
  const plaintext = Buffer.from('bundle bytes \x00\x01\x02');
  const ciphertext = ageEncrypt({ plaintext, recipients: [recipient], ageBin: AGE });
  assert.ok(ciphertext.subarray(0, 22).toString() === 'age-encryption.org/v1\n');
  const scratch = mkdtempSync(join(tmpdir(), 'age-test-'));
  try {
    const out = ageDecrypt({ ciphertext, identity, ageBin: AGE, tmpDir: scratch });
    assert.deepEqual(out, plaintext);
    assert.deepEqual(readdirSync(scratch), [], 'identity file and its directory are gone');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('decrypt with the wrong key fails without leaking the key', { skip }, () => {
  const a = keypair();
  const b = keypair();
  const ciphertext = ageEncrypt({ plaintext: Buffer.from('x'), recipients: [a.recipient], ageBin: AGE });
  const scratch = mkdtempSync(join(tmpdir(), 'age-test-'));
  try {
    assert.throws(
      () => ageDecrypt({ ciphertext, identity: b.identity, ageBin: AGE, tmpDir: scratch }),
      (err) => err instanceof AgeError && !err.message.includes(parseIdentity(b.identity)) && /decrypt/.test(err.message),
    );
    assert.deepEqual(readdirSync(scratch), []);
    assert.throws(
      () => ageDecrypt({ ciphertext: Buffer.from('not age'), identity: a.identity, ageBin: AGE, tmpDir: scratch }),
      AgeError,
    );
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('encrypt refuses an empty or malformed recipient list', () => {
  assert.throws(() => ageEncrypt({ plaintext: Buffer.from('x'), recipients: [] }), /no recipients/);
  assert.throws(() => ageEncrypt({ plaintext: Buffer.from('x'), recipients: ['age1nope'] }), /not an age X25519 public key/);
});

test('readSealRecipients refuses the committed placeholder ingest.pub with a clear error', () => {
  const placeholder = fileURLToPath(new URL('../../worker-kit/ingest.pub', import.meta.url));
  assert.match(readFileSync(placeholder, 'utf8'), /PLACEHOLDER/, 'the committed file is still the placeholder');
  assert.throws(() => readSealRecipients(placeholder), (err) => err instanceof AgeError
    && err.code === 'placeholder'
    && /ingest\.pub has no age public key yet \(it is still the placeholder\)/.test(err.message)
    && /will not seal anything to it/.test(err.message)
    && /docs\/OPERATIONS\.md, "Result encryption keys"/.test(err.message));
  const dir = mkdtempSync(join(tmpdir(), 'seal-to-'));
  try {
    const pub = join(dir, 'ingest.pub');
    writeFileSync(pub, `# real key\n${fakeRecipient('q')}\n`);
    assert.deepEqual(readSealRecipients(pub), [fakeRecipient('q')]);
    assert.throws(() => readSealRecipients(join(dir, 'missing.pub')), /cannot read .*missing\.pub \(ENOENT\)/);
    writeFileSync(pub, 'not a key\n');
    assert.throws(() => readSealRecipients(pub), /line 1 is not an age X25519 public key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing age binary is a clear error', () => {
  assert.throws(
    () => ageEncrypt({ plaintext: Buffer.from('x'), recipients: [fakeRecipient('q')], ageBin: '/nonexistent/age' }),
    /could not run age/,
  );
});

test('agePublicKey derives the recipient of an identity', { skip }, () => {
  const { identity, recipient } = keypair();
  assert.equal(agePublicKey({ identity, keygenBin: KEYGEN }), recipient);
  assert.throws(() => agePublicKey({ identity: 'nonsense', keygenBin: KEYGEN }), AgeError);
});
