// Ingest inside the pump: judge the results of finished worker runs and record
// them in the state before the pump pushes it.
//
// The pump is the state's only writer, so ingest runs in its process, at the
// start of every tick (pump/run.mjs). collect() walks the dispatches that are
// still waiting for a result (StateDb.dispatchesAwaitingResults), oldest first:
//
//   no run id yet       find the run by its run name ("shard <shard_id>"); if
//                       there is none yet, wait
//   run not finished    wait (a run GitHub does not know also waits: the lease
//                       expires and the work is due again)
//   run finished        openAttempt() (ingest.mjs) reads the ledger row, checks
//                       the run and lists its artifacts once; then each item
//                       (run_key) of the shard that has no result yet is judged
//                       against its own result bundle, recorded, and its outputs
//                       sealed to worker-kit/ingest.pub as
//                       <outDir>/ingest-<attempt>-<index>.tar.age. Once every
//                       item has a decision the dispatch is closed
//                       (run_completed, unless the store already closed it as
//                       results_in), which frees its slot and any lease left
//
// Each item's recording and sealing share one state transaction: if its outputs
// cannot be written, nothing is recorded for it, the other items go on, and a
// later tick judges it again; the dispatch stays open until then. The deadline
// is checked before every item, so a large shard can be judged over several
// ticks; items already recorded are skipped. An attempt refused before any item
// could be judged records nothing; its report is sealed as
// <outDir>/ingest-<attempt>.tar.age and the dispatch is closed. A dispatch whose
// lease expired before its run finished is still judged for `lateMs` after it
// closed (the store keeps those late results as rejected); such late runs are
// looked at every `recheckLateMs` at most.
//
// Before anything is judged, check() makes sure it can be sealed and decrypted:
// ingest.pub holds a real age key, AGE_IDENTITY is set and belongs to it.
// Otherwise it throws IngestSetupError, and the pump dispatches nothing, so no
// worker runs whose result could not be judged.
//
// GitHub calls use an installation token per worker repository with actions:
// read only. The pump hands in a fetch that goes through its API budget
// (pump/budgets.mjs budgetedFetch); a BudgetExceededError ends this tick's
// ingest: items recorded before it stay recorded, nothing more is judged.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packBundle } from '../worker-kit/bundle.mjs';
import { writeTar } from '../worker-kit/tar.mjs';
import { AgeError, ageDecrypt, ageEncrypt, agePublicKey, readSealRecipients } from './age.mjs';
import { makeGithub, sleepUnless } from './github.mjs';
import { MAX_BUNDLE_BYTES, openAttempt } from './ingest.mjs';
import { dbLedger } from './ledger.mjs';
import { loadRegistry as loadPinnedRegistry } from './registry.mjs';
import { keepSet } from './retention.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_MARGIN_MS = 5 * MINUTE;
/**
 * Record in kv `retention.seal` what one seal did: bytes before and after
 * compression, and any failure. `streak` counts seals in a row with a failure
 * (the watchdog's amber at one, red at three). Never throws into the seal.
 */
export function noteSeal(db, { bytesIn, bytesOut, keptBytes = 0, failures = [], gaps = [], at }) {
  try {
    const prev = db.getKv(SEAL_KEY) ?? {};
    const failed = failures.length > 0;
    const next = {
      at: new Date(at).toISOString(),
      sealed: (prev.sealed ?? 0) + 1,
      bytes_in: (prev.bytes_in ?? 0) + bytesIn,
      bytes_out: (prev.bytes_out ?? 0) + bytesOut,
      kept_bytes: (prev.kept_bytes ?? 0) + keptBytes,
      failures: { compress: (prev.failures?.compress ?? 0) + failures.filter((f) => f.kind === 'compress').length, keep: (prev.failures?.keep ?? 0) + failures.filter((f) => f.kind === 'keep').length },
      streak: failed ? (prev.streak ?? 0) + 1 : 0,
      // Each keep-forever file that could not be written and the pump run whose gap marker artifact (ingest-keepgap-<run>) must
      // exist for it: the watchdog checks the marker is there (keep/health.mjs markerCheck, R-WD-14). The last 20.
      keep_gaps: [...(Array.isArray(prev.keep_gaps) ? prev.keep_gaps : []), ...gaps.map((g) => ({ ...g, at: new Date(at).toISOString() }))].slice(-20),
      last_failure: failed ? { at: new Date(at).toISOString(), kind: failures[0].kind, what: failures[0].what, error: failures[0].error } : prev.last_failure ?? null,
    };
    db.setKv(SEAL_KEY, next, { now: at });
  } catch {
    // the note is only for the health issue
  }
}
export const SEAL_KEY = 'retention.seal';

