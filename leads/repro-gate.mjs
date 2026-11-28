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
// A lead whose key has waited REPRO_WAIT_MS since its first dispatch with no verdict is filed anyway, saying the
// check did not finish. A class no template can trigger needs no run. Each pump run reads at most
// MAX_LOOKUPS artifacts and sends at most MAX_DISPATCHES dispatches, so the pump's run time stays bounded.
// Never throws: a failure leaves the lead waiting (or, past the wait, filed without a fixture).

import { readZip } from '../scripts/lib/unzip.mjs';
import { pinsFor, reproKey, reproSpec, REPRO_VERDICTS } from './repro.mjs';

export const REPRO_REPO = 'isokron-ai/tool-qa';
export const REPRO_WORKFLOW = 'lead-repro.yml';
export const REPRO_KV = 'leads.repro';
export const ARTIFACT_PREFIX = 'lead-repro-';
export const REPRO_FORMAT = 'isokron-lead-repro/1';
const MIN = 60_000;
export const REPRO_RETRY_MS = 45 * MIN;
export const REPRO_WAIT_MS = 3 * 60 * MIN;
export const REPRO_MAX_TRIES = 3;
export const MAX_LOOKUPS = 10;
export const MAX_DISPATCHES = 3;
/** Keys kept in kv leads.repro at most (the oldest go first). */
export const KV_MAX = 300;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
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
  const tool = typeof r.tool === 'string' && /^[a-z0-9@., -]{1,300}$/i.test(r.tool) ? r.tool : null;
  return { verdict: r.verdict, run_id: Number.isSafeInteger(doc.run_id) ? doc.run_id : null, tool, why: typeof r.why === 'string' ? r.why.slice(0, 300) : null };
}

/** An artifact of a lead-repro run on main of the repository itself (not a pull request, not a fork). */
export function trustedArtifact(a, { repoId = null } = {}) {
  const run = a?.workflow_run ?? {};
  if (a?.expired) return false;
  if (run.head_branch !== 'main') return false;
  if (run.repository_id == null || run.head_repository_id !== run.repository_id) return false;
  return repoId == null || run.repository_id === repoId;
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
 * @returns {Promise<Map<string, {state: 'ready'|'pending'|'unchecked', key: string|null, verdict: object|null}>>} by fingerprint;
 *   ready: a verdict that settles the key; pending: wait (do not file yet); unchecked: waited long enough, file without a fixture
 */
export async function reproVerdicts({ db, leads, workflows, now, client: given = null, getClient = null, fetch: fetchImpl = globalThis.fetch, ref = 'main', log = () => {}, note = {} }) {
  const out = new Map();
  let client = given;
  let asked = given !== null || typeof getClient !== 'function';
  const net = async () => {
    if (!asked) {
      asked = true;
      try { client = await getClient(); } catch (err) { client = null; note.repro_errors = (note.repro_errors ?? 0) + 1; log(`leads: no token for lead-repro (verdicts from the state only): ${err?.message ?? err}`); }
    }
    return client;
  };
  const kv = readKv(db);
  let lookups = 0;
  let dispatches = 0;
  let changed = false;
  const iso = new Date(now).toISOString();
  Object.assign(note, { repro_lookups: 0, repro_dispatches: 0, repro_read: 0, repro_errors: 0 });
  for (const lead of leads) {
    const spec = reproSpec(lead);
    if (!spec.synthesizable) { out.set(lead.fingerprint, { state: 'ready', key: null, verdict: { verdict: 'not_reproducible_synthetically', why: spec.why } }); continue; }
    const key = reproKey(lead, spec, pinsFor(lead.lane, workflows));
    let rec = kv[key] ?? null;
    if (!(rec && FINAL.has(rec.verdict)) && lookups < MAX_LOOKUPS && await net()) {
      lookups += 1;
      try {
        const res = await client.request('GET', `/repos/${REPRO_REPO}/actions/artifacts`, { query: { name: `${ARTIFACT_PREFIX}${key}`, per_page: 20 } });
        const found = (res.data?.artifacts ?? []).filter((a) => a?.name === `${ARTIFACT_PREFIX}${key}` && trustedArtifact(a) && Number(a.size_in_bytes) <= MAX_ARTIFACT_BYTES)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        if (found) {
          const z = await client.request('GET', `/repos/${REPRO_REPO}/actions/artifacts/${found.id}/zip`, { redirect: 'manual' });
          const location = z.headers?.get?.('location');
          if (!location) throw new Error(`expected a redirect to the artifact, got HTTP ${z.status}`);
          const blob = await fetchImpl(location, { headers: { 'user-agent': 'isokron-tool-qa' }, redirect: 'follow' });
          if (!blob.ok) throw new Error(`the artifact download returned HTTP ${blob.status}`);
          const v = verdictFromArtifact(Buffer.from(await blob.arrayBuffer()), key);
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
    const due = !Number.isFinite(last) || now - last >= REPRO_RETRY_MS;
    if (due && tries < REPRO_MAX_TRIES && dispatches < MAX_DISPATCHES && await net()) {
      dispatches += 1;
      try {
        await client.request('POST', `/repos/${REPRO_REPO}/actions/workflows/${REPRO_WORKFLOW}/dispatches`, { body: { ref, inputs: { lead: leadInput(lead) } } });
        rec = { ...(rec ?? {}), dispatched_at: iso, first_dispatched_at: rec?.first_dispatched_at ?? iso, tries: tries + 1 };
        kv[key] = rec;
        changed = true;
      } catch (err) {
        note.repro_errors += 1;
        log(`leads: could not dispatch lead-repro for key ${key}: ${err?.message ?? err}`);
      }
    }
    if (!rec?.first_wait_at) {
      // The wait is counted from the first run that needed this key, dispatched or not: a lead-repro that can never be
      // dispatched (no token) holds a lead for REPRO_WAIT_MS, not for ever.
      rec = { ...(rec ?? {}), first_wait_at: iso };
      kv[key] = rec;
      changed = true;
    }
    const first = Date.parse(rec.first_dispatched_at ?? rec.first_wait_at);
    const waited = Number.isFinite(first) && now - first >= REPRO_WAIT_MS;
    const givenUp = tries >= REPRO_MAX_TRIES && Number.isFinite(last) && now - last >= REPRO_RETRY_MS;
    out.set(lead.fingerprint, { state: waited || givenUp ? 'unchecked' : 'pending', key, verdict: rec?.verdict === 'error' ? { verdict: 'error', key } : null });
  }
  note.repro_lookups = lookups;
  note.repro_dispatches = dispatches;
  if (changed) { try { writeKv(db, kv, now); } catch (err) { log(`leads: could not keep the lead-repro verdicts: ${err?.message ?? err}`); } }
  return out;
}
