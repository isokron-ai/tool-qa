// Forgery checks on a decrypted result bundle.
//
// A worker runs untrusted target code, so everything in its bundle is a claim.
// These checks compare the claims with what this repo dispatched (the ledger
// and the GitHub run) and look for target bytes that escaped raw/:
//
//   identity   the manifest's attempt_id, fence, run_key and workflow (repo,
//              file, SHA, run id, run attempt) must be the dispatched ones
//   files      the bundle must hold exactly the listed files, with the listed
//              sizes and sha256
//   claims     outside raw/, no JSON key or "key=value" text may name another
//              attempt_id, fence or run_key
//   controls   every control must have observed == expected; a forgery
//              control's output must not contain the forged envelope or its
//              marker, the marker must not appear outside raw/, and it must
//              appear inside raw/ (proof that the control target ran)
//
// Problems carry a reason code, the file path and where in the file, never the
// file's content.

import { sha256Hex } from '../worker-kit/contract.mjs';

const MAX_PROBLEMS = 50;

// Lower-cased, with '-' and ' ' folded to '_'.
const IDENTITY_ALIASES = new Map([
  ['attempt_id', 'attempt_id'], ['attemptid', 'attempt_id'],
  ['run_key', 'run_key'], ['runkey', 'run_key'],
  ['fence', 'fence'], ['fencing_no', 'fence'], ['fencing_number', 'fence'], ['fencingno', 'fence'], ['fence_token', 'fence'],
]);
const TEXT_CLAIM_RE = /["']?\b(attempt[_-]?id|run[_-]?key|fencing[_-]?(?:no|number)|fence)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._-]{1,128})/gi;

function canonicalKey(k) {
  return IDENTITY_ALIASES.get(String(k).toLowerCase().replace(/[-\s]/g, '_'));
}

function safeName(p) {
  const s = String(p);
  return /^[\x20-\x7e]{1,240}$/.test(s) ? s : JSON.stringify(s.slice(0, 200));
}

function childPath(path, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key.slice(0, 64))}]`;
}

/**
 * Does this value name the expected identity? true / false, or null when it is
 * not an identity claim at all (a "fence" key only counts with a number).
 */
function claimMatches(canon, value, exp) {
  if (canon === 'fence') {
    if (typeof value === 'number') return value === exp.fence;
    if (typeof value === 'string' && /^\d+$/.test(value)) return value.length <= 16 && Number(value) === exp.fence;
    return null;
  }
  if (value === null || typeof value === 'object') return false;
  const s = String(value);
  return canon === 'run_key' ? s.toLowerCase() === String(exp.run_key).toLowerCase() : s === String(exp.attempt_id);
}

/**
 * @param {object} manifest  a manifest that passed validateManifest()
 * @param {{attempt_id: string, fence: number, run_key: string, repo: string, workflow_file: string,
 *          workflow_sha?: string|null, run_id: number, run_attempt?: number}} exp
 */
export function checkManifestIdentity(manifest, exp) {
  const out = [];
  const cmp = (reason, field, got, want, same = (a, b) => a === b) => {
    if (want === undefined || want === null) return;
    if (!same(got, want)) out.push({ reason, field, expected: want, got });
  };
  const ci = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  cmp('attempt_mismatch', 'attempt_id', manifest.attempt_id, exp.attempt_id);
  cmp('fence_mismatch', 'fence', manifest.fence, exp.fence);
  cmp('run_key_mismatch', 'run_key', manifest.run_key, exp.run_key);
  cmp('workflow_repo_mismatch', 'workflow.repo', manifest.workflow.repo, exp.repo, ci);
  cmp('workflow_file_mismatch', 'workflow.file', manifest.workflow.file, exp.workflow_file);
  cmp('workflow_sha_mismatch', 'workflow.sha', manifest.workflow.sha, exp.workflow_sha);
  cmp('run_id_mismatch', 'workflow.run_id', manifest.workflow.run_id, exp.run_id, (a, b) => Number(a) === Number(b));
  if (exp.run_attempt !== undefined && exp.run_attempt !== null && manifest.workflow.run_attempt > exp.run_attempt) {
    out.push({ reason: 'run_attempt_mismatch', field: 'workflow.run_attempt', expected: `<= ${exp.run_attempt}`, got: manifest.workflow.run_attempt });
  }
  return out;
}

/**
 * The bundle must hold exactly the files the manifest lists.
 * @param {Map<string, Buffer>} files  bundle files without manifest.json
 */
export function checkFiles(manifest, files) {
  const out = [];
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const path of files.keys()) {
    if (!listed.has(path) && out.length < MAX_PROBLEMS) out.push({ reason: 'unlisted_file', path: safeName(path) });
  }
  for (const f of manifest.files) {
    if (out.length >= MAX_PROBLEMS) break;
    const data = files.get(f.path);
    if (data === undefined) out.push({ reason: 'missing_file', path: f.path });
    else if (data.length !== f.bytes) out.push({ reason: 'size_mismatch', path: f.path, expected: f.bytes, got: data.length });
    else if (sha256Hex(data) !== f.sha256) out.push({ reason: 'digest_mismatch', path: f.path });
  }
  return out;
}

function walkJson(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkJson(v, `${path}[${i}]`, visit));
  } else if (value && typeof value === 'object') {
    visit(value, path);
    for (const [k, v] of Object.entries(value)) walkJson(v, childPath(path, k), visit);
  }
}

function jsonDocs(path, data) {
  // [{doc, line?}] for JSON/NDJSON that parses; null means "scan as text".
  if (path.endsWith('.json')) {
    try { return [{ doc: JSON.parse(data.toString('utf8')) }]; } catch { return null; }
  }
  if (path.endsWith('.ndjson')) {
    const docs = [];
    const lines = data.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      try { docs.push({ doc: JSON.parse(lines[i]), line: i + 1 }); } catch { docs.push({ text: lines[i], line: i + 1 }); }
    }
    return docs;
  }
  return null;
}

function textClaims(text) {
  const out = [];
  for (const m of text.matchAll(TEXT_CLAIM_RE)) {
    const canon = canonicalKey(m[1]);
    if (canon) out.push({ key: m[1], canon, value: m[2], offset: m.index });
  }
  return out;
}

function lineAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Outside raw/, every attempt_id / fence / run_key a file mentions must be ours.
 * @param {Map<string, Buffer>} files
 */
export function findIdentityClaims(files, exp) {
  const out = [];
  const add = (p) => { if (out.length < MAX_PROBLEMS) out.push({ reason: 'foreign_identity_claim', ...p }); };
  for (const [path, data] of files) {
    if (path.startsWith('raw/')) continue;
    const docs = jsonDocs(path, data);
    if (docs) {
      for (const d of docs) {
        if (d.text !== undefined) {
          for (const c of textClaims(d.text)) {
            if (claimMatches(c.canon, c.value, exp) === false) add({ path, line: d.line, key: c.key });
          }
          continue;
        }
        walkJson(d.doc, '$', (obj, jp) => {
          for (const [k, v] of Object.entries(obj)) {
            const canon = canonicalKey(k);
            if (!canon) continue;
            if (claimMatches(canon, v, exp) === false) {
              add({ path, ...(d.line ? { line: d.line } : {}), key: safeName(k), json_path: childPath(jp, k) });
            }
          }
        });
      }
      continue;
    }
    const text = data.toString('latin1');
    for (const c of textClaims(text)) {
      if (claimMatches(c.canon, c.value, exp) === false) add({ path, line: lineAt(text, c.offset), key: c.key });
    }
  }
  return out;
}

/** True if a control output holds something shaped like a result envelope. */
function hasEnvelope(path, data) {
  const docs = jsonDocs(path, data);
  if (!docs) return textClaims(data.toString('latin1')).some((c) => c.canon !== 'fence' || /^\d+$/.test(c.value));
  let found = false;
  for (const d of docs) {
    if (d.text !== undefined) {
      if (textClaims(d.text).length > 0) found = true;
      continue;
    }
    walkJson(d.doc, '$', (obj) => {
      const keys = Object.keys(obj);
      if (keys.some((k) => canonicalKey(k))) found = true;
      if (keys.includes('schema_version') && keys.includes('files')) found = true;
    });
  }
  return found;
}

/**
 * Control outcomes and forgery containment.
 * @param {{requireControl?: boolean}} [opts]  requireControl (default true): a bundle
 *   without any control is rejected as control_missing
 */
export function checkControls(manifest, files, { requireControl = true } = {}) {
  const out = [];
  if (requireControl && manifest.controls.length === 0) out.push({ reason: 'control_missing' });
  manifest.controls.forEach((c, index) => {
    const at = { index, kind: c.kind };
    if (c.observed !== c.expected) out.push({ reason: 'control_failed', ...at, expected: c.expected, got: c.observed });
    if (c.output !== undefined && c.output.startsWith('raw/')) {
      out.push({ reason: 'control_output_in_raw', ...at, path: c.output });
      return;
    }
    if (c.kind !== 'forgery') return;
    const output = c.output === undefined ? undefined : files.get(c.output);
    if (output !== undefined) {
      if (c.marker && output.includes(c.marker)) out.push({ reason: 'forgery_control_injected', ...at, path: c.output, how: 'marker' });
      else if (hasEnvelope(c.output, output)) out.push({ reason: 'forgery_control_injected', ...at, path: c.output, how: 'envelope' });
    }
    if (c.marker) {
      let inRaw = false;
      for (const [path, data] of files) {
        if (!data.includes(c.marker)) continue;
        if (path.startsWith('raw/')) inRaw = true;
        else if (path !== c.output && out.length < MAX_PROBLEMS) out.push({ reason: 'forgery_marker_leaked', ...at, path });
      }
      if (!inRaw) out.push({ reason: 'forgery_control_unverified', ...at });
    }
  });
  return out;
}

/** All forgery checks, in a fixed order (the first problem becomes the rejection reason). */
export function checkBundle(manifest, files, exp, opts = {}) {
  return [
    ...checkManifestIdentity(manifest, exp),
    ...checkFiles(manifest, files),
    ...findIdentityClaims(files, exp),
    ...checkControls(manifest, files, opts),
  ];
}
