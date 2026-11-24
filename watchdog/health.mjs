// The loop health issue: one pinned issue titled "Loop health", labelled
// `loop-health`, whose body is rewritten in place.
//
// The body starts with a hidden comment holding the machine-readable state
// (`<!-- loop-health:v1 {...} -->`), then a table of checks. The body is only
// written when a check changed. A comment is added only when the overall status
// turns red or comes back from red, so the issue does not notify on every run.
//
// mode 'replace' (the watchdog): the new checks replace the old ones, except
// items another job raised with `keep: true` (for example the pump's
// `pump-successor`), which stay until a reading of the same id with a newer `at`
// arrives. mode 'merge' (other jobs): add or update the given items only.

import { overallStatus } from './checks.mjs';

export const LABEL = 'loop-health';
export const TITLE = 'Loop health';
const MARK = 'loop-health:v1';
const MARK_RE = /<!-- loop-health:v1 (\{[\s\S]*?\}) -->/;

const iso = (now) => new Date(now).toISOString();
const cell = (text) => String(text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

export function renderBody({ checks, now }) {
  const overall = overallStatus(checks);
  const json = JSON.stringify({ overall, updated: iso(now), checks }).replace(/--/g, '-\\u002d');
  const rows = checks.map((c) => `| ${cell(c.id)} | ${cell(c.status)} | ${cell(c.summary)}${c.link ? ` ([run](${c.link}))` : ''} |`);
  return [
    `<!-- ${MARK} ${json} -->`,
    '',
    `**Overall: ${overall}**`,
    '',
    `Updated ${iso(now).replace(/\.\d+Z$/, 'Z')} by the loop watchdog.`,
    '',
    '| Check | Status | Details |',
    '|---|---|---|',
    ...rows,
    '',
    'green: fine. amber: late or degraded. red: needs a person. off: switched off on purpose.',
    'This body is rewritten in place. A comment is added only when the overall status turns red or recovers.',
    'What each check means and what to do: docs/OPERATIONS.md.',
    '',
  ].join('\n');
}

/** The hidden state from an issue body, or null. */
export function parseBody(body) {
  const m = MARK_RE.exec(String(body ?? ''));
  if (!m) return null;
  try {
    const state = JSON.parse(m[1]);
    return state && Array.isArray(state.checks) ? state : null;
  } catch {
    return null;
  }
}

const newer = (a, b) => Boolean(a?.at && b?.at && a.at > b.at);

/** Combine the previous items with new ones (see the header for the rules). */
export function mergeChecks(prev, next, mode = 'replace') {
  const out = [];
  const index = new Map();
  const put = (item) => {
    if (index.has(item.id)) out[index.get(item.id)] = item;
    else {
      index.set(item.id, out.length);
      out.push(item);
    }
  };
  const prevById = new Map((prev ?? []).map((c) => [c.id, c]));
  if (mode === 'merge') {
    for (const p of prev ?? []) put(p);
    for (const n of next) put(newer(prevById.get(n.id), n) ? prevById.get(n.id) : n);
    return out;
  }
  for (const n of next) {
    const p = prevById.get(n.id);
    put(p?.keep && newer(p, n) ? p : n);
  }
  for (const p of prev ?? []) if (p.keep && !index.has(p.id)) put(p);
  return out;
}

export async function findIssue(client, repo) {
  const res = await client.request('GET', `/repos/${repo}/issues`, {
    essential: true,
    query: { labels: LABEL, state: 'open', per_page: 30 },
  });
  const list = (Array.isArray(res.data) ? res.data : []).filter((i) => !i.pull_request && i.title === TITLE);
  list.sort((a, b) => a.number - b.number);
  return list[0] ?? null;
}

async function pin(client, nodeId) {
  try {
    const res = await client.request('POST', '/graphql', {
      family: 'graphql',
      body: { query: 'mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { number } } }', variables: { id: nodeId } },
    });
    return !res.data?.errors;
  } catch {
    return false;
  }
}

function comment(prevOverall, overall, checks) {
  if (overall === 'red' && prevOverall !== 'red') {
    const reds = checks.filter((c) => c.status === 'red').map((c) => `- **${c.id}**: ${c.summary}`);
    return ['Loop health turned **red**.', '', ...reds, '', 'See the table in the issue body; what to do is in docs/OPERATIONS.md.'].join('\n');
  }
  if (prevOverall === 'red' && overall !== 'red') return `Loop health recovered: overall is now **${overall}**.`;
  return null;
}

/**
 * Bring the health issue up to date.
 * @returns {Promise<{ number: number, created: boolean, updated: boolean, commented: boolean,
 *   pinned: boolean|null, overall: string, previous: string|null }>}
 */
export async function applyHealth({ client, repo, checks, mode = 'replace', now = Date.now() }) {
  const issue = await findIssue(client, repo);
  const prevState = issue ? parseBody(issue.body) : null;
  const merged = mergeChecks(prevState?.checks ?? [], checks, mode);
  const overall = overallStatus(merged);
  const previous = prevState?.overall ?? null;
  const body = renderBody({ checks: merged, now });
  const out = { number: issue?.number ?? null, created: false, updated: false, commented: false, pinned: null, overall, previous };
  if (!issue) {
    const res = await client.request('POST', `/repos/${repo}/issues`, { essential: true, body: { title: TITLE, body, labels: [LABEL] } });
    out.number = res.data.number;
    out.created = true;
    out.pinned = await pin(client, res.data.node_id);
  } else if (!prevState || JSON.stringify(prevState.checks) !== JSON.stringify(merged)) {
    await client.request('PATCH', `/repos/${repo}/issues/${issue.number}`, { essential: true, body: { body } });
    out.updated = true;
  }
  const text = comment(previous, overall, merged);
  if (text && (out.created ? overall === 'red' : true)) {
    await client.request('POST', `/repos/${repo}/issues/${out.number}/comments`, { essential: true, body: { body: text } });
    out.commented = true;
  }
  return out;
}
