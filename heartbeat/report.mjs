// Report step of the heartbeat: writes v1/heartbeat.json to the R2 binding LIVE for the public loop view.
// Runs after tick in its own waitUntil, only when REPORT_ENABLED is "true". It reads and records; it dispatches nothing.
import { scanBody } from './scan.mjs';

export const SCHEMA = 'isokron-loop-heartbeat/1';
export const KEY = 'v1/heartbeat.json';
export const RING = 48;
export const STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';
export const ISSUE_PATH = '/repos/isokron-ai/tool-qa/issues/40';
const COMPONENTS = { Actions: 'actions', 'API Requests': 'api', 'Git Operations': 'git', Webhooks: 'webhooks' };
const GH_STATUS = new Set(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
const CHECK_STATUS = new Set(['green', 'amber', 'yellow', 'red', 'off', 'unknown']); // off: switched off on purpose (never shown as red)
const ACTIONS = new Set(['ok', 'restarted', 'failed', 'check_failed', 'deferred', 'skipped_switch']);
export const MAX_EXISTING_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const SUMMARY_IDS = (id) => ['pump', 'slots', 'dispatches', 'sandbox-breaker'].includes(id) || id.startsWith('history-');
const MAX_CHECKS = 40;
const iso = (x) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x)) ? x : undefined);
const unavailable = (checked_at) => ({ error: 'unavailable', checked_at });
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(TIMEOUT_MS) } : {});

/** Keep only the four known fields of a decision. Anything else is dropped. */
export function cleanDecision(d) {
  if (!d || typeof d !== 'object' || !ACTIONS.has(d.action) || !iso(d.at)) return null;
  if (typeof d.workflow !== 'string' || !/^(?:\*|[A-Za-z0-9_.() -]{1,60})$/.test(d.workflow)) return null;
  const http = Number.isInteger(d.http) && d.http >= 100 && d.http <= 599 ? d.http : undefined;
  return { at: d.at, workflow: d.workflow, action: d.action, ...(http ? { http } : {}) };
}

/** Ring of the last RING decisions. Everything but a restart is written only when a workflow's state (action and http)
 *  changes: 11 workflows x 288 ticks a day, or a two-hour outage, would otherwise push a restart out of the ring within
 *  minutes. A restart is always written. */
export function appendDecisions(ring, fresh) {
  const out = (Array.isArray(ring) ? ring : []).map(cleanDecision).filter(Boolean);
  const state = (d) => `${d.action}|${d.http ?? ''}`;
  const last = new Map();
  for (const d of out) last.set(d.workflow, state(d));
  for (const raw of Array.isArray(fresh) ? fresh : []) {
    const d = cleanDecision(raw);
    if (!d) continue;
    if (d.action !== 'restarted' && last.get(d.workflow) === state(d)) continue;
    out.push(d); last.set(d.workflow, state(d));
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

/** The existing object, for read-append-write: { previous: decisions, etag } (etag undefined when there is none). */
async function readExisting(bucket) {
  const obj = await bucket.get(KEY);
  if (!obj) return { previous: [], etag: undefined };
  if (obj.size > MAX_EXISTING_BYTES) { console.log(`heartbeat report: existing ${KEY} is ${obj.size} bytes (over ${MAX_EXISTING_BYTES}); starting a fresh ring`); return { previous: [], etag: obj.etag }; }
  try {
    const j = JSON.parse(await obj.text());
    return { previous: Array.isArray(j && j.decisions) ? j.decisions : [], etag: obj.etag };
  } catch { console.log(`heartbeat report: existing ${KEY} cannot be parsed; starting a fresh ring`); return { previous: [], etag: obj.etag }; }
}

const heartbeatState = (env) => (env.HEARTBEAT_ENABLED !== 'true' ? 'off' : env.GH_TOKEN ? 'on' : 'no_token');
const dropSummaries = (doc) => (doc.health && Array.isArray(doc.health.checks)
  ? { ...doc, health: { ...doc.health, checks: doc.health.checks.map(({ summary, ...rest }) => rest) } } : doc);

/** Build and write v1/heartbeat.json. Resolves { written, blocked?, degraded?, skipped? }; throws only when R2 itself fails (the caller logs it).
 *  `scan` is a parameter only so tests can force the later stages of the scan fallback. */
export async function report({ env, decisions = [], fetch: fetchImpl = globalThis.fetch, now = Date.now(), scan = scanBody } = {}) {
  const [github, health, existing] = await Promise.all([fetchGithub(fetchImpl, now), fetchHealth(fetchImpl, env.GH_TOKEN, now), readExisting(env.LIVE)]);
  const checked_at = new Date(now).toISOString();
  let doc = { schema: SCHEMA, checked_at, heartbeat: heartbeatState(env), decisions: appendDecisions(existing.previous, decisions), github, health };
  // Serialize once; scan that text; put that same text. A hit first drops the free-text summaries, then the whole health
  // section; only if it is still dirty is nothing written.
  let body = JSON.stringify(doc);
  let hits = scan(body, doc);
  let degraded;
  const log = (hs) => { for (const h of hs) console.log(`heartbeat report: scan hit, rule ${h.rule} at ${h.path}`); };
  if (hits.length) {
    log(hits);
    doc = dropSummaries(doc); body = JSON.stringify(doc); hits = scan(body, doc); degraded = 'summaries';
    if (hits.length) {
      log(hits);
      doc = { ...doc, health: unavailable(checked_at) }; body = JSON.stringify(doc); hits = scan(body, doc); degraded = 'health';
      if (hits.length) { log(hits); return { written: false, blocked: hits[0].rule }; }
    }
  }
  const onlyIf = existing.etag ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }; // R2's "does not exist"
  const put = await env.LIVE.put(KEY, body, { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' }, onlyIf });
  if (put === null) { console.log('heartbeat report: another writer changed the file; skipping this tick'); return { written: false, skipped: 'conflict' }; }
  return { written: true, ...(degraded ? { degraded } : {}) };
}
