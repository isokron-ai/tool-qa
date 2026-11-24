// Build provenance for a published package: npm's SLSA v1 provenance
// (dist.attestations) and PyPI's PEP 740 publish attestations (the integrity
// API), each a Sigstore-signed DSSE statement.
//
// The checks are those of isokron-ai/mcp-check corpus/live-probe.mjs at
// 0e39a56 (sigstoreProblem, npmProvenanceProblem, pypiProvenanceProblem;
// mcp-check R-LP-15, R-LP-18, R-LP-19), ported here so the release-diff lane
// needs no code from another repository at run time:
//
//   - the leaf certificate chains to Sigstore's public-good Fulcio authority
//     (fixtures/sigstore-fulcio.json, copied from mcp-check at 0e39a56);
//   - it was issued to a GitHub Actions workflow (OIDC issuer extension) of the
//     subject (Source Repository URI extension, and the SAN or an allowlisted
//     reusable signer);
//   - the DSSE signature over the statement verifies with it;
//   - the statement names this artifact by its digest (npm: the tarball's
//     sha512 from dist.integrity; PyPI: the file's sha256).
//
// Not checked, as in live-probe: the transparency-log entry and the signing
// time inside the certificate's ten minutes; the registry checked both when it
// accepted the attestation.
//
// New here: the commit and ref the certificate names (Fulcio extensions 13,
// Source Repository Digest, and 14, Source Repository Ref), and for npm the
// commit the signed statement resolves (resolvedDependencies), so the lane can
// compare the commit a release was built from with the commit its tag names.

import { X509Certificate, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FULCIO_FILE = new URL('../fixtures/sigstore-fulcio.json', import.meta.url);
let fulcioChains = null;

/** The pinned Fulcio certificate chains (intermediate first, root last). */
export function sigstoreChains(file = FULCIO_FILE) {
  if (file === FULCIO_FILE && fulcioChains) return fulcioChains;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const chains = d.certificate_authorities.map((ca) => ca.chain.map((b) => new X509Certificate(Buffer.from(b, 'base64'))));
  if (file === FULCIO_FILE) fulcioChains = chains;
  return chains;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const SHA1_RE = /^[0-9a-f]{40}$/;

/** One DER element at `i` of `buf`: { tag, start, end, next }, or null. */
function derAt(buf, i, limit = buf.length) {
  if (i + 2 > limit) return null;
  const tag = buf[i];
  if ((tag & 0x1f) === 0x1f) return null;
  let len = buf[i + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || i + 2 + n > limit) return null;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i + 2 + k];
    if (len < 0x80 || (n > 1 && buf[i + 2] === 0)) return null;
    hdr += n;
  }
  const start = i + hdr;
  const end = start + len;
  return end <= limit ? { tag, start, end, next: end } : null;
}

function derChildren(buf, el) {
  const out = [];
  for (let i = el.start; i < el.end;) {
    const c = derAt(buf, i, el.end);
    if (!c) return null;
    out.push(c);
    i = c.next;
  }
  return out;
}

function oidText(b) {
  if (!b.length) return null;
  const first = Math.min(2, Math.floor(b[0] / 40));
  const parts = [first, b[0] - 40 * first];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; } else if (v > 2 ** 40) return null;
  }
  return b[b.length - 1] & 0x80 ? null : parts.join('.');
}

/** The extensions of a DER certificate: [{ oid, critical, value }]; throws when malformed or an extension repeats. */
export function certExtensions(der) {
  const cert = derAt(der, 0);
  if (!cert || cert.tag !== 0x30 || cert.end !== der.length) throw new Error('not a DER certificate');
  const top = derChildren(der, cert);
  if (!top || top.length !== 3 || top[0].tag !== 0x30) throw new Error('not a DER certificate');
  const tbs = derChildren(der, top[0]);
  if (!tbs) throw new Error('the tbsCertificate is not well-formed');
  const ext = tbs.find((e) => e.tag === 0xa3);
  if (!ext) return [];
  const wrapped = derChildren(der, ext);
  if (!wrapped || wrapped.length !== 1 || wrapped[0].tag !== 0x30) throw new Error('the extensions are not well-formed');
  const list = derChildren(der, wrapped[0]);
  if (!list) throw new Error('the extensions are not well-formed');
  const out = [];
  const seen = new Set();
  for (const e of list) {
    const f = e.tag === 0x30 ? derChildren(der, e) : null;
    if (!f || f.length < 2 || f.length > 3 || f[0].tag !== 0x06) throw new Error('an extension is not well-formed');
    const oid = oidText(der.subarray(f[0].start, f[0].end));
    if (!oid) throw new Error('an extension OID is not well-formed');
    if (seen.has(oid)) throw new Error(`the extension ${oid} appears twice`);
    seen.add(oid);
    let critical = false;
    let val = f[1];
    if (f.length === 3) {
      if (f[1].tag !== 0x01 || f[1].end - f[1].start !== 1) throw new Error('an extension is not well-formed');
      critical = der[f[1].start] === 0xff;
      val = f[2];
    }
    if (val.tag !== 0x04) throw new Error('an extension value is not an OCTET STRING');
    out.push({ oid, critical, value: der.subarray(val.start, val.end) });
  }
  return out;
}

