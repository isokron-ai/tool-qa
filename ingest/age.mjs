// age encryption and decryption through the age command-line tool.
//
// The identity (secret key) arrives in memory, from the AGE_IDENTITY secret.
// For decryption it is written to a 0600 file in a fresh 0700 directory and
// removed straight after, whatever happens. Error messages never include the
// identity or anything age printed that looks like a key.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const IDENTITY_RE = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;
const KEYISH_RE = /AGE-SECRET-KEY-1[0-9A-Z]*/gi;
const DEFAULT_MAX = 2 * 1024 ** 3;
/**
 * age is linear in its input, and the input is capped (worker-kit/contract.mjs),
 * so a minute is far more than it needs; past that the process is killed and
 * the call fails as 'timeout' instead of holding the pump.
 */
export const AGE_TIMEOUT_MS = 60_000;

/**
 * code: 'input' (bad key text), 'placeholder' (the public-key file has no key
 * yet), 'spawn' (age could not run), 'too_large' (output over the cap),
 * 'timeout' (age ran past its time limit and was killed) or 'failed' (age ran
 * and refused, e.g. wrong key or damaged ciphertext).
 */
export class AgeError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'AgeError';
    this.code = code;
  }
}

/** Recipients from a public-key file: one age1... per line; '#' comments and blank lines ignored. */
export function parseRecipientFile(text) {
  const out = [];
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (!RECIPIENT_RE.test(line)) throw new AgeError(`recipient file: line ${i + 1} is not an age X25519 public key`, 'input');
    out.push(line);
  });
  return out;
}

/**
 * The recipients ingest seals its outputs to, from a public-key file
 * (worker-kit/ingest.pub by default). While the file is still the committed
 * placeholder (comments only) this throws AgeError code 'placeholder': nothing
 * may be judged or sealed until the real key is there.
 */
export function readSealRecipients(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AgeError(`cannot read ${path} (${err.code ?? 'error'})`, 'input');
  }
  const recipients = parseRecipientFile(text);
  if (recipients.length === 0) {
    throw new AgeError(
      `${path} has no age public key yet (it is still the placeholder), so ingest will not seal anything to it; `
        + 'put the real recipient there first (docs/OPERATIONS.md, "Result encryption keys")',
      'placeholder',
    );
  }
  return recipients;
}

/** The single X25519 identity in an age-keygen style text (comments allowed). Never echoes input. */
export function parseIdentity(text) {
  const keys = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!IDENTITY_RE.test(line)) throw new AgeError('identity: a line is neither a comment nor an age X25519 identity', 'input');
    keys.push(line);
  }
  if (keys.length !== 1) throw new AgeError(`identity: expected exactly one age X25519 identity, found ${keys.length}`, 'input');
  return keys[0];
}

function scrub(text, secret) {
  let s = String(text ?? '');
  if (secret) s = s.split(secret).join('[identity]');
  return s.replace(KEYISH_RE, '[identity]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// The child gets only PATH: no tokens or keys from our environment.
function childEnv() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin' };
}

function run(ageBin, args, input, maxBytes, timeoutMs) {
  const r = spawnSync(ageBin, args, {
    input, maxBuffer: maxBytes, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  if (r.error) {
    if (r.error.code === 'ENOBUFS') throw new AgeError(`age output is larger than ${maxBytes} bytes`, 'too_large');
    if (r.error.code === 'ETIMEDOUT') throw new AgeError(`age ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, 'timeout');
    throw new AgeError(`could not run age (${ageBin}): ${r.error.code ?? 'error'}`, 'spawn');
  }
  return r;
}

/**
 * Decrypt age ciphertext (binary format) with one X25519 identity.
 * @param {{ciphertext: Buffer, identity: string, ageBin?: string, tmpDir?: string, maxBytes?: number, timeoutMs?: number}} p
 * @returns {Buffer}
 */
export function ageDecrypt({ ciphertext, identity, ageBin = 'age', tmpDir = tmpdir(), maxBytes = DEFAULT_MAX, timeoutMs = AGE_TIMEOUT_MS }) {
  const key = parseIdentity(identity);
  const dir = mkdtempSync(join(tmpDir, 'ingest-id-'));
  try {
    const file = join(dir, 'identity.txt');
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    const r = run(ageBin, ['--decrypt', '--identity', file], ciphertext, maxBytes, timeoutMs);
    if (r.status !== 0) throw new AgeError(`age could not decrypt the bundle: ${scrub(r.stderr, key) || `exit ${r.status}`}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The public key (age1...) of an identity, via `age-keygen -y` on stdin.
 * Used to check, before any bundle is judged, that AGE_IDENTITY belongs to the
 * key workers encrypt to.
 */
export function agePublicKey({ identity, keygenBin = 'age-keygen' }) {
  const key = parseIdentity(identity);
  const r = spawnSync(keygenBin, ['-y'], { input: `${key}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, env: childEnv() });
  if (r.error) throw new AgeError(`could not run age-keygen (${keygenBin}): ${r.error.code ?? 'error'}`, 'spawn');
  const out = r.stdout.toString('utf8').trim();
  if (r.status !== 0 || !RECIPIENT_RE.test(out)) throw new AgeError(`age-keygen -y failed: ${scrub(r.stderr, key) || `exit ${r.status}`}`);
  return out;
}

/**
 * Encrypt to one or more age X25519 recipients (binary output).
 * @param {{plaintext: Buffer, recipients: string[], ageBin?: string, maxBytes?: number}} p
 * @returns {Buffer}
 */
export function ageEncrypt({ plaintext, recipients, ageBin = 'age', maxBytes = DEFAULT_MAX, timeoutMs = AGE_TIMEOUT_MS }) {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new AgeError('encrypt: no recipients', 'input');
  for (const r of recipients) {
    if (!RECIPIENT_RE.test(r)) throw new AgeError('encrypt: a recipient is not an age X25519 public key', 'input');
  }
  const args = ['--encrypt', ...recipients.flatMap((r) => ['--recipient', r])];
  const r = run(ageBin, args, plaintext, maxBytes + 1024 * 1024, timeoutMs); // ciphertext is a little larger
  if (r.status !== 0) throw new AgeError(`age could not encrypt: ${scrub(r.stderr) || `exit ${r.status}`}`);
  return r.stdout;
}
