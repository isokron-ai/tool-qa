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

import { FetchProblem, forbiddenKind, readBytesCapped } from './http.mjs';

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

const MAX_HOPS = 3;
const SMART_PATH_RE = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/git-upload-pack$/;

/**
 * Where a renamed or moved repository now lives, from the Location of a 3xx,
 * or null when it points anywhere but github.com's own smart HTTP path for
 * another owner/name (another host, a port, credentials, a path we do not know).
 */
export function movedTo(location, from) {
  let u;
  try { u = new URL(location, `https://github.com/${from}.git/git-upload-pack`); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port !== '' || u.username || u.password) return null;
  const m = SMART_PATH_RE.exec(u.pathname);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Read the tags and HEAD of github.com/<repo>. A repository that was renamed
 * or moved answers with a redirect: it is read again at the new place (at most
 * three hops, github.com only, every request checked by the caller's host
 * guard) and the result says where it went (`moved_to`).
 * @returns {Promise<{status: 'ok', head, head_ref, tags, unreadable, moved_to: string|null}
 *   | {status: 'not_found'}
 *   | {status: 'gone', why: 'dmca'|'disabled'}
 *   | {status: 'moved', to: string|null}>}
 *   not_found: the repository answered 401 or 404 (GitHub says 401 for one that is gone or private).
 *   gone: a 403 or 451 whose body says GitHub took the repository down (DMCA, disabled); throttling is not this.
 *   moved: a redirect we could not follow (another host, a loop, too many hops).
 *   Throws FetchProblem for 429 and a 403 that is throttling (a rate limit), an outage, any other status or an answer over the cap.
 */
export async function readGitRefs(http, repo) {
  let at = repo;
  const seen = new Set([repo.toLowerCase()]);
  for (let hop = 0; ; hop++) {
    const url = `https://github.com/${at}.git/git-upload-pack`;
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
    if (res.status === 200) {
      const buf = await readBytesCapped(res, MAX_REFS_BYTES, 'github.com');
      try {
        return { status: 'ok', ...parseLsRefs(buf), moved_to: at === repo ? null : at };
      } catch {
        throw new FetchProblem('upstream_unavailable', 'github.com: the refs answer could not be read');
      }
    }
    // A 403 for a repository GitHub took down (DMCA, disabled) is the repository's: gone, settled. Throttling is not.
    if (res.status === 403 || res.status === 451) {
      const k = await forbiddenKind(res);
      if (k.kind === 'gone') return { status: 'gone', why: k.why };
      throw new FetchProblem('rate_limited', `github.com: HTTP ${res.status}`, { status: res.status });
    }
    await res.body?.cancel?.().catch(() => {});
    // GitHub answers a repository that does not exist, or is private, with 401 (it asks for credentials).
    if (res.status === 401 || res.status === 404) return { status: 'not_found' };
    if (res.status === 429) throw new FetchProblem('rate_limited', `github.com: HTTP ${res.status}`, { status: res.status });
    if (res.status >= 300 && res.status < 400) {
      const next = movedTo(res.headers.get('location') ?? '', at);
      if (next === null || seen.has(next.toLowerCase()) || hop >= MAX_HOPS) return { status: 'moved', to: next };
      seen.add(next.toLowerCase());
      at = next;
      continue;
    }
    throw new FetchProblem('upstream_unavailable', `github.com: HTTP ${res.status}`, { status: res.status });
  }
}
