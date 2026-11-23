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
//   run finished        ingestAttempt() (ingest.mjs) judges the one result
//                       artifact and records the decision; the outputs are
//                       sealed to worker-kit/ingest.pub as
//                       <outDir>/ingest-<attempt>.tar.age; the dispatch is closed
//                       (run_completed), which frees its slot and any lease left
//
// Recording, sealing and closing share one state transaction: if the outputs
// cannot be written, nothing is recorded and a later tick judges it again. A
// dispatch whose lease expired before its run finished is still judged for
// `lateMs` after it closed (the store keeps that late result as rejected); such
// late runs are looked at every `recheckLateMs` at most.
//
// Before anything is judged, check() makes sure it can be sealed and decrypted:
// ingest.pub holds a real age key, AGE_IDENTITY is set and belongs to it, and
// (given the workflows) every enabled workflow has shard_size 1, because result
// manifest v1 carries one run_key. Otherwise it throws IngestSetupError, and the
// pump dispatches nothing, so no worker runs whose result could not be judged.
//
// GitHub calls use an installation token per worker repository with actions:
// read only. The pump hands in a fetch that goes through its API budget
// (pump/budgets.mjs budgetedFetch); a BudgetExceededError ends this tick's
// ingest without recording anything.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeTar } from '../worker-kit/tar.mjs';
import { AgeError, ageDecrypt, ageEncrypt, agePublicKey, readSealRecipients } from './age.mjs';
import { makeGithub } from './github.mjs';
import { ingestAttempt, MAX_BUNDLE_BYTES } from './ingest.mjs';
import { dbLedger } from './ledger.mjs';
import { loadRegistry as loadPinnedRegistry } from './registry.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_MARGIN_MS = 5 * MINUTE;
const SEAL_TO = fileURLToPath(new URL('../worker-kit/ingest.pub', import.meta.url));

/** Ingest cannot work as set up (keys, contract). The pump must not dispatch work. */
export class IngestSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestSetupError';
  }
}

function shardSize(wf) {
  return Math.max(1, Math.trunc(Number(wf?.shard_size)) || 1);
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
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {number} [o.retries]        retries per GitHub call (ingest/github.mjs)
 * @param {string} [o.outDir]         where sealed outputs go (default $RUNNER_TEMP/ingest-out)
 * @param {string} [o.sealTo]         recipients file (default worker-kit/ingest.pub)
 * @param {object} [o.registry]       a loaded field registry (default: the pinned one, fetched once)
 * @param {Function} [o.loadRegistry]
 * @param {{decrypt?: Function, encrypt?: Function, publicKey?: Function}} [o.crypto]  default: the age binary
 * @param {boolean} [o.allowNoControls]
 * @param {number} [o.lateMs]         how long after a lease expired a result is still judged
 * @param {number} [o.recheckLateMs]  how often such a late run is looked at
 */
export function createCollector({
  env = process.env,
  identity = env.AGE_IDENTITY,
  fetch = globalThis.fetch,
  apiUrl = env.GITHUB_API_URL || 'https://api.github.com',
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retries = 3,
  outDir = join(env.RUNNER_TEMP || tmpdir(), 'ingest-out'),
  sealTo = SEAL_TO,
  registry = null,
  loadRegistry = loadPinnedRegistry,
  crypto = {},
  allowNoControls = false,
  lateMs = 6 * HOUR,
  recheckLateMs = 10 * MINUTE,
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

  /**
   * Throw IngestSetupError unless results can be decrypted and sealed (and, given
   * `workflows`, every enabled one has shard_size 1). Local only: no API calls.
   */
  async function check({ workflows } = {}) {
    for (const [name, wf] of Object.entries(workflows ?? {})) {
      if (wf?.enabled === true && shardSize(wf) !== 1) {
        throw new IngestSetupError(
          `workflow "${name}" has shard_size ${wf.shard_size}, but result manifest v1 carries one run_key, so ingest needs `
            + 'shard_size 1: set it in pump/workflows.json (or extend the result contract first)',
        );
      }
    }
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
    const client = makeGithub({ token: minted.token, fetch, apiUrl, sleep, retries });
    const expiresAt = Number(minted.expiresAt);
    tokens.set(key, { client, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
    return client;
  }

  function seal(attemptId, outputs, recipients) {
    const tar = writeTar([...outputs].map(([path, data]) => ({ path, data })));
    const box = encrypt(tar, recipients);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const file = join(outDir, `ingest-${attemptId}.tar.age`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, box, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return file;
  }

  /**
   * Judge what has finished. Returns a summary; `changed` says the state was
   * written. Throws IngestSetupError (nothing can be judged) and nothing else:
   * other failures are logged per dispatch and tried again on a later tick.
   */
  async function collect({ db, now = Date.now, log = () => {}, mintToken, deadline = Infinity } = {}) {
    const summary = {
      checked: 0, waiting: 0, judged: 0, recorded: 0, closed: 0, correlated: 0, unsupported: 0, errors: 0,
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
      if (!open) {
        const last = lateSeen.get(d.attempt_id);
        if (last !== undefined && t - last < recheckLateMs) continue;
        lateSeen.set(d.attempt_id, t);
      }
      summary.checked += 1;
      const label = `${d.workflow} shard ${d.shard_id} (${d.attempt_id})`;
      try {
        const { items } = db.getDispatch(d.attempt_id);
        if (items.length !== 1) {
          summary.unsupported += 1;
          if (open && db.closeDispatch(d.attempt_id, { reason: 'unsupported_shard', now: t })) {
            summary.closed += 1;
            summary.changed = true;
          }
          if (!open) lateSeen.set(d.attempt_id, Infinity);
          log(`ingest: ${label} carries ${items.length} run_keys; result manifest v1 holds one, so it cannot be judged (use shard_size 1); closed as unsupported_shard`);
          continue;
        }

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
            runId: found.id, runUrl: found.html_url ?? null, workflowSha: found.head_sha ?? null, correlatedBy: 'run-name',
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

        let sealed = false;
        const result = await db.txAsync(async () => {
          const r = await ingestAttempt({ repo: d.repo, runId: Number(runId), attemptId: d.attempt_id }, {
            ledger: dbLedger(db, { now }),
            github: {
              getRun: async () => run,
              listRunArtifacts: (repo, id) => client.listRunArtifacts(repo, id),
              downloadArtifact: (repo, id) => client.downloadArtifact(repo, id),
            },
            decrypt,
            registry: reg,
            now: () => new Date(now()),
            allowNoControls,
          });
          if (r.outcome === 'pending') return r;
          if (r.outputs.size > 0) {
            seal(d.attempt_id, r.outputs, recipients);
            sealed = true;
          }
          if (open && db.closeDispatch(d.attempt_id, { reason: 'run_completed', now: now() })) summary.closed += 1;
          return r;
        });
        if (result.outcome === 'pending') {
          summary.waiting += 1;
          continue;
        }
        summary.judged += 1;
        summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
        if (result.recorded) summary.recorded += 1;
        summary.changed = true;
        if (!open) lateSeen.set(d.attempt_id, Infinity);
        const why = result.reason ? ` (${result.reason})` : '';
        log(`ingest: ${label}: ${result.outcome}${why}${result.recorded ? ', recorded' : ''}${sealed ? ', outputs sealed' : ''}`);
      } catch (err) {
        if (err instanceof IngestSetupError) throw err;
        if (err?.name === 'BudgetExceededError') {
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
