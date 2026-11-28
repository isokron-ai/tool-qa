// The worker files of an untrusted T0 lane (t0-dogfood), checked against the lane: every subject's workflow must end in
// a t0-manifest job that builds the result bundle with the pinned worker-kit (a worker without one never returns a
// result, and a worker that runs third-party code outside the sandbox must not be in the lane at all: R-CTL-17), and it
// must run the same sandbox commit the lane names as sandbox_sha (its SANDBOX_REF, and every mcp-surface-corpus action or
// reusable workflow it uses), so the sandbox breaker gates the very sandbox the worker runs.
//
// The worker files live in the worker repository (isokron-ai/mcp-writecheck-action); pump/test/t0-workers.test.mjs reads
// them at the lane's ref.

const SHA = /^[0-9a-f]{40}$/;

/** The top-level job names of a workflow's text. */
export function jobNames(text) {
  const i = String(text).indexOf('\njobs:\n');
  if (i < 0) return [];
  return [...String(text).slice(i + 7).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

/** One job's text (up to the next top-level job), or ''. */
export function jobText(text, name) {
  const s = String(text);
  const at = s.indexOf(`\n  ${name}:\n`);
  if (at < 0) return '';
  const rest = s.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

/** Every reason a worker file does not fit its untrusted T0 lane; empty when it does. */
export function t0WorkerProblems(text, { sandboxSha } = {}) {
  const p = [];
  if (!SHA.test(String(sandboxSha ?? ''))) return ['the lane names no sandbox_sha'];
  const t = String(text ?? '');
  if (!t.includes('\njobs:\n')) return ['not a workflow file'];
  if (!jobNames(t).includes('t0-manifest')) p.push('no t0-manifest job: the worker builds no result bundle');
  else {
    const man = jobText(t, 't0-manifest');
    if (!/uses: isokron-ai\/tool-qa\/worker-kit@[0-9a-f]{40}\b/.test(man)) p.push('t0-manifest does not build the bundle with the worker-kit pinned to a full commit');
    if (!/node loop\/t0-bundle\.mjs/.test(man)) p.push('t0-manifest does not build the bundle with loop/t0-bundle.mjs');
  }
  const ref = /^ {2}SANDBOX_REF: '([0-9a-f]{40})'\s*$/m.exec(t)?.[1] ?? null;
  if (!ref) p.push('no SANDBOX_REF pin in the workflow env');
  else if (ref !== sandboxSha) p.push(`SANDBOX_REF ${ref.slice(0, 7)} is not the lane's sandbox_sha ${sandboxSha.slice(0, 7)}`);
  const uses = [...t.matchAll(/uses: isokron-ai\/mcp-surface-corpus\/([^@\s]+)@(\S+)/g)].map((m) => ({ what: m[1], at: m[2] }));
  if (!uses.some((u) => u.what === '.github/workflows/sandbox-conformance.yml')) p.push('no sandbox-conformance job');
  if (!uses.some((u) => u.what === 'sandbox-guard')) p.push('no sandbox-guard step');
  for (const u of uses) if (u.at !== sandboxSha) p.push(`${u.what} at ${u.at.slice(0, 12)}, not the lane's sandbox_sha`);
  return p;
}

/** The raw URL of a lane subject's worker file at the lane's ref. */
export function workerFileUrl(lane, subject) {
  const file = lane.control_subjects?.[subject]?.file ?? lane.file;
  return `https://raw.githubusercontent.com/${lane.repo}/${lane.ref}/.github/workflows/${file}`;
}
