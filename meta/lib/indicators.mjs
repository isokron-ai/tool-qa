// Content indicators for release-diff: patterns that, in the wrong place, look
// like malicious code rather than a packaging slip.
//
// They are never a verdict on their own. release-diff holds an item as
// security-class (field release_diff_held, class S: private, never published,
// counts included) only when a strong indicator turns up where the source does
// not explain it: in a file the repository does not have, in a file whose
// content differs from the source (and the source's copy lacks the
// indicator), in what runs at install time, or in build output when the
// matched text appears nowhere in the source tree. Everything else stays a
// public hardening finding with no indicator detail.
//
// Rule ids are ours and stable: they go into the held record, never the
// matched text.

export const STRONG_RULES = Object.freeze([
  // javascript-obfuscator's hex identifiers, in bulk.
  { id: 'js_obfuscator_identifiers', re: /\b_0x[0-9a-f]{4,6}\b/g, min: 30, literal: false },
  // Code decoded at run time and evaluated.
  { id: 'eval_of_decoded_text', re: /\b(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/g, min: 1, literal: false },
  { id: 'python_exec_of_decoded_text', re: /\bexec\s*\(\s*(?:base64\.b64decode|zlib\.decompress|marshal\.loads|codecs\.decode|bytes\.fromhex|__import__\s*\(\s*['"](?:base64|zlib|marshal|codecs)['"]\s*\))/g, min: 1, literal: false },
  // Endpoints that collect what is sent to them, used for exfiltration.
  { id: 'exfiltration_endpoint', re: /\b(?:discord(?:app)?\.com\/api\/webhooks\/[0-9]+|api\.telegram\.org\/bot[0-9]+|webhook\.site\/[0-9a-f-]{8,}|[a-z0-9-]+\.m\.pipedream\.net|[a-z0-9]{8,}\.oast(?:ify)?\.(?:com|fun|me|site|live|pro)|[a-z0-9]{8,}\.burpcollaborator\.net|[a-z0-9]{8,}\.interact\.sh)/gi, min: 1, literal: true },
  // Download and run.
  { id: 'download_and_execute', re: /\b(?:curl|wget)\b[^\n]{0,300}\|\s*(?:ba|z)?sh\b|\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]{0,300}\|\s*(?:iex|Invoke-Expression)\b/gi, min: 1, literal: false },
  // Credential stores read by name.
  { id: 'credential_store_access', re: /(?:\.npmrc|\.pypirc|\.git-credentials|\.ssh\/id_(?:rsa|ed25519|ecdsa)|\.aws\/credentials|\.config\/gcloud\/|\.kube\/config|Local Storage\/leveldb|Login Data|wallet\.dat|\.config\/solana\/id\.json|\.docker\/config\.json)/g, min: 2, literal: true },
]);

export const WEAK_RULES = Object.freeze([
  { id: 'long_encoded_blob', re: /(?<![A-Za-z0-9+/]|base64,)[A-Za-z0-9+/]{4000,}={0,2}/g, min: 1 },
  { id: 'process_spawn', re: /\b(?:child_process|execSync|spawnSync|subprocess\.(?:Popen|run|call|check_output)|os\.system|os\.popen)\b/g, min: 1 },
  { id: 'network_call', re: /\b(?:https?\.(?:get|request)|fetch\s*\(\s*['"`]https?:|urllib\.request|requests\.(?:get|post)|http\.client|socket\.socket)\b/g, min: 1 },
]);

const MAX_SCAN_CHARS = 4 * 1024 ** 2;

/** Is this buffer text we should scan (no NUL byte in its first 8 KiB)? */
export function looksText(data) {
  if (!data) return false;
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return false;
  return true;
}

/**
 * Scan text for indicators.
 * @returns {{strong: {id: string, literals: string[]}[], weak: string[]}}  literals: matched text for literal rules (for comparing with the source; never published)
 */
export function scanIndicators(text) {
  const s = typeof text === 'string' ? text.slice(0, MAX_SCAN_CHARS) : '';
  const strong = [];
  for (const r of STRONG_RULES) {
    r.re.lastIndex = 0;
    const hits = s.match(r.re) ?? [];
    if (hits.length >= r.min) strong.push({ id: r.id, literals: r.literal ? [...new Set(hits.map((h) => h.toLowerCase()))].slice(0, 20) : [] });
  }
  const weak = [];
  for (const r of WEAK_RULES) {
    r.re.lastIndex = 0;
    if ((s.match(r.re) ?? []).length >= r.min) weak.push(r.id);
  }
  return { strong, weak };
}

/** What the source tree holds of the strong rules: per rule, any hit at all, and the literals seen. */
export function createSourceIndex() {
  const rules = new Map();
  return {
    add(text) {
      for (const h of scanIndicators(text).strong) {
        const cur = rules.get(h.id) ?? new Set();
        for (const l of h.literals) if (cur.size < 1000) cur.add(l);
        rules.set(h.id, cur);
      }
    },
    /** Does the source explain this hit: the rule fires in the source and, for literal rules, with the same text? */
    explains(hit) {
      const seen = rules.get(hit.id);
      if (!seen) return false;
      if (hit.literals.length === 0) return true;
      return hit.literals.every((l) => seen.has(l));
    },
    get size() { return rules.size; },
  };
}

/** File names that hold secrets when they are published (templates such as .env.example excluded). */
export const SECRET_FILE_RE = /(?:^|\/)(?:\.env(?!\.(?:example|sample|template|dist|defaults?|schema)$)(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|ed25519|ecdsa|dsa)|[^/]*\.(?:pem|p12|pfx|keystore|jks))$/i;

/** ingest/redact.mjs rules precise enough to hold a published file for (email and the generic assignment rule are not). */
export const SECRET_RULES = Object.freeze(new Set([
  'private-key-block', 'age-secret-key', 'aws-access-key-id', 'github-token', 'github-fine-grained-pat', 'gitlab-pat',
  'slack-token', 'stripe-secret-key', 'npm-token', 'url-credentials',
]));