/**
 * How many times the pump may fail to judge one item (an error of ours, not
 * a transient GitHub or network one) before it records the item as rejected
 * ingest_error. Three ticks rule out a passing glitch.
 */
export const MAX_ITEM_FAILURES = 3;
/** How long after its lease expired a dispatch's late result is still judged. */
export const LATE_MS = 6 * HOUR;
/**
 * collect()'s deadline is when it starts nothing new (the pump's run end minus
 * two minutes). A GitHub call already running may finish within this grace,
 * which takes it to the pump run's end; then it is aborted (R-ING-17).
 */
export const CALL_GRACE_MS = 2 * MINUTE;
const MAX_TIMER_MS = 2 ** 31 - 1;
const SEAL_TO = fileURLToPath(new URL('../worker-kit/ingest.pub', import.meta.url));

/** Ingest cannot work as set up (keys, contract). The pump must not dispatch work. */
export class IngestSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestSetupError';
  }
}

/** When GitHub says a completed run finished (its updated_at), in ms; null if it does not say. */
export function completedAt(run) {
  if (run?.status !== 'completed') return null;
  const t = Date.parse(run.updated_at);
  return Number.isFinite(t) ? t : null;
}

/** ISO time to the second (the form GitHub's created filter documents). */
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {object} [o]
 * @param {Record<string, string|undefined>} [o.env]  AGE_IDENTITY, AGE_BIN, AGE_KEYGEN_BIN, GITHUB_API_URL, RUNNER_TEMP
 * @param {string} [o.identity]       the age identity (default env.AGE_IDENTITY, read now)
 * @param {Function} [o.fetch]        the pump passes its budgeted fetch
 * @param {string} [o.apiUrl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [o.sleep]  ends early when signal aborts
 * @param {number} [o.retries]        retries per GitHub call (ingest/github.mjs)
 * @param {string} [o.outDir]         where sealed outputs go (default $RUNNER_TEMP/ingest-out)
 * @param {string} [o.keepDir]        where the keep-forever files go (default keep-out beside outDir)
 * @param {string} [o.gapDir]         where a keep-forever gap marker goes (default keep-gap-out beside outDir)
 * @param {(tar: Buffer) => Buffer} [o.compress]  zstd for a tar before it is sealed (default worker-kit/bundle.mjs packBundle)
 * @param {string} [o.sealTo]         recipients file (default worker-kit/ingest.pub)
 * @param {object} [o.registry]       a loaded field registry (default: the pinned one, fetched once)
 * @param {Function} [o.loadRegistry]
 * @param {{decrypt?: Function, encrypt?: Function, publicKey?: Function}} [o.crypto]  default: the age binary
 * @param {boolean} [o.allowNoControls]
 * @param {number} [o.lateMs]         how long after a lease expired a result is still judged
 * @param {number} [o.recheckLateMs]  how often such a late run is looked at
 * @param {number} [o.maxItemFailures] failed judgings of one item before it is
 *                                    recorded as rejected ingest_error
 * @param {{analyze?: Function, judgeTimeoutMs?: number}} [o.judge]  passed to openAttempt (tests)
 * @param {number} [o.callGraceMs]     how long after collect()'s deadline a GitHub call may still run
 */
export function createCollector({
  env = process.env,
  identity = env.AGE_IDENTITY,
  fetch = globalThis.fetch,
  apiUrl = env.GITHUB_API_URL || 'https://api.github.com',
  sleep = sleepUnless,
  retries = 3,
  outDir = join(env.RUNNER_TEMP || tmpdir(), 'ingest-out'),
  keepDir = join(dirname(outDir), 'keep-out'),
  gapDir = join(dirname(outDir), 'keep-gap-out'),
  compress = packBundle,
  sealTo = SEAL_TO,
  registry = null,
  loadRegistry = loadPinnedRegistry,
  crypto = {},
  allowNoControls = false,
  lateMs = LATE_MS,
  recheckLateMs = 10 * MINUTE,
  maxItemFailures = MAX_ITEM_FAILURES,
  judge = {},
  callGraceMs = CALL_GRACE_MS,
} = {}) {
  const ageBin = env.AGE_BIN || 'age';
  const keygenBin = env.AGE_KEYGEN_BIN || 'age-keygen';
  const tmpDir = env.RUNNER_TEMP || tmpdir();
  const decrypt = crypto.decrypt ?? ((ciphertext) => ageDecrypt({ ciphertext, identity, ageBin, tmpDir, maxBytes: MAX_BUNDLE_BYTES }));
  const encrypt = crypto.encrypt ?? ((plaintext, recipients) => ageEncrypt({ plaintext, recipients, ageBin, maxBytes: plaintext.length }));
  const publicKey = crypto.publicKey ?? (() => agePublicKey({ identity, keygenBin }));

  let ready = null; // { recipients } once the keys check out
  let reg = registry;
  const tokens = new Map(); // repo (lower case) -> { client, expiresAt }
  const lateSeen = new Map(); // attempt_id -> when a late dispatch was last looked at
  let callDeadline = null; // the AbortSignal of the running collect()'s hard deadline

  /**
   * Throw IngestSetupError unless results can be decrypted and sealed. Local
   * only: no API calls. Any shard size can be judged (one bundle per item).
   */
  async function check() {
    if (ready) return ready;
    let recipients;
    try {
      recipients = readSealRecipients(sealTo);
    } catch (err) {
      if (err instanceof AgeError) throw new IngestSetupError(`${err.message}. Until then the pump judges no results and dispatches no work`);
      throw err;
    }
    if (!identity) {
      throw new IngestSetupError('AGE_IDENTITY is not set; the pump needs it (a secret in the loop environment) to decrypt results, so it judges none and dispatches no work');
    }
    let pub;
    try {
      pub = await publicKey();
    } catch (err) {
      throw new IngestSetupError(`AGE_IDENTITY is not a usable age identity (${err?.message ?? err})`);
    }
    if (!recipients.includes(pub)) {
      throw new IngestSetupError(`AGE_IDENTITY does not belong to any key in ${sealTo}; workers encrypt to that file, so nothing could be decrypted`);
    }
    ready = { recipients };
    return ready;
  }

  async function clientFor(repo, mintToken, at) {
    const key = repo.toLowerCase();
    const hit = tokens.get(key);
    if (hit && (hit.expiresAt === null || hit.expiresAt - TOKEN_MARGIN_MS > at)) return hit.client;
    const name = repo.split('/')[1];
    const minted = await mintToken({ repositories: [name], permissions: { actions: 'read' } });
    const client = makeGithub({ token: minted.token, fetch, apiUrl, sleep, retries, deadlineSignal: () => callDeadline });
    const expiresAt = Number(minted.expiresAt);
    tokens.set(key, { client, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
    return client;
  }

  function writeSealed(dir, name, box) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, name);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, box, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return file;
  }

  /**
   * zstd of a tar before it is sealed (loop upgrade 20). A failure never stops
   * the seal: the tar is sealed as it is, which readers also take, and the
   * failure is counted for the watchdog.
   */
  function pack(tar, failures, what) {
    try {
      return compress(tar);
    } catch (err) {
      failures.push({ kind: 'compress', what, error: String(err?.message ?? err).slice(0, 200) });
      return tar;
    }
  }

  /**
   * Seal one item's outputs: the full bundle (`ingest-<attempt>.tar.age`, kept
   * 30 days) and the keep-forever part of it in `keepDir` (`keep-<attempt>.tar.age`,
   * and `catalog-<sha256>.tar.age` once per distinct tool list). All of it is
   * zstd, then age. What happened is noted in kv `retention.seal` for the watchdog.
   */
  function seal(attemptId, outputs, recipients, db, at) {
    const failures = [];
    const gaps = [];
    const tar = writeTar([...outputs].map(([path, data]) => ({ path, data })));
    const body = pack(tar, failures, `ingest-${attemptId}`);
    const file = writeSealed(outDir, `ingest-${attemptId}.tar.age`, encrypt(body, recipients));
    let keptBytes = 0;
    try {
      const { keep, catalogs } = keepSet(outputs);
      if (keep.size > 0) {
        const keepTar = writeTar([...keep].map(([path, data]) => ({ path, data })));
        const box = encrypt(pack(keepTar, failures, `keep-${attemptId}`), recipients);
        writeSealed(keepDir, `keep-${attemptId}.tar.age`, box);
        keptBytes += box.length;
      }
      for (const [sha, data] of catalogs) {
        if (existsSync(join(keepDir, `catalog-${sha}.tar.age`))) continue;
        const catTar = writeTar([{ path: 'tools.json', data }]);
        const box = encrypt(pack(catTar, failures, `catalog-${sha}`), recipients);
        writeSealed(keepDir, `catalog-${sha}.tar.age`, box);
        keptBytes += box.length;
      }
    } catch (err) {
      failures.push({ kind: 'keep', what: `keep-${attemptId}`, error: String(err?.message ?? err).slice(0, 200) });
      gaps.push({ attempt: attemptId, run: env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : null });
      // The artifact of keep files may still exist, so the prune cannot tell from it that this item has no
      // keep-forever file. The marker (uploaded as ingest-keepgap-<run>-<attempt>) tells it to keep this run's
      // full bundles. If even the marker cannot be written the item is not recorded: it is judged again next tick.
      try {
        const gap = writeTar([{ path: 'gap.json', data: Buffer.from(`${JSON.stringify({ attempt: attemptId, error: failures.at(-1).error })}\n`) }]);
        writeSealed(gapDir, `keep-gap-${attemptId}.tar.age`, encrypt(gap, recipients));
      } catch (gapErr) {
        throw new Error(`the keep-forever file of ${attemptId} could not be written (${failures.at(-1).error}) and neither could its gap marker (${String(gapErr?.message ?? gapErr).slice(0, 120)}); not recorded`);
      }
    }
    if (db) noteSeal(db, { bytesIn: tar.length, bytesOut: body.length, keptBytes, failures, gaps, at });
    return file;
  }

  /**
   * Judge what has finished. Returns a summary; `changed` says the state was
   * written. judged, recorded and outcomes count items; checked, waiting,
   * closed and correlated count dispatches. Throws IngestSetupError (nothing
   * can be judged) and nothing else: other failures are logged and tried again
   * on a later tick.
   */
  async function collect({ db, now = Date.now, log = () => {}, mintToken, deadline = Infinity } = {}) {
    // No GitHub call outlives `deadline` + callGraceMs (R-ING-17): in the pump
    // that is the run's end, four minutes before the job's time limit.
    const end = deadline + callGraceMs;
    // A timer cannot wait past 2^31 - 1 ms (Node fires it after 1 ms instead), so a deadline further off than
    // that is none at all (R-ING-21).
    const wait = end - now();
    callDeadline = Number.isFinite(wait) && wait <= MAX_TIMER_MS ? AbortSignal.timeout(Math.max(0, wait)) : null;
    const summary = {
      checked: 0, waiting: 0, judged: 0, recorded: 0, closed: 0, correlated: 0, errors: 0,
      stopped: null, outcomes: {}, changed: false,
    };
    const list = db.dispatchesAwaitingResults({ now: now(), lateMs });
    if (list.length === 0) return summary;
    const { recipients } = await check();
    if (typeof mintToken !== 'function') throw new TypeError('collect: mintToken is required');

    for (const d of list) {
      const t = now();
      if (t >= deadline) {
        summary.stopped = 'deadline';
        break;
      }
      const open = d.status === 'pending' || d.status === 'dispatched';
      const lastSeen = lateSeen.get(d.attempt_id);
      if (!open) {
        if (lastSeen !== undefined && t - lastSeen < recheckLateMs) continue;
        lateSeen.set(d.attempt_id, t);
      }
      summary.checked += 1;
      const label = `${d.workflow} shard ${d.shard_id} (${d.attempt_id})`;
      const closeIfOpen = () => {
        if (open && db.closeDispatch(d.attempt_id, { reason: 'run_completed', now: now() })) {
          summary.closed += 1;
          summary.changed = true;
        }
        if (!open) lateSeen.set(d.attempt_id, Infinity);
      };
      try {
        const client = await clientFor(d.repo, mintToken, t);
        let runId = d.run_id;
        if (runId === null || runId === undefined) {
          const since = isoSeconds(Date.parse(d.created) - 2 * MINUTE);
          const found = await client.findDispatchRun(d.repo, d.workflow_file, `shard ${d.shard_id}`, { since });
          if (!found) {
            summary.waiting += 1;
            continue;
          }
          if (db.setDispatchRun(d.attempt_id, {
            runId: found.id, runUrl: found.html_url ?? null, correlatedBy: 'run-name',
          })) {
            summary.correlated += 1;
            summary.changed = true;
            log(`ingest: ${label}: found its run ${found.id} by run name`);
          }
          runId = found.id;
        }

        const run = await client.getRun(d.repo, runId);
        if (!run) {
          summary.waiting += 1;
          if (!open) lateSeen.set(d.attempt_id, Infinity);
          log(`ingest: ${label}: run ${runId} was not found; leaving the dispatch to its lease`);
          continue;
        }
        if (run.status !== 'completed') {
          summary.waiting += 1;
          continue;
        }

        if (!reg) {
          try {
            reg = { ...(await loadRegistry({ fetch })), source: 'pinned' };
          } catch (err) {
            summary.stopped = 'registry';
            log(`ingest: cannot load the field registry (${err?.message ?? err}); judging nothing this tick`);
            break;
          }
        }

        // The ledger row, the run checks and the artifact list, once per dispatch.
        const opened = await openAttempt({ repo: d.repo, runId: Number(runId), attemptId: d.attempt_id }, {
          // The lease is checked against when the run completed, not when
          // this tick got to it (R-CHAOS-02).
          ledger: dbLedger(db, { now, completedAt: completedAt(run) }),
          github: {
            getRun: async () => run,
            listRunArtifacts: (repo, id) => client.listRunArtifacts(repo, id),
            downloadArtifact: (repo, id) => client.downloadArtifact(repo, id),
          },
          decrypt,
          registry: reg,
          now: () => new Date(now()),
          allowNoControls,
          ...judge,
        });
        if (opened.done) {
          const r = opened.done;
          if (r.outcome === 'pending') {
            summary.waiting += 1;
            continue;
          }
          // Refused before any item could be judged (nothing recorded), or
          // every item has a result already: seal the report, close the dispatch.
          let sealed = false;
          db.tx(() => {
            if (r.outputs.size > 0) {
              seal(d.attempt_id, r.outputs, recipients, db, now());
              sealed = true;
            }
            closeIfOpen();
          });
          if (r.outcome !== 'already_recorded') {
            log(`ingest: ${label}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}, nothing recorded${sealed ? ', outputs sealed' : ''}`);
          }
          continue;
        }

        // Each item in its own transaction: its decision is recorded only if
        // its outputs were sealed. An item that fails with an error that is
        // neither transient nor a decision is counted in the state; after
        // maxItemFailures it is recorded as rejected ingest_error, so no item
        // is retried forever (R-ING-05).
        let decided = 0;
        let stopped = false;
        const reasons = []; // of the items decided now, for the run_sha_mismatch alarm
        const failures = new Map(); // log line -> item indexes
        const decide = async (item, abandon) => {
          let sealed = false;
          const r = await db.txAsync(async () => {
            const res = await opened.judge(item, abandon ? { abandon } : {});
            if (res.outputs.size > 0) {
              seal(`${d.attempt_id}-${item.index}`, res.outputs, recipients, db, now());
              sealed = true;
            }
            db.clearIngestFailures(d.attempt_id, item.index);
            return res;
          });
          decided += 1;
          reasons.push(r.reason);
          summary.judged += 1;
          summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] ?? 0) + 1;
          if (r.recorded) summary.recorded += 1;
          summary.changed = true;
          const why = r.reason ? ` (${r.reason})` : '';
          log(`ingest: ${label} item ${item.index}: ${r.outcome}${why}${r.recorded ? ', recorded' : ''}${sealed ? ', outputs sealed' : ''}`);
        };
        const giveUpText = (n, error) => `the pump failed to judge this item ${n} times; last error: ${error ?? 'unknown'}`;
        for (const item of opened.items) {
          if (now() >= deadline) {
            summary.stopped = 'deadline';
            stopped = true;
            break;
          }
          const before = db.ingestFailures(d.attempt_id, item.index);
          try {
            await decide(item, before.count >= maxItemFailures ? giveUpText(before.count, before.error) : null);
          } catch (err) {
            if (err instanceof IngestSetupError || err?.name === 'BudgetExceededError') throw err;
            summary.errors += 1;
            const message = String(err?.message ?? err);
            if (err?.transient === true) {
              // GitHub or the network: not counted, tried again next tick.
              const line = `${message} (transient; nothing recorded; will try again)`;
              failures.set(line, [...(failures.get(line) ?? []), item.index]);
              continue;
            }
            const n = db.noteIngestFailure(d.attempt_id, item.index, { error: message, now: now() });
            summary.changed = true;
            let line = `${message} (failure ${n} of ${maxItemFailures}; nothing recorded; will try again)`;
            if (n >= maxItemFailures) {
              try {
                await decide(item, giveUpText(n, message));
                line = `${message} (failure ${n} of ${maxItemFailures}; recorded as ingest_error)`;
              } catch (again) {
                if (again instanceof IngestSetupError || again?.name === 'BudgetExceededError') throw again;
                line = `${message} (failure ${n} of ${maxItemFailures}; recording ingest_error failed too: ${again?.message ?? again}; will try again)`;
              }
            }
            failures.set(line, [...(failures.get(line) ?? []), item.index]);
          }
        }
        // R-ING-22: count dispatches whose run was at the wrong commit; one whose run passed resets the count.
        if (reasons.includes('run_sha_mismatch')) {
          const alarm = db.noteShaMismatch(d.workflow, { sha: d.workflow_sha ?? null, created: d.created ?? null, now: now() });
          summary.changed = true;
          log(`ingest: ${label}: run at another commit than recorded at dispatch (${alarm.count} dispatch${alarm.count === 1 ? '' : 'es'} in a row)${alarm.paused ? `; ${d.workflow} is paused` : ''}`);
        } else if (reasons.some((x) => x === null || !(/^run_/.test(x) || x === 'stale_fence' || x === 'ingest_error'))) {
          db.clearShaMismatch(d.workflow);
        }
        for (const [line, indexes] of failures) {
          const which = indexes.length === 1 ? `item ${indexes[0]}` : `items ${indexes.join(', ')}`;
          log(`ingest: ${label} ${which}: ${line}`);
        }
        if (decided === opened.items.length) {
          closeIfOpen();
        } else if (stopped && !open) {
          lateSeen.delete(d.attempt_id); // the rest is judged on the next tick
        }
        if (stopped) break;
      } catch (err) {
        if (err instanceof IngestSetupError) throw err;
        if (err?.name === 'BudgetExceededError') {
          // Not looked at after all: a late dispatch is first in line on the
          // next tick, not held back ten minutes while its work is sent again
          // (R-CHAOS-07).
          if (!open) {
            if (lastSeen === undefined) lateSeen.delete(d.attempt_id);
            else lateSeen.set(d.attempt_id, lastSeen);
          }
          summary.stopped = 'budget';
          log(`ingest: stopped for this tick by the API budget (${err.message})`);
          break;
        }
        summary.errors += 1;
        log(`ingest: ${label}: ${err?.message ?? err} (nothing recorded; will try again)`);
      }
    }
    return summary;
  }

  return { check, collect };
}
