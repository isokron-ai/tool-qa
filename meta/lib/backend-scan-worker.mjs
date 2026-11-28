// Worker thread of meta-backend's scan (meta/backend.mjs runScan): the scan of one subject runs here, so the lane can
// stop it at a wall-clock limit (worker.terminate) whatever a file does to a regex (R-WB-20). It gets the job as a
// message (the archive's bytes, transferred, or root files) and answers with the scan's result or an error code.

import { parentPort } from 'node:worker_threads';

import { loadMapsFrom } from './backend-maps.mjs';
import { scanArchive, scanFiles } from './backend-archive.mjs';

parentPort.once('message', async (job) => {
  try {
    const maps = loadMapsFrom(job.mapsSource ?? null);
    const opts = { maps, repo: job.repo, mapVersions: { stand_ins: maps.versions.stand_ins, spec_urls: maps.versions.spec_urls } };
    const out = job.kind === 'archive'
      ? await scanArchive(Buffer.from(job.buf), { ...opts, limits: job.limits, fileLimits: job.fileLimits, pinnedCommit: job.pinnedCommit ?? null })
      : scanFiles(job.files, { ...opts, commit: job.pinnedCommit ?? null });
    parentPort.postMessage({ ok: true, out });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.name ?? 'Error' });
  }
});
