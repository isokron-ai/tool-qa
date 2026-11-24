// Test helper: a passing nightly sandbox conformance status (pump/breaker.mjs), checked at `at` (ms).
export function greenStatus(at) {
  return {
    format: 'isokron-sandbox-conformance/1', ok: true, selftest: 'pass', mutations: 'pass', result: 'success',
    checked_at: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: 1, run_attempt: 1,
    run_url: 'https://github.com/isokron-ai/mcp-surface-corpus/actions/runs/1', sandbox_sha: 'a'.repeat(40),
    runner_image: 'ubuntu24/20261117.1', kernel: '6.11.0-1018-azure', docker: '28.0.4', gvisor_release: '20261116.0', runsc_version: 'release-20261116.0',
  };
}

/** A run lookup that backs any status: its run started when the status was checked and ended 5 minutes later. */
export async function backed(status) {
  const t = Date.parse(status.checked_at);
  return { ok: true, why: 'test', run: { started_at: status.checked_at, updated_at: new Date(t + 300_000).toISOString().replace(/\.\d{3}Z$/, 'Z') } };
}
