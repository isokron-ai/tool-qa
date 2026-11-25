// One accepted result in, one published record out (or a reason it is not published).
//
// The record is built from three things only: the manifest ingest checked, the
// observation files ingest checked against the field registry, and the skips in
// the manifest. Nothing from `results/`, `raw/`, `logs/` or `controls/` is read
// (those hold tool reports, captured server bytes and findings; none is published).
//
// Outcomes of buildRecord():
//   {record}            publish it
//   {held, reason}      the whole result is held. Never counted or described in any
//                       output (see HELD_SILENT): a security-class field, or the
//                       record would not pass the redaction scan
//   {withheldAll}       nothing publishable in it (every field left out); it is still
//                       published as a record with no observations, so a coverage
//                       state and a skip stay visible
//
// "Separate measurements, never one score": a record has no pass/fail and no score. A
// skip is published as what it is (a stage, a reason, who it is down to), and the
// coverage block says whose limit it was.

import { JsonDepthError, redactValue, scanValue } from '../ingest/redact.mjs';
import { resultFault } from '../worker-kit/contract.mjs';
import { canonical, contentDigest, recordId } from './canonical.mjs';
import { ATTRIBUTION, decideField } from './policy.mjs';

export const RECORD_SCHEMA = 'mcp-results/record/1';
/** Held for these reasons, the item is not named, counted or logged by reason. */
export const HELD_SILENT = Object.freeze(['security_class']);
export const MAX_STRING = 4096;
export const MAX_VALUE_BYTES = 64 * 1024;
const MAX_WHY = 300;

const laneOf = (workflowFile) => String(workflowFile ?? '').replace(/^.*\//, '').replace(/\.ya?ml$/, '');
const textOk = (s) => typeof s === 'string' && s.length > 0;

function parseLines(files) {
  const lines = [];
  for (const [path, data] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const raw of data.toString('utf8').split('\n')) {
      if (raw.trim() === '') continue;
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && typeof o.field === 'string') lines.push(o);
      } catch { /* ingest already refused a bundle with an unreadable observation file */ }
    }
  }
  return lines;
}

/** The longest string anywhere in a JSON value (iterative: a deep value cannot overflow the stack). */
function longestString(value) {
  let max = 0;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') max = Math.max(max, v.length);
    else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') stack.push(...Object.values(v));
  }
  return max;
}

/**
 * @param {object} item     from read.mjs checkItem()
 * @param {{fields: Map<string, object>}} registry  parsed registry
 * @returns {{record: object, withheld: Record<string, number>}|{held: true, reason: string}}
 */
export function buildRecord(item, registry) {
  const { manifest, ingest } = item;
  const lines = parseLines(item.observationFiles);

  // 1. The security hold comes first, over every line, before anything is read as a value.
  for (const line of lines) {
    if (decideField(registry.fields, line.field).decision === 'hold') return { held: true, reason: 'security_class' };
  }

  // 2. Fields: publish, or leave out by class/status (counted, never named).
  const withheld = {};
  const observations = [];
  for (const line of lines) {
    const d = decideField(registry.fields, line.field);
    if (d.decision === 'withhold') {
      withheld[d.reason] = (withheld[d.reason] ?? 0) + 1;
      continue;
    }
    const entry = d.entry;
    let value = line.value === undefined ? null : line.value;
    // 3. Redaction, as the registry says. R1 (text the server's author wrote): only the
    //    matching span is masked. Everything else: a hit of any rule holds the result.
    let maskedR1 = false;
    try {
      if (entry.redaction?.includes('R1')) {
        const r = redactValue(value);
        // Only a secret in the author's own text is masked. A canary or a personal
        // detail (R3, R4) in it means something upstream of us went wrong: hold.
        if (r.hits.some((h) => h.class !== 'R1')) return { held: true, reason: 'redaction_hit' };
        if (r.hits.length) { value = r.value; maskedR1 = true; }
      }
      if (scanValue(value).length > 0) return { held: true, reason: 'redaction_hit' };
      for (const key of ['why', 'stage']) {
        if (line[key] !== undefined && (typeof line[key] !== 'string' || scanValue(line[key]).length > 0)) return { held: true, reason: 'redaction_hit' };
      }
    } catch (err) {
      if (err instanceof JsonDepthError) return { held: true, reason: 'too_deep' };
      throw err;
    }
    if (longestString(value) > MAX_STRING || Buffer.byteLength(canonical(value)) > MAX_VALUE_BYTES) return { held: true, reason: 'oversize' };
    const obs = { field: line.field, value, class: entry.class, basis: entry.class === 'P-s' ? 'read_from_source' : 'measured' };
    if (typeof line.why === 'string') obs.why = line.why.slice(0, MAX_WHY);
    if (typeof line.stage === 'string') obs.stage = line.stage.slice(0, 64);
    if (maskedR1) obs.masked = true;
    observations.push(obs);
  }
  observations.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : canonical(a) < canonical(b) ? -1 : 1));

  // 4. Coverage: from the skips, by the contract's own rule. Ingest recorded the same; they must agree.
  const skips = (manifest.skips ?? []).map((s) => ({
    stage: s.stage,
    reason: s.reason,
    ...(s.fault ? { fault: s.fault } : {}),
    ...(s.retryable === true ? { retryable: true } : {}),
  }));
  const rf = resultFault(manifest.skips ?? []);
  const said = ingest.bundle ?? {};
  if (said.coverage !== undefined && said.coverage !== rf.coverage) return { held: true, reason: 'coverage_mismatch' };
  const coverage = {
    state: rf.coverage,
    fault_side: rf.fault,
    attribution: ATTRIBUTION[rf.coverage],
    skips,
  };

  const record = {
    schema: RECORD_SCHEMA,
    record_id: recordId({ attempt_id: item.attempt_id, item_index: item.item_index, run_key: manifest.run_key }),
    lane: laneOf(manifest.workflow?.file),
    subject: { id: manifest.subject.id, repo: manifest.subject.repo ?? null, sha: manifest.subject.sha ?? null },
    measured: { started_at: manifest.started_at, finished_at: manifest.finished_at },
    provenance: {
      run_key: manifest.run_key,
      attempt_id: item.attempt_id,
      item_index: item.item_index,
      fence: manifest.fence,
      workflow: {
        repo: manifest.workflow.repo,
        file: manifest.workflow.file,
        sha: manifest.workflow.sha,
        run_id: manifest.workflow.run_id,
        run_attempt: manifest.workflow.run_attempt,
      },
      tools: manifest.tools.map((t) => ({ name: t.name, version: t.version })),
      oracles: (manifest.oracles ?? []).map((t) => ({ name: t.name, version: t.version })),
      settings_manifest_digest: manifest.settings_manifest_digest,
    },
    coverage,
    observations,
  };
  if (!textOk(record.lane)) return { held: true, reason: 'no_lane' };
  record.content_sha256 = contentDigest(record);
  return { record, withheld };
}
