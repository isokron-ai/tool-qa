#!/usr/bin/env node
// Measure one of our own servers with the pinned Inspector CLI's --load mode.
//
//   node perf/run.mjs --server <id> --srv-dir <dir> --out <file> [options]
//
//   --server <id>        a key of perf/servers.json (our own servers only)
//   --srv-dir <dir>      an npm prefix with the server installed at the release to measure
//                        (not needed for the `fixture` control)
//   --out <file>         where to write the result JSON (schema tool-qa/perf/1)
//   --inspector <file>   the Inspector CLI entry (default: perf/node_modules/.../cli/build/index.js)
//   --duration <s>       measured seconds per repeat (default 20)
//   --warmup <s>         seconds before measuring, left out of every number (default 3)
//   --repeats <n>        repeats per profile; the medians are what is compared (default 3)
//   --concurrency <n>    calls in flight, and sessions over HTTP (default 8)
//   --profiles a,b       only these profiles (stdio, http)
//   --extra-arg <arg>    appended to the server's command line (repeatable; used by the control)
//
// Only loopback and stdio: this script never opens a connection to anything
// but a server it started itself. See docs/PERFORMANCE.md.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { RESULT_SCHEMA, calibrate, summariseChurn, summariseRepeats, summariseSteps } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FORBIDDEN_PORTS = new Set([4710, 4711, 47310, 47311]);

/** Whole-string checks for anything that reaches a command line or a path. */
export const SAFE_ID = /^[a-z][a-z0-9-]{0,40}$/;
export const SAFE_NUM = /^[0-9]{1,4}$/;

