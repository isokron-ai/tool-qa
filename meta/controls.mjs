// Controls for the metadata lanes (worker-kit README, "controls"; ingest/forgery.mjs).
//
// known-answer (kind known_good, expected "match")
//   The lane reads one of our own repositories, isokron-ai/mcp-check, live,
//   through the same code and APIs as the subjects, and compares facts that do
//   not change (ids, creation times, first published versions) or only grow
//   (release count) with meta/fixtures/known-answer.json. A mismatch means the
//   lane no longer reads what it claims, and the run uploads nothing. When the
//   read itself hit a passing problem (a rate limit, an outage) in a stage the
//   facts come from, nothing is compared: the control is unavailable, and the
//   run reports every item as a retryable skip instead (R-META-02).
//
// forgery (kind forgery, expected "contained")
//   The lane reads a planted subject, offline, from meta/fixtures/forgery-<lane>.json:
//   API answers whose keys and text pose as another attempt's result (attempt_id,
//   run_key, fence, a manifest envelope) and carry a fresh marker. The answers
//   are kept under raw/ (proof the target was read); what the lane keeps must
//   hold no marker, no identity-shaped key, no identity-shaped text and no
//   envelope. Contained means upstream data cannot pose as a result.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { TEXT_CLAIM_RE } from '../ingest/forgery.mjs';
import { createCache, createHttp } from './lib/http.mjs';
import { sanitize } from './lib/common.mjs';
import { createBudget } from './github.mjs';
import { writeTar } from '../worker-kit/tar.mjs';

export const CONTROL_FORMAT = 'isokron-tool-qa-meta-control/1';
export const KNOWN_ANSWER_SUBJECT = 'isokron-ai/mcp-check';
export const FORGERY_SUBJECT = 'forgery-target/forgery-target';
const FIXTURES = new URL('./fixtures/', import.meta.url);
const MARKER_RE = /^[A-Za-z0-9_-]{16,128}$/;
const IDENTITY_KEY_RE = /^(?:attempt[_-\s]?id|attemptid|run[_-\s]?key|runkey|fence|fencing[_-\s]?(?:no|number)|fencingno|fence[_-\s]?token)$/i;

/** A fresh marker: letters and digits only, so no redaction rule can match it. */
export function newMarker() {
  return `FORGERYMARK${randomBytes(12).toString('hex')}`;
}

