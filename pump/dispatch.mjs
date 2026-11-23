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

/** The workflow_dispatch inputs for one shard. */
export function workerInputs({ shardId, attemptId, items }) {
  const list = items.map(({ subject, run_key, fence }) => ({ subject, run_key, fence }));
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
 * @returns {Promise<{ runId: number|null, runUrl: string|null, workflowSha: string|null,
 *   correlatedBy: 'response'|'poll'|null }>}
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
    let workflowSha = null;
    try {
      const run = await client.request('GET', `/repos/${repo}/actions/runs/${runId}`, { family: 'actions' });
      workflowSha = run.data?.head_sha ?? null;
    } catch {
      // Not fatal: ingest can still match the run by id.
    }
    return { runId, runUrl: res.data.html_url ?? res.data.run_url ?? null, workflowSha, correlatedBy: 'response' };
  }
  for (let i = 0; i < pollAttempts; i++) {
    await sleep(pollIntervalMs);
    const list = await client.request('GET', `/repos/${repo}/actions/workflows/${file}/runs`, {
      family: 'actions',
      query: { event: 'workflow_dispatch', created: `>=${since}`, per_page: 30 },
    });
    const run = (list.data?.workflow_runs ?? []).find((r) => r.display_title === runName || r.name === runName);
    if (run) return { runId: Number(run.id), runUrl: run.html_url ?? null, workflowSha: run.head_sha ?? null, correlatedBy: 'poll' };
  }
  return { runId: null, runUrl: null, workflowSha: null, correlatedBy: null };
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
    const client = createClient({ token: minted.token, fetch, apiUrl, budget: bud, now, sleep });
    cache.set(repo, { token: minted.token, expiresAt: minted.expiresAt, client });
    return client;
  }

  return {
    budget: bud,
    async dispatch({ repo, workflowFile, ref, inputs, shardId }) {
      const client = await clientFor(repo);
      return dispatchWorkflow(client, { repo, workflowFile, ref, inputs, shardId, now, sleep, pollAttempts, pollIntervalMs });
    },
  };
}