/** A Fulcio extension (1.3.6.1.4.1.57264.1.<arc>) as text, or null. */
export function fulcioExtension(der, arc) {
  const hit = certExtensions(der).find((e) => e.oid === `1.3.6.1.4.1.57264.1.${arc}`);
  if (!hit) return null;
  const v = hit.value;
  if (arc < 8) return v.toString('utf8');
  const s = derAt(v, 0);
  if (!s || s.tag !== 0x0c || s.start === s.end || s.end !== v.length) return null;
  return v.subarray(s.start, s.end).toString('utf8');
}

export const TRUSTED_REUSABLE_SIGNERS = Object.freeze([
  'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/',
]);
const trustedSigner = (uri) => typeof uri === 'string' && TRUSTED_REUSABLE_SIGNERS.some((p) => uri.startsWith(p) && /^[A-Za-z0-9_.-]+\.ya?ml@refs\/tags\/v[0-9][0-9A-Za-z.-]*$/.test(uri.slice(p.length)));

export function signerKind({ san, buildSigner, repo }) {
  const want = `https://github.com/${repo.toLowerCase()}/`;
  if (String(san).toLowerCase().startsWith(`uri:${want}`)) return 'repository_workflow';
  if (trustedSigner(buildSigner) && san === `URI:${buildSigner}`) return 'trusted_reusable_workflow';
  return null;
}

/**
 * Check one Sigstore-signed DSSE statement for `repo`. Returns null when every
 * check holds, else the first reason. Fills `info` with signer, commit and ref.
 */
export function sigstoreProblem({ certDer, payloadType, body, signature, repo, chains = sigstoreChains(), info = {} }) {
  let leaf;
  try { leaf = new X509Certificate(certDer); certExtensions(certDer); } catch { return 'certificate_unreadable'; }
  const chain = chains.find((c) => c.length && leaf.checkIssued(c[0]) && leaf.verify(c[0].publicKey)
    && c.every((x, k) => (k + 1 < c.length ? x.checkIssued(c[k + 1]) && x.verify(c[k + 1].publicKey) : x.verify(x.publicKey))));
  if (!chain) return 'certificate_not_from_fulcio';
  const issuer = fulcioExtension(certDer, 8) || fulcioExtension(certDer, 1);
  if (issuer !== 'https://token.actions.githubusercontent.com') return 'not_github_actions';
  const source = fulcioExtension(certDer, 12);
  if (!source || source.toLowerCase() !== `https://github.com/${repo.toLowerCase()}`) return 'certificate_other_repository';
  const signer = signerKind({ san: String(leaf.subjectAltName || ''), buildSigner: fulcioExtension(certDer, 9), repo });
  if (!signer) return 'certificate_other_repository';
  info.signer = signer;
  const digest = fulcioExtension(certDer, 13);
  info.commit = typeof digest === 'string' && SHA1_RE.test(digest) ? digest : null;
  const ref = fulcioExtension(certDer, 14);
  info.ref = typeof ref === 'string' && /^refs\/[A-Za-z0-9._\/@+-]{1,200}$/.test(ref) ? ref : null;
  const pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${body.length} `), body]);
  try { if (!createVerify('sha256').update(pae).verify(leaf.publicKey, signature)) return 'signature_invalid'; } catch { return 'signature_invalid'; }
  return null;
}

/**
 * npm: check the attestations document the registry serves for one version.
 * @param {object} att      the JSON from dist.attestations.url
 * @param {object} o
 * @param {string} o.name   package name
 * @param {string} o.version
 * @param {string} o.integrity  dist.integrity (sha512-...)
 * @param {string} o.repo   the subject, owner/name
 * @returns {{present: boolean, verified: boolean, why: string|null, signer: string|null, commit: string|null, ref: string|null}}
 */
export function npmProvenance(att, { name, version, integrity, repo, chains }) {
  const out = { present: false, verified: false, why: null, signer: null, commit: null, ref: null };
  const m = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(integrity || ''));
  const prov = (isObj(att) && Array.isArray(att.attestations) ? att.attestations : [])
    .find((x) => isObj(x) && x.predicateType === 'https://slsa.dev/provenance/v1' && isObj(x.bundle));
  if (!prov) { out.why = 'no_provenance'; return out; }
  out.present = true;
  if (!m) { out.why = 'no_integrity'; return out; }
  const tarSha512 = Buffer.from(m[1], 'base64').toString('hex');
  const env = prov.bundle.dsseEnvelope;
  const vm = prov.bundle.verificationMaterial;
  const certB64 = isObj(vm) && isObj(vm.certificate) ? vm.certificate.rawBytes
    : isObj(vm) && isObj(vm.x509CertificateChain) && Array.isArray(vm.x509CertificateChain.certificates) && isObj(vm.x509CertificateChain.certificates[0]) ? vm.x509CertificateChain.certificates[0].rawBytes : null;
  if (!isObj(env) || typeof env.payload !== 'string' || env.payloadType !== 'application/vnd.in-toto+json' || !Array.isArray(env.signatures) || !isObj(env.signatures[0]) || typeof env.signatures[0].sig !== 'string' || typeof certB64 !== 'string') {
    out.why = 'provenance_unreadable';
    return out;
  }
  const body = Buffer.from(env.payload, 'base64');
  let st;
  try { st = JSON.parse(body.toString('utf8')); } catch { out.why = 'provenance_unreadable'; return out; }
  const purl = `pkg:npm/${String(name).replace(/^@/, '%40')}@${version}`;
  if (!(Array.isArray(st?.subject) && st.subject.some((x) => isObj(x) && x.name === purl && isObj(x.digest) && x.digest.sha512 === tarSha512))) { out.why = 'provenance_other_artifact'; return out; }
  const wf = st?.predicate?.buildDefinition?.externalParameters?.workflow;
  if (!isObj(wf) || String(wf.repository || '').toLowerCase() !== `https://github.com/${repo.toLowerCase()}`) { out.why = 'provenance_other_repository'; return out; }
  const info = {};
  const p = sigstoreProblem({ certDer: Buffer.from(certB64, 'base64'), payloadType: env.payloadType, body, signature: Buffer.from(env.signatures[0].sig, 'base64'), repo, info, ...(chains ? { chains } : {}) });
  out.signer = info.signer ?? null;
  if (p) { out.why = p; return out; }
  // The commit the signed statement resolved; it must agree with the certificate's when both are there.
  const dep = (Array.isArray(st.predicate.buildDefinition.resolvedDependencies) ? st.predicate.buildDefinition.resolvedDependencies : [])
    .find((d) => isObj(d) && isObj(d.digest) && typeof d.digest.gitCommit === 'string');
  const stmtCommit = dep && SHA1_RE.test(dep.digest.gitCommit) ? dep.digest.gitCommit : null;
  if (info.commit && stmtCommit && info.commit !== stmtCommit) { out.why = 'provenance_commit_disagrees'; return out; }
  out.verified = true;
  out.commit = info.commit ?? stmtCommit;
  out.ref = info.ref ?? (typeof wf.ref === 'string' && /^refs\/[A-Za-z0-9._\/@+-]{1,200}$/.test(wf.ref) ? wf.ref : null);
  return out;
}

