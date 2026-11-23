#!/usr/bin/env node
// Loop kill-switch guard. Run it as the first step of every scheduled or
// dispatched loop job:
//
//   node scripts/guard.mjs --job <name> [--slots]
//
// Inputs (environment; map repository variables in with `vars.*`):
//   LOOP_ENABLED          must be exactly "true", or the job does nothing.
//   LOOP_PAUSE_UNTIL      optional ISO 8601 time; the job does nothing until then.
//                         A value that can't be read also stops the job (fail safe).
//   LANE_<JOB>_ENABLED    optional per-job switch; if set and not "true", this job
//                         does nothing. Unset or empty leaves the job on.
//   LOOP_SLOTS            whole number of worker slots, default 0, clamped to 0..15.
//                         With --slots, 0 slots means the job does nothing.
//
// Outputs (appended to $GITHUB_OUTPUT, or printed if it is not set):
//   proceed=true|false, slots=<n>, reason=<code>
//
// The guard always exits 0 when it has decided, so a stopped loop never shows
// as a failed run. It exits 2 only on a usage error.

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_SLOTS = 15;

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Parse LOOP_SLOTS. Returns { slots, valid }. */
export function parseSlots(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { slots: 0, valid: true };
  if (!/^[+-]?\d+$/.test(text)) return { slots: 0, valid: false };
  const n = Number(text);
  if (n <= 0) return { slots: 0, valid: true };
  return { slots: Math.min(n, MAX_SLOTS), valid: true };
}

/** Parse an ISO 8601 time. Date-only values mean 00:00 UTC. Returns ms or NaN. */
export function parseIsoTime(raw) {
  const m = ISO_RE.exec(String(raw ?? '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return NaN;
  const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if (day > daysInMonth) return NaN;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return NaN;
  return Date.parse(String(raw).trim());
}

/** Name of the per-job switch for a job, e.g. meta-github -> LANE_META_GITHUB_ENABLED. */
export function laneVariable(job) {
  const id = String(job)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `LANE_${id}_ENABLED`;
}

function oneLine(text) {
  return String(text).replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/**
 * Decide whether a loop job may run.
 * @param {Record<string, string|undefined>} env
 * @param {{ job: string, needsSlots?: boolean, now?: number }} opts
 * @returns {{ proceed: boolean, slots: number, reason: string, notice: string }}
 */
export function evaluateGuard(env, { job, needsSlots = false, now = Date.now() } = {}) {
  if (!job || !String(job).trim()) throw new Error('guard: a job name is required (--job, LOOP_JOB or GITHUB_JOB)');
  const name = oneLine(job).trim();
  const stop = (reason, why) => ({ proceed: false, slots: 0, reason, notice: `${name}: ${why}; skipping.` });

  if (env.LOOP_ENABLED !== 'true') {
    return stop('disabled', 'loop is off (LOOP_ENABLED is not "true")');
  }

  const pauseRaw = env.LOOP_PAUSE_UNTIL;
  if (pauseRaw !== undefined && String(pauseRaw).trim() !== '') {
    const until = parseIsoTime(pauseRaw);
    if (Number.isNaN(until)) {
      return stop('invalid_pause', `LOOP_PAUSE_UNTIL "${oneLine(pauseRaw)}" is not an ISO 8601 time with a zone, so the loop stays paused`);
    }
    if (until > now) {
      return stop('paused', `loop is paused until ${new Date(until).toISOString()} (LOOP_PAUSE_UNTIL)`);
    }
  }

  const lane = laneVariable(name);
  const laneRaw = env[lane];
  if (laneRaw !== undefined && laneRaw !== '' && laneRaw !== 'true') {
    return stop('lane_disabled', `this lane is off (${lane} is not "true")`);
  }

  const { slots, valid } = parseSlots(env.LOOP_SLOTS);
  const slotNote = valid ? '' : ' (LOOP_SLOTS is not a whole number, using 0)';
  if (needsSlots && slots === 0) {
    return stop('no_slots', `no worker slots (LOOP_SLOTS is 0 or unset)${slotNote}`);
  }
  return {
    proceed: true,
    slots,
    reason: 'ok',
    notice: `${name}: loop is on; proceeding with ${slots} slot${slots === 1 ? '' : 's'}${slotNote}.`,
  };
}

function escapeCommand(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function parseArgs(argv) {
  const opts = { job: undefined, needsSlots: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slots') opts.needsSlots = true;
    else if (a === '--job') opts.job = argv[++i];
    else if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else throw new Error(`guard: unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let result;
  try {
    const opts = parseArgs(argv);
    const job = opts.job || env.LOOP_JOB || env.GITHUB_JOB;
    result = evaluateGuard(env, { job, needsSlots: opts.needsSlots });
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node scripts/guard.mjs --job <name> [--slots]\n`);
    return 2;
  }
  const line = env.GITHUB_ACTIONS === 'true'
    ? `::notice title=Loop guard::${escapeCommand(result.notice)}`
    : result.notice;
  process.stdout.write(`${line}\n`);
  const outputs = `proceed=${result.proceed}\nslots=${result.slots}\nreason=${result.reason}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
