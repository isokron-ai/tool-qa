// Redaction rules as pure functions.
//
//   R1  target-authored text: scanned for secrets; only the matching span is
//       masked, and the JSON path and rule id are recorded.
//   R2  secret-bearing values (env values, stderr, headers, URLs with queries):
//       public data keeps only a hash and a length (r2Summary).
//   R3  personal data: emails are never stored.
//   R4  our injected canaries: every output is searched; a hit is a finding and
//       the value is replaced by [CANARY].
//
// A hit never carries the matched text: only the rule, its class and where it
// is (offsets, JSON path, line). Ingest quarantines a bundle on any hit.
//
// The secret patterns are a small subset in the style of common secret
// scanners (verification off: found values are never tried anywhere).
//
// Every pattern runs in linear time on any input, because ingest scans
// untrusted bundles (R-ING-01 in REGRESSIONS.md). A pattern whose leading run
// is unbounded starts only where that run starts (a lookbehind), so the regex
// engine never rescans one long run from each of its positions; repeated
// groups and long runs that must be followed by something specific are
// bounded. test/redact.test.mjs times each rule on inputs built to make it
// backtrack.

import { createHash } from 'node:crypto';

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'ssh.dev.azure.com']);

/**
 * Each rule: id, class (R1..R4), a global regex, optional `group` (mask only
 * that capture group) and optional `check(match)` to drop obvious placeholders.
 */
export const RULES = Object.freeze([
  { id: 'private-key-block', class: 'R1', re: /-----BEGIN (?:[A-Z0-9]{1,32} ){0,8}PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'age-secret-key', class: 'R1', re: /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}/g },
  { id: 'aws-access-key-id', class: 'R1', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { id: 'github-token', class: 'R1', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github-fine-grained-pat', class: 'R1', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { id: 'gitlab-pat', class: 'R1', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'slack-token', class: 'R1', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-secret-key', class: 'R1', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key', class: 'R1', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'npm-token', class: 'R1', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // A JWT starts where a run of base64url characters starts.
  { id: 'jwt', class: 'R1', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'generic-sk-key', class: 'R1', re: /\bsk-[A-Za-z0-9_-]{32,}/g,
    check: (m) => /\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3)),
  },
  {
    id: 'url-credentials', class: 'R1',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/?#"'<>]{1,256}:([^\s@/?#"'<>]{1,256})@[A-Za-z0-9.-]+/g,
    check: (m) => !/^[$%{<[]/.test(m[1]) && m[1].length >= 6,
  },
  {
    id: 'generic-secret-assignment', class: 'R1', group: 1,
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|secret|token|passw(?:or)?d)["']?\s{0,16}[:=]\s{0,16}["']([^"'\s]{16,1024})["']/dgi,
    check: (m) => /\d/.test(m[1]) && entropy(m[1]) >= 3.5 && !/^(?:your|example|sample|dummy|xxx|changeme)/i.test(m[1]),
  },
  {
    // The local part starts where a run of local-part characters starts, and
    // is at most 64 characters (RFC 5321); labels are at most 63, and there
    // are at most 16 of them.
    id: 'email', class: 'R3',
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.){1,16}[A-Za-z]{2,63})\b/g,
    check: (m) => !RESERVED_EMAIL_DOMAIN.test(m[2]) && !(m[1] === 'git' && SSH_HOSTS.has(m[2].toLowerCase())),
  },
  { id: 'canary', class: 'R4', re: /ISOKRON_CANARY_[A-Za-z0-9]{8,}/g },
]);

/**
 * Find rule hits in a string.
 * @param {string} text
 * @param {{canaries?: string[]}} [opts]  extra literal canary values (R4)
 * @returns {{rule: string, class: string, start: number, end: number, length: number}[]}
 */
