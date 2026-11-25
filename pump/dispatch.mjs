// Dispatch worker workflows and find the run each dispatch created.
//
// The dispatch contract (docs/INTERFACES.md): every worker workflow takes
//
//   shard_id    the shard's id, also used as the run name: `run-name: shard <id>`
//   attempt_id  the dispatch's attempt id in the state store
//   items       JSON: [{ "subject", "run_key", "fence" }, ...]
//
// The pump asks for the run details in the dispatch response. If GitHub doesn't
// return them, it polls the workflow's recent workflow_dispatch runs for the one
// named `shard <id>`. A dispatch that was accepted but can't be matched to a run
// still counts as sent; its lease expires if no result comes back.

import { ApiBudget } from './budgets.mjs';
import { createClient } from './github.mjs';

const MAX_ITEMS_CHARS = 60_000;
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * The workflow_dispatch inputs for one shard. Each item's `subject` is the
 * repository's current owner/name (subject_name) when there is one, so the
 * worker clones or reads what the repository is called now; the result is
 * still recorded under the subject key, by run_key (state schema v8).
 */
export function workerInputs({ shardId, attemptId, items }) {
  const list = items.map(({ subject, subject_name: name, run_key, fence }) => ({ subject: name ?? subject, run_key, fence }));
  const json = JSON.stringify(list);
  if (json.length > MAX_ITEMS_CHARS) throw new Error(`shard ${shardId}: items input is too large (${json.length} characters); use a smaller shard_size`);
  return { shard_id: String(shardId), attempt_id: String(attemptId), items: json };
}

function splitRepo(repo) {
  const [owner, name, extra] = String(repo).split('/');
  if (!owner || !name || extra !== undefined) throw new TypeError(`repo must be owner/name, got "${repo}"`);
  return { owner, name };
}

/**
 * Send one workflow_dispatch and correlate it with its run.
 * @returns {Promise<{ runId: number|null, runUrl: string|null, correlatedBy: 'response'|'poll'|null }>}
 */
export async function dispatchWorkflow(client, {
  repo,
  workflowFile,
  ref,
  inputs,
  shardId,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollAttempts = 6,
  pollIntervalMs = 5000,
}) {
  splitRepo(repo);
  const file = encodeURIComponent(workflowFile);
  const since = new Date(now() - 60_000).toISOString();
  const res = await client.request('POST', `/repos/${repo}/actions/workflows/${file}/dispatches`, {
    family: 'dispatch',
    body: { ref, inputs, return_run_details: true },
  });
  const runName = `shard ${shardId}`;
  if (res.status === 200 && res.data?.workflow_run_id) {
    const runId = Number(res.data.workflow_run_id);
    return { runId, runUrl: res.data.html_url ?? res.data.run_url ?? null, correlatedBy: 'response' };
  }
  for (let i = 0; i < pollAttempts; i++) {
    await sleep(pollIntervalMs);
    const list = await client.request('GET', `/repos/${repo}/actions/workflows/${file}/runs`, {
      family: 'actions',
      query: { event: 'workflow_dispatch', created: `>=${since}`, per_page: 30 },
    });
    const run = (list.data?.workflow_runs ?? []).find((r) => r.display_title === runName || r.name === runName);
    if (run) return { runId: Number(run.id), runUrl: run.html_url ?? null, correlatedBy: 'poll' };
  }
  return { runId: null, runUrl: null, correlatedBy: null };
}

/**
 * The commit a branch points to now: the commit a dispatch on that ref is
 * expected to run. The pump records it with the dispatch before sending, and
 * ingest checks the worker run against it (R-ING-12).
 *
 * It is read with the dispatcher's own token ({ actions: write } on the worker
 * repository, nothing else; R-ING-19). That works because worker repositories
 * are public, and GitHub answers reads of a public repository's branches
 * whatever the token's permissions. We keep it that way rather than mint
 * contents: read as well: the App has no Contents permission at all (adding one
 * is an App-wide change for every installation), and a worker repository
 * should stay public anyway, since its runs are the published evidence. If a
 * worker repository ever turns private, GitHub answers 404 here, the error
 * says what to do, and nothing is dispatched to it (the tick skips that
 * workflow): it fails closed.
 */
export async function resolveRef(client, { repo, ref }) {
  splitRepo(repo);
  let res;
  try {
    res = await client.request('GET', `/repos/${repo}/branches/${encodeURIComponent(ref)}`, { family: 'contents' });
  } catch (err) {
    if (err?.status === 404 || (err?.status === 403 && !/rate limit/i.test(String(err?.message)))) {
      const e = new Error(`${repo}: cannot read branch ${ref} (HTTP ${err.status}). Either the branch does not exist (check \`ref\` in pump/workflows.json for a typo or a deleted branch), or the repository is private: the dispatch token has actions: write only, which reads a public repository's branches, so a private worker repository needs the App's Contents: read permission and the dispatcher to ask for it (pump/dispatch.mjs resolveRef)`);
      e.status = err.status;
      throw e;
    }
    throw err;
  }
  const sha = res.data?.commit?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}: branch ${ref} has no commit SHA in the answer`);
  return sha;
}

/**
 * A dispatcher that mints an installation token per worker repository, narrowed
 * to { actions: write } on that repository alone, and reuses it until five
 * minutes before it expires. All its calls share one API budget.
 */
export function createDispatcher({
  mintToken,
  fetch = globalThis.fetch,
  apiUrl,
  budget,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollAttempts,
  pollIntervalMs,
  onToken = () => {},
  log,
}) {
  if (typeof mintToken !== 'function') throw new TypeError('createDispatcher: mintToken is required');
  const bud = budget ?? new ApiBudget({ now, sleep });
  const cache = new Map(); // repo -> { token, expiresAt, client }

  async function clientFor(repo) {
    const hit = cache.get(repo);
    if (hit && hit.expiresAt - now() > TOKEN_MARGIN_MS) return hit.client;
    const { name } = splitRepo(repo);
    const minted = await mintToken({ repositories: [name], permissions: { actions: 'write' } });
    onToken(minted.token);
    const client = createClient({ token: minted.token, fetch, apiUrl, budget: bud, now, sleep, ...(log ? { log } : {}) });
    cache.set(repo, { token: minted.token, expiresAt: minted.expiresAt, client });
    return client;
  }

  return {
    budget: bud,
    async dispatch({ repo, workflowFile, ref, inputs, shardId }) {
      const client = await clientFor(repo);
      return dispatchWorkflow(client, { repo, workflowFile, ref, inputs, shardId, now, sleep, pollAttempts, pollIntervalMs });
    },
    /** The commit `ref` points to now (resolveRef). */
    async resolveRef({ repo, ref }) {
      const client = await clientFor(repo);
      return resolveRef(client, { repo, ref });
    },
  };
}