/**
 * PyPI: check the integrity API's provenance document for one file.
 * @param {object} doc   the JSON from https://pypi.org/integrity/<project>/<version>/<file>/provenance
 * @returns same shape as npmProvenance, plus publisher_kind
 */
export function pypiProvenance(doc, { filename, sha256, repo, chains }) {
  const out = { present: false, verified: false, why: 'no_provenance', signer: null, commit: null, ref: null };
  for (const b of isObj(doc) && Array.isArray(doc.attestation_bundles) ? doc.attestation_bundles : []) {
    out.present = true;
    const pub = isObj(b) && isObj(b.publisher) ? b.publisher : null;
    if (!pub || pub.kind !== 'GitHub' || String(pub.repository || '').toLowerCase() !== repo.toLowerCase()) { out.why = 'provenance_other_repository'; continue; }
    for (const a of Array.isArray(b.attestations) ? b.attestations : []) {
      if (!isObj(a) || !isObj(a.envelope) || !isObj(a.verification_material) || typeof a.envelope.statement !== 'string' || typeof a.envelope.signature !== 'string' || typeof a.verification_material.certificate !== 'string') { out.why = 'provenance_unreadable'; continue; }
      const body = Buffer.from(a.envelope.statement, 'base64');
      let st;
      try { st = JSON.parse(body.toString('utf8')); } catch { out.why = 'provenance_unreadable'; continue; }
      if (!(Array.isArray(st?.subject) && st.subject.some((x) => isObj(x) && x.name === filename && isObj(x.digest) && x.digest.sha256 === sha256))) { out.why = 'provenance_other_artifact'; continue; }
      const info = {};
      const p = sigstoreProblem({ certDer: Buffer.from(a.verification_material.certificate, 'base64'), payloadType: 'application/vnd.in-toto+json', body, signature: Buffer.from(a.envelope.signature, 'base64'), repo, info, ...(chains ? { chains } : {}) });
      out.signer = info.signer ?? out.signer;
      if (!p) {
        return { ...out, verified: true, why: null, commit: info.commit ?? null, ref: info.ref ?? null };
      }
      out.why = p;
    }
  }
  return out;
}
