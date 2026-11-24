#!/usr/bin/env node
// Write the package.json that installs one server release into a directory:
//
//   node perf/prepare-install.mjs <dir> <package> <exact version>
//
// The workflow then runs a plain `npm install --ignore-scripts` there. (The
// package name and version come from the plan job; both are checked again here
// as whole strings.)

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
    const [dir, pkg, version] = process.argv.slice(2);
    if (!dir || !pkg || !version) throw new Error('usage: prepare-install.mjs <dir> <package> <version>');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest(pkg, version), null, 2)}\n`);
  } catch (e) {
    console.error(`perf prepare-install: ${e.message}`);
    process.exit(2);
  }
}