export function loadServers(file = join(HERE, 'servers.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).servers;
}

/** Replace "@fixtures/<name>" string values with the parsed JSON of that file (inside perf/fixtures only). */
export function inlineFixtures(value, dir = join(HERE, 'fixtures')) {
  if (typeof value === 'string' && value.startsWith('@fixtures/')) {
    const name = value.slice('@fixtures/'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad fixture name ${name}`);
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  }
  if (Array.isArray(value)) return value.map((v) => inlineFixtures(v, dir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineFixtures(v, dir)]));
  return value;
}

/** The Inspector scenario file for a server: the steps, fixtures inlined. */
export function buildScenario(spec) {
  return { steps: inlineFixtures(spec.scenario) };
}

/** Fill {data} and {port} in a server's argument template. */
export function fillArgs(template, vars) {
  return template.map((a) => a.replace(/\{(data|port)\}/g, (_, k) => String(vars[k])));
}

export async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = await new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => res(p));
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error('no free port found');
}

function waitForPort(port, ms = 20000) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const attempt = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > end) rej(new Error(`nothing listening on 127.0.0.1:${port} after ${ms} ms`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** The environment a measured server gets: no tokens, no home, nothing of the runner's. */
export function cleanEnv(home) {
  const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, LANG: 'C.UTF-8', NO_COLOR: '1' };
  return env;
}

/** Run a command to the end; resolves { code, stdout, stderr }. */
function run(cmd, args, { env, cwd, timeoutMs = 180000 } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < 8e6) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    child.on('close', (code, signal) => { clearTimeout(timer); res({ code, signal, stdout, stderr }); });
  });
}

/** Parse the Inspector's --format json load output: the first JSON line, `.result`. */
export function parseLoadOutput(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error('the Inspector printed no JSON');
  const parsed = JSON.parse(line);
  if (parsed.error) throw new Error(`Inspector error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  if (!parsed.result?.latencyMs) throw new Error('the Inspector load summary has no latency numbers (no call succeeded?)');
  return parsed.result;
}

function loadFlags(o) {
  return ['--load', '--load-concurrency', String(o.concurrency), '--load-duration', String(o.duration), '--load-warmup', String(o.warmup)];
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: 'string' },
      'srv-dir': { type: 'string' },
      out: { type: 'string' },
      inspector: { type: 'string' },
      duration: { type: 'string', default: '20' },
      warmup: { type: 'string', default: '3' },
      repeats: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '8' },
      profiles: { type: 'string' },
      'extra-arg': { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.server || !SAFE_ID.test(values.server)) throw new Error('--server must name an entry of perf/servers.json');
  if (!values.out) throw new Error('--out is required');
  for (const k of ['duration', 'warmup', 'repeats', 'concurrency']) {
    if (!SAFE_NUM.test(values[k])) throw new Error(`--${k} must be a whole number`);
  }
  const opt = { duration: Number(values.duration), warmup: Number(values.warmup), repeats: Number(values.repeats), concurrency: Number(values.concurrency) };
  if (opt.repeats < 1 || opt.concurrency < 1 || opt.duration < 1) throw new Error('duration, repeats and concurrency must be at least 1');

  const spec = loadServers()[values.server];
  if (!spec) throw new Error(`no server ${values.server} in perf/servers.json: only our own servers are listed`);
  const inspector = resolve(values.inspector ?? join(HERE, 'node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js'));
  if (!existsSync(inspector)) throw new Error(`Inspector CLI not found at ${inspector}`);
  const inspectorVersion = JSON.parse(readFileSync(join(inspector, '../../../../package.json'), 'utf8')).version;

  // Where the server's command is: an installed package, or the local control script.
  let serverCmd;
  let pkgInfo = { package: null, version: 'control', integrity: null };
  if (spec.local_script) {
    serverCmd = [process.execPath, join(HERE, spec.local_script)];
  } else {
    if (!values['srv-dir']) throw new Error('--srv-dir is required for a published server');
    const dir = join(resolve(values['srv-dir']), 'node_modules', spec.package);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const binName = spec.bin ?? Object.keys(pkg.bin)[0];
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName];
    if (!rel) throw new Error(`${spec.package} has no bin ${binName}`);
    serverCmd = [process.execPath, join(dir, rel)];
    let integrity = null;
    try {
      const lock = JSON.parse(readFileSync(join(resolve(values['srv-dir']), 'node_modules/.package-lock.json'), 'utf8'));
      integrity = lock.packages?.[`node_modules/${spec.package}`]?.integrity ?? null;
    } catch { /* no lock file: leave null */ }
    pkgInfo = { package: spec.package, version: pkg.version, integrity };
  }
  const extra = values['extra-arg'];

  const work = mkdtempSync(join(os.tmpdir(), 'perf-'));
  const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
  const children = new Set();
  const stopAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
  process.on('exit', stopAll);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); cleanup(); process.exit(130); });

  const env = cleanEnv(work);
  const scenarioFile = join(work, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(buildScenario(spec)));

  const wanted = values.profiles ? values.profiles.split(',') : spec.profiles;
  const profiles = {};
  const calibration_ms = await calibrate(crypto);
  const startedAt = new Date().toISOString();

  /** Seed one data dir by a bounded load run of the seed tool (a stdio server on that dir, or an HTTP URL). */
  async function seed(target) {
    if (!spec.seed) return;
    const rows = join(work, `seed-${crypto.randomBytes(4).toString('hex')}.ndjson`);
    writeFileSync(rows, `${JSON.stringify(spec.seed.args)}\n`);
    const r = await run(process.execPath, [inspector, '-q', '--method', 'tools/call', '--tool-name', spec.seed.tool, '--load', '--load-requests', String(spec.seed.count), '--load-concurrency', '1', '--load-args-file', rows, '--format', 'json', ...target], { env, cwd: work });
    const sum = parseLoadOutput(r.stdout);
    if (sum.ok !== spec.seed.count) throw new Error(`seeding made ${sum.ok} of ${spec.seed.count} ${spec.seed.tool} calls: ${(sum.toolErrorMessages ?? sum.errorMessages ?? []).slice(0, 2).join(' | ')}`);
  }

  for (const name of wanted) {
    if (!spec.profiles.includes(name)) { console.error(`perf: ${values.server} has no ${name} profile, skipped`); continue; }
    const prof = {
      transport: name,
      workload: { scenario: spec.scenario.map((s) => `${s.tool} x${s.weight}`), concurrency: opt.concurrency, sessions: name === 'http' ? opt.concurrency : 1, warmup_s: opt.warmup, duration_s: opt.duration, repeats: opt.repeats },
      repeats: [],
    };
    try {
      for (let rep = 0; rep < opt.repeats; rep++) {
        const data = mkdtempSync(join(work, 'data-'));
        const port = name === 'http' ? await freePort() : 0;
        const vars = { data, port };
        if (name === 'stdio') {
          const target = ['--', ...serverCmd, ...fillArgs(spec.stdio_args ?? [], vars), ...extra];
          await seed(target);
          const r = await run(process.execPath, [inspector, '-q', '--method', 'tools/call', '--load-scenario', scenarioFile, ...loadFlags(opt), '--format', 'json', ...target], { env, cwd: work });
          prof.repeats.push(parseLoadOutput(r.stdout));
        } else {
          // A stdio pass first lays the seed data down on disk; the HTTP server then starts on the same directory.
          if (spec.stdio_args && spec.seed) await seed(['--', ...serverCmd, ...fillArgs(spec.stdio_args, vars), ...extra]);
          const child = spawn(serverCmd[0], [...serverCmd.slice(1), ...fillArgs(spec.http_args, vars), ...extra], { env, cwd: work, stdio: ['ignore', 'ignore', 'pipe'] });
          children.add(child);
          let errTail = '';
          child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
          try {
            await waitForPort(port);
            const url = `http://127.0.0.1:${port}/mcp`;
            const headers = [];
            if (spec.bearer_file) {
              const token = readFileSync(join(data, spec.bearer_file), 'utf8').trim();
              headers.push('--header', `Authorization: Bearer ${token}`);
            }
            const target = ['--server-url', url, '--transport', 'http', ...headers];
            if (spec.seed && !spec.stdio_args) await seed(target);
            const r = await run(process.execPath, [inspector, '-q', '--method', 'tools/call', '--load-scenario', scenarioFile, ...loadFlags(opt), '--load-connections', String(opt.concurrency), '--format', 'json', ...target], { env, cwd: work });
            const main = parseLoadOutput(r.stdout);
            // Session churn: every worker connects, makes 3 calls, disconnects, repeats.
            const c = await run(process.execPath, [inspector, '-q', '--method', 'tools/call', '--load-scenario', scenarioFile, '--load', '--load-churn', '--load-churn-calls', '3', '--load-concurrency', String(opt.concurrency), '--load-duration', '8', '--format', 'json', ...target], { env, cwd: work });
            try { main.churn = parseLoadOutput(c.stdout); } catch (e) { main.churn = { error: e.message }; }
            prof.repeats.push(main);
          } catch (e) {
            e.message += errTail ? ` (server stderr tail: ${errTail.replace(/\s+/g, ' ').slice(-300)})` : '';
            throw e;
          } finally {
            child.kill('SIGKILL');
            children.delete(child);
          }
        }
        console.error(`perf: ${values.server} ${name} repeat ${rep + 1}/${opt.repeats}: p50 ${prof.repeats.at(-1).latencyMs.p50} ms, p95 ${prof.repeats.at(-1).latencyMs.p95} ms, ${prof.repeats.at(-1).ok}/${prof.repeats.at(-1).requests} ok`);
      }
      prof.summary = summariseRepeats(prof.repeats);
      prof.summary.steps = summariseSteps(prof.repeats);
      const churn = summariseChurn(prof.repeats.map((r) => r.churn));
      if (churn) prof.summary.churn = churn;
    } catch (e) {
      prof.error = e.message.slice(0, 600);
      console.error(`perf: ${values.server} ${name} failed: ${prof.error}`);
    }
    // Keep the raw load summaries out of the committed result except for the numbers that are compared.
    prof.repeats = prof.repeats.map((r) => ({ requests: r.requests, ok: r.ok, errorRate: r.errorRate, okThroughput: r.okThroughput, latencyMs: r.latencyMs, ...(r.steps ? { steps: r.steps.map((st) => ({ name: st.name, requests: st.requests, ok: st.ok, errorRate: st.errorRate, p50: st.latencyMs?.p50 ?? null, p95: st.latencyMs?.p95 ?? null, p99: st.latencyMs?.p99 ?? null, errors: [...(st.errorMessages ?? []), ...(st.toolErrorMessages ?? [])].slice(0, 2) })) } : {}), ...(r.churn && !r.churn.error ? { churn: { opened: r.churn.churn?.opened, failed: r.churn.churn?.failed, connectMs: r.churn.churn?.connectMs, latencyMs: r.churn.latencyMs, elapsedMs: r.churn.elapsedMs, requests: r.churn.requests, errorRate: r.churn.errorRate } } : {}) }));
    profiles[name] = prof;
  }

  const result = {
    schema: RESULT_SCHEMA,
    server: values.server,
    ...pkgInfo,
    measured_at: startedAt,
    inspector: { package: '@modelcontextprotocol/inspector', version: inspectorVersion, mode: '--load', scenario: 'weighted read-only mix (perf/servers.json)', flags: ['--load-scenario', ...loadFlags(opt), '--load-connections (http)', '--load-churn --load-churn-calls 3 (http)'] },
    runner: { os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, node: process.version, calibration_ms, github_runner: process.env.RUNNER_NAME ? 'github-hosted' : null },
    profiles,
  };
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  cleanup();
  const failed = Object.values(profiles).some((p) => p.error);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`perf: ${e.message}`); process.exit(2); });
}
