// The pump's side of lead-repro (R-LEAD-54): before an issue shows a synthetic repro, the lead's fixture must have
// been run by .github/workflows/lead-repro.yml and must have reproduced the lead's class and signature.
//
// The verdict is about a repro key (leads/repro.mjs reproKey: the template, how it is run, the lane's pins and the
// lead's class and signature), so leads that share a key share one run. Per lead, in order:
//   1. a verdict already in the state (kv leads.repro, by key) is used;
//   2. else the artifact lead-repro-<key> of a run of lead-repro on main of tool-qa itself is read back (an artifact
//      of a pull request run, or of a fork, never counts) and its verdict kept;
//   3. else lead-repro is dispatched for the lead (its shape as the `lead` input: shape only) and the lead waits;
//      a dispatch with no verdict is sent again after REPRO_RETRY_MS, at most REPRO_MAX_TRIES times.
// Fail closed (owner rule): a lead with no verdict is never filed. No token, a dispatch GitHub refused (a failed
// dispatch counts as a try), or a key whose tries ran out with no verdict leaves the lead unfiled and `stuck`, counted
// in kv leads.last (repro_no_token, repro_dispatch_errors, repro_stuck), shown in the pump's `leads:` line and amber in
// the watchdog's leads item. A stuck key is tried again once every REPRO_STUCK_RETRY_MS. A class no template can
// trigger needs no run. An artifact counts only from a run of .github/workflows/lead-repro.yml itself, started by
// workflow_dispatch on main of tool-qa (one GET of the run). Each pump run reads at most MAX_LOOKUPS artifacts and
// sends at most MAX_DISPATCHES dispatches, so the pump's run time stays bounded. Never throws.

import { readZip } from '../scripts/lib/unzip.mjs';
import { pinsFor, reproKey, reproSpec, REPRO_VERDICTS } from './repro.mjs';

