// Report step of the heartbeat: writes v1/heartbeat.json to the R2 binding LIVE for the public loop view.
// Runs after tick in its own waitUntil, only when REPORT_ENABLED is "true". It reads and records; it dispatches nothing.
import { scanObject } from './scan.mjs';

export const SCHEMA = 'isokron-loop-heartbeat/1';
export const KEY = 'v1/heartbeat.json';
export const RING = 48;
export const STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';
export const ISSUE_PATH = '/repos/isokron-ai/tool-qa/issues/40';
const COMPONENTS = { Actions: 'actions', 'API Requests': 'api', 'Git Operations': 'git', Webhooks: 'webhooks' };
const GH_STATUS = new Set(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
const CHECK_STATUS = new Set(['green', 'amber', 'yellow', 'red', 'unknown']);
const ACTIONS = new Set(['ok', 'restarted', 'failed', 'skipped_switch']);
const SUMMARY_IDS = (id) => ['pump', 'slots', 'dispatches', 'sandbox-breaker'].includes(id) || id.startsWith('history-');
const MAX_CHECKS = 40;
const iso = (x) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x)) ? x : undefined);
const unavailable = (checked_at) => ({ error: 'unavailable', checked_at });
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {});

/** Keep only the four known fields of a decision. Anything else is dropped. */
export function cleanDecision(d) {
  if (!d || typeof d !== 'object' || !ACTIONS.has(d.action) || !iso(d.at)) return null;
  if (typeof d.workflow !== 'string' || !/^[A-Za-z0-9_.() -]{1,60}$/.test(d.workflow)) return null;
  const http = Number.isInteger(d.http) && d.http >= 100 && d.http <= 599 ? d.http : undefined;
  return { at: d.at, workflow: d.workflow, action: d.action, ...(http ? { http } : {}) };
}

/** Ring of the last RING decisions. A workflow that is "ok" or "skipped_switch" is written when that changes, not every
 *  tick (11 workflows x 288 ticks a day would push a restart out of the ring within 20 minutes); restarts and failures
 *  are always written. */
export function appendDecisions(ring, fresh) {
  const out = (Array.isArray(ring) ? ring : []).map(cleanDecision).filter(Boolean);
  const last = new Map();
  for (const d of out) last.set(d.workflow, d.action);
  for (const raw of Array.isArray(fresh) ? fresh : []) {
    const d = cleanDecision(raw);
    if (!d) continue;
    if ((d.action === 'ok' || d.action === 'skipped_switch') && last.get(d.workflow) === d.action) continue;
    out.push(d); last.set(d.workflow, d.action);
  }
  return out.slice(-RING);
}

export function mapComponents(json) {
  const list = json && Array.isArray(json.components) ? json.components : null;
  if (!list) return null;
  const components = { actions: 'unknown', api: 'unknown', git: 'unknown', webhooks: 'unknown' };
  for (const c of list) {
    const key = c && COMPONENTS[c.name];
    if (key) components[key] = GH_STATUS.has(c.status) ? c.status : 'unknown';
  }
  return components;
}

/** Parse the loop-health:v1 block from the issue body and keep only allowlisted fields. */
export function allowlistHealth(body) {
  const m = /<!-- loop-health:v1 (\{.*?\}) -->/s.exec(String(body ?? ''));
  if (!m) return null;
  let raw; try { raw = JSON.parse(m[1]); } catch { return null; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.checks)) return null;
  const checks = [];
  for (const c of raw.checks.slice(0, MAX_CHECKS)) {
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9:_-]{1,40}$/.test(c.id)) continue;
    const e = { id: c.id, status: CHECK_STATUS.has(c.status) ? c.status : 'unknown' };
    if (iso(c.at)) e.at = c.at;
    if (SUMMARY_IDS(c.id) && typeof c.summary === 'string') e.summary = c.summary.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    checks.push(e);
  }
  return { updated: iso(raw.updated) ?? null, overall: CHECK_STATUS.has(raw.overall) ? raw.overall : 'unknown', checks };
}

async function fetchGithub(fetchImpl, now) {
  const checked_at = new Date(now).toISOString();
  try {
    const res = await fetchImpl(STATUS_URL, { headers: { accept: 'application/json', 'user-agent': 'isokron-loop-heartbeat' }, ...signal() });
    if (!res.ok) return unavailable(checked_at);
    const components = mapComponents(await res.json());
    return components ? { checked_at, components } : unavailable(checked_at);
  } catch { return unavailable(checked_at); }
}

async function fetchHealth(fetchImpl, token, now) {
  const checked_at = new Date(now).toISOString();
  const get = (auth) => fetchImpl('https://api.github.com' + ISSUE_PATH, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'isokron-loop-heartbeat', ...(auth ? { authorization: 'Bearer ' + token } : {}) },
    ...signal(),
  });
  try {
    let res = await get(Boolean(token));
    if (token && [401, 403, 404].includes(res.status)) res = await get(false); // a token that cannot read it: try the public read once
    if (!res.ok) return unavailable(checked_at);
    const issue = await res.json();
    const health = allowlistHealth(issue && issue.body);
    return health ? { checked_at, ...health } : unavailable(checked_at);
  } catch { return unavailable(checked_at); }
}

async function readExisting(bucket) {
  const obj = await bucket.get(KEY);
  if (!obj) return [];
  try { const j = JSON.parse(await obj.text()); return Array.isArray(j && j.decisions) ? j.decisions : []; } catch { return []; }
}

/** Build and write v1/heartbeat.json. Resolves { written, blocked? }; throws only when R2 itself fails (the caller logs it). */
export async function report({ env, decisions = [], fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const [github, health, previous] = await Promise.all([fetchGithub(fetchImpl, now), fetchHealth(fetchImpl, env.GH_TOKEN, now), readExisting(env.LIVE)]);
  const doc = { schema: SCHEMA, checked_at: new Date(now).toISOString(), decisions: appendDecisions(previous, decisions), github, health };
  const hits = scanObject(doc);
  if (hits.length) {
    for (const h of hits) console.log(`heartbeat report: scan hit, rule ${h.rule} at ${h.path}; nothing written`);
    return { written: false, blocked: hits[0].rule };
  }
  await env.LIVE.put(KEY, JSON.stringify(doc), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' } });
  return { written: true };
}
