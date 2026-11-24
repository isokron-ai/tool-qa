#!/usr/bin/env node
// Build a result bundle: manifest.json plus the files of a bundle directory,
// packed as a deterministic tar. Used by worker-kit/action.yml; the action then
// encrypts the tar with age and uploads only the encrypted file.
//
//   node worker-kit/build-bundle.mjs --dir <bundle-dir> --meta <meta.json> \
//     --attempt-id <id> --fence <n> --run-key <sha256> [--item-index <i>] --out <dir>
//
// --item-index is the item's 0-based position in the dispatched items list
// (default 0). The bundle is named result-<attempt_id>-<index>.tar(.age).
//
// --meta is a JSON file with: subject {id, repo, sha}, tools [{name, version}],
// oracles [{name, version}], settings_manifest_digest, started_at, optional
// finished_at, skips [{stage, reason, evidence?}], controls [{kind, expected,
// observed, output?, marker?}]. The workflow identity comes from the runner's
// GITHUB_* variables.
//
// Step outputs (to $GITHUB_OUTPUT, else stdout): attempt_id, item_index,
// artifact_name, bundle_path, encrypted_path, manifest_sha256.
//
// Exit codes: 0 built, 1 the bundle or meta is invalid, 2 usage error.
// Errors never echo file contents.

import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_NAME, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, artifactName, buildManifest, collectFiles, sha256Hex, workflowFromEnv,
} from './contract.mjs';
import { writeTar } from './tar.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  const names = { '--dir': 'dir', '--meta': 'meta', '--attempt-id': 'attemptId', '--fence': 'fence', '--run-key': 'runKey', '--out': 'out' };
  const optional = { '--item-index': 'itemIndex' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]] ?? optional[argv[i]];
    if (!key) throw new UsageError(`unknown argument ${JSON.stringify(argv[i])}`);
    if (i + 1 >= argv.length) throw new UsageError(`${argv[i]} needs a value`);
    opts[key] = argv[++i];
  }
  for (const [flag, key] of Object.entries(names)) {
    if (opts[key] === undefined || opts[key] === '') throw new UsageError(`${flag} is required`);
  }
  opts.itemIndex ??= '0';
  if (!/^(0|[1-9]\d{0,3})$/.test(opts.itemIndex)) throw new UsageError('--item-index must be a whole number from 0 to 9999');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.attemptId)) throw new UsageError('--attempt-id has characters outside A-Z a-z 0-9 . _ -');
  if (!/^[1-9]\d{0,15}$/.test(opts.fence) || !Number.isSafeInteger(Number(opts.fence))) throw new UsageError('--fence must be a positive whole number');
  if (!/^[0-9a-f]{64}$/.test(opts.runKey)) throw new UsageError('--run-key must be 64 lowercase hex characters');
  return { ...opts, fence: Number(opts.fence), itemIndex: Number(opts.itemIndex) };
}

export function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const write = io.write ?? ((s) => process.stdout.write(s));
  const error = io.error ?? ((s) => process.stderr.write(`${s}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    error(`build-bundle: ${err.message}`);
    return 2;
  }
  try {
    let meta;
    try {
      meta = JSON.parse(readFileSync(opts.meta, 'utf8'));
    } catch {
      throw new Error('the meta file is missing or is not valid JSON');
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('the meta file must hold a JSON object');
    const files = collectFiles(opts.dir);
    const manifest = buildManifest({
      identity: { attempt_id: opts.attemptId, fence: opts.fence, run_key: opts.runKey },
      workflow: workflowFromEnv(env),
      meta,
      files,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > MAX_FILE_BYTES) throw new Error(`manifest.json would be ${manifestBytes.length} bytes, more than the ${MAX_FILE_BYTES} a file may hold`);
    const tar = writeTar([{ path: MANIFEST_NAME, data: manifestBytes }, ...files]);
    if (tar.length > MAX_BUNDLE_BYTES) throw new Error(`the bundle would be ${tar.length} bytes, more than the ${MAX_BUNDLE_BYTES} allowed`);
    mkdirSync(opts.out, { recursive: true });
    const name = artifactName(opts.attemptId, opts.itemIndex);
    const bundlePath = join(opts.out, name.replace(/\.age$/, ''));
    writeFileSync(bundlePath, tar, { mode: 0o600 });
    const outputs = {
      attempt_id: opts.attemptId,
      item_index: opts.itemIndex,
      artifact_name: name,
      bundle_path: bundlePath,
      encrypted_path: join(opts.out, name),
      manifest_sha256: sha256Hex(manifestBytes),
    };
    const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join('');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text);
    else write(text);
    write(`build-bundle: ${files.length} file(s), ${tar.length} bytes, manifest sha256 ${outputs.manifest_sha256}\n`);
    return 0;
  } catch (err) {
    error(`build-bundle: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