export const REPRO_REPO = 'isokron-ai/tool-qa';
export const REPRO_WORKFLOW = 'lead-repro.yml';
export const REPRO_KV = 'leads.repro';
export const ARTIFACT_PREFIX = 'lead-repro-';
export const REPRO_FORMAT = 'isokron-lead-repro/1';
const MIN = 60_000;
export const REPRO_RETRY_MS = 45 * MIN;
export const REPRO_MAX_TRIES = 3;
/** A key whose tries ran out is sent once more after this long (it stays stuck, and its lead unfiled, until a verdict). */
export const REPRO_STUCK_RETRY_MS = 12 * 60 * MIN;
/** The workflow file a trusted artifact's run must be. */
export const REPRO_PATH = '.github/workflows/lead-repro.yml';
/** The artifact download gives up after this long. */
export const BLOB_TIMEOUT_MS = 30_000;
export const MAX_LOOKUPS = 10;
export const MAX_DISPATCHES = 3;
/** Keys kept in kv leads.repro at most (the oldest go first). */
export const KV_MAX = 300;
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
/** What may reach an issue body from an artifact: a short line of plain words, no Markdown that changes the page. */
const SAFE_TOOL = /^[a-z0-9@., -]{1,300}$/i;
const SAFE_WHY = /^[A-Za-z0-9 .,:;()'`_/+=@<>-]{1,300}$/;
/** Verdicts that settle a key: error does not (the run failed; it is sent again). */
export const FINAL = new Set(['reproduced', 'not_reproduced', 'not_reproducible_synthetically']);

const SHAPE_INPUT = ['fingerprint', 'tool', 'lane', 'component', 'oracle', 'class', 'idiom', 'layout', 'signature'];
/** The `lead` input of a dispatch: the fingerprint's columns only. */
export const leadInput = (lead) => JSON.stringify(Object.fromEntries(SHAPE_INPUT.map((k) => [k, lead[k]])));

/**
 * Read a lead-repro artifact (a zip holding lead-repro.json) and the verdict it gives for `key`, or null.
 * Checked whole: format, one result whose key is this key, a known verdict.
 */
export function verdictFromArtifact(zip, key) {
  let doc;
  try {
    const entry = readZip(zip, { maxEntries: 4, maxTotalBytes: MAX_ARTIFACT_BYTES }).find((e) => e.name === 'lead-repro.json');
    if (!entry) return null;
    doc = JSON.parse(entry.data.toString('utf8'));
  } catch {
    return null;
  }
  if (doc?.format !== REPRO_FORMAT || !Array.isArray(doc.results)) return null;
  const r = doc.results.find((x) => x?.key === key);
  if (!r || !REPRO_VERDICTS.includes(r.verdict)) return null;
  const tool = typeof r.tool === 'string' && SAFE_TOOL.test(r.tool) ? r.tool : null;
  const why = typeof r.why === 'string' && SAFE_WHY.test(r.why) ? r.why : null;
  return { verdict: r.verdict, run_id: Number.isSafeInteger(doc.run_id) ? doc.run_id : null, tool, why };
}

/** An artifact of a run on main of the repository itself (not a pull request, not a fork), not expired, at most 1 MiB. */
export function trustedArtifact(a, { repoId = null } = {}) {
  const run = a?.workflow_run ?? {};
  if (a?.expired) return false;
  if (!(Number(a?.size_in_bytes) <= MAX_ARTIFACT_BYTES)) return false;
  if (run.head_branch !== 'main') return false;
  if (run.repository_id == null || run.head_repository_id !== run.repository_id) return false;
  return repoId == null || run.repository_id === repoId;
}

/** The artifact's run (one GET) is lead-repro.yml itself, started by workflow_dispatch on main of this repository. */
export function trustedRun(run, a) {
  if (!run || typeof run !== 'object') return false;
  if (Number(run.id) !== Number(a?.workflow_run?.id)) return false;
  if (run.path !== REPRO_PATH || run.event !== 'workflow_dispatch' || run.head_branch !== 'main') return false;
  return run.repository?.full_name === REPRO_REPO && run.head_repository?.full_name === REPRO_REPO;
}

function readKv(db) {
  try { const v = db.getKv(REPRO_KV); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function writeKv(db, kv, now) {
  const keys = Object.keys(kv);
  if (keys.length > KV_MAX) {
    keys.sort((a, b) => String(kv[a].at ?? kv[a].dispatched_at ?? '').localeCompare(String(kv[b].at ?? kv[b].dispatched_at ?? '')));
    for (const k of keys.slice(0, keys.length - KV_MAX)) delete kv[k];
  }
  db.setKv(REPRO_KV, kv, { now });
}

/**
 * The repro verdicts of some leads, looked up, read back or asked for as above.
 * @param {object} o
 * @param {import('../state/db.mjs').StateDb} o.db
 * @param {object[]} o.leads  lead shapes
 * @param {object} o.workflows  pump/workflows.json workflows (the lanes' pins)
 * @param {number} o.now
 * @param {object|null} [o.client]  pump/github.mjs client with actions: write on tool-qa, or null (no network: kv only)
 * @param {() => Promise<object>} [o.getClient]  makes that client when the first network call is needed (a token is
 *   minted only then); a failure leaves the run on the state only
 * @param {(url: string, init: object) => Promise<Response>} [o.fetch]  for the artifact's signed storage link
 * @param {string} [o.ref]  the branch lead-repro is dispatched on
 * @returns {Promise<Map<string, {state: 'ready'|'pending'|'stuck', key: string|null, verdict: object|null}>>} by fingerprint;
 *   ready: a verdict that settles the key; pending: the check is running or not sent yet; stuck: it cannot get a verdict
 *   now (no token, dispatch refused, tries ran out). Only ready is ever filed.
 */
export async function reproVerdicts({ db, leads, workflows, now, client: given = null, getClient = null, fetch: fetchImpl = globalThis.fetch, ref = 'main', log = () => {}, note = {} }) {
  const out = new Map();
  let client = given;
  let asked = given !== null || typeof getClient !== 'function';
  const net = async () => {
    if (!asked) {
      asked = true;
      try { client = await getClient(); } catch (err) { client = null; note.repro_no_token = 1; log(`leads: no token for lead-repro: no verdict can be read or asked for, so nothing waiting for one is filed: ${err?.message ?? err}`); }
    }
    return client;
  };
  const kv = readKv(db);
  let lookups = 0;
  let dispatches = 0;
  let changed = false;
  const iso = new Date(now).toISOString();
  Object.assign(note, { repro_lookups: 0, repro_dispatches: 0, repro_read: 0, repro_errors: 0, repro_dispatch_errors: 0, repro_stuck: 0, repro_pending: 0, repro_no_token: note.repro_no_token ?? 0 });
  for (const lead of leads) {
    const spec = reproSpec(lead);
    if (!spec.synthesizable) { out.set(lead.fingerprint, { state: 'ready', key: null, verdict: { verdict: 'not_reproducible_synthetically', why: spec.why } }); continue; }
    const key = reproKey(lead, spec, pinsFor(lead.lane, workflows));
    let rec = kv[key] ?? null;
    if (!(rec && FINAL.has(rec.verdict)) && lookups < MAX_LOOKUPS && await net()) {
      lookups += 1;
      try {
        const res = await client.request('GET', `/repos/${REPRO_REPO}/actions/artifacts`, { query: { name: `${ARTIFACT_PREFIX}${key}`, per_page: 20 } });
        const candidates = (res.data?.artifacts ?? []).filter((a) => a?.name === `${ARTIFACT_PREFIX}${key}` && trustedArtifact(a))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        let found = null;
        // The newest whose run is lead-repro.yml itself (one GET of its run): never another workflow's artifact of that name.
        for (const a of candidates.slice(0, 2)) {
          const run = (await client.request('GET', `/repos/${REPRO_REPO}/actions/runs/${Number(a.workflow_run.id)}`)).data;
          if (trustedRun(run, a)) { found = a; break; }
        }
        if (found) {
          const z = await client.request('GET', `/repos/${REPRO_REPO}/actions/artifacts/${found.id}/zip`, { redirect: 'manual' });
          const location = z.headers?.get?.('location');
          if (!location) throw new Error(`expected a redirect to the artifact, got HTTP ${z.status}`);
          const blob = await fetchImpl(location, { headers: { 'user-agent': 'isokron-tool-qa' }, redirect: 'follow', signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
          if (!blob.ok) throw new Error(`the artifact download returned HTTP ${blob.status}`);
          // Refused before the body is read when its length says it is over the cap; checked again once read.
          const declared = Number(blob.headers?.get?.('content-length'));
          if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) throw new Error(`the artifact download declares ${declared} bytes, over ${MAX_ARTIFACT_BYTES}`);
          const buf = Buffer.from(await blob.arrayBuffer());
          if (buf.length > MAX_ARTIFACT_BYTES) throw new Error(`the artifact is ${buf.length} bytes, over ${MAX_ARTIFACT_BYTES}`);
          const v = verdictFromArtifact(buf, key);
          if (v) {
            rec = { ...(rec ?? {}), ...v, at: iso };
            kv[key] = rec;
            changed = true;
            note.repro_read += 1;
          }
        }
      } catch (err) {
        note.repro_errors += 1;
        log(`leads: could not read the lead-repro verdict for key ${key}: ${err?.message ?? err}`);
      }
    }
    if (rec && FINAL.has(rec.verdict)) { out.set(lead.fingerprint, { state: 'ready', key, verdict: { ...rec, key } }); continue; }
    const tries = Number.isSafeInteger(rec?.tries) ? rec.tries : 0;
    const last = Date.parse(rec?.dispatched_at ?? '');
    const spent = tries >= REPRO_MAX_TRIES;
    const due = !Number.isFinite(last) || now - last >= (spent ? REPRO_STUCK_RETRY_MS : REPRO_RETRY_MS);
    let dispatchFailed = false;
    if (due && dispatches < MAX_DISPATCHES && await net()) {
      dispatches += 1;
      // A try is counted whether GitHub took the dispatch or not, so a dispatch that keeps failing ends stuck, not silent.
      rec = { ...(rec ?? {}), dispatched_at: iso, first_dispatched_at: rec?.first_dispatched_at ?? iso, tries: spent ? tries : tries + 1 };
      kv[key] = rec;
      changed = true;
      try {
        await client.request('POST', `/repos/${REPRO_REPO}/actions/workflows/${REPRO_WORKFLOW}/dispatches`, { body: { ref, inputs: { lead: leadInput(lead) } } });
        if (rec.dispatch_error) { delete rec.dispatch_error; }
      } catch (err) {
        dispatchFailed = true;
        note.repro_dispatch_errors += 1;
        rec.dispatch_errors = (Number.isSafeInteger(rec.dispatch_errors) ? rec.dispatch_errors : 0) + 1;
        rec.dispatch_error = `HTTP ${Number(err?.status) || 0}`;
        log(`leads: could not dispatch lead-repro for key ${key} (try ${rec.tries} of ${REPRO_MAX_TRIES}; its lead stays unfiled): ${err?.message ?? err}`);
      }
    }
    // Fail closed: no token, a refused dispatch, or tries spent with no verdict is stuck; anything else waits. Never filed.
    const lastNow = Date.parse(rec?.dispatched_at ?? '');
    const triesSpent = Number.isSafeInteger(rec?.tries) && rec.tries >= REPRO_MAX_TRIES && Number.isFinite(lastNow) && now - lastNow >= REPRO_RETRY_MS;
    const stuck = (asked && !client) || dispatchFailed || !!rec?.dispatch_error || triesSpent;
    if (stuck) note.repro_stuck += 1; else note.repro_pending += 1;
    out.set(lead.fingerprint, { state: stuck ? 'stuck' : 'pending', key, verdict: rec?.verdict === 'error' ? { verdict: 'error', key } : null });
  }
  note.repro_lookups = lookups;
  note.repro_dispatches = dispatches;
  if (changed) { try { writeKv(db, kv, now); } catch (err) { log(`leads: could not keep the lead-repro verdicts: ${err?.message ?? err}`); } }
  return out;
}
