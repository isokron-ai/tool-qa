// meta-backend's scan of one subject's text, kept apart from the network so it can run in a worker thread with a
// wall-clock limit (meta/lib/backend-scan-worker.mjs, meta/backend.mjs runScan): one pathological file then costs that
// subject a reader_limit skip, never the shard (R-WB-20). Pure CPU: no network, no filesystem.

import { looksText } from './indicators.mjs';
import { createAnalyzer, fileRole } from './backend-scan.mjs';
import { ArchiveError, ArchiveLimit, readTarGz } from '../../scripts/lib/untar.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const stripTop = (p) => { const i = p.indexOf('/'); return i < 0 ? null : p.slice(i + 1); };

/**
 * Scan a downloaded source archive (gzip bytes). Returns { status: 'ok', value, commit, truncated } or
 * { status: 'too_large' | 'malformed' }.
 */
export async function scanArchive(buf, { maps, limits, fileLimits, repo, mapVersions, pinnedCommit = null }) {
  const analyzer = createAnalyzer(maps);
  let codeBytes = 0;
  let truncated = false;
  const keep = ({ path, size }) => {
    const rel = stripTop(path);
    if (!rel) return false;
    const role = fileRole(rel);
    if (!role) return false;
    if (role === 'code') {
      if (size > fileLimits.codeFileBytes || codeBytes + size > fileLimits.codeBytes) { truncated = true; return false; }
      codeBytes += size;
      return true;
    }
    const cap = role === 'maybe_spec' ? fileLimits.specFileBytes : fileLimits.otherFileBytes;
    if (size > cap) { if (role !== 'maybe_spec') truncated = true; return false; }
    return true;
  };
  let t;
  try {
    t = await readTarGz(buf, {
      limits,
      keep,
      onFile: (f) => {
        if (!f.data) return;
        const rel = stripTop(f.path);
        if (rel && looksText(f.data)) analyzer.addFile(rel, f.data.toString('utf8'));
        f.data = null;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveLimit) return { status: 'too_large' };
    if (err instanceof ArchiveError) return { status: 'malformed' };
    throw err;
  }
  const commit = t.global_comment && SHA_RE.test(t.global_comment) ? t.global_comment : pinnedCommit;
  return { status: 'ok', commit, truncated, value: analyzer.result({ repo, commit, source: 'archive', truncated, mapVersions }) };
}

/** Scan root files read one by one ([[name, text], ...]). */
export function scanFiles(files, { maps, repo, mapVersions, commit = null }) {
  const analyzer = createAnalyzer(maps);
  for (const [name, text] of files) analyzer.addFile(name, text);
  return { status: 'ok', commit, truncated: true, value: analyzer.result({ repo, commit, source: 'root_files', truncated: true, mapVersions }) };
}
