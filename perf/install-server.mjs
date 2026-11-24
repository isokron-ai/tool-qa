#!/usr/bin/env node
// Install one release of one of our servers into a directory, with no install
// scripts, then build only the native add-ons it needs:
//
//   node perf/install-server.mjs <dir> <package> <exact version> [native add-on ...]
//
// The package name and version come from the plan job; both are checked again
// here as whole strings, and they reach npm as a one-line package.json and as
// argument-array entries, never through a shell.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVersion } from './lib.mjs';
import { PACKAGE_NAME } from './plan.mjs';

export function manifest(pkg, version) {
  if (!PACKAGE_NAME.test(pkg)) throw new Error(`bad package name ${JSON.stringify(pkg).slice(0, 60)}`);
  if (!parseVersion(version) || /^v/.test(version)) throw new Error(`bad version ${JSON.stringify(version).slice(0, 40)}`);
  return { name: 'perf-server-under-test', version: '0.0.0', private: true, dependencies: { [pkg]: version } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [dir, pkg, version, ...native] = process.argv.slice(2);
    if (!dir || !pkg || !version) throw new Error('usage: install-server.mjs <dir> <package> <version> [native add-on ...]');
    for (const n of native) if (!PACKAGE_NAME.test(n)) throw new Error(`bad add-on name ${JSON.stringify(n).slice(0, 60)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest(pkg, version), null, 2)}\n`);
    const npm = (args) => {
      const r = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`npm ${args[0]} failed (${r.status})`);
    };
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
    for (const n of native) npm(['rebuild', n]);
  } catch (e) {
    console.error(`perf install-server: ${e.message}`);
    process.exit(2);
  }
}
