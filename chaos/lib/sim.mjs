// The chaos simulator: the real pump, ingest, successor, watchdog, state
// snapshot and restore drill, run end to end over many ticks and runs against
// the in-memory GitHub of fake-github.mjs, on a virtual clock.
//
// Nothing here talks to a network, a real repository or the live loop: every
// GitHub call goes to FakeGitHub, tokens are made up, and age is a stand-in
// that keeps the one property the loop relies on (only the right identity
// decrypts). The code under test is the shipped code, unchanged: runPump,
// createCollector (inside the pump), dispatchSuccessor, runWatchdog,
// runSnapshot, drill, pullState and pushState, the state store.
//
// Time: a discrete-event scheduler. Every actor (a pump job, a watchdog run,
// a snapshot run, the operator) is a task; a task gives up the clock only in
// sleep(). The scheduler moves the clock to the next event once every task is
// either asleep or finished, so real async work (SQLite, the judge's worker
// thread) finishes before virtual time moves on. GitHub's own side (cron,
// worker runs, concurrency groups) runs as events.
//
// What it models of GitHub Actions:
//   pump.yml     cron every 30 minutes and workflow_dispatch; concurrency group
//                `pump` with cancel-in-progress false: one run at a time, one
//                pending, a newer pending run cancels the older one. A job is
//                guard (scripts/guard.mjs), then the successor
//                (pump/successor.mjs) when slots > 0, then the pump
//                (pump/run.mjs), as in .github/workflows/pump.yml.
//   watchdog.yml cron at :07, :22, :37, :52 (guard --no-slots, then runWatchdog).
//   state-snapshot.yml  cron at :41 (guard --no-slots, then runSnapshot).
//   the worker   each dispatch creates a run named `shard <id>`; by default it
//                starts after 15 s, runs 3 minutes, uploads one sealed bundle per
//                item (result-<attempt>-<i>.tar.age) and succeeds. A scenario
//                can change any of that per dispatch (sim.worker).
//
// What it checks (sim.violations, and the helpers at the bottom):
//   every state asset version the release shows decrypts with the loop
//   identity, passes quick_check, and never moves backwards from the one
//   before it (fence counter, attempts, results, dispatch statuses), unless a
//   scenario marks an operator restore; no run_key has two accepted results;
//   no accepted result carries a fence older than a lease granted before it
//   was recorded; every accepted result is a bundle a worker really uploaded.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runPump } from '../../pump/run.mjs';
import { ApiBudget } from '../../pump/budgets.mjs';
import { dispatchSuccessor } from '../../pump/successor.mjs';
import { runKey, runKeyFields } from '../../pump/due.mjs';
import { evaluateGuard } from '../../scripts/guard.mjs';
import { pullState, pushState } from '../../scripts/state-asset.mjs';
import { openState } from '../../state/db.mjs';
import { runWatchdog, loadExpected } from '../../watchdog/run.mjs';
import { parseBody } from '../../watchdog/health.mjs';
import { createReleaseClient } from '../../snapshot/github.mjs';
import { runSnapshot } from '../../snapshot/snapshot.mjs';
import { drill } from '../../snapshot/restore.mjs';
import { AgeError } from '../../ingest/age.mjs';
import { parseRegistry } from '../../ingest/registry.mjs';
import { makeBundle, REGISTRY_TEXT } from '../../ingest/testkit.mjs';
import { FakeGitHub, API_HOST } from './fake-github.mjs';

export const TOOLQA = 'chaos-sim/tool-qa';
export const WORKER = 'chaos-sim/worker';
export const WORKER_FILE = 'scan-static.yml';
export const WORKFLOW = 'scan-static';
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const START = Date.parse('2026-11-23T12:00:00Z');
const TIERS = (await import('../../pump/tiers.json', { with: { type: 'json' } })).default;
const LOOP_WORKFLOW_FILES = ['pump.yml', 'watchdog.yml', 'history-registry.yml', 'history-packages.yml', 'history-popularity.yml', 'state-snapshot.yml', 'ingest.yml'];

// ---- a stand-in for age ----

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const AGE_HEAD = 'age-encryption.org/v1\n';

/** The (fake) public key of a (fake) identity: a valid-looking age1 recipient. */
export function pubOf(identity) {
  const h = createHash('sha256').update(String(identity)).digest();
  let s = 'age1';
  for (let i = 0; i < 58; i++) s += BECH[h[i % 32] % 32];
  return s;
}

export function sealTo(recipients, plaintext) {
  return Buffer.concat([Buffer.from(`${AGE_HEAD}-> chaos ${recipients.join(' ')}\n---\n`), Buffer.from(plaintext)]);
}

export function openWith(identity, ciphertext) {
  const buf = Buffer.from(ciphertext);
  if (buf.subarray(0, AGE_HEAD.length).toString('latin1') !== AGE_HEAD) throw new AgeError('age: not an age file', 'failed');
  const end = buf.indexOf('\n---\n', AGE_HEAD.length);
  if (end < 0) throw new AgeError('age: header is truncated', 'failed');
  const line = buf.subarray(AGE_HEAD.length, end).toString('latin1');
  const m = /^-> chaos (.*)$/.exec(line);
  if (!m || !m[1].split(' ').includes(pubOf(identity))) throw new AgeError('age could not decrypt: no identity matched any of the recipients', 'failed');
  return buf.subarray(end + 5);
}

