// Worker-thread entry for judging one decrypted bundle (analyze.mjs
// runAnalysis). It receives {plaintext, ctx}, posts back {result} or {error},
// and holds no secrets: the pump runs it with an empty environment.

import { parentPort, workerData } from 'node:worker_threads';

import { analyzeBundle } from './analyze.mjs';

const { plaintext, ctx } = workerData;
try {
  // A Buffer arrives as a plain Uint8Array.
  const buf = Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  parentPort.postMessage({ result: analyzeBundle(buf, ctx) });
} catch (err) {
  parentPort.postMessage({ error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` });
}
