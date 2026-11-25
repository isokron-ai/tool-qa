#!/usr/bin/env node
// Seal and open the build job's output, so nothing readable is ever uploaded before a person
// has reviewed it. The output folder (the files that would be in the pull request, report.json
// and BASE_SHA) goes into one tar, age-encrypted to the loop's public key (worker-kit/ingest.pub).
// Only the loop key (and the owner's copy of it) opens it.
//
//   node publish/seal.mjs seal --dir <out> --out <file.tar.age> --base <40-hex commit> [--to worker-kit/ingest.pub]
//   node publish/seal.mjs open --in <file.tar.age> --dir <empty folder> --expect <sha256 of SHA256SUMS>
//
// seal writes BASE_SHA and SHA256SUMS (sha256 of every file, sorted) into the folder first, and
// prints `sums=<sha256 of SHA256SUMS>` (to $GITHUB_OUTPUT too). That digest is what a reviewer
// passes back to approve a delivery: open refuses an archive whose SHA256SUMS digest is not the
// one given, whose files do not match their sums, or that holds anything but plain files.
// open reads the identity from AGE_IDENTITY (removed from the environment at start).

import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ageDecrypt, ageEncrypt, readSealRecipients } from '../ingest/age.mjs';
import { readTar, writeTar } from '../worker-kit/tar.mjs';
import { sha256 } from './canonical.mjs';

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`a link in the output: ${p}`);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

export const sumsText = (files) => files.map(([p, data]) => `${sha256(data)}  ${p}\n`).join('');

/** Write BASE_SHA and SHA256SUMS into `dir`, tar it, encrypt it. @returns {{sealed: Buffer, sums: string}} */
export function seal({ dir, base, recipients, ageBin }) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('--base must be a full commit id');
  writeFileSync(join(dir, 'BASE_SHA'), `${base}\n`);
  const files = walk(dir).filter((p) => p !== 'SHA256SUMS').map((p) => [p, readFileSync(join(dir, p))]);
  const sums = sumsText(files);
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  const tar = writeTar([...files, ['SHA256SUMS', Buffer.from(sums)]].map(([path, data]) => ({ path, data })));
  return { sealed: ageEncrypt({ plaintext: tar, recipients, ageBin }), sums: sha256(sums) };
}

/** Decrypt and check an archive made by seal(); write its files into `dir`. @returns {{sums: string, base: string}} */
export function open({ sealed, identity, expect, dir, ageBin }) {
  const entries = readTar(ageDecrypt({ ciphertext: sealed, identity, ageBin }));
  const sumsEntry = entries.find((e) => e.path === 'SHA256SUMS');
  if (!sumsEntry) throw new Error('the archive has no SHA256SUMS');
  const digest = sha256(sumsEntry.data);
  if (expect !== undefined && digest !== expect) throw new Error(`the archive's SHA256SUMS is ${digest}, not the reviewed ${expect}; nothing was written`);
  const listed = new Map(sumsEntry.data.toString('utf8').split('\n').filter(Boolean).map((l) => { const m = /^([0-9a-f]{64})  (.+)$/.exec(l); if (!m) throw new Error('bad line in SHA256SUMS'); return [m[2], m[1]]; }));
  const others = entries.filter((e) => e.path !== 'SHA256SUMS');
  if (others.length !== listed.size) throw new Error('the archive holds files that SHA256SUMS does not list, or the reverse');
  for (const e of others) if (listed.get(e.path) !== sha256(e.data)) throw new Error(`${e.path} does not match SHA256SUMS`);
  for (const e of entries) {
    const f = join(dir, e.path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, e.data);
  }
  const base = entries.find((e) => e.path === 'BASE_SHA')?.data.toString('utf8').trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('the archive has no BASE_SHA');
  return { sums: digest, base };
}

/** Pad a text with trailing spaces to a fixed size (a multiple of `block`), so its length shows nothing. */
export function pad(text, block = 16384) {
  const n = Buffer.byteLength(text);
  const size = Math.max(block, Math.ceil((n + 1) / block) * block);
  return `${text}${' '.repeat(size - n - 1)}\n`;
}

async function main(argv, env) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, '')] = rest[i + 1];
  const identity = env.AGE_IDENTITY;
  delete process.env.AGE_IDENTITY;
  const ageBin = env.AGE_BIN || 'age';
  try {
    if (cmd === 'seal') {
      const r = seal({ dir: o.dir, base: o.base, recipients: readSealRecipients(o.to ?? 'worker-kit/ingest.pub'), ageBin });
      writeFileSync(o.out, r.sealed);
      process.stdout.write(`sums=${r.sums}\n`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sums=${r.sums}\n`);
    } else if (cmd === 'open') {
      if (!identity) throw new Error('AGE_IDENTITY is needed to open the archive');
      if (!/^[0-9a-f]{64}$/.test(o.expect ?? '')) throw new Error('--expect must be the reviewed sha256 of SHA256SUMS');
      const r = open({ sealed: readFileSync(o.in), identity, expect: o.expect, dir: o.dir, ageBin });
      process.stdout.write(`base=${r.base}\n`);
    } else throw new Error('usage: seal.mjs seal|open ...');
    return 0;
  } catch (err) {
    process.stderr.write(`seal: ${String(err?.message ?? err).replace(identity ?? '\u0000', '***')}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await main(process.argv.slice(2), process.env);
