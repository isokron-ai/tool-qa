// A repository's tags and HEAD, read over Git's smart HTTP protocol (version
// 2, `ls-refs`) from github.com: one POST, no GitHub API quota, and only the
// refs asked for (HEAD and refs/tags/), so a repository with many pull
// request refs costs no more than one without.
//
//   POST https://github.com/<owner>/<name>.git/git-upload-pack
//   Git-Protocol: version=2
//   command=ls-refs, peel, symrefs, ref-prefix refs/tags/, ref-prefix HEAD
//
// The answer is pkt-lines "<oid> <ref>[ symref-target:<t>][ peeled:<oid>]".
// An annotated tag's own object is `object`; the commit it points at is its
// `peeled` oid. Nothing is cloned and no object is fetched.

import { FetchProblem, readBytesCapped } from './http.mjs';

export const MAX_REFS_BYTES = 8 * 1024 ** 2;
const OID_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^(?:HEAD|refs\/[^\0\s~^:?*[\\]{1,250})$/;

function pkt(s) {
  return (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
}

/** The ls-refs request body. */
export function lsRefsBody() {
  return pkt('command=ls-refs\n') + pkt('object-format=sha1\n') + '0001'
    + pkt('peel\n') + pkt('symrefs\n') + pkt('ref-prefix refs/tags/\n') + pkt('ref-prefix HEAD\n') + '0000';
}

/**
 * Parse an ls-refs answer.
 * @returns {{head: string|null, head_ref: string|null, tags: Map<string, {object: string, commit: string, annotated: boolean}>, unreadable: number}}
 */
export function parseLsRefs(buf) {
  const tags = new Map();
  let head = null;
  let headRef = null;
  let unreadable = 0;
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(lenHex)) throw new Error('git refs: a packet length is malformed');
    const len = parseInt(lenHex, 16);
    if (len === 0) break; // flush: the end of the list
    if (len < 4 || i + len > buf.length) throw new Error('git refs: a packet runs past the answer');
    const line = buf.toString('utf8', i + 4, i + len).replace(/\n$/, '');
    i += len;
    if (line.startsWith('ERR ')) throw new Error('git refs: the server refused the request');
    const parts = line.split(' ');
    const [oid, ref, ...attrs] = parts;
    if (!OID_RE.test(oid ?? '') || !REF_RE.test(ref ?? '')) { unreadable++; continue; }
    let peeled = null;
    let symref = null;
    for (const a of attrs) {
      if (a.startsWith('peeled:') && OID_RE.test(a.slice(7))) peeled = a.slice(7);
      else if (a.startsWith('symref-target:') && REF_RE.test(a.slice(14))) symref = a.slice(14);
    }
    if (ref === 'HEAD') { head = oid; headRef = symref; continue; }
    if (ref.startsWith('refs/tags/')) {
      const name = ref.slice('refs/tags/'.length);
      if (name.endsWith('^{}')) continue; // v0 style peel lines do not occur in v2; ignored if they do
      tags.set(name, { object: oid, commit: peeled ?? oid, annotated: peeled !== null });
    }
  }
  return { head, head_ref: headRef, tags, unreadable };
}

/**
 * Read the tags and HEAD of github.com/<repo>.
 * @returns {Promise<{status: 'ok', head, head_ref, tags, unreadable} | {status: 'not_found'|'moved'|'http_<n>'}>}
 *   throws FetchProblem for a rate limit, an outage or an answer over the cap
 */
export async function readGitRefs(http, repo) {
  const url = `https://github.com/${repo}.git/git-upload-pack`;
  const res = await http.request(url, {
    method: 'POST',
    body: lsRefsBody(),
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
      'git-protocol': 'version=2',
    },
  });
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    // GitHub answers a repository that does not exist, or is private, with 401 (it asks for credentials).
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: 'not_found' };
    if (res.status >= 300 && res.status < 400) return { status: 'moved' };
    return { status: `http_${res.status}` };
  }
  const buf = await readBytesCapped(res, MAX_REFS_BYTES, 'github.com');
  try {
    return { status: 'ok', ...parseLsRefs(buf) };
  } catch {
    throw new FetchProblem('upstream_unavailable', 'github.com: the refs answer could not be read');
  }
}