export function loadKnownAnswer(path = new URL('known-answer.json', FIXTURES)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Compare observed facts with the expected spec: exact, at_least (numbers), contains (array elements). */
export function compareFacts(spec, observed) {
  const mismatches = [];
  for (const [k, want] of Object.entries(spec.exact ?? {})) {
    if (!same(observed[k], want)) mismatches.push({ fact: k, rule: 'exact' });
  }
  for (const [k, min] of Object.entries(spec.at_least ?? {})) {
    if (!(typeof observed[k] === 'number' && observed[k] >= min)) mismatches.push({ fact: k, rule: 'at_least' });
  }
  for (const [k, items] of Object.entries(spec.contains ?? {})) {
    const have = Array.isArray(observed[k]) ? observed[k] : [];
    for (const want of items) if (!have.some((h) => same(h, want))) mismatches.push({ fact: k, rule: 'contains' });
  }
  return mismatches;
}

/**
 * The known-answer control, live.
 * @returns {Promise<{control: object|null, files: Record<string, string>, unavailable?: string, stage?: string}>}
 *   unavailable: the skip reason (rate_limited or upstream_unavailable) when a passing problem stopped the read
 */
export async function knownAnswerControl(lane, { http, token, budget, spec = loadKnownAnswer() }) {
  const want = spec[lane.name];
  // A lane may name its own known-answer subjects and pin the versions it reads (release-diff).
  const subjects = Array.isArray(want?.subjects) ? want.subjects : [spec.subject ?? KNOWN_ANSWER_SUBJECT];
  const subject = subjects.length === 1 ? subjects[0] : subjects;
  let observed = null;
  let mismatches;
  let error = null;
  try {
    const outs = await lane.collect({ http, repos: subjects, token, budget, ...(want?.pins ? { pins: want.pins } : {}) });
    const parts = [];
    for (const s of subjects) {
      const o = outs.get(s);
      if (!o) throw new Error('the lane returned nothing for the known-answer subject');
      const passing = lane.factProblem(o, want);
      if (passing) return { unavailable: passing, control: null, files: {} };
      parts.push(lane.facts(o));
    }
    observed = parts.length === 1 ? parts[0] : lane.mergeFacts(parts);
    mismatches = compareFacts(want, observed);
  } catch (err) {
    error = err?.code ?? 'error';
    mismatches = [{ fact: 'collect', rule: 'ran' }];
  }
  const match = mismatches.length === 0;
  const output = sanitize({ format: CONTROL_FORMAT, control: 'known-answer', lane: lane.name, lane_version: lane.version, subject, match, error, mismatches, expected: want, observed });
  return {
    control: { kind: 'known_good', expected: 'match', observed: match ? 'match' : 'mismatch', output: 'controls/known-answer.json' },
    files: { 'controls/known-answer.json': `${JSON.stringify(output, null, 2)}\n` },
  };
}

/**
 * A fetch that answers from the forgery fixture: the first route whose method
 * and prefix match. A route's body is JSON or text, or one built here after
 * the marker is in place (so its bytes carry the marker):
 *   tgz: { "<path>": "<text>" }   a gzip-compressed tar of those files
 *   pkt_lines: ["<line>", ...]     Git pkt-lines, then a flush
 * In a text body, __SHA512__<prefix>__ and __SHA256__<prefix>__ become the
 * digests of the built route with that prefix (npm's integrity, PyPI's sha256).
 */
export function fixtureFetch(routes) {
  const built = new Map();
  for (const r of routes) {
    if (r.tgz) built.set(r.prefix, gzipSync(writeTar(Object.entries(r.tgz).map(([path, text]) => ({ path, data: Buffer.from(text) })))));
    else if (r.pkt_lines) built.set(r.prefix, Buffer.from(r.pkt_lines.map((l) => (Buffer.byteLength(`${l}\n`) + 4).toString(16).padStart(4, '0') + `${l}\n`).join('') + '0000'));
  }
  const fill = (text) => text.replace(/__SHA(512|256)__(.+?)__/g, (m, bits, prefix) => {
    const b = built.get(prefix);
    if (!b) return m;
    return bits === '512' ? `sha512-${createHash('sha512').update(b).digest('base64')}` : createHash('sha256').update(b).digest('hex');
  });
  return async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const r = routes.find((x) => (x.method ?? 'GET') === method && url.startsWith(x.prefix));
    if (!r) return new Response('not found', { status: 404 });
    if (built.has(r.prefix)) return new Response(built.get(r.prefix), { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/octet-stream' } });
    const body = fill(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
}

/** Every object key in a JSON value (an explicit stack; our own output is shallow). */
function keysOf(value) {
  const keys = new Set();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); stack.push(x); }
  }
  return keys;
}

/**
 * The forgery control, offline.
 * @returns {Promise<{control: object, files: Record<string, string>}>}
 */
export async function forgeryControl(lane, { marker = newMarker(), fixturePath = new URL(`forgery-${lane.name}.json`, FIXTURES) } = {}) {
  if (!MARKER_RE.test(marker)) throw new Error('forgery control: bad marker');
  const text = readFileSync(fixturePath, 'utf8').split('__MARKER__').join(marker);
  const fixture = JSON.parse(text);
  const http = createHttp({ fetch: fixtureFetch(fixture.routes), cache: createCache(), retries: 0, sleep: async () => {}, minIntervalMs: {} });
  let status = 'read';
  let kept = [];
  try {
    const outs = await lane.collect({ http, repos: [FORGERY_SUBJECT], token: null, budget: createBudget() });
    const o = outs.get(FORGERY_SUBJECT);
    if (!o) status = 'not_read';
    else kept = sanitize([o.records, o.stages]);
  } catch (err) {
    status = err?.message?.startsWith('sanitize:') ? 'identity_key' : 'not_read';
  }
  const keptText = JSON.stringify(kept);
  const keys = keysOf(kept);
  TEXT_CLAIM_RE.lastIndex = 0;
  const checks = {
    records: Array.isArray(kept[0]) ? kept[0].length : 0,
    target_read: status === 'read' && http.stats.requests > 0,
    marker_kept: keptText.includes(marker),
    identity_shaped_keys: [...keys].filter((k) => IDENTITY_KEY_RE.test(k)).length,
    identity_shaped_text: [...keptText.matchAll(TEXT_CLAIM_RE)].length,
    envelope: keys.has('schema_version') && keys.has('files'),
  };
  const contained = checks.target_read && checks.records > 0 && !checks.marker_kept
    && checks.identity_shaped_keys === 0 && checks.identity_shaped_text === 0 && !checks.envelope;
  const observed = status === 'identity_key' ? 'leaked' : !checks.target_read ? 'not_read' : contained ? 'contained' : 'leaked';
  const output = { format: CONTROL_FORMAT, control: 'forgery', lane: lane.name, lane_version: lane.version, status: observed, checks };
  return {
    control: { kind: 'forgery', expected: 'contained', observed, output: 'controls/forgery.json', marker },
    files: {
      'controls/forgery.json': `${JSON.stringify(output, null, 2)}\n`,
      'raw/control-forgery/answers.json': text,
    },
  };
}
