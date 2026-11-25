// Pre-write scan for the heartbeat report. The Worker is deployed on its own, so this is a minimal copy of the
// token, key and email rules of ingest/redact.mjs (keep in step; test/heartbeat-report.test.mjs runs the same cases),
// plus the vendor-name word list of publish/test/publish.test.mjs R-PUB-08 (kept split in source so this file does not
// match its own scan). A hit never carries the matched text: only the rule and the JSON path.

const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'ssh.dev.azure.com']);
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export const RULES = Object.freeze([
  { id: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]{1,32} ){0,8}PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'age-secret-key', re: /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe-secret-key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'generic-sk-key', re: /\bsk-[A-Za-z0-9_-]{32,}/g, check: (m) => /\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3)) },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/?#"'<>]{1,256}:([^\s@/?#"'<>]{1,256})@[A-Za-z0-9.-]+/g, check: (m) => !/^[$%{<[]/.test(m[1]) && m[1].length >= 6 },
  {
    id: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|secret|token|passw(?:or)?d)["']?\s{0,16}[:=]\s{0,16}["']([^"'\s]{16,1024})["']/gi,
    check: (m) => /\d/.test(m[1]) && entropy(m[1]) >= 3.5 && !/^(?:your|example|sample|dummy|xxx|changeme)/i.test(m[1]),
  },
  { id: 'canary', re: /ISOKRON_CANARY_[A-Za-z0-9]{8,}/ },
  { id: 'email', re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.){1,16}[A-Za-z]{2,63})\b/g, check: (m) => !RESERVED_EMAIL_DOMAIN.test(m[2]) && !(m[1] === 'git' && SSH_HOSTS.has(m[2].toLowerCase())) },
]);

const VENDOR_WORDS = [['cl', 'aude'], ['anthr', 'opic'], ['open', 'ai'], ['gp', 't-'], ['gem', 'ini'], ['op', 'us '], ['son', 'net'], ['ha', 'iku'], ['chat', 'gpt'], ['gr', 'ok']].map((p) => p.join(''));
export const VENDOR_RE = new RegExp(VENDOR_WORDS.join('|'), 'i');

function ruleHit(text) {
  for (const r of RULES) {
    if (!r.check) { if (r.re.test(text)) return r.id; continue; }
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    for (const m of text.matchAll(re)) if (r.check(m)) return r.id;
  }
  if (VENDOR_RE.test(text)) return 'vendor-name';
  return null;
}

/** Scan every key and string value of a JSON value. Returns [{rule, path}] (never the text). */
export function scanObject(value, path = '$', out = []) {
  if (typeof value === 'string') { const rule = ruleHit(value); if (rule) out.push({ rule, path }); }
  else if (Array.isArray(value)) value.forEach((v, i) => scanObject(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const rule = ruleHit(k); if (rule) out.push({ rule, path: `${path}.<key>` });
      scanObject(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Scan the exact text that will be written, plus each string by path (a serialized string has its quotes escaped, which
 *  can hide an assignment pattern). Returns [{rule, path}]; path is '$' for a hit only the serialized text shows. */
export function scanBody(body, doc) {
  const hits = scanObject(doc);
  const rule = ruleHit(String(body));
  if (rule && !hits.some((h) => h.rule === rule)) hits.push({ rule, path: '$' });
  return hits;
}