/** stateCrypto() of scripts/state-asset.mjs, with the stand-in for age. */
export function fakeStateCrypto({ identity, recipients }) {
  return {
    encrypt(plaintext) {
      if (identity && !recipients.includes(pubOf(identity))) {
        throw new Error('AGE_IDENTITY is not one of the recipients in state/state.pub; refusing to push a state it could not read back');
      }
      return sealTo(recipients, plaintext);
    },
    decrypt(ciphertext) {
      if (!identity) throw new Error('the state asset is encrypted and AGE_IDENTITY is not set, so it cannot be read');
      return openWith(identity, ciphertext);
    },
  };
}

// ---- seeded randomness ----

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString();

export class SimDeadlock extends Error {}

// ---- the simulator ----

export class Sim {
  constructor({
    seed = 1, subjects = 6, slots = '3', shardSize = 2, start = START, vars = {}, verbose = false,
    workflow = {}, pumpSkewMs = 0,
  } = {}) {
    this.pumpSkewMs = pumpSkewMs;
    this.t = start;
    this.start = start;
    this.random = rng(seed);
    this.seq = 0;
    this.events = [];
    this.tasks = new Set();
    this.active = 0;
    this.idleWaiters = [];
    this.logs = [];
    this.verbose = verbose;
    this.violations = [];
    this.dir = mkdtempSync(join(tmpdir(), 'chaos-'));
    this.ids = 0;
    this.tokens = 0;

    // Keys. The loop identity reads the state and the result bundles.
    this.identity = `chaos-loop-identity-${seed}`; // a stand-in, not key-shaped
    this.statePub = [pubOf(this.identity)];
    this.ingestPub = pubOf(this.identity);
    this.sealFile = join(this.dir, 'ingest.pub');
    writeFileSync(this.sealFile, `# chaos\n${this.ingestPub}\n`);
    this.registry = { ...parseRegistry(REGISTRY_TEXT), source: 'chaos' };

    this.gh = new FakeGitHub({ now: () => this.t });
    const tq = this.gh.addRepo(TOOLQA, { workflows: LOOP_WORKFLOW_FILES });
    tq.variables = { LOOP_ENABLED: 'true', LOOP_SLOTS: slots, ...vars };
    tq.extraArtifacts = (now) => ['registry-delta-', 'registry-full-', 'history-packages-', 'history-popularity-'].map((p, i) => ({
      id: 100 + i, name: `${p}x`, size_in_bytes: 1, expired: false, created_at: new Date(now - 5 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      workflow_run: { id: 1 },
    }));
    this.gh.addRepo(WORKER, { branches: { main: 'b'.repeat(40) }, workflows: [WORKER_FILE] });
    this.gh.hooks.onDispatch = (repo, file, run, inputs) => this.onDispatch(repo, file, run, inputs);
    this.gh.hooks.onChange = () => this.observeState();
    this.gh.hooks.onCancel = (repo, run) => this.cancelRun(run);

    this.config = {
      tiers: TIERS,
      workflows: {
        [WORKFLOW]: {
          enabled: true, runs_untrusted: false, repo: WORKER, file: WORKER_FILE, ref: 'main',
          shard_size: shardSize, setup_minutes: 3, minutes_per_subject: 1, slots_max: 3,
          versions: { tool: { 'mcp-check': 'chaos01' }, oracle: {}, probe: {} }, image_digest: null, settings_state: 'default',
          ...workflow,
        },
      },
    };

    // Subjects, in a state asset as the live loop has one.
    this.subjects = [];
    for (let i = 0; i < subjects; i++) {
      this.subjects.push({ id: `chaos-org/server-${i}`, kind: 'github', source: 'seed:chaos', tier: 1, sha: createHash('sha1').update(`s${i}`).digest('hex') });
    }
    const seedFile = join(this.dir, 'seed.sqlite');
    const db = openState(seedFile);
    for (const s of this.subjects) db.setSubjectVersion({ ...s, now: start });
    db.close();
    this.statePrev = null;
    this.stateVersions = [];
    this.allowRollback = 0;
    this.injected = new Set();
    this.gh.addAsset(TOOLQA, 'state', 'state.sqlite', Buffer.alloc(0));
    this.replaceState(this.encryptState(readFileSync(seedFile)), { injected: false });

    // Worker behaviour, per dispatch. Return a plan or leave the default.
    this.worker = () => ({});
    this.uploaded = new Set(); // `${attempt}:${run_key}:${fence}` of every bundle a worker uploaded
    this.workerRuns = [];
    this.maxInProgress = 0;

    // GitHub's pump concurrency group.
    this.pumpGroup = { running: null, pending: null };
    this.pumpRuns = [];
    this.killRules = [];
    this.taps = [];
    this.cronOn = { pump: true, watchdog: true, snapshot: true };
    this.scheduleCron();
  }

  // ---- logging ----

  log(who, line) {
    const entry = `${iso(this.t).slice(11, 19)} ${who}: ${line}`;
    this.logs.push(entry);
    if (this.verbose) process.stderr.write(`${entry}\n`);
  }

  tail(n = 80) {
    return this.logs.slice(-n).join('\n');
  }

  violate(what) {
    this.violations.push(`${iso(this.t)} ${what}`);
    this.log('INVARIANT', what);
  }

  // ---- the scheduler ----

  at(time, fn, label = '') {
    this.events.push({ at: Math.max(time, this.t), seq: this.seq++, fn, label });
  }

  after(ms, fn, label) {
    this.at(this.t + ms, fn, label);
  }

  spawn(name, fn) {
    const task = { name, dead: false, busy: true, done: false };
    let finish;
    task.finished = new Promise((r) => { finish = r; });
    task.sleep = (ms) => this.sleepFor(task, ms);
    task.fetch = (input, init) => this.fetchFor(task, input, init);
    this.tasks.add(task);
    this.active += 1;
    Promise.resolve()
      .then(() => fn(task))
      .then((value) => ({ value }), (error) => ({ error }))
      .then((out) => {
        if (task.dead) return;
        task.done = true;
        task.result = out;
        this.tasks.delete(task);
        this.idle(task);
        finish(out);
      });
    return task;
  }

  idle(task) {
    if (!task.busy) return;
    task.busy = false;
    this.active -= 1;
    if (this.active === 0) for (const w of this.idleWaiters.splice(0)) w();
  }

  sleepFor(task, ms) {
    if (task.dead) return new Promise(() => {});
    const wait = Math.max(0, Number(ms) || 0);
    this.idle(task);
    return new Promise((resolve) => {
      this.at(this.t + wait, () => {
        if (task.dead) return;
        task.busy = true;
        this.active += 1;
        resolve();
      }, `wake ${task.name}`);
    });
  }

  /** The task is gone (its runner died): it never runs again and holds nothing. */
  kill(task, why) {
    if (task.dead || task.done) return;
    this.log(task.name, `KILLED (${why})`);
    this.idle(task);
    task.dead = true;
    this.tasks.delete(task);
    if (task.onKill) task.onKill(why);
  }

  async fetchFor(task, input, init = {}) {
    if (task.dead) return new Promise(() => {});
    const res = await this.gh.fetch(input, init);
    if (task.dead) return new Promise(() => {});
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const call = { method: String(init.method ?? 'GET').toUpperCase(), url, path: url.pathname, status: res.status, task };
    if (/\/actions\/artifacts\/\d+\/zip$/.test(call.path)) task.sawArtifact = true;
    for (const tap of this.taps) {
      if (tap.left > 0 && tap.task(task) && tap.when(call)) {
        tap.left -= 1;
        tap.fn(call);
      }
    }
    for (const rule of this.killRules) {
      if (rule.left > 0 && rule.task(task) && rule.when(call)) {
        rule.left -= 1;
        rule.hits += 1;
        this.kill(task, rule.name);
        return new Promise(() => {});
      }
    }
    return res;
  }

  /** Run fn(call) (synchronously) after GitHub answered a matching call of a matching task. */
  tapWhen({ task = (t) => t.name.startsWith('pump'), when, fn, times = 1 }) {
    const tap = { task, when, fn, left: times };
    this.taps.push(tap);
    return tap;
  }

  /** Kill the first task matching `task` whose call matches `when`, after GitHub answered it. */
  killWhen({ name = 'kill', task = (t) => t.name.startsWith('pump'), when, times = 1 }) {
    const rule = { name, task, when, left: times, hits: 0 };
    this.killRules.push(rule);
    return rule;
  }

  async quiesce() {
    const started = Date.now();
    while (this.active > 0) {
      await new Promise((resolve) => {
        this.idleWaiters.push(resolve);
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
      });
      if (this.active > 0 && Date.now() - started > 60_000) {
        throw new SimDeadlock(`tasks still busy after 60 s of real time: ${[...this.tasks].filter((t) => t.busy).map((t) => t.name).join(', ')}`);
      }
    }
  }

  /** Run the world until virtual time `until`. */
  async runUntil(until) {
    for (;;) {
      await this.quiesce();
      this.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const ev = this.events[0];
      if (!ev || ev.at > until) break;
      this.events.shift();
      this.t = Math.max(this.t, ev.at);
      ev.fn();
    }
    this.t = Math.max(this.t, until);
  }

  runFor(ms) {
    return this.runUntil(this.t + ms);
  }

  // ---- GitHub's side: cron and the pump concurrency group ----

  scheduleCron() {
    const next = (fromMs, minutes) => {
      const d = new Date(fromMs);
      for (let i = 0; i < 24 * 60; i++) {
        const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() + i + 1));
        if (minutes.includes(c.getUTCMinutes())) return c.getTime();
      }
      throw new Error('no cron time');
    };
    const loop = (what, minutes, fire) => {
      const go = () => {
        if (this.cronOn[what]) fire();
        this.at(next(this.t, minutes), go, `cron ${what}`);
      };
      this.at(next(this.t - 1, minutes), go, `cron ${what}`);
    };
    loop('pump', [0, 30], () => this.queuePump(this.gh.createRun(TOOLQA, 'pump.yml', { event: 'schedule' })));
    loop('watchdog', [7, 22, 37, 52], () => this.startWatchdog());
    loop('snapshot', [41], () => this.startSnapshot());
  }

  onDispatch(repo, file, run, inputs) {
    if (repo === TOOLQA && file === 'pump.yml') {
      this.queuePump(run);
      return;
    }
    if (repo === WORKER) this.startWorker(run, inputs);
  }

  vars() {
    return { ...this.gh.repo(TOOLQA).variables };
  }

  setVar(name, value) {
    const v = this.gh.repo(TOOLQA).variables;
    if (value === undefined) delete v[name];
    else v[name] = value;
    this.log('operator', `set ${name}=${value}`);
  }

  queuePump(run) {
    this.pumpRuns.push(run);
    const g = this.pumpGroup;
    if (!g.running) {
      this.startPump(run);
      return;
    }
    if (g.pending) {
      this.gh.finishRun(g.pending, 'cancelled');
      this.log('github', `pump run ${g.pending.id} cancelled: a newer run is pending in the group`);
    }
    g.pending = run;
  }

  /** A pump job outside the concurrency group (only for a scenario that breaks it). */
  startPumpUngrouped(run) {
    this.gh.startRun(run);
    const task = this.spawn(`pump#${run.id}`, (t) => this.pumpJob(t, run));
    task.onKill = () => this.gh.finishRun(run, 'failure');
    task.finished.then((out) => this.gh.finishRun(run, out.error ? 'failure' : out.value));
    return task;
  }

  /** A run cancelled through the API: a pending pump run leaves the group; a running job stops. */
  cancelRun(run) {
    const g = this.pumpGroup;
    this.log('github', `run ${run.id} cancelled through the API`);
    if (g.pending === run) {
      g.pending = null;
      this.gh.finishRun(run, 'cancelled');
      return;
    }
    if (g.running === run && run.status === 'queued') {
      // Its start is scheduled: it ends at once, and the group frees.
      run.cancelledBeforeStart = true;
      this.gh.finishRun(run, 'cancelled');
      g.running = null;
      return;
    }
    const task = [...this.tasks].find((t) => t.run === run);
    if (task) this.kill(task, 'cancelled');
    else this.gh.finishRun(run, 'cancelled');
  }

  startPump(run) {
    const g = this.pumpGroup;
    if (run.cancelledBeforeStart) return;
    g.running = run;
    this.gh.startRun(run);
    const task = this.spawn(`pump#${run.id}`, (t) => this.pumpJob(t, run));
    task.run = run;
    const done = (conclusion) => {
      this.gh.finishRun(run, conclusion);
      run.conclusionSeen = conclusion;
      const p = g.pending;
      g.pending = null;
      g.running = p;
      if (p) this.after(20_000, () => this.startPump(p), 'start pending pump');
    };
    task.onKill = () => this.after(MIN, () => done('failure'), 'runner lost');
    task.finished.then((out) => done(out.error ? 'failure' : out.value));
  }

  mintToken() {
    return async () => ({ token: `ghs_chaos${String(++this.tokens).padStart(6, '0')}`, expiresAt: this.t + HOUR });
  }

  pullFor(task) {
    return (o) => pullState({ ...o, apiUrl: API_HOST, sleep: task.sleep, crypto: fakeStateCrypto({ identity: o.identity, recipients: this.statePub }) });
  }

  pushFor(task) {
    return (o) => pushState({ ...o, apiUrl: API_HOST, sleep: task.sleep, crypto: fakeStateCrypto({ identity: o.identity, recipients: this.statePub }) });
  }

  async pumpJob(task, run) {
    const who = `pump#${run.id}`;
    const say = (l) => this.log(who, l);
    // The pump runner's clock, which may be off from GitHub's by pumpSkewMs.
    const clock = () => this.t + this.pumpSkewMs;
    await task.sleep(20_000); // checkout
    const vars = this.vars();
    const g = evaluateGuard({ LOOP_ENABLED: vars.LOOP_ENABLED, LOOP_SLOTS: vars.LOOP_SLOTS, LOOP_PAUSE_UNTIL: vars.LOOP_PAUSE_UNTIL, LANE_PUMP_ENABLED: vars.LANE_PUMP_ENABLED }, { job: 'pump', now: this.t });
    say(`guard: ${g.notice}`);
    run.guard = g;
    if (!g.proceed) return 'success';
    const dir = mkdtempSync(join(this.dir, 'pump-'));
    const successorFile = join(dir, 'successor.json');
    if (g.slots !== 0) {
      const res = await dispatchSuccessor({
        env: { GITHUB_REPOSITORY: TOOLQA, GITHUB_REF_NAME: 'main' }, now: clock, sleep: task.sleep, fetch: task.fetch,
        apiUrl: API_HOST, random: this.random, log: say, mintToken: this.mintToken(),
      });
      writeFileSync(successorFile, `${JSON.stringify(res)}\n`);
      run.successor = res;
    }
    await task.sleep(10_000); // set up node, install age
    const out = await runPump({
      env: { GITHUB_REPOSITORY: TOOLQA, GITHUB_TOKEN: `ghs_jobtoken${run.id}`, LOOP_SLOTS: String(g.slots), AGE_IDENTITY: this.identity, GITHUB_API_URL: API_HOST },
      now: clock,
      sleep: task.sleep,
      fetch: task.fetch,
      log: say,
      stateFile: join(dir, 'state.sqlite'),
      seedFile: null,
      config: this.config,
      pull: this.pullFor(task),
      push: this.pushFor(task),
      mintToken: this.mintToken(),
      budget: new ApiBudget({ now: clock, sleep: task.sleep, random: this.random }),
      ingestOptions: {
        crypto: {
          decrypt: (ct) => openWith(this.identity, ct),
          encrypt: (pt, recipients) => sealTo(recipients, pt),
          publicKey: () => this.ingestPub,
        },
        registry: this.registry,
        sealTo: this.sealFile,
        outDir: join(dir, 'ingest-out'),
      },
      successorFile: run.successor ? successorFile : undefined,
      newId: () => this.newId(),
      readConformance: async () => { throw new Error('no untrusted lane in the chaos config'); },
      verifyConformanceRun: async () => ({ ok: false, why: 'unused' }),
    });
    run.pump = out;
    say(`run ended ok=${out.ok} ticks=${out.ticks} dispatched=${out.dispatched} failed=${out.failed}`);
    return out.ok ? 'success' : 'failure';
  }

  newId() {
    this.ids += 1;
    const r = Math.floor(this.random() * 0xffffffff).toString(16).padStart(8, '0');
    return `${r}-c4a0-4000-8000-${String(this.ids).padStart(12, '0')}`;
  }

  // ---- the watchdog, the snapshot, the operator ----

  startWatchdog() {
    const run = this.gh.createRun(TOOLQA, 'watchdog.yml', { event: 'schedule' });
    this.gh.startRun(run);
    const task = this.spawn(`watchdog#${run.id}`, async (t) => {
      const vars = this.vars();
      const g = evaluateGuard({ ...vars }, { job: 'watchdog', noSlots: true, now: this.t });
      if (!g.proceed) return 'success';
      const say = (l) => this.log(`watchdog#${run.id}`, l);
      const lanes = Object.fromEntries(Object.entries(vars).filter(([k]) => /^LANE_/.test(k)));
      const out = await runWatchdog({
        env: {
          GITHUB_REPOSITORY: TOOLQA, GITHUB_TOKEN: `ghs_wdjob${run.id}`, GITHUB_REF_NAME: 'main', LOOP_SLOTS: vars.LOOP_SLOTS ?? '',
          AGE_IDENTITY: this.identity, ARCHIVE_LAST_OK: JSON.stringify({ at: iso(this.t - HOUR), pulled: 1, quarantined: 0 }), ...lanes,
        },
        now: () => this.t,
        sleep: t.sleep,
        fetch: t.fetch,
        apiUrl: API_HOST,
        log: say,
        mintToken: this.mintToken(),
        pull: this.pullFor(t),
        stateDir: mkdtempSync(join(this.dir, 'wd-')),
        expected: loadExpected(),
        readConformance: async () => ({ status: greenStatus(this.t - HOUR) }),
        verifyConformanceRun: async (status) => ({ ok: true, why: 'chaos', run: { started_at: status.checked_at, updated_at: status.checked_at } }),
        workerWorkflows: this.config.workflows,
      });
      this.lastWatchdog = out;
      return 'success';
    });
    task.finished.then((o) => {
      if (o.error) this.log(`watchdog#${run.id}`, `failed: ${o.error.message}`);
      this.gh.finishRun(run, o.error ? 'failure' : o.value);
    });
  }

  startSnapshot() {
    const run = this.gh.createRun(TOOLQA, 'state-snapshot.yml', { event: 'schedule' });
    this.gh.startRun(run);
    const task = this.spawn(`snapshot#${run.id}`, async (t) => {
      const vars = this.vars();
      const g = evaluateGuard({ ...vars }, { job: 'state-snapshot', noSlots: true, now: this.t });
      if (!g.proceed) return 'success';
      const gh = createReleaseClient({ repo: TOOLQA, token: `ghs_snap${run.id}`, fetch: t.fetch, apiUrl: API_HOST, sleep: t.sleep });
      const r = await runSnapshot({ gh, now: () => this.t, log: (l) => this.log(`snapshot#${run.id}`, l) });
      this.lastSnapshot = r;
      return 'success';
    });
    task.finished.then((o) => {
      if (o.error) this.log(`snapshot#${run.id}`, `failed: ${o.error.message}`);
      this.gh.finishRun(run, o.error ? 'failure' : o.value);
    });
  }

  /**
   * The restore drill with --apply, run by an operator. Resolves to { report }
   * or { error }. While it runs, a new live state is the restored snapshot: an
   * intended step back, so the state history checks start again from it.
   */
  restore({ name } = {}) {
    this.restores = (this.restores ?? 0) + 1;
    const task = this.spawn('operator-restore', async (t) => {
      const gh = createReleaseClient({ repo: TOOLQA, token: 'ghs_operator', fetch: t.fetch, apiUrl: API_HOST, sleep: t.sleep });
      this.restoring = true;
      try {
        return await drill({ gh, name, apply: true, now: () => this.t, log: (l) => this.log('operator', l), decrypt: (b) => openWith(this.identity, b), tmpRoot: this.dir });
      } finally {
        this.restoring = false;
      }
    });
    return task.finished.then((o) => {
      if (!o.error && o.value?.applied) this.restoresApplied = (this.restoresApplied ?? 0) + 1;
      return o.error ? { error: o.error } : { report: o.value };
    });
  }

  /**
   * Another writer's push lands (a person pushing by hand, a second writer):
   * the live state is read, changed by mutate(db) and put back as a new asset,
   * the way scripts/state-asset.mjs push leaves it. Checked like any push.
   */
  foreignWrite(mutate) {
    const live = this.liveAsset();
    const plain = openWith(this.identity, this.gh.assetBytes(live.id));
    const file = join(this.dir, `foreign-${++this.seq}.sqlite`);
    writeFileSync(file, plain);
    const db = openState(file);
    try {
      mutate(db);
    } finally {
      db.close();
    }
    const bytes = this.encryptState(readFileSync(file));
    rmSync(file, { force: true });
    const sha = createHash('sha256').update(bytes).digest('hex');
    const rel = this.stateRelease();
    const up = this.gh.addAsset(TOOLQA, 'state', `state.sqlite.upload-foreign${this.seq}`, bytes, `sha256:${sha}`);
    rel.assets = rel.assets.filter((a) => a.id !== live.id);
    up.name = 'state.sqlite';
    up.updated_at = new Date(this.t + 1).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.log('foreign', `pushed the state as asset ${up.id}`);
    this.observeState();
    return up;
  }

  /** The live state asset is deleted (an injected fault). */
  deleteState() {
    const rel = this.stateRelease();
    const live = this.liveAsset();
    if (!rel || !live) return;
    rel.assets = rel.assets.filter((a) => a.id !== live.id);
    this.gh.blobs.delete(`asset:${live.id}`);
    this.injected.add('absent');
    this.observeState({ injected: true });
  }

  // ---- the worker ----

  startWorker(run, inputs) {
    let items;
    try {
      items = JSON.parse(inputs.items);
    } catch {
      items = [];
    }
    const ctx = { run, inputs, items, attemptId: inputs.attempt_id, n: this.workerRuns.length, sim: this };
    const plan = {
      startMs: 15_000, durationMs: 3 * MIN, conclusion: 'success', hold: false,
      item: () => ({}),
      ...this.worker(ctx),
    };
    run.plan = plan;
    this.workerRuns.push(run);
    this.log('worker', `run ${run.id} for ${inputs.shard_id} (${items.length} item(s))${plan.hold ? ', held' : ''}`);
    if (plan.hold) return;
    this.after(plan.startMs, () => {
      this.gh.startRun(run);
      this.countInProgress();
    }, 'worker start');
    this.after(plan.startMs + plan.durationMs, () => this.finishWorker(run), 'worker finish');
  }

  /** Finish a held worker run now (it uploads its bundles and completes). */
  releaseWorker(run) {
    if (run.status === 'queued') this.gh.startRun(run);
    this.finishWorker(run);
  }

  finishWorker(run) {
    if (run.status === 'completed') return;
    const plan = run.plan;
    const items = JSON.parse(run.inputs.items);
    items.forEach((it, i) => {
      const p = { upload: true, identity: {}, meta: {}, ...plan.item(it, i, run) };
      if (!p.upload) return;
      const identity = { attempt_id: run.inputs.attempt_id, run_key: it.run_key, fence: it.fence, ...p.identity };
      const bundle = makeBundle({
        identity,
        workflow: { repo: WORKER, file: `.github/workflows/${WORKER_FILE}`, sha: run.head_sha, run_id: run.id, run_attempt: 1 },
        meta: {
          subject: { id: it.subject, repo: it.subject, sha: 'c'.repeat(40) },
          started_at: iso(Date.parse(run.run_started_at ?? run.created_at)).replace(/\.\d{3}Z$/, 'Z'),
          finished_at: iso(this.t).replace(/\.\d{3}Z$/, 'Z'),
          ...p.meta,
        },
      });
      this.gh.uploadArtifact(WORKER, run, `result-${run.inputs.attempt_id}-${i}.tar.age`, sealTo([this.ingestPub], bundle.tar));
      this.uploaded.add(`${identity.attempt_id}:${identity.run_key}:${identity.fence}`);
    });
    this.gh.finishRun(run, plan.conclusion);
    this.countInProgress();
    this.log('worker', `run ${run.id} finished (${plan.conclusion})`);
  }

  countInProgress() {
    const n = this.workerRuns.filter((r) => r.status === 'in_progress').length;
    this.maxInProgress = Math.max(this.maxInProgress, n);
  }

  // ---- the state asset, as the release shows it ----

  encryptState(plain) {
    return sealTo(this.statePub, plain);
  }

  stateRelease() {
    return this.gh.release(TOOLQA, 'state');
  }

  /** The asset the pump would read: state.sqlite, else the newest interrupted upload. */
  liveAsset() {
    const rel = this.stateRelease();
    if (!rel) return null;
    const main = rel.assets.find((a) => a.name === 'state.sqlite');
    if (main) return main;
    return rel.assets.filter((a) => a.name.startsWith('state.sqlite.upload-')).sort((a, b) => b.id - a.id)[0] ?? null;
  }

  /** Replace the live asset's bytes in place (an injected fault; not checked as a pump write). */
  replaceState(bytes, { label, injected = true } = {}) {
    const a = this.liveAsset();
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.gh.corruptAsset(a.id, bytes, { label: label === undefined ? `sha256:${sha}` : label });
    if (injected) this.injected.add(this.versionKey(this.liveAsset()));
    this.observeState({ injected });
  }

  versionKey(a) {
    return a ? `${a.id}:${a.label}:${a.size}` : 'absent';
  }

  /** Open the live state with the loop identity; null if it cannot be read. */
  readLive(asset = this.liveAsset()) {
    if (!asset) return null;
    const bytes = this.gh.assetBytes(asset.id);
    let plain;
    try {
      plain = openWith(this.identity, bytes);
    } catch {
      return { unreadable: 'decrypt' };
    }
    const file = join(this.dir, `observe-${++this.seq}.sqlite`);
    writeFileSync(file, plain);
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const qc = Object.values(db.prepare('PRAGMA quick_check').get())[0];
        if (qc !== 'ok') return { unreadable: `quick_check ${qc}` };
        const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
        const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
        return {
          version: db.prepare('PRAGMA user_version').get().user_version,
          fence: has('counters') ? db.prepare("SELECT value FROM counters WHERE name = 'fence'").get()?.value ?? 0 : 0,
          attempts: has('attempts') ? all('SELECT id, run_key, fence, attempt_id, accepted, reason, received, outcome FROM attempts ORDER BY id') : [],
          results: has('results') ? all('SELECT run_key, subject, attempt_id, fence, accepted_at, outcome FROM results') : [],
          dispatches: has('dispatches') ? all('SELECT attempt_id, shard_id, status, created, expires, closed, close_reason, run_id FROM dispatches') : [],
          items: has('dispatch_items') ? all('SELECT attempt_id, run_key, subject, fence, resolved FROM dispatch_items') : [],
          slots: has('slot_ledger') ? all('SELECT * FROM slot_ledger WHERE released IS NULL') : [],
          kv: has('kv') ? Object.fromEntries(all('SELECT key, value FROM kv').map((r) => [r.key, safeJson(r.value)])) : {},
        };
      } finally {
        db.close();
      }
    } catch (err) {
      return { unreadable: `sqlite ${err.message}` };
    } finally {
      rmSync(file, { force: true });
    }
  }

  observeState({ injected = false } = {}) {
    const a = this.liveAsset();
    const key = this.versionKey(a);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (!a || a.size === 0) return;
    const s = this.readLive(a);
    const v = { key, at: this.t, injected: injected || this.injected.has(key), restored: Boolean(this.restoring), s };
    this.stateVersions.push(v);
    if (v.injected) return;
    if (s.unreadable) {
      this.violate(`the live state asset ${key} cannot be read by the loop (${s.unreadable})`);
      return;
    }
    if (this.statePrev && this.allowRollback === 0 && !v.restored) this.checkForward(this.statePrev, s, key);
    if (this.allowRollback > 0) this.allowRollback -= 1;
    this.checkState(s, key);
    this.statePrev = s;
  }

  /** The state never moves backwards from one pushed version to the next. */
  checkForward(prev, cur, key) {
    if (cur.version < prev.version) this.violate(`${key}: schema version went back from ${prev.version} to ${cur.version}`);
    if (cur.fence < prev.fence) this.violate(`${key}: fence counter went back from ${prev.fence} to ${cur.fence}`);
    const attempts = new Map(cur.attempts.map((x) => [x.id, x]));
    for (const p of prev.attempts) {
      const c = attempts.get(p.id);
      if (!c) this.violate(`${key}: attempt ${p.id} (${p.attempt_id} ${p.reason ?? 'accepted'}) disappeared`);
      else if (c.run_key !== p.run_key || c.fence !== p.fence || c.accepted !== p.accepted || c.attempt_id !== p.attempt_id) this.violate(`${key}: attempt ${p.id} changed`);
    }
    const results = new Map(cur.results.map((r) => [r.run_key, r]));
    for (const p of prev.results) {
      const c = results.get(p.run_key);
      if (!c) this.violate(`${key}: the result for ${p.run_key.slice(0, 12)} disappeared`);
      else if (c.accepted_at < p.accepted_at) this.violate(`${key}: the result for ${p.run_key.slice(0, 12)} went back in time`);
    }
    const dispatches = new Map(cur.dispatches.map((d) => [d.attempt_id, d]));
    const forward = { pending: ['pending', 'dispatched', 'failed', 'done', 'expired'], dispatched: ['dispatched', 'done', 'expired'], done: ['done'], failed: ['failed'], expired: ['expired'] };
    for (const p of prev.dispatches) {
      const c = dispatches.get(p.attempt_id);
      if (!c) this.violate(`${key}: dispatch ${p.attempt_id} disappeared`);
      else if (!(forward[p.status] ?? []).includes(c.status)) this.violate(`${key}: dispatch ${p.attempt_id} went from ${p.status} to ${c.status}`);
    }
  }

  /** Safety of one state version: no duplicate and no stale-fence acceptance. */
  checkState(s, key) {
    const accepted = s.attempts.filter((a) => a.accepted === 1);
    const perKey = new Map();
    for (const a of accepted) perKey.set(a.run_key, [...(perKey.get(a.run_key) ?? []), a]);
    for (const [k, list] of perKey) if (list.length > 1) this.violate(`${key}: run_key ${k.slice(0, 12)} has ${list.length} accepted results (${list.map((a) => a.attempt_id.slice(0, 8)).join(', ')})`);
    const created = new Map(s.dispatches.map((d) => [d.attempt_id, d.created]));
    for (const a of accepted) {
      const item = s.items.find((i) => i.attempt_id === a.attempt_id && i.run_key === a.run_key);
      if (!item || item.fence !== a.fence) this.violate(`${key}: accepted ${a.attempt_id.slice(0, 8)} with fence ${a.fence} that its dispatch did not carry`);
      const newer = s.items.filter((i) => i.run_key === a.run_key && i.fence > a.fence && (created.get(i.attempt_id) ?? '') <= a.received);
      if (newer.length) this.violate(`${key}: accepted a stale fence ${a.fence} for ${a.run_key.slice(0, 12)} after fence ${newer[0].fence} was granted`);
      if (!this.uploaded.has(`${a.attempt_id}:${a.run_key}:${a.fence}`)) this.violate(`${key}: accepted ${a.attempt_id.slice(0, 8)}/${a.fence}, which no worker uploaded`);
    }
  }

  // ---- what tests look at ----

  /** The current run_key of every subject for the chaos workflow. */
  runKeys() {
    const wf = this.config.workflows[WORKFLOW];
    return this.subjects.map((s) => runKey(runKeyFields({ id: s.id, sha: s.sha, artifact_digest: null }, WORKFLOW, wf)));
  }

  /** Subjects whose current run_key has no accepted result in the live state. */
  missing(s = this.readLive()) {
    if (!s || s.unreadable) return this.subjects.map((x) => x.id);
    const have = new Set(s.results.map((r) => r.run_key));
    return this.runKeys().map((k, i) => (have.has(k) ? null : this.subjects[i].id)).filter(Boolean);
  }

  health() {
    const issue = this.gh.repo(TOOLQA).issues.find((i) => i.title === 'Loop health');
    const parsed = issue ? parseBody(issue.body) : null;
    if (!parsed) return { overall: null, checks: {} };
    return { overall: parsed.overall, checks: Object.fromEntries(parsed.checks.map((c) => [c.id, c])) };
  }

  /** Worker runs whose attempt the live state does not know. */
  orphanRuns(s = this.readLive()) {
    const known = new Set((s?.dispatches ?? []).map((d) => d.attempt_id));
    return this.workerRuns.filter((r) => !known.has(r.inputs.attempt_id));
  }

  /**
   * Run_keys parked after too many counted rejections (pump/tiers.json
   * max_rejections): the loop stops sending them on purpose.
   */
  parked(s = this.readLive()) {
    const max = this.config.tiers.max_rejections ?? 3;
    const notCounted = new Set(['unknown_attempt', 'unknown_run_key', 'fence_mismatch', 'duplicate_result', 'stale_fence', 'retry_later', 'retry_throttled', 'run_sha_mismatch']);
    const out = new Set();
    for (const k of this.runKeys()) {
      const accepted = s.results.find((r) => r.run_key === k)?.accepted_at ?? '';
      const n = s.attempts.filter((a) => a.run_key === k && a.accepted === 0 && !notCounted.has(a.reason) && a.received > accepted).length;
      if (n >= max) out.add(k);
    }
    return out;
  }

  /**
   * Everything that is wrong once the loop has had time to recover: the
   * invariant violations seen on the way, plus the end state. `allow` widens
   * what a scenario expects (worker runs the state cannot know after a
   * restore, extra runs from an answer that lied).
   */
  problems({ health = ['green'], allowOrphans = false, extraRuns = 0, allowParked = false } = {}) {
    const out = [...this.violations];
    const s = this.readLive();
    if (!s || s.unreadable) {
      out.push(`the live state cannot be read at the end (${s?.unreadable ?? 'absent'})`);
      return out;
    }
    const parked = this.parked(s);
    const missing = this.runKeys().map((k, i) => ({ k, id: this.subjects[i].id })).filter(({ k }) => !s.results.some((r) => r.run_key === k));
    const lost = missing.filter(({ k }) => !(allowParked && parked.has(k)));
    if (lost.length) out.push(`no accepted result at the end for ${lost.map((m) => m.id).join(', ')}`);
    if (parked.size && !allowParked) out.push(`parked run_keys: ${[...parked].map((k) => k.slice(0, 12)).join(', ')}`);
    const h = this.health();
    if (!health.includes(h.overall)) {
      out.push(`health is ${h.overall}, expected ${health.join(' or ')}: ${Object.values(h.checks).filter((c) => c.status !== 'green').map((c) => `${c.id}=${c.status} (${c.summary})`).join('; ')}`);
    }
    const orphans = this.orphanRuns(s);
    if (orphans.length && !allowOrphans) out.push(`${orphans.length} worker run(s) the state does not know: ${orphans.map((r) => r.display_title).join(', ')}`);
    const slots = Number(this.vars().LOOP_SLOTS ?? 0);
    if (this.maxInProgress > slots + extraRuns) out.push(`${this.maxInProgress} worker runs in progress at once with ${slots} slots`);
    const openPast = s.dispatches.filter((d) => ['pending', 'dispatched'].includes(d.status) && Date.parse(d.expires) < this.t - 20 * MIN);
    if (openPast.length) out.push(`${openPast.length} dispatch(es) open long past their lease`);
    return out;
  }

  pumpConclusions() {
    return this.pumpRuns.map((r) => r.conclusion ?? r.status);
  }

  async close() {
    for (const t of [...this.tasks]) this.kill(t, 'sim closed');
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function safeJson(v) {
  try { return JSON.parse(v); } catch { return v; }
}

/** A passing nightly sandbox conformance status (as test/lib/conformance.mjs), checked at `at`. */
export function greenStatus(at) {
  return {
    format: 'isokron-sandbox-conformance/1', ok: true, selftest: 'pass', mutations: 'pass', result: 'success',
    checked_at: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: 1, run_attempt: 1,
    run_url: 'https://github.com/chaos-sim/sandbox/actions/runs/1', sandbox_sha: 'a'.repeat(40),
    runner_image: 'ubuntu24/chaos', kernel: 'chaos', docker: 'chaos', gvisor_release: 'chaos', runsc_version: 'chaos',
  };
}
