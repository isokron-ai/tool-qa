#!/usr/bin/env node
// Decide what the performance workflow measures: which of our servers, at which
// release. Writes the job matrix to $GITHUB_OUTPUT.
//
// Inputs (environment; the workflow maps dispatch inputs in):
//   PERF_SERVER   "all" (default) or one id from perf/servers.json
//   PERF_VERSION  empty (the latest release on npm) or one exact version; only with one server
//   PERF_FORCE    "true" to measure a release that already has a baseline
//
// A scheduled run measures a server only when its latest release has no
// baseline file yet, so each release is measured once. Only the npm registry is
// read (our own package names, from perf/servers.json); nothing is sent.

import { appendFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVersion } from './lib.mjs';
import { SAFE_ID, loadServers } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;

/**
 * @param {{servers: object, env: Record<string,string|undefined>, hasBaseline: (server:string, version:string)=>boolean, latest: (pkg:string)=>Promise<string>}} d
 */
export async function plan({ servers, env, hasBaseline, latest }) {
  const want = env.PERF_SERVER === undefined || env.PERF_SERVER === '' ? 'all' : env.PERF_SERVER;
  if (want !== 'all' && !(SAFE_ID.test(want) && Object.hasOwn(servers, want) && want !== 'fixture')) {
    throw new Error(`PERF_SERVER must be "all" or one of our servers, not ${JSON.stringify(want).slice(0, 60)}`);
  }
  const pinned = env.PERF_VERSION ?? '';
  if (pinned !== '') {
    if (want === 'all') throw new Error('PERF_VERSION needs one server, not all');
    if (!parseVersion(pinned) || /^v/.test(pinned)) throw new Error('PERF_VERSION must be an exact version such as 0.12.1');
  }
  const force = env.PERF_FORCE === 'true';
  const out = [];
  const notes = [];
  for (const [id, spec] of Object.entries(servers)) {
    if (id === 'fixture' || (want !== 'all' && id !== want)) continue;
    if (!PACKAGE_NAME.test(spec.package)) throw new Error(`${id}: bad package name`);
    const version = pinned || await latest(spec.package);
    if (!parseVersion(version)) throw new Error(`${id}: the registry returned a bad version ${JSON.stringify(version).slice(0, 40)}`);
    if (!force && hasBaseline(id, version)) {
      notes.push(`${id} ${version}: already has a baseline, skipped`);
      continue;
    }
    for (const r of spec.rebuild ?? []) if (!PACKAGE_NAME.test(r)) throw new Error(`${id}: bad rebuild name`);
    out.push({ server: id, package: spec.package, version, rebuild: (spec.rebuild ?? []).join(' ') });
  }
  return { matrix: { include: out }, notes };
}

async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${pkg}`);
  return (await res.json()).version;
}

async function main() {
  const servers = loadServers();
  const { matrix, notes } = await plan({
    servers,
    env: process.env,
    hasBaseline: (id, v) => existsSync(join(HERE, 'baselines', id, `${v}.json`)),
    latest: npmLatest,
  });
  for (const n of notes) console.log(n);
  console.log(`measuring: ${matrix.include.map((m) => `${m.server} ${m.version}`).join(', ') || 'nothing'}`);
  const line = `matrix=${JSON.stringify(matrix)}\ncount=${matrix.include.length}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`perf plan: ${e.message}`); process.exit(2); });
}