export function scanText(text, { canaries = [] } = {}) {
  const hits = [];
  const seen = new Set();
  const add = (rule, cls, start, end) => {
    const key = `${rule}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ rule, class: cls, start, end, length: end - start });
  };
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      if (r.check && !r.check(m)) continue;
      if (r.group) {
        const [s, e] = m.indices[r.group];
        add(r.id, r.class, s, e);
      } else {
        add(r.id, r.class, m.index, m.index + m[0].length);
      }
    }
  }
  for (const c of canaries) {
    if (typeof c !== 'string' || c.length < 6) continue;
    for (let i = text.indexOf(c); i !== -1; i = text.indexOf(c, i + 1)) add('canary', 'R4', i, i + c.length);
  }
  return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Replace hit spans: canaries by [CANARY], everything else by [REDACTED:<rule>]. */
export function maskText(text, hits) {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const h of sorted) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  let out = '';
  let pos = 0;
  for (const h of merged) {
    out += text.slice(pos, h.start) + (h.rule === 'canary' ? '[CANARY]' : `[REDACTED:${h.rule}]`);
    pos = h.end;
  }
  return out + text.slice(pos);
}

function childPath(path, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key.slice(0, 64))}]`;
}

/**
 * How deep a JSON document may nest before it is scanned as plain text
 * instead (R-ING-07). Bundle formats nest a few levels; 64 leaves room.
 */
export const MAX_JSON_DEPTH = 64;

/** A JSON value nests deeper than MAX_JSON_DEPTH. */
export class JsonDepthError extends Error {
  constructor(depth) {
    super(`JSON nests deeper than ${depth} levels`);
    this.name = 'JsonDepthError';
    this.depth = depth;
  }
}

/**
 * Scan every string (and object key) in a JSON value. Hits carry `json_path`.
 * Walks with an explicit stack (a deep document cannot overflow the call
 * stack) and throws JsonDepthError past `maxDepth`.
 */
export function scanValue(value, opts = {}, path = '$', out = [], { maxDepth = MAX_JSON_DEPTH } = {}) {
  // Frames are visited in document order: a key's hits come before its value's.
  const stack = [{ v: value, path, depth: 0 }];
  while (stack.length > 0) {
    const f = stack.pop();
    if (f.key !== undefined) {
      for (const h of scanText(f.key, opts)) out.push({ ...h, json_path: f.parent, in_key: true });
    }
    const v = f.v;
    if (typeof v === 'string') {
      for (const h of scanText(v, opts)) out.push({ ...h, json_path: f.path });
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (f.depth >= maxDepth) throw new JsonDepthError(maxDepth);
    const depth = f.depth + 1;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: `${f.path}[${i}]`, depth });
    } else {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, x] = entries[i];
        stack.push({ v: x, path: childPath(f.path, k), depth, key: k, parent: f.path });
      }
    }
  }
  return out;
}

/**
 * A masked deep copy of a JSON value, plus the hits. The input is not changed.
 * Throws JsonDepthError past `maxDepth` (so the recursion stays shallow).
 */
export function redactValue(value, opts = {}, { maxDepth = MAX_JSON_DEPTH } = {}) {
  const hits = [];
  const walk = (v, path, depth) => {
    if (typeof v === 'string') {
      const h = scanText(v, opts);
      h.forEach((x) => hits.push({ ...x, json_path: path }));
      return h.length ? maskText(v, h) : v;
    }
    if (v && typeof v === 'object' && depth >= maxDepth) throw new JsonDepthError(maxDepth);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const kh = scanText(k, opts);
        kh.forEach((y) => hits.push({ ...y, json_path: path, in_key: true }));
        o[kh.length ? maskText(k, kh) : k] = walk(x, childPath(path, k), depth + 1);
      }
      return o;
    }
    return v;
  };
  return { value: walk(value, '$', 0), hits };
}

/** R2: what public data may keep of a secret-bearing value. */
export function r2Summary(value) {
  const s = String(value);
  return { sha256: createHash('sha256').update(s, 'utf8').digest('hex'), length: s.length };
}

/** For display only: drop bidi controls, zero-width and tag characters (originals stay in data). */
export function stripDisplayUnsafe(text) {
  return String(text).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu, '');
}

/**
 * Scan bundle files. .json files are scanned by JSON path, .ndjson per line,
 * anything else (or JSON that does not parse, or nests deeper than
 * MAX_JSON_DEPTH) as text: Latin-1 for whole files, so offsets are byte
 * offsets.
 * @param {Map<string, Buffer>|Iterable<[string, Buffer]>} files
 * @returns {object[]} hits with `path` and, where known, `json_path` and `line`
 */
export function scanFiles(files, opts = {}) {
  const out = [];
  // Hits of one JSON document, or null when it must be scanned as text.
  const docHits = (doc) => {
    try {
      return scanValue(doc, opts);
    } catch (err) {
      if (err instanceof JsonDepthError) return null;
      throw err;
    }
  };
  for (const [path, data] of files) {
    if (path.endsWith('.json')) {
      let doc;
      let parsed = true;
      try { doc = JSON.parse(data.toString('utf8')); } catch { parsed = false; }
      const hits = parsed ? docHits(doc) : null;
      if (hits) {
        for (const h of hits) out.push({ path, ...h });
        continue;
      }
    } else if (path.endsWith('.ndjson')) {
      const lines = data.toString('utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trim() === '') return;
        let hits = null;
        try { hits = docHits(JSON.parse(line)); } catch { /* not JSON: scanned as text */ }
        if (hits === null) {
          for (const h of scanText(line, opts)) out.push({ path, line: i + 1, ...h });
          return;
        }
        for (const h of hits) out.push({ path, line: i + 1, ...h });
      });
      continue;
    }
    for (const h of scanText(data.toString('latin1'), opts)) out.push({ path, ...h });
  }
  return out;
}
